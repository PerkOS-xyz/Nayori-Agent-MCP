// Hard safety rails. Everything in this file is a compile-time constant or a pure
// function. Nothing here is configurable through tool input. The only runtime knob is the
// fee (env NAYORI_AGENT_FEE_USTX), and it is capped.
//
// Audit checklist:
//   1. NETWORK is mainnet and is the only network the transaction builder ever receives.
//   2. CONTRACTS is the complete contract allowlist (one deployer, four contract names).
//   3. WRITE_ALLOWLIST is the complete (contract, function) allowlist: seven function
//      names. The escrows allow exactly create-job, set-budget, assign-provider and
//      submit-work. NONE of them moves an asset: create-job and assign-provider write job
//      metadata, set-budget writes a number (it declares the budget, it does not pay it).
//      fund-job, the only client call that moves STX or sBTC into escrow, is deliberately
//      NOT here: funding stays a human wallet action. Decisions (record-decision,
//      finalize-decision, appeals) are not here either.
//   4. buildCallOptions() is the single place transaction options are produced. It always
//      sets PostConditionMode.Deny with an EMPTY post-condition list, so the chain aborts
//      any transaction that would move STX, a fungible token or an NFT out of the signer
//      wallet. The only thing the wallet can ever lose is the fee.
//   5. No function in this package builds a token transfer or a contract deploy.
//   6. create-job expiry is computed by computeExpiredAt() from the chain TENURE height
//      (the escrows are Clarity 2, so their `block-height` is the tenure height on current
//      mainnet), never from the Stacks block height, and the window is bounded.

import { createHash } from "node:crypto";
import { PostConditionMode } from "@stacks/transactions";

export const NETWORK = "mainnet";
export const HIRO_API = "https://api.hiro.so";
export const EXPLORER_TX = "https://explorer.hiro.so/txid";

export const DEPLOYER = "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH";

export const CONTRACTS = Object.freeze({
  registry: "agent-registry",
  sbtcEscrow: "sbtc-commerce-v5",
  stxEscrow: "agentic-commerce-v6",
  applications: "job-applications-v1",
});

export const CONTRACT_IDS = Object.freeze(
  Object.fromEntries(Object.entries(CONTRACTS).map(([k, name]) => [k, `${DEPLOYER}.${name}`]))
);

// Asset ids used by job-applications-v1 (ASSET_STX u1, ASSET_SBTC u2).
export const ASSETS = Object.freeze({
  stx: Object.freeze({ id: 1, escrow: CONTRACTS.stxEscrow, unit: "microSTX" }),
  sbtc: Object.freeze({ id: 2, escrow: CONTRACTS.sbtcEscrow, unit: "sats" }),
});

export const WRITE_ALLOWLIST = Object.freeze({
  [CONTRACTS.registry]: Object.freeze(["register-agent"]),
  [CONTRACTS.applications]: Object.freeze(["apply-to-job", "withdraw-application"]),
  [CONTRACTS.sbtcEscrow]: Object.freeze(["create-job", "set-budget", "assign-provider", "submit-work", "appeal-decision"]),
  [CONTRACTS.stxEscrow]: Object.freeze(["create-job", "set-budget", "assign-provider", "submit-work", "appeal-decision"]),
});

// The Nayori managed Evaluator on mainnet (default evaluator of nayori_client_create_job).
export const MANAGED_EVALUATOR = "SP3GRG5CKEFNYM5BV0NPPHCM51FT176JQ02QWQ9T3";
// Nayori's public evaluation relay: app.nayori.ai forwards the body unchanged to the private Evaluator.
export const EVALUATION_RELAY = "https://app.nayori.ai/api/evaluations";

// create-job expiry window, in tenures (about one Bitcoin block each).
export const EXPIRY_TENURES = Object.freeze({ default: 144, min: 12, max: 4320 });

export const JOB_STATUS = Object.freeze({
  0: "open",
  1: "funded",
  2: "submitted",
  3: "completed",
  4: "rejected",
  5: "expired",
  6: "timeout-paid",
  7: "decision-pending",
  8: "disputed",
});

export const DEFAULT_FEE_USTX = 3000n;
export const MAX_FEE_USTX = 50000n;

export class RailError extends Error {
  constructor(message) {
    super(message);
    this.name = "RailError";
  }
}

/** Throws unless (contractAddress, contractName, functionName) is on the write allowlist. */
export function assertAllowedCall(contractAddress, contractName, functionName) {
  if (contractAddress !== DEPLOYER) {
    throw new RailError(`Refused: contract deployer ${String(contractAddress)} is not the Nayori deployer.`);
  }
  if (!Object.hasOwn(WRITE_ALLOWLIST, contractName)) {
    throw new RailError(`Refused: contract ${String(contractName)} is not on the allowlist.`);
  }
  if (!WRITE_ALLOWLIST[contractName].includes(functionName)) {
    throw new RailError(`Refused: function ${String(functionName)} is not allowed on ${contractName}.`);
  }
}

/** Fee in microSTX. Default 3000, overridable only by env, never above 50000. */
export function resolveFee(env = process.env) {
  const raw = env.NAYORI_AGENT_FEE_USTX;
  if (raw === undefined || raw === "") return DEFAULT_FEE_USTX;
  if (!/^[0-9]{1,9}$/.test(raw)) {
    throw new RailError("NAYORI_AGENT_FEE_USTX must be a positive integer number of microSTX.");
  }
  const fee = BigInt(raw);
  if (fee <= 0n) throw new RailError("NAYORI_AGENT_FEE_USTX must be greater than zero.");
  if (fee > MAX_FEE_USTX) {
    throw new RailError(`NAYORI_AGENT_FEE_USTX ${fee} exceeds the hard cap of ${MAX_FEE_USTX} microSTX.`);
  }
  return fee;
}

/**
 * The single producer of transaction options. The caller adds only the signing key.
 * contractAddress is accepted so the allowlist check covers it, but the output always
 * uses the pinned DEPLOYER.
 */
export function buildCallOptions({ contractAddress = DEPLOYER, contractName, functionName, functionArgs, nonce, fee }) {
  assertAllowedCall(contractAddress, contractName, functionName);
  if (!Array.isArray(functionArgs)) throw new RailError("functionArgs must be an array.");
  const feeValue = BigInt(fee);
  if (feeValue <= 0n || feeValue > MAX_FEE_USTX) {
    throw new RailError(`Refused: fee ${feeValue} is outside 1..${MAX_FEE_USTX} microSTX.`);
  }
  const nonceValue = BigInt(nonce);
  if (nonceValue < 0n) throw new RailError("Refused: negative nonce.");
  return {
    contractAddress: DEPLOYER,
    contractName,
    functionName,
    functionArgs,
    network: NETWORK,
    fee: feeValue,
    nonce: nonceValue,
    postConditionMode: PostConditionMode.Deny,
    postConditions: [],
    validateWithAbi: false,
  };
}

/** Belt and braces: inspect a built transaction before it is broadcast. */
export function assertTransactionIsSafe(tx, expected) {
  const payload = tx.payload;
  const problems = [];
  if (tx.postConditionMode !== PostConditionMode.Deny) problems.push("post-condition mode is not Deny");
  if ((tx.postConditions?.values?.length ?? -1) !== 0) problems.push("post-condition list is not empty");
  // Transaction version 0x00 and chain id 0x00000001 = mainnet.
  if (tx.transactionVersion !== 0 || tx.chainId !== 1) problems.push("transaction version is not mainnet");
  // Payload type 2 = contract call.
  if (payload?.payloadType !== 2) problems.push("payload is not a contract call");
  const name = payload?.contractName?.content;
  const fn = payload?.functionName?.content;
  if (name !== expected.contractName || fn !== expected.functionName) problems.push("payload target mismatch");
  try {
    assertAllowedCall(DEPLOYER, name, fn);
  } catch {
    problems.push("payload target is not on the allowlist");
  }
  const fee = BigInt(tx.auth?.spendingCondition?.fee ?? -1);
  if (fee <= 0n || fee > MAX_FEE_USTX) problems.push("fee outside the cap");
  if (problems.length) throw new RailError(`Refused to broadcast: ${problems.join("; ")}.`);
}

// ---------------------------------------------------------------------------
// Pre-sign state checks (pure; the caller supplies freshly read chain state).
// ---------------------------------------------------------------------------

/** job/agent are plain objects as produced by lib/chain.mjs. */
export function checkApplyPreconditions({ job, agent, signerAddress, existingApplication }) {
  if (!job) throw new RailError("Refused: job not found.");
  if (job.status !== 0 && job.status !== 1) {
    throw new RailError(`Refused: job status is ${job.status} (${JOB_STATUS[job.status] ?? "unknown"}); applications need 0 (open) or 1 (funded).`);
  }
  if (job.provider) throw new RailError("Refused: the job already has a provider assigned.");
  for (const role of ["client", "evaluator", "appealAuthority", "treasury"]) {
    if (job[role] === signerAddress) {
      throw new RailError(`Refused: the signer is the ${role} of this job and cannot apply to it.`);
    }
  }
  if (!agent) throw new RailError("Refused: agent id not found in the registry.");
  if (agent.wallet !== signerAddress) {
    throw new RailError("Refused: the agent's registered wallet is not the signer address.");
  }
  if (agent.active !== true) throw new RailError("Refused: the agent is not active.");
  if (existingApplication?.active === true) {
    throw new RailError("Refused: this address already has an active application for the job.");
  }
}

export function checkSubmitPreconditions({ job, signerAddress }) {
  if (!job) throw new RailError("Refused: job not found.");
  if (job.provider !== signerAddress) {
    throw new RailError("Refused: the signer is not the assigned provider of this job.");
  }
  if (job.status !== 1) {
    throw new RailError(`Refused: job status is ${job.status} (${JOB_STATUS[job.status] ?? "unknown"}); submit-work needs 1 (funded).`);
  }
}

/**
 * expired-at for create-job = current TENURE height + window. `tenureHeight` must be the
 * `tenure_height` field of /v2/info. The Stacks block height is a much larger number
 * (several blocks per tenure); using it would create a job that never expires in practice.
 */
export function computeExpiredAt(tenureHeight, expiresInTenures = EXPIRY_TENURES.default) {
  if (!Number.isSafeInteger(tenureHeight) || tenureHeight <= 0) {
    throw new RailError("Refused: the current tenure height is not available.");
  }
  if (!Number.isSafeInteger(expiresInTenures) || expiresInTenures < EXPIRY_TENURES.min || expiresInTenures > EXPIRY_TENURES.max) {
    throw new RailError(`Refused: expiresInTenures must be ${EXPIRY_TENURES.min}..${EXPIRY_TENURES.max}.`);
  }
  return tenureHeight + expiresInTenures;
}

/** protocol = { appealAuthority, treasury } read fresh from the escrow (get-protocol-config). */
export function checkCreateJobPreconditions({ signerAddress, evaluator, provider, protocol }) {
  if (evaluator === signerAddress) throw new RailError("Refused: the evaluator must differ from the signer (the client).");
  if (provider && provider === signerAddress) throw new RailError("Refused: the provider must differ from the signer (the client).");
  if (provider && provider === evaluator) throw new RailError("Refused: the evaluator must differ from the provider.");
  if (!protocol?.appealAuthority || !protocol?.treasury) {
    throw new RailError("Refused: the escrow protocol configuration could not be read.");
  }
  for (const role of ["appealAuthority", "treasury"]) {
    if (protocol[role] === signerAddress) throw new RailError(`Refused: the signer is the escrow ${role} and cannot be a client.`);
    if (protocol[role] === evaluator) throw new RailError(`Refused: the evaluator is the escrow ${role}.`);
    if (provider && protocol[role] === provider) throw new RailError(`Refused: the provider is the escrow ${role}.`);
  }
}

export function checkSetBudgetPreconditions({ job, signerAddress }) {
  if (!job) throw new RailError("Refused: job not found.");
  if (job.client !== signerAddress) throw new RailError("Refused: the signer is not the client of this job.");
  if (job.status !== 0) {
    throw new RailError(`Refused: job status is ${job.status} (${JOB_STATUS[job.status] ?? "unknown"}); set-budget needs 0 (open).`);
  }
}

export function checkAssignProviderPreconditions({ job, signerAddress, provider }) {
  if (!job) throw new RailError("Refused: job not found.");
  if (job.client !== signerAddress) throw new RailError("Refused: the signer is not the client of this job.");
  if (job.status !== 1) {
    throw new RailError(`Refused: job status is ${job.status} (${JOB_STATUS[job.status] ?? "unknown"}); assign-provider needs 1 (funded).`);
  }
  if (job.provider) throw new RailError("Refused: the job already has a provider assigned.");
  for (const role of ["client", "evaluator", "appealAuthority", "treasury"]) {
    if (job[role] === provider) throw new RailError(`Refused: the provider is the ${role} of this job.`);
  }
}

export function checkEvaluationRequestPreconditions({ job }) {
  if (!job) throw new RailError("Refused: job not found.");
  if (job.status !== 2) {
    throw new RailError(`Refused: job status is ${job.status} (${JOB_STATUS[job.status] ?? "unknown"}); an evaluation request needs 2 (submitted).`);
  }
  if (!job.provider || !job.deliverableHex || !job.reviewDeadline) {
    throw new RailError("Refused: the submitted job has no provider, deliverable or review deadline on-chain.");
  }
}

export function checkWithdrawPreconditions({ existingApplication }) {
  if (existingApplication?.active !== true) {
    throw new RailError("Refused: no active application from this address for that job.");
  }
}

// ---------------------------------------------------------------------------
// Deliverable encoding, mirrored from the production web app
// (App/src/app/jobs/page.tsx handleSubmitWork + sha256Ascii, and
//  App/src/services/sbtc-commerce.ts submitSbtcWork):
//
//   digest = lowercase hex of SHA-256( UTF-8( reference.trim() ) )   -> 64 hex characters
//   deliverable = Cl.bufferFromAscii(digest.slice(0, 64))            -> (buff 64)
//
// So the on-chain buffer is 64 bytes holding the ASCII characters of the hex digest, NOT
// the 32 raw hash bytes. Reading `deliverable` back as ASCII yields the hex digest.
// ---------------------------------------------------------------------------

export function deliverableDigestHex(reference) {
  const trimmed = String(reference).trim();
  if (!trimmed) throw new RailError("deliverableReference is empty.");
  return createHash("sha256").update(Buffer.from(trimmed, "utf8")).digest("hex");
}

export function deliverableBufferBytes(reference) {
  const bytes = Buffer.from(deliverableDigestHex(reference).slice(0, 64), "ascii");
  if (bytes.length !== 64) throw new RailError("Deliverable buffer must be exactly 64 bytes.");
  return new Uint8Array(bytes);
}

// appeal-decision moves no funds: it only flags a recorded decision as disputed so the pinned
// human appeal authority can resolve it. The contract lets the CLIENT appeal an approval and the
// PROVIDER appeal a rejection, once, until the on-chain appeal deadline (burn height).
export function checkAppealPreconditions({ job, decision, signerAddress, burnHeight }) {
  if (!job) throw new RailError("Refused: job not found.");
  if (job.status !== 7) {
    throw new RailError(`Refused: job status is ${job.status} (${JOB_STATUS[job.status] ?? "unknown"}); an appeal needs 7 (decision-pending).`);
  }
  if (!decision) throw new RailError("Refused: no decision recorded for this job.");
  const appellant = decision.originalDecision === 1 ? job.client : job.provider;
  if (appellant !== signerAddress) {
    throw new RailError(`Refused: only the ${decision.originalDecision === 1 ? "client may appeal an approval" : "provider may appeal a rejection"}, and the signer is not that party.`);
  }
  if (!(Number.isSafeInteger(burnHeight) && burnHeight > 0 && burnHeight <= decision.appealDeadline)) {
    throw new RailError("Refused: the on-chain appeal window is closed or the burn height is unknown.");
  }
}

/** Mirrors the web app: SHA-256 of the trimmed reference, as 32 raw bytes. */
export function appealEvidenceBytes(reference) {
  const trimmed = String(reference).trim();
  if (!trimmed) throw new RailError("appealReference is empty.");
  return new Uint8Array(createHash("sha256").update(Buffer.from(trimmed, "utf8")).digest());
}
