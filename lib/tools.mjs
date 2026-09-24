// Tool definitions and handlers. Handlers receive validated input and a `deps` object
// ({ chain, signer, env, commitments? }) so tests can run them with no network and no real
// key. `commitments` defaults to the @perkos/agent-sdk wrapper in lib/commitments.mjs.

import { Cl } from "@stacks/transactions";
import {
  NETWORK,
  DEPLOYER,
  CONTRACTS,
  CONTRACT_IDS,
  ASSETS,
  EXPLORER_TX,
  MAX_FEE_USTX,
  MANAGED_EVALUATOR,
  EVALUATION_RELAY,
  EXPIRY_TENURES,
  WRITE_ALLOWLIST,
  RailError,
  resolveFee,
  checkApplyPreconditions,
  checkSubmitPreconditions,
  checkWithdrawPreconditions,
  checkCreateJobPreconditions,
  checkSetBudgetPreconditions,
  checkAppealPreconditions,
  appealEvidenceBytes,
  checkAssignProviderPreconditions,
  checkEvaluationRequestPreconditions,
  computeExpiredAt,
  deliverableDigestHex,
  deliverableBufferBytes,
} from "./rails.mjs";
import { shapes } from "./schemas.mjs";
import { sdkCommitments, assertCommittedDescription, assertCommittedDeliverable } from "./commitments.mjs";

const commitmentsOf = (deps) => deps.commitments ?? sdkCommitments;
const hex = (bytes) => Buffer.from(bytes).toString("hex");

/**
 * Recomputes both commitments for a job from its fresh on-chain state plus the caller's
 * criteria and evidence, and refuses unless the criteria hash equals the one committed in
 * the on-chain description.
 */
async function recomputeCommitment(commitments, { asset, job, provider, acceptanceCriteria, evidence }) {
  const onChain = commitments.parseEvaluationDescription(job.description);
  const contract = `${DEPLOYER}.${ASSETS[asset].escrow}`;
  const jobId = String(job.jobId);
  const prepared = await commitments.prepareEvaluationSubmission({
    network: NETWORK, asset, contract, jobId,
    client: job.client, provider, evaluator: job.evaluator,
    description: onChain.description, acceptanceCriteria, evidence,
  });
  if (prepared.criteriaHash !== onChain.criteriaHash || prepared.description !== job.description) {
    throw new RailError(
      "Refused: the acceptance criteria do not match the job's commitment. The criteria must be exactly the ones the client committed at create-job (same ids, text and order)."
    );
  }
  const deliverable = assertCommittedDeliverable(prepared.deliverable);
  const evaluationId = await commitments.evaluationJobId({ network: NETWORK, contract, jobId });
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

/** Shared write path: verify signer, refuse on pending mempool tx, run checks, sign, broadcast. */
async function signAndBroadcast(deps, { contractName, functionName, preflight, buildArgs }) {
  const { chain, signer, env } = deps;
  const fee = resolveFee(env);
  const { address } = signer.verifySigner(env); // throws a clear read-only error when unset

  const pending = await chain.getPendingMempoolCount(address);
  if (pending > 0) {
    throw new RailError(
      `Refused: ${address} already has ${pending} pending mempool transaction(s). Wait for confirmation (nayori_tx_status) before sending another.`
    );
  }
  const context = preflight ? await preflight(address) : {};
  const nonce = await chain.getNextNonce(address);
  const { tx } = await signer.signContractCall(
    { contractAddress: DEPLOYER, contractName, functionName, functionArgs: buildArgs(address), nonce, fee },
    { env, expectedAddress: address }
  );
  const txid = await chain.broadcast(tx);
  return {
    txid,
    explorerUrl: `${EXPLORER_TX}/${txid}?chain=mainnet`,
    note: BROADCAST_NOTE,
    contract: `${DEPLOYER}.${contractName}`,
    function: functionName,
    sender: address,
    nonce,
    feeMicroStx: fee.toString(),
    postConditionMode: "deny",
    postConditions: 0,
    ...context,
  };
}

async function listAgentsForWallet(chain, address) {
  const count = await chain.getAgentCount();
  const ids = Array.from({ length: count }, (_, i) => i + 1); // registry ids are 1-based
  const agents = await mapLimit(ids, 4, (id) => chain.getAgent(id));
  return agents.filter((a) => a && a.wallet === address);
}

export const tools = [
  {
    name: "nayori_agent_context",
    description:
      "Show who this MCP server acts as on the Nayori marketplace (Stacks mainnet): signer address, STX balance, whether it is in read-only or signing mode, the registry agents whose wallet is this address, the fixed fee, and the allowlisted contract ids. Call this first.",
    readOnly: true,
    async handler(_input, deps) {
      const { chain, signer, env } = deps;
      const fee = resolveFee(env);
      const base = {
        network: NETWORK,
        contracts: CONTRACT_IDS,
        assets: { stx: ASSETS.stx.id, sbtc: ASSETS.sbtc.id },
        feeMicroStx: fee.toString(),
        feeCapMicroStx: MAX_FEE_USTX.toString(),
        writeFunctions: [...new Set(Object.values(WRITE_ALLOWLIST).flat())],
        funding: "Not available: fund-job is not on the allowlist. Funding a job is a human wallet action.",
        managedEvaluator: MANAGED_EVALUATOR,
        committedEvaluations: { sdkSupportsMainnet: await commitmentsOf(deps).supportsMainnet() },
        safety: "Every transaction uses post-condition mode Deny with zero post-conditions: no STX, token or NFT can leave the wallet, only the fee.",
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
      const [balance, pending, agents] = await Promise.all([
        chain.getStxBalance(address),
        chain.getPendingMempoolCount(address),
        listAgentsForWallet(chain, address),
      ]);
      return {
        mode: "signing",
        address,
        stxBalanceMicroStx: balance.microStx,
        stxBalance: (Number(balance.microStx) / 1e6).toFixed(6),
        pendingMempoolTransactions: pending,
        agents,
        ...base,
      };
    },
  },
  {
    name: "nayori_open_jobs",
    description:
      "List Nayori jobs a provider agent can still apply to: status 0 (open) or 1 (funded) with no provider assigned, plus how many applications each already has. asset is 'sbtc' or 'stx' (omit for both). Read-only.",
    readOnly: true,
    async handler({ asset, limit = 20 }, { chain }) {
      const assets = asset ? [asset] : ["sbtc", "stx"];
      const jobs = [];
      const scanned = {};
      for (const a of assets) {
        const count = await chain.getJobCount(a);
        scanned[a] = count;
        // Newest first; job ids are 1-based.
        const ids = Array.from({ length: count }, (_, i) => count - i);
        let found = 0;
        for (let i = 0; i < ids.length && found < limit; i += 4) {
          const batch = await mapLimit(ids.slice(i, i + 4), 4, (id) => chain.getJob(a, id));
          for (const job of batch) {
            if (!job || job.provider || (job.status !== 0 && job.status !== 1) || found >= limit) continue;
            jobs.push({ ...job, applicationCount: await chain.getApplicationCount(a, job.jobId) });
            found++;
          }
        }
      }
      return { network: NETWORK, jobCountByAsset: scanned, openJobs: jobs };
    },
  },
  {
    name: "nayori_get_job",
    description: "Read one Nayori job from the escrow contract (asset 'sbtc' or 'stx', numeric jobId). Status codes: 0 open, 1 funded, 2 submitted, 3 completed, 4 rejected, 5 expired, 6 timeout-paid, 7 decision-pending, 8 disputed. Read-only.",
    readOnly: true,
    async handler({ asset, jobId }, { chain }) {
      const job = await chain.getJob(asset, jobId);
      if (!job) return { found: false, asset, jobId };
      return { found: true, job, applicationCount: await chain.getApplicationCount(asset, jobId) };
    },
  },
  {
    name: "nayori_list_applications",
    description: "List the on-chain applications for a job from job-applications-v1 (applicant, agent id, note, burn height, active flag). Withdrawn applications appear with active=false. Read-only.",
    readOnly: true,
    async handler({ asset, jobId }, { chain }) {
      const count = await chain.getApplicationCount(asset, jobId);
      const idx = Array.from({ length: count }, (_, i) => i);
      const applications = (await mapLimit(idx, 4, (i) => chain.getApplicantAt(asset, jobId, i))).filter(Boolean);
      return { asset, assetId: ASSETS[asset].id, jobId, applicationCount: count, applications };
    },
  },
  {
    name: "nayori_register_agent",
    description:
      "WRITE (mainnet). Register this wallet as an agent in the Nayori agent-registry. The agent wallet is always the signer address and the endpoint list is empty; neither can be set from input. name: printable ASCII, 1-64 chars; description: printable ASCII, max 256. Costs only the fixed fee. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ name, description }, deps) {
      return signAndBroadcast(deps, {
        contractName: CONTRACTS.registry,
        functionName: "register-agent",
        buildArgs: (address) => [Cl.stringAscii(name), Cl.stringAscii(description), Cl.principal(address), Cl.list([])],
      });
    },
  },
  {
    name: "nayori_apply_to_job",
    description:
      "WRITE (mainnet). Apply to a Nayori job as a provider through job-applications-v1. Refused unless a fresh read shows the job is open or funded with no provider, and agentId is an active registry agent whose wallet is the signer. Applying moves no funds; the client still has to assign the provider. note: optional printable ASCII, max 140. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ asset, jobId, agentId, note = "" }, deps) {
      const info = ASSETS[asset];
      return signAndBroadcast(deps, {
        contractName: CONTRACTS.applications,
        functionName: "apply-to-job",
        async preflight(address) {
          const [job, agent, existingApplication] = await Promise.all([
            deps.chain.getJob(asset, jobId),
            deps.chain.getAgent(agentId),
            deps.chain.getApplication(asset, jobId, address),
          ]);
          checkApplyPreconditions({ job, agent, signerAddress: address, existingApplication });
          return { asset, jobId, agentId };
        },
        buildArgs: () => [
          Cl.contractPrincipal(DEPLOYER, info.escrow),
          Cl.contractPrincipal(DEPLOYER, CONTRACTS.registry),
          Cl.uint(jobId),
          Cl.uint(agentId),
          Cl.stringAscii(note),
        ],
      });
    },
  },
  {
    name: "nayori_withdraw_application",
    description: "WRITE (mainnet). Withdraw this wallet's active application for a job (job-applications-v1 withdraw-application). Refused if there is no active application. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ asset, jobId }, deps) {
      return signAndBroadcast(deps, {
        contractName: CONTRACTS.applications,
        functionName: "withdraw-application",
        async preflight(address) {
          const existingApplication = await deps.chain.getApplication(asset, jobId, address);
          checkWithdrawPreconditions({ existingApplication });
          return { asset, jobId };
        },
        buildArgs: () => [Cl.uint(ASSETS[asset].id), Cl.uint(jobId)],
      });
    },
  },
  {
    name: "nayori_submit_work",
    description:
      "WRITE (mainnet). Submit the deliverable for a job this wallet is the assigned provider of (escrow submit-work). Refused unless the job's provider is the signer and status is 1 (funded). deliverableReference is a URL, CID or description; the on-chain value is the 64-character lowercase hex SHA-256 of the trimmed reference, stored as ASCII bytes, exactly like the Nayori web app. Keep the reference so the evaluator can verify it. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ asset, jobId, deliverableReference }, deps) {
      const digest = deliverableDigestHex(deliverableReference);
      return signAndBroadcast(deps, {
        contractName: ASSETS[asset].escrow,
        functionName: "submit-work",
        async preflight(address) {
          const job = await deps.chain.getJob(asset, jobId);
          checkSubmitPreconditions({ job, signerAddress: address });
          return { asset, jobId, deliverableSha256Hex: digest, deliverableReference: deliverableReference.trim() };
        },
        buildArgs: () => [Cl.uint(jobId), Cl.buffer(deliverableBufferBytes(deliverableReference))],
      });
    },
  },
  {
    name: "nayori_client_create_job",
    description:
      "WRITE (mainnet). Act as a CLIENT: create an evaluable Nayori job on the escrow (create-job). The acceptance criteria are hashed with @perkos/agent-sdk and the on-chain description is your description plus a 'nayori-criteria-v1:<hash>' commitment, which is what lets the managed Evaluator evaluate it. Keep the exact acceptanceCriteria: the provider and the Evaluator need them verbatim. Default evaluator is the Nayori managed Evaluator. Expiry is current tenure height + expiresInTenures (default 144). Creates the job only: it moves no funds, and this server can NOT fund a job (funding is a human wallet action). The new job id is the (ok uN) result shown by nayori_tx_status. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ asset, description, acceptanceCriteria, evaluator = MANAGED_EVALUATOR, provider, expiresInTenures = EXPIRY_TENURES.default }, deps) {
      const info = ASSETS[asset];
      let committed;
      return signAndBroadcast(deps, {
        contractName: info.escrow,
        functionName: "create-job",
        async preflight(address) {
          const protocol = await deps.chain.getProtocolConfig(asset);
          checkCreateJobPreconditions({ signerAddress: address, evaluator, provider, protocol });
          const prepared = await commitmentsOf(deps).prepareEvaluationJob({
            network: NETWORK, asset, contract: `${DEPLOYER}.${info.escrow}`, client: address, evaluator, description, acceptanceCriteria,
          });
          assertCommittedDescription({ plainDescription: description, prepared });
          const tenureHeight = await deps.chain.getTenureHeight();
          const expiredAt = computeExpiredAt(tenureHeight, expiresInTenures);
          committed = { description: prepared.description, expiredAt };
          return {
            asset, client: address, evaluator, provider: provider ?? null,
            criteriaHash: prepared.criteriaHash,
            committedDescription: prepared.description,
            description,
            acceptanceCriteria,
            tenureHeight, expiresInTenures, expiredAt,
            next: "After confirmation read the job id from nayori_tx_status (ok uN), then nayori_client_set_budget. Funding is done by a human wallet.",
          };
        },
        buildArgs: () => [
          provider ? Cl.some(Cl.principal(provider)) : Cl.none(),
          Cl.principal(evaluator),
          Cl.uint(committed.expiredAt),
          Cl.stringAscii(committed.description),
        ],
      });
    },
  },
  {
    name: "nayori_client_set_budget",
    description:
      "WRITE (mainnet). Act as a CLIENT: declare the budget of a job you created (escrow set-budget). amount is in atomic units: sats for sbtc, microSTX for stx. This only records a number; it does NOT pay anything. Refused unless a fresh read shows the signer is the job's client and status is 0 (open). Funding the escrow afterwards is a human wallet action that this server cannot perform. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ asset, jobId, amount }, deps) {
      return signAndBroadcast(deps, {
        contractName: ASSETS[asset].escrow,
        functionName: "set-budget",
        async preflight(address) {
          const job = await deps.chain.getJob(asset, jobId);
          checkSetBudgetPreconditions({ job, signerAddress: address });
          return { asset, jobId, amount: String(amount), amountUnit: ASSETS[asset].unit, next: "A human wallet must now fund the job (fund-job). This server cannot." };
        },
        buildArgs: () => [Cl.uint(jobId), Cl.uint(amount)],
      });
    },
  },
  {
    name: "nayori_appeal_decision",
    description:
      "WRITE (mainnet). Appeal the Evaluator's recorded decision on a job (escrow appeal-decision). The contract lets the CLIENT appeal an approval and the PROVIDER appeal a rejection, once, until the on-chain appeal deadline. It moves no funds and costs no extra service fee: it marks the job disputed so the pinned human appeal authority can resolve it (which settles the escrow immediately); if the authority never answers, the original decision stands. Only the SHA-256 of appealReference goes on-chain. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ asset, jobId, appealReference }, deps) {
      const bytes = appealEvidenceBytes(appealReference);
      return signAndBroadcast(deps, {
        contractName: ASSETS[asset].escrow,
        functionName: "appeal-decision",
        async preflight(address) {
          const [job, decision, burnHeight] = await Promise.all([
            deps.chain.getJob(asset, jobId), deps.chain.getDecision(asset, jobId), deps.chain.getBurnHeight(),
          ]);
          checkAppealPreconditions({ job, decision, signerAddress: address, burnHeight });
          return {
            asset, jobId, originalDecision: decision.originalDecision === 1 ? "approve" : "reject",
            appealDeadline: decision.appealDeadline, burnHeight,
            appealEvidenceSha256Hex: Buffer.from(bytes).toString("hex"),
            next: "The pinned human appeal authority resolves the appeal from its own wallet; that settles the escrow.",
          };
        },
        buildArgs: () => [Cl.uint(jobId), Cl.buffer(bytes)],
      });
    },
  },
  {
    name: "nayori_client_assign_provider",
    description:
      "WRITE (mainnet). Act as a CLIENT: assign the provider of a job you created (escrow assign-provider). Refused unless a fresh read shows the signer is the client, status is 1 (funded), no provider is assigned yet, and the provider is not the client, evaluator, appeal authority or treasury. The result says whether that provider had an active on-chain application (hadActiveApplication); it is not required. Moves no funds. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ asset, jobId, provider }, deps) {
      return signAndBroadcast(deps, {
        contractName: ASSETS[asset].escrow,
        functionName: "assign-provider",
        async preflight(address) {
          const [job, application] = await Promise.all([deps.chain.getJob(asset, jobId), deps.chain.getApplication(asset, jobId, provider)]);
          checkAssignProviderPreconditions({ job, signerAddress: address, provider });
          return { asset, jobId, provider, hadActiveApplication: application?.active === true };
        },
        buildArgs: () => [Cl.uint(jobId), Cl.principal(provider)],
      });
    },
  },
  {
    name: "nayori_provider_submit_committed",
    description:
      "WRITE (mainnet). Act as a PROVIDER: submit work for an evaluable job with an evidence commitment (escrow submit-work). Reads the job fresh, splits its on-chain description into plain text + criteria hash, recomputes the commitments with @perkos/agent-sdk from your acceptanceCriteria and evidence, and REFUSES unless the criteria hash equals the one committed on-chain, the signer is the assigned provider and status is 1 (funded). The deliverable is 36 bytes: 'ny1:' + the 32 raw bytes of the evidence hash. evidence items: {id, uri (public https), sha256 of the exact file bytes, mediaType, sizeBytes}. Keep the exact inputs for nayori_evaluation_request. Use this instead of nayori_submit_work when the job description ends with 'nayori-criteria-v1:'. Returns a txid; broadcast is not confirmation.",
    readOnly: false,
    handler({ asset, jobId, acceptanceCriteria, evidence }, deps) {
      let deliverable;
      return signAndBroadcast(deps, {
        contractName: ASSETS[asset].escrow,
        functionName: "submit-work",
        async preflight(address) {
          const job = await deps.chain.getJob(asset, jobId);
          checkSubmitPreconditions({ job, signerAddress: address });
          const c = await recomputeCommitment(commitmentsOf(deps), { asset, job: { ...job, jobId }, provider: address, acceptanceCriteria, evidence });
          deliverable = c.deliverable;
          return {
            asset, jobId,
            criteriaHash: c.criteriaHash,
            evidenceHash: c.evidenceHash,
            deliverableHex: hex(c.deliverable),
            evaluationId: c.evaluationId,
            next: "After confirmation (status 2), build the Evaluator request with nayori_evaluation_request using the same acceptanceCriteria and evidence.",
          };
        },
        buildArgs: () => [Cl.uint(jobId), Cl.buffer(deliverable)],
      });
    },
  },
  {
    name: "nayori_evaluation_request",
    description:
      "Build the exact JSON body for the Nayori Evaluator's committed admission endpoint, POST /v1/evaluations, for a submitted job; with send:true it also posts it through Nayori's public evaluation relay and returns the answer (202 = queued, 409 = already admitted). Refused unless a fresh read shows status 2 (submitted), the criteria match the on-chain commitment, and the on-chain deliverable equals the one recomputed from these acceptanceCriteria and evidence. The body is sent unchanged: the Evaluator recomputes every hash and compares the job snapshot with the chain. Signs nothing and needs no key.",
    readOnly: true,
    async handler({ asset, jobId, acceptanceCriteria, evidence, send = false }, deps) {
      const job = await deps.chain.getJob(asset, jobId);
      checkEvaluationRequestPreconditions({ job });
      const c = await recomputeCommitment(commitmentsOf(deps), { asset, job: { ...job, jobId }, provider: job.provider, acceptanceCriteria, evidence });
      if (hex(c.deliverable) !== String(job.deliverableHex).toLowerCase()) {
        throw new RailError("Refused: the deliverable on-chain is not the evidence commitment recomputed from these inputs. Use exactly the evidence that was submitted.");
      }
      const body = {
        commitmentVersion: "1",
        evaluationId: c.evaluationId,
        network: NETWORK,
        asset,
        contract: c.contract,
        jobId: c.jobId,
        job: {
          client: job.client,
          provider: job.provider,
          evaluator: job.evaluator,
          status: "submitted",
          reviewDeadlineBurn: String(job.reviewDeadline),
          description: job.description,
        },
        acceptanceCriteria,
        evidence,
      };
      let delivery = { sent: false };
      if (send) {
        const relay = (deps.env?.NAYORI_EVALUATION_RELAY ?? EVALUATION_RELAY).trim();
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
        statusPath: `/v1/evaluations/${c.evaluationId}`,
        evaluatorMatchesManaged: job.evaluator === MANAGED_EVALUATOR,
        note: "Admission also requires: evaluator = the managed Evaluator, budget at or above the Evaluator's minimum, escrow balance = budget, no decision yet, review window still open, evidence hosted on an origin the Evaluator allows (nayori.ai/job-evidence, raw.githubusercontent.com, gist.githubusercontent.com). See README.",
      };
    },
  },
  {
    name: "nayori_tx_status",
    description: "Check a Stacks mainnet transaction by txid: pending, success, or an abort status, plus the Clarity result. Use after any write tool. Read-only.",
    readOnly: true,
    handler({ txid }, { chain }) {
      return chain.getTxStatus(txid).then((s) => ({ ...s, explorerUrl: `${EXPLORER_TX}/${s.txid}?chain=mainnet` }));
    },
  },
].map((t) => ({ ...t, inputShape: shapes[t.name] }));
