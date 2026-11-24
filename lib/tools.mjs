// Tool definitions and handlers. Handlers receive validated input and a `deps` object
// ({ chain, signer, env, commitments?, fetch? }) so tests can run them with no network and no
// real key. `commitments` defaults to the @perkos/agent-sdk wrapper in lib/commitments.mjs.
//
// Job lifecycle on the live Nayori contracts (statuses are Bitcoin-block driven):
//   open -> funded (client, human wallet) -> offered (client names a provider)
//   -> accepted (the provider accepts) -> submitted (the provider delivers)
//   -> decided (evaluator or default approval) -> completed / rejected (settlement, anyone),
//   with disputed (appeal), refunded and expired on the side.

import {
  EXPLORER_TX,
  MAX_FEE_USTX,
  WRITE_ALLOWLIST,
  ACCEPTING,
  LIMITS,
  ASSET_UNITS,
  RailError,
  resolveProfile,
  resolveFee,
  resolveMaxDeposit,
  contractIds,
  escrowId,
  checkRegisterPreconditions,
  checkApplyPreconditions,
  checkWithdrawPreconditions,
  checkAcceptPreconditions,
  checkSubmitPreconditions,
  checkCreateJobPreconditions,
  checkBudget,
  checkNameProviderPreconditions,
  checkEvaluationRequestPreconditions,
  checkAppealPreconditions,
  appealEvidenceBytes,
  deliverableDigestHex,
  deliverableBufferBytes,
} from "./rails.mjs";
import { shapes } from "./schemas.mjs";
import { sdkCommitments, assertCommittedDescription, assertCommittedDeliverable } from "./commitments.mjs";
import { NayoriNextTransactionBuilder, resolveNayoriNextConfig, describeNayoriNextError, quoteNayoriNextFee } from "./sdk.mjs";

const commitmentsOf = (deps) => deps.commitments ?? sdkCommitments;
const profileOf = (deps) => resolveProfile(deps.env ?? {});
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const explorerUrl = (profile, txid) => `${EXPLORER_TX}/${txid}?chain=${profile.network}`;

const builders = new Map();
/** The SDK transaction builder pinned to the rails' deployer for this network. */
function builderFor(profile) {
  if (!builders.has(profile.network)) {
    builders.set(profile.network, new NayoriNextTransactionBuilder(resolveNayoriNextConfig({ network: profile.network, deployer: profile.deployer })));
  }
  return builders.get(profile.network);
}

/** SDK input errors become clean refusals; the SDK never echoes keys. */
function sdkPlan(fn) {
  try {
    return fn();
  } catch (err) {
    throw new RailError(`Refused: ${err?.message ?? "the SDK rejected the input"}`);
  }
}

const NETWORK_PRINCIPAL = { mainnet: /^S[PM]/, testnet: /^S[TN]/ };
function assertNetworkPrincipal(profile, principal, field) {
  if (!NETWORK_PRINCIPAL[profile.network].test(String(principal))) {
    throw new RailError(`Refused: ${field} must be a ${profile.network} address (${profile.network === "mainnet" ? "SP or SM" : "ST or SN"}...).`);
  }
}

function hasCommittedCriteria(commitments, description) {
  try {
    commitments.parseEvaluationDescription(description);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recomputes both commitments for a job from its fresh on-chain state plus the caller's
 * criteria and evidence, and refuses unless the criteria hash equals the one committed in
 * the on-chain description.
 */
async function recomputeCommitment(profile, commitments, { asset, job, provider, acceptanceCriteria, evidence }) {
  const onChain = commitments.parseEvaluationDescription(job.description);
  const contract = escrowId(profile, asset);
  const jobId = String(job.jobId);
  const prepared = await commitments.prepareEvaluationSubmission({
    network: profile.network, asset, contract, jobId,
    client: job.client, provider, evaluator: job.evaluator,
    description: onChain.description, acceptanceCriteria, evidence,
  });
  if (prepared.criteriaHash !== onChain.criteriaHash || prepared.description !== job.description) {
    throw new RailError(
      "Refused: the acceptance criteria do not match the job's commitment. The criteria must be exactly the ones the client committed at create-job (same ids, text and order)."
    );
  }
  const deliverable = assertCommittedDeliverable(prepared.deliverable);
  const evaluationId = await commitments.evaluationJobId({ network: profile.network, contract, jobId });
  return { contract, jobId, criteriaHash: prepared.criteriaHash, evidenceHash: prepared.evidenceHash, deliverable, evaluationId };
}

const BROADCAST_NOTE =
  "Broadcast is NOT confirmation. The transaction is only in the mempool; poll nayori_tx_status until status is 'success' (or an abort) before acting on it.";

// Simple bounded concurrency so scans stay polite to the Hiro API.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

/**
 * Shared write path: verify signer, refuse on pending mempool tx, run checks, build the SDK
 * plan, sign through the rails (which re-derive and compare the post-conditions), broadcast.
 * `build(address)` returns { plan, amount? }; amount is the deposit the rails bind.
 */
async function signAndBroadcast(deps, { preflight, build }) {
  const { chain, signer, env } = deps;
  const profile = profileOf(deps);
  const fee = resolveFee(env);
  resolveMaxDeposit(env); // fail fast on a bad cap
  const { address } = signer.verifySigner(env); // throws a clear read-only error when unset

  const pending = await chain.getPendingMempoolCount(address);
  if (pending > 0) {
    throw new RailError(
      `Refused: ${address} already has ${pending} pending mempool transaction(s). Wait for confirmation (nayori_tx_status) before sending another.`
    );
  }
  const context = preflight ? await preflight(address) : {};
  const { plan, amount } = build(address);
  if (plan.network !== profile.network || plan.postConditionMode !== "deny") {
    throw new RailError("Refused: the SDK plan is not a deny-mode call on the configured network.");
  }
  const [contractAddress, contractName] = String(plan.contract).split(".");
  const nonce = await chain.getNextNonce(address);
  const { tx } = await signer.signContractCall(
    {
      contractAddress, contractName, functionName: plan.functionName, functionArgs: [...plan.functionArgs], nonce, fee,
      ...(amount !== undefined ? { amount } : {}),
      planPostConditions: [...plan.postConditions],
    },
    { env, expectedAddress: address }
  );
  const txid = await chain.broadcast(tx);
  return {
    txid,
    explorerUrl: explorerUrl(profile, txid),
    note: BROADCAST_NOTE,
    network: profile.network,
    contract: plan.contract,
    function: plan.functionName,
    sender: address,
    nonce,
    feeMicroStx: fee.toString(),
    postConditionMode: "deny",
    postConditions: plan.postConditions.length,
    ...context,
  };
}

/** What happens next for a job, by status. */
function nextStep(job, submission, decision) {
  switch (job.status) {
    case "open":
      return `The client funds the job (a human wallet action) before Bitcoin block ${job.deliveryDeadline}.${job.asset === "sbtc" ? " Providers may already apply with nayori_apply_to_job." : ""}`;
    case "funded":
      return `The client offers the job to a provider (nayori_client_name_provider).${job.asset === "sbtc" ? " Providers apply with nayori_apply_to_job." : " STX jobs take no applications: share your address with the client."}`;
    case "offered":
      return `Offered to ${job.provider}. That provider accepts with nayori_accept_job before Bitcoin block ${job.deliveryDeadline}.`;
    case "accepted":
      return `${job.provider} delivers before Bitcoin block ${job.deliveryDeadline}: nayori_provider_submit_committed when the description ends with nayori-criteria-v1, otherwise nayori_submit_work.`;
    case "submitted":
      return `Request the evaluation with nayori_evaluation_request (send: true). Without a decision by Bitcoin block ${submission?.reviewDeadline ?? "?"} the job is approved by default.`;
    case "decided":
      return `Decision: ${decision?.decision ?? "?"}${decision?.byDefault ? " (by default)" : ""}. The losing side may appeal with nayori_appeal_decision until Bitcoin block ${decision?.appealDeadline ?? "?"}; after that anyone settles the job (not from this server).`;
    case "disputed":
      return `The job's appeal authority resolves the appeal by Bitcoin block ${decision?.resolutionDeadline ?? "?"}; if it does not, the decision stands and anyone settles the job.`;
    default:
      return "Final. Nothing left to do on this job.";
  }
}

export const tools = [
  {
    name: "nayori_agent_context",
    description:
      "Show who this MCP server acts as on the Nayori marketplace (the live Nayori contracts on Stacks): network, signer address, STX and sBTC balances, read-only or signing mode, this wallet's agent in nayori-agents (one per wallet), its reputation, the fixed fee, the deposit cap and the allowlisted contracts and functions. Call this first.",
    readOnly: true,
    async handler(_input, deps) {
      const { chain, signer, env } = deps;
      const profile = profileOf(deps);
      const fee = resolveFee(env);
      const base = {
        network: profile.network,
        contracts: contractIds(profile),
        feeMicroStx: fee.toString(),
        feeCapMicroStx: MAX_FEE_USTX.toString(),
        maxApplicationDepositSats: resolveMaxDeposit(env).toString(),
        writeFunctions: WRITE_ALLOWLIST,
        funding: "Not available: fund-job is not on the allowlist. Funding a job is a human wallet action, and settlement is never done from this server.",
        managedEvaluator: profile.managedEvaluator,
        committedEvaluations: { sdkSupportsNetwork: await commitmentsOf(deps).supportsNetwork(profile.network) },
        safety:
          "Every transaction uses post-condition mode Deny. Only apply-to-job lets sBTC leave the wallet: exactly the deposit you chose (capped), refundable. Every other call allows no transfer at all; the wallet only pays the fee.",
      };
      if (!signer.signerConfigured(env)) {
        return { mode: "read-only", address: null, reason: "NAYORI_AGENT_ENV_FILE is not set.", ...base };
      }
      let address;
      try {
        ({ address } = signer.verifySigner(env));
      } catch (err) {
        return { mode: "read-only", address: null, reason: err.message, ...base };
      }
      const [balance, sbtc, pending, agent, reputation] = await Promise.all([
        chain.getStxBalance(address),
        chain.getSbtcBalance(address),
        chain.getPendingMempoolCount(address),
        chain.getAgent(address),
        chain.getProviderStats(address).catch(() => null),
      ]);
      return {
        mode: "signing",
        address,
        stxBalanceMicroStx: balance.microStx,
        stxBalance: (Number(balance.microStx) / 1e6).toFixed(6),
        sbtcBalanceSats: sbtc,
        pendingMempoolTransactions: pending,
        agent,
        registered: agent !== null,
        reputation,
        ...base,
      };
    },
  },
  {
    name: "nayori_open_jobs",
    description:
      "List Nayori jobs that still look for a provider: status open, funded or offered, before their deadline. sBTC jobs include their application list summary (count, lowest and highest deposit, whether it is full); STX jobs take no applications, the client names a provider directly. offeredToYou marks jobs offered to this wallet: accept them with nayori_accept_job. asset is 'sbtc' or 'stx' (omit for both). Read-only.",
    readOnly: true,
    async handler({ asset, limit = 20 }, { chain, signer, env }) {
      const profile = resolveProfile(env ?? {});
      const assets = asset ? [asset] : ["sbtc", "stx"];
      let me = null;
      if (signer?.signerConfigured(env)) {
        try {
          ({ address: me } = signer.verifySigner(env));
        } catch {
          me = null;
        }
      }
      const burnHeight = await chain.getBurnHeight();
      const jobs = [];
      const scanned = {};
      const MAX_SCAN = 200;
      for (const a of assets) {
        const count = await chain.getJobCount(a);
        scanned[a] = count;
        // Newest first; job ids are 1-based.
        const ids = Array.from({ length: Math.min(count, MAX_SCAN) }, (_, i) => count - i);
        let found = 0;
        for (let i = 0; i < ids.length && found < limit; i += 4) {
          const batch = await mapLimit(ids.slice(i, i + 4), 4, (id) => chain.getJob(a, id));
          for (const job of batch) {
            if (!job || !ACCEPTING.includes(job.status) || burnHeight >= job.deliveryDeadline || found >= limit) continue;
            const entry = { ...job, blocksLeft: job.deliveryDeadline - burnHeight, offeredToYou: Boolean(me && job.status === "offered" && job.provider === me) };
            if (a === "sbtc") {
              const apps = await chain.getApplications(job.jobId);
              const deposits = apps.map((x) => BigInt(x.deposit));
              entry.applications = {
                count: apps.length,
                highestDeposit: deposits.length ? deposits.reduce((m, d) => (d > m ? d : m)).toString() : null,
                lowestDeposit: deposits.length ? deposits.reduce((m, d) => (d < m ? d : m)).toString() : null,
                full: apps.length >= LIMITS.maxApplications,
                youApplied: Boolean(me && apps.some((x) => x.applicant === me)),
              };
            } else {
              entry.applications = null;
              entry.howToGetHired = "STX jobs take no applications: the client names a provider directly.";
            }
            jobs.push(entry);
            found++;
          }
        }
      }
      return { network: profile.network, burnHeight, jobCountByAsset: scanned, openJobs: jobs };
    },
  },
  {
    name: "nayori_get_job",
    description:
      "Status of one Nayori job (asset 'sbtc' or 'stx', numeric jobId): the job, its submission (deliverable, review deadline), the decision (appeal deadline), the escrow balance, the application list for sBTC jobs, the current Bitcoin block and what happens next. Statuses: open, funded, offered, accepted, submitted, decided, disputed, completed, rejected, refunded, expired. Read-only.",
    readOnly: true,
    async handler({ asset, jobId }, deps) {
      const { chain } = deps;
      const job = await chain.getJob(asset, jobId);
      if (!job) return { found: false, asset, jobId };
      const [submission, decision, escrowBalance, burnHeight, applications] = await Promise.all([
        chain.getSubmission(asset, jobId),
        chain.getDecision(asset, jobId),
        chain.getEscrowBalance(asset, jobId),
        chain.getBurnHeight(),
        asset === "sbtc" ? chain.getApplications(jobId) : Promise.resolve(null),
      ]);
      return {
        found: true,
        job,
        committedCriteria: hasCommittedCriteria(commitmentsOf(deps), job.description),
        submission,
        decision,
        escrowBalance,
        burnHeight,
        applications,
        next: nextStep(job, submission, decision),
      };
    },
  },
  {
    name: "nayori_list_applications",
    description:
      "List the on-chain applications for an sBTC job from nayori-applications: applicant and deposit (sats), highest deposit first. Read-only.",
    readOnly: true,
    async handler({ jobId }, { chain }) {
      const [job, applications] = await Promise.all([chain.getJob("sbtc", jobId), chain.getApplications(jobId)]);
      return {
        asset: "sbtc",
        jobId,
        jobStatus: job?.status ?? null,
        takesApplications: Boolean(job && ACCEPTING.includes(job.status)),
        applicationCount: applications.length,
        maxApplications: LIMITS.maxApplications,
        applications,
      };
    },
  },
  {
    name: "nayori_register_agent",
    description:
      "WRITE. Register this wallet as an agent in nayori-agents (one agent per wallet; refused if it already has one). name: printable ASCII, 1-64 chars; uri: optional link, max 256. Moves no funds, costs only the fixed fee. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ name, uri = "" }, deps) {
      const profile = profileOf(deps);
      return signAndBroadcast(deps, {
        async preflight(address) {
          checkRegisterPreconditions({ existingAgent: await deps.chain.getAgent(address) });
          return { name, uri };
        },
        build: () => ({ plan: sdkPlan(() => builderFor(profile).registerAgent({ name, uri })) }),
      });
    },
  },
  {
    name: "nayori_apply_to_job",
    description:
      "WRITE. Apply to an sBTC job as a provider (nayori-applications apply-to-job) with a refundable sBTC deposit in sats (100 to 1,000,000, capped by NAYORI_AGENT_MAX_DEPOSIT_SATS, default 10,000). The list holds 50 applications sorted by deposit; on a full list you must beat the lowest. Refused unless a fresh read shows the job open, funded or offered before its deadline, this wallet is a registered agent that has not applied yet, is not a party of the job and holds the deposit. The deposit comes back when you withdraw, when the client declines you, or once the job stops taking applications. Post-conditions: you send exactly the deposit, nothing else. STX jobs take no applications. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ jobId, deposit }, deps) {
      const profile = profileOf(deps);
      const max = resolveMaxDeposit(deps.env);
      if (BigInt(deposit) > max) {
        return Promise.reject(new RailError(`Refused: the deposit ${deposit} sats exceeds NAYORI_AGENT_MAX_DEPOSIT_SATS (${max} sats).`));
      }
      return signAndBroadcast(deps, {
        async preflight(address) {
          const { chain } = deps;
          const [job, agent, existingApplication, applications, burnHeight, sbtcBalance] = await Promise.all([
            chain.getJob("sbtc", jobId),
            chain.getAgent(address),
            chain.getApplication(jobId, address),
            chain.getApplications(jobId),
            chain.getBurnHeight(),
            chain.getSbtcBalance(address),
          ]);
          checkApplyPreconditions({ job, agent, signerAddress: address, existingApplication, applications, deposit, burnHeight, sbtcBalance });
          return {
            asset: "sbtc", jobId, deposit: String(deposit), depositUnit: "sats", agent: agent.name,
            refund: "The deposit comes back on nayori_withdraw_application, when the client declines you, or once the job stops taking applications.",
            next: "Wait for the client to offer you the job (nayori_open_jobs shows offeredToYou), then accept it with nayori_accept_job.",
          };
        },
        build: (address) => ({ plan: sdkPlan(() => builderFor(profile).applyToJob({ jobId, deposit, sender: address })), amount: deposit }),
      });
    },
  },
  {
    name: "nayori_withdraw_application",
    description:
      "WRITE. Withdraw this wallet's application to an sBTC job (nayori-applications withdraw); the contract sends the recorded deposit back to this wallet. Refused if there is no application. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ jobId }, deps) {
      const profile = profileOf(deps);
      let deposit;
      return signAndBroadcast(deps, {
        async preflight(address) {
          const existingApplication = await deps.chain.getApplication(jobId, address);
          checkWithdrawPreconditions({ existingApplication });
          deposit = existingApplication.deposit;
          return { asset: "sbtc", jobId, refundSats: deposit };
        },
        build: (address) => ({
          plan: sdkPlan(() => builderFor(profile).withdrawApplication({ jobId, applicant: address, deposit })),
          amount: deposit,
        }),
      });
    },
  },
  {
    name: "nayori_accept_job",
    description:
      "WRITE. Accept a job the client offered to this wallet (escrow accept-job). Required before delivering: the job moves from offered to accepted and the delivery window (the job's delivery blocks) starts. Refused unless a fresh read shows the job is offered to the signer and its deadline has not passed. Moves no funds. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ asset, jobId }, deps) {
      const profile = profileOf(deps);
      return signAndBroadcast(deps, {
        async preflight(address) {
          const [job, burnHeight] = await Promise.all([deps.chain.getJob(asset, jobId), deps.chain.getBurnHeight()]);
          checkAcceptPreconditions({ job, signerAddress: address, burnHeight });
          return {
            asset, jobId, deliveryBlocks: job.deliveryBlocks, deliverByAboutBurnHeight: burnHeight + job.deliveryBlocks,
            committedCriteria: hasCommittedCriteria(commitmentsOf(deps), job.description),
            next: "After confirmation deliver with nayori_provider_submit_committed (description ends with nayori-criteria-v1) or nayori_submit_work.",
          };
        },
        build: () => ({ plan: sdkPlan(() => builderFor(profile).acceptJob({ asset, jobId })) }),
      });
    },
  },
  {
    name: "nayori_submit_work",
    description:
      "WRITE. Submit the deliverable for a job this wallet accepted (escrow submit-work), for jobs WITHOUT committed criteria. Refused unless a fresh read shows the signer is the provider, the job is accepted and the deadline has not passed; refused for jobs whose description ends with 'nayori-criteria-v1:' (use nayori_provider_submit_committed). deliverableReference is a URL, CID or description; the on-chain value is the 64-character lowercase hex SHA-256 of the trimmed reference, stored as ASCII bytes. Keep the reference so the evaluator can verify it. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ asset, jobId, deliverableReference }, deps) {
      const profile = profileOf(deps);
      const digest = deliverableDigestHex(deliverableReference);
      return signAndBroadcast(deps, {
        async preflight(address) {
          const [job, burnHeight] = await Promise.all([deps.chain.getJob(asset, jobId), deps.chain.getBurnHeight()]);
          checkSubmitPreconditions({ job, signerAddress: address, burnHeight });
          if (hasCommittedCriteria(commitmentsOf(deps), job.description)) {
            throw new RailError("Refused: this job has committed acceptance criteria. Deliver with nayori_provider_submit_committed so the Evaluator can admit it.");
          }
          return { asset, jobId, deliverableSha256Hex: digest, deliverableReference: deliverableReference.trim() };
        },
        build: () => ({ plan: sdkPlan(() => builderFor(profile).submitWork({ asset, jobId, deliverable: deliverableBufferBytes(deliverableReference) })) }),
      });
    },
  },
  {
    name: "nayori_provider_submit_committed",
    description:
      "WRITE. Act as a PROVIDER: deliver an evaluable job with an evidence commitment (escrow submit-work). Reads the job fresh, splits its on-chain description into plain text + criteria hash, recomputes the commitments with @perkos/agent-sdk from your acceptanceCriteria and evidence, and REFUSES unless the criteria hash equals the one committed on-chain, the signer is the provider, the job is accepted and the deadline has not passed. The deliverable is 36 bytes: 'ny1:' + the 32 raw bytes of the evidence hash. evidence items: {id, uri (public https), sha256 of the exact file bytes, mediaType, sizeBytes}. Keep the exact inputs for nayori_evaluation_request. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ asset, jobId, acceptanceCriteria, evidence }, deps) {
      const profile = profileOf(deps);
      let deliverable;
      return signAndBroadcast(deps, {
        async preflight(address) {
          const [job, burnHeight] = await Promise.all([deps.chain.getJob(asset, jobId), deps.chain.getBurnHeight()]);
          checkSubmitPreconditions({ job, signerAddress: address, burnHeight });
          const c = await recomputeCommitment(profile, commitmentsOf(deps), { asset, job: { ...job, jobId }, provider: address, acceptanceCriteria, evidence });
          deliverable = c.deliverable;
          return {
            asset, jobId,
            criteriaHash: c.criteriaHash,
            evidenceHash: c.evidenceHash,
            deliverableHex: hex(c.deliverable),
            evaluationId: c.evaluationId,
            next: "After confirmation (status submitted), request the evaluation with nayori_evaluation_request (send: true) using the same acceptanceCriteria and evidence.",
          };
        },
        build: () => ({ plan: sdkPlan(() => builderFor(profile).submitWork({ asset, jobId, deliverable })) }),
      });
    },
  },
  {
    name: "nayori_evaluation_request",
    description:
      "Build the exact JSON body for the Nayori Evaluator's committed admission endpoint, POST /v1/evaluations, for a submitted job; with send:true it also posts it through Nayori's public evaluation relay and returns the answer (202 = queued, 409 = already admitted). Refused unless a fresh read shows the job submitted inside its review window, the criteria match the on-chain commitment, and the on-chain deliverable equals the one recomputed from these acceptanceCriteria and evidence. The body is sent unchanged: the Evaluator recomputes every hash and compares the job snapshot with the chain. Signs nothing and needs no key.",
    readOnly: true,
    async handler({ asset, jobId, acceptanceCriteria, evidence, send = false }, deps) {
      const profile = profileOf(deps);
      const [job, submission, burnHeight] = await Promise.all([
        deps.chain.getJob(asset, jobId), deps.chain.getSubmission(asset, jobId), deps.chain.getBurnHeight(),
      ]);
      checkEvaluationRequestPreconditions({ job, submission, burnHeight });
      const c = await recomputeCommitment(profile, commitmentsOf(deps), { asset, job: { ...job, jobId }, provider: job.provider, acceptanceCriteria, evidence });
      if (hex(c.deliverable) !== submission.deliverableHex) {
        throw new RailError("Refused: the deliverable on-chain is not the evidence commitment recomputed from these inputs. Use exactly the evidence that was submitted.");
      }
      const body = {
        commitmentVersion: "1",
        evaluationId: c.evaluationId,
        network: profile.network,
        asset,
        contract: c.contract,
        jobId: c.jobId,
        job: {
          client: job.client,
          provider: job.provider,
          evaluator: job.evaluator,
          status: "submitted",
          reviewDeadlineBurn: String(submission.reviewDeadline),
          description: job.description,
        },
        acceptanceCriteria,
        evidence,
      };
      let delivery = { sent: false };
      if (send) {
        const relay = (deps.env?.NAYORI_EVALUATION_RELAY ?? profile.evaluationRelay).trim();
        const fetchImpl = deps.fetch ?? globalThis.fetch;
        let response;
        try {
          response = await fetchImpl(relay, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(body),
            redirect: "error",
            signal: AbortSignal.timeout(60_000),
          });
        } catch {
          throw new RailError("The evaluation relay did not answer within 60 s. The request may still have been admitted: check nayori_get_job for a decision before retrying.");
        }
        const text = await response.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 512) }; }
        delivery = { sent: true, relay, httpStatus: response.status, response: parsed };
      }
      return {
        method: "POST",
        path: "/v1/evaluations",
        contentType: "application/json",
        ...delivery,
        body,
        criteriaHash: c.criteriaHash,
        evidenceHash: c.evidenceHash,
        budget: job.budget,
        budgetUnit: job.budgetUnit,
        reviewDeadlineBurn: submission.reviewDeadline,
        burnHeight,
        statusPath: `/v1/evaluations/${c.evaluationId}`,
        evaluatorMatchesManaged: job.evaluator === profile.managedEvaluator,
        note: "Admission also requires: evaluator = the managed Evaluator, budget at or above the Evaluator's minimum, escrow balance = budget, no decision yet, review window still open, evidence hosted on an origin the Evaluator allows (nayori.ai/job-evidence, raw.githubusercontent.com, gist.githubusercontent.com). See README.",
      };
    },
  },
  {
    name: "nayori_appeal_decision",
    description:
      "WRITE. Appeal the recorded decision on a job (escrow appeal). The contract lets the CLIENT appeal an approval and the PROVIDER appeal a rejection, once, until the on-chain appeal deadline (Bitcoin block). It moves no funds: it marks the job disputed so the job's pinned appeal authority can resolve it (which settles the escrow); if the authority never answers, the original decision stands. Only the SHA-256 of appealReference goes on-chain. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ asset, jobId, appealReference }, deps) {
      const profile = profileOf(deps);
      const bytes = appealEvidenceBytes(appealReference);
      return signAndBroadcast(deps, {
        async preflight(address) {
          const [job, decision, burnHeight] = await Promise.all([
            deps.chain.getJob(asset, jobId), deps.chain.getDecision(asset, jobId), deps.chain.getBurnHeight(),
          ]);
          checkAppealPreconditions({ job, decision, signerAddress: address, burnHeight });
          return {
            asset, jobId, decision: decision.decision, byDefault: decision.byDefault,
            appealDeadline: decision.appealDeadline, burnHeight,
            appealEvidenceSha256Hex: hex(bytes),
            next: "The job's appeal authority resolves the appeal from its own wallet; that settles the escrow.",
          };
        },
        build: () => ({ plan: sdkPlan(() => builderFor(profile).appeal({ asset, jobId, evidenceHash: bytes })) }),
      });
    },
  },
  {
    name: "nayori_client_create_job",
    description:
      "WRITE. Act as a CLIENT: create an evaluable Nayori job on the escrow (create-job) with its budget, delivery window and review window. The acceptance criteria are hashed with @perkos/agent-sdk and the on-chain description is your description plus a 'nayori-criteria-v1:<hash>' commitment, which is what lets the managed Evaluator evaluate it. Keep the exact acceptanceCriteria: the provider and the Evaluator need them verbatim. Default evaluator is the Nayori managed Evaluator. budget: sats for sbtc (1,000 to 100,000,000), microSTX for stx (1,000,000 to 100,000,000,000); a 2% service fee goes to the treasury on settlement. Creates the job only: it moves no funds, and this server can NOT fund a job (funding is a human wallet action). The new job id is the (ok uN) result shown by nayori_tx_status. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler(
      { asset, description, acceptanceCriteria, budget, evaluator, deliveryBlocks = LIMITS.deliveryBlocks.default, reviewBlocks = LIMITS.reviewBlocks.default },
      deps
    ) {
      const profile = profileOf(deps);
      const evaluatorAddress = evaluator ?? profile.managedEvaluator;
      try {
        checkBudget(asset, budget);
        assertNetworkPrincipal(profile, evaluatorAddress, "evaluator");
      } catch (err) {
        return Promise.reject(err);
      }
      const contract = escrowId(profile, asset);
      let committed;
      return signAndBroadcast(deps, {
        async preflight(address) {
          const roles = await deps.chain.getRoles();
          checkCreateJobPreconditions({ signerAddress: address, evaluator: evaluatorAddress, roles });
          const prepared = await commitmentsOf(deps).prepareEvaluationJob({
            network: profile.network, asset, contract, client: address, evaluator: evaluatorAddress, description, acceptanceCriteria,
          });
          assertCommittedDescription({ plainDescription: description, prepared });
          committed = prepared.description;
          const fee = quoteNayoriNextFee(budget);
          return {
            asset, client: address, evaluator: evaluatorAddress,
            budget: String(budget), budgetUnit: ASSET_UNITS[asset],
            serviceFeeOnSettlement: fee.fee.toString(), providerReceivesOnApproval: fee.net.toString(),
            deliveryBlocks, reviewBlocks,
            criteriaHash: prepared.criteriaHash,
            committedDescription: prepared.description,
            description,
            acceptanceCriteria,
            next: `After confirmation read the job id from nayori_tx_status (ok uN). A human wallet funds it before ${deliveryBlocks} Bitcoin blocks pass; then offer it with nayori_client_name_provider.`,
          };
        },
        build: (address) => ({
          plan: sdkPlan(() =>
            builderFor(profile).createJob({ asset, evaluator: evaluatorAddress, budget, deliveryBlocks, reviewBlocks, description: committed, client: address })
          ),
        }),
      });
    },
  },
  {
    name: "nayori_client_name_provider",
    description:
      "WRITE. Act as a CLIENT: offer a job you created to a provider (escrow name-provider). The job becomes offered; the provider must accept it (nayori_accept_job) before delivering, and you can change the offer until then. Refused unless a fresh read shows the signer is the client, the job is funded or offered, and the provider is not the client, evaluator, treasury or appeal authority. The result says whether that provider applied (sBTC jobs); it is not required. Moves no funds. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ asset, jobId, provider }, deps) {
      const profile = profileOf(deps);
      try {
        assertNetworkPrincipal(profile, provider, "provider");
      } catch (err) {
        return Promise.reject(err);
      }
      let parties;
      return signAndBroadcast(deps, {
        async preflight(address) {
          const [job, application] = await Promise.all([
            deps.chain.getJob(asset, jobId),
            asset === "sbtc" ? deps.chain.getApplication(jobId, provider) : Promise.resolve(null),
          ]);
          checkNameProviderPreconditions({ job, signerAddress: address, provider });
          parties = [job.client, job.evaluator, job.treasury, job.appealAuthority];
          return {
            asset, jobId, provider, applied: application !== null, applicationDepositSats: application?.deposit ?? null,
            next: `The provider accepts with nayori_accept_job before Bitcoin block ${job.deliveryDeadline}.`,
          };
        },
        build: () => ({ plan: sdkPlan(() => builderFor(profile).nameProvider({ asset, jobId, provider, parties })) }),
      });
    },
  },
  {
    name: "nayori_tx_status",
    description:
      "Check a Stacks transaction by txid on the configured network: pending, success, or an abort status, plus the Clarity result with the Nayori error explained when there is one. Use after any write tool. Read-only.",
    readOnly: true,
    async handler({ txid }, deps) {
      const profile = profileOf(deps);
      const s = await deps.chain.getTxStatus(txid);
      const m = /\(err u(\d+)\)/.exec(s.result ?? "");
      const info = m ? describeNayoriNextError(Number(m[1])) : undefined;
      return {
        ...s,
        ...(info ? { error: { code: Number(m[1]), name: info.name, message: info.message } } : {}),
        explorerUrl: explorerUrl(profile, s.txid),
      };
    },
  },
].map((t) => ({ ...t, inputShape: shapes[t.name] }));
