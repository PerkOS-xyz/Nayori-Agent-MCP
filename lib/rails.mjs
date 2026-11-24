// Hard safety rails. Everything in this file is a compile-time constant or a pure
// function. Nothing here is configurable through tool input. The runtime knobs are env only:
// the network (NAYORI_AGENT_NETWORK, mainnet unless set to testnet), the fee
// (NAYORI_AGENT_FEE_USTX, capped) and the application deposit cap
// (NAYORI_AGENT_MAX_DEPOSIT_SATS, capped at the contract maximum).
//
// Audit checklist:
//   1. PROFILES holds the only two networks. resolveProfile() picks one from the env and
//      defaults to mainnet; the transaction builder only ever receives that profile's network.
//   2. CONTRACT_NAMES is the complete contract set: the seven Nayori contracts live since
//      2026-11-24, all under the profile's deployer (the deployer has no powers; roles are
//      pinned per job in nayori-roles).
//   3. WRITE_ALLOWLIST is the complete (contract, function) allowlist. The escrows allow
//      create-job, name-provider, accept-job, submit-work and appeal: none of them moves an
//      asset. fund-job (the only call that moves a budget into escrow), record-decision,
//      record-default-approval, resolve-appeal, settle-job, refund-no-delivery and
//      close-unfunded are deliberately NOT here: funding and settlement stay off the agent side.
//   4. buildCallOptions() is the single place transaction options are produced. It always
//      sets PostConditionMode.Deny, and the post-condition list comes from
//      railPostConditions() only:
//        apply-to-job: the signer sends EXACTLY the deposit in sBTC (capped by
//                      NAYORI_AGENT_MAX_DEPOSIT_SATS) and the applications contract sends AT
//                      MOST the deposit (the refund of a displaced lower application);
//        withdraw:     the applications contract sends EXACTLY the recorded deposit back;
//        every other allowed call: an EMPTY list, so the chain aborts any transaction that
//                      would move STX, a fungible token or an NFT out of the signer wallet.
//      So the wallet can lose the fee and, when it applies, a refundable application deposit.
//   5. No function in this package builds a token transfer or a contract deploy.

import { createHash } from "node:crypto";
import { PostConditionMode, Pc, postConditionToWire, serializePostConditionWire, addressToString } from "@stacks/transactions";

export const PROFILES = Object.freeze({
  mainnet: Object.freeze({
    network: "mainnet",
    transactionVersion: 0x00,
    chainId: 0x00000001,
    addressPrefix: "SP",
    hiroApi: "https://api.hiro.so",
    deployer: "SP2BM4WCNQM286PFHPGA1BG2YXER0PCG1PKQ5MF1X",
    sbtcToken: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    sbtcAssetName: "sbtc-token",
    // The Nayori managed Evaluator (default evaluator of nayori_client_create_job).
    managedEvaluator: "SP3GRG5CKEFNYM5BV0NPPHCM51FT176JQ02QWQ9T3",
    // Nayori's public evaluation relay: forwards the body unchanged to the private Evaluator.
    evaluationRelay: "https://app.nayori.ai/api/evaluations",
  }),
  testnet: Object.freeze({
    network: "testnet",
    transactionVersion: 0x80,
    chainId: 0x80000000,
    addressPrefix: "ST",
    hiroApi: "https://api.testnet.hiro.so",
    deployer: "ST3MRPNX0VNWYRSJ07PNTASE5BZ9K5XE57ARZ39DY",
    sbtcToken: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token",
    sbtcAssetName: "sbtc-token",
    managedEvaluator: "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4",
    evaluationRelay: "https://qa.nayori.ai/api/evaluations",
  }),
});

export const EXPLORER_TX = "https://explorer.hiro.so/txid";

export const CONTRACT_NAMES = Object.freeze({
  agents: "nayori-agents",
  applications: "nayori-applications",
  escrowSbtc: "nayori-escrow-sbtc",
  escrowStx: "nayori-escrow-stx",
  reputation: "nayori-reputation",
  roles: "nayori-roles",
  permissions: "nayori-permissions",
});

export const ESCROW_BY_ASSET = Object.freeze({ sbtc: CONTRACT_NAMES.escrowSbtc, stx: CONTRACT_NAMES.escrowStx });
export const ASSET_UNITS = Object.freeze({ sbtc: "sats", stx: "microSTX" });

const ESCROW_WRITES = Object.freeze(["create-job", "name-provider", "accept-job", "submit-work", "appeal"]);
export const WRITE_ALLOWLIST = Object.freeze({
  [CONTRACT_NAMES.agents]: Object.freeze(["register"]),
  [CONTRACT_NAMES.applications]: Object.freeze(["apply-to-job", "withdraw"]),
  [CONTRACT_NAMES.escrowSbtc]: ESCROW_WRITES,
  [CONTRACT_NAMES.escrowStx]: ESCROW_WRITES,
});

/** Bounds fixed in the contracts (Bitcoin blocks for windows). */
export const LIMITS = Object.freeze({
  budget: Object.freeze({
    sbtc: Object.freeze({ min: 1_000, max: 100_000_000 }),
    stx: Object.freeze({ min: 1_000_000, max: 100_000_000_000 }),
  }),
  deliveryBlocks: Object.freeze({ min: 144, max: 4_320, default: 144 }),
  reviewBlocks: Object.freeze({ min: 12, max: 1_008, default: 144 }),
  deposit: Object.freeze({ min: 100, max: 1_000_000 }),
  maxApplications: 50,
  agentName: 64,
  agentUri: 256,
  description: 512,
});

/** Statuses in which a job still takes applications (nayori-applications `accepting`). */
export const ACCEPTING = Object.freeze(["open", "funded", "offered"]);

export const DEFAULT_FEE_USTX = 3000n;
export const MAX_FEE_USTX = 50000n;
export const DEFAULT_MAX_DEPOSIT_SATS = 10_000n;

export class RailError extends Error {
  constructor(message) {
    super(message);
    this.name = "RailError";
  }
}

/** mainnet unless NAYORI_AGENT_NETWORK is exactly "testnet". */
export function resolveProfile(env = process.env) {
  const raw = env.NAYORI_AGENT_NETWORK;
  if (raw === undefined || raw === "" || raw === "mainnet") return PROFILES.mainnet;
  if (raw === "testnet") return PROFILES.testnet;
  throw new RailError('NAYORI_AGENT_NETWORK must be "mainnet" (the default) or "testnet".');
}

/** Full contract ids of the seven Nayori contracts on a profile. */
export function contractIds(profile = PROFILES.mainnet) {
  return Object.freeze(Object.fromEntries(Object.entries(CONTRACT_NAMES).map(([k, name]) => [k, `${profile.deployer}.${name}`])));
}

export function escrowId(profile, asset) {
  const name = ESCROW_BY_ASSET[asset];
  if (!name) throw new RailError(`Refused: unknown asset ${String(asset)}.`);
  return `${profile.deployer}.${name}`;
}

/** Throws unless (contractAddress, contractName, functionName) is on the write allowlist. */
export function assertAllowedCall(contractAddress, contractName, functionName, profile = PROFILES.mainnet) {
  if (contractAddress !== profile.deployer) {
    throw new RailError(`Refused: contract deployer ${String(contractAddress)} is not the Nayori deployer on ${profile.network}.`);
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

/** Largest application deposit the agent may put up, in sats. Default 10000, never above the contract maximum. */
export function resolveMaxDeposit(env = process.env) {
  const raw = env.NAYORI_AGENT_MAX_DEPOSIT_SATS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_DEPOSIT_SATS;
  if (!/^[0-9]{1,9}$/.test(raw)) throw new RailError("NAYORI_AGENT_MAX_DEPOSIT_SATS must be a whole number of sats.");
  const cap = BigInt(raw);
  if (cap < BigInt(LIMITS.deposit.min) || cap > BigInt(LIMITS.deposit.max)) {
    throw new RailError(`NAYORI_AGENT_MAX_DEPOSIT_SATS must be ${LIMITS.deposit.min} to ${LIMITS.deposit.max} sats.`);
  }
  return cap;
}

function depositAmount(amount, max) {
  let value;
  try {
    value = BigInt(amount);
  } catch {
    throw new RailError("Refused: the deposit is not a whole number of sats.");
  }
  if (value < BigInt(LIMITS.deposit.min) || value > max) {
    throw new RailError(`Refused: the deposit ${value} sats is outside ${LIMITS.deposit.min}..${max} sats.`);
  }
  return value;
}

/**
 * The ONLY source of post-conditions. `sender` is the signer address, `amount` the deposit in
 * sats read fresh from the chain or given by the agent, `maxDeposit` the env cap.
 */
export function railPostConditions(profile, { contractName, functionName, sender, amount, maxDeposit = DEFAULT_MAX_DEPOSIT_SATS }) {
  const applications = `${profile.deployer}.${CONTRACT_NAMES.applications}`;
  if (contractName === CONTRACT_NAMES.applications && functionName === "apply-to-job") {
    if (typeof sender !== "string" || !sender.startsWith(profile.addressPrefix)) {
      throw new RailError("Refused: the apply-to-job post-condition needs the signer address.");
    }
    const deposit = depositAmount(amount, maxDeposit);
    return [
      Pc.principal(sender).willSendEq(deposit).ft(profile.sbtcToken, profile.sbtcAssetName),
      Pc.principal(applications).willSendLte(deposit).ft(profile.sbtcToken, profile.sbtcAssetName),
    ];
  }
  if (contractName === CONTRACT_NAMES.applications && functionName === "withdraw") {
    // The refund goes back to the signer; the contract maximum is the only bound needed.
    const deposit = depositAmount(amount, BigInt(LIMITS.deposit.max));
    return [Pc.principal(applications).willSendEq(deposit).ft(profile.sbtcToken, profile.sbtcAssetName)];
  }
  return [];
}

const wireHex = (postConditions) => postConditions.map((pc) => serializePostConditionWire(postConditionToWire(pc)));

/**
 * The single producer of transaction options. The caller adds only the signing key.
 * `planPostConditions`, when given (the SDK's plan), must equal the rail post-conditions byte
 * for byte, or nothing is signed.
 */
export function buildCallOptions(
  { contractAddress, contractName, functionName, functionArgs, nonce, fee, sender, amount, maxDeposit, planPostConditions },
  profile = PROFILES.mainnet
) {
  assertAllowedCall(contractAddress ?? profile.deployer, contractName, functionName, profile);
  if (!Array.isArray(functionArgs)) throw new RailError("functionArgs must be an array.");
  const feeValue = BigInt(fee);
  if (feeValue <= 0n || feeValue > MAX_FEE_USTX) {
    throw new RailError(`Refused: fee ${feeValue} is outside 1..${MAX_FEE_USTX} microSTX.`);
  }
  const nonceValue = BigInt(nonce);
  if (nonceValue < 0n) throw new RailError("Refused: negative nonce.");
  const postConditions = railPostConditions(profile, { contractName, functionName, sender, amount, maxDeposit });
  if (planPostConditions !== undefined) {
    const a = wireHex(postConditions);
    const b = Array.isArray(planPostConditions) ? wireHex(planPostConditions) : null;
    if (!b || a.length !== b.length || a.some((hex, i) => hex !== b[i])) {
      throw new RailError("Refused: the SDK plan's post-conditions differ from the rail post-conditions.");
    }
  }
  return {
    contractAddress: profile.deployer,
    contractName,
    functionName,
    functionArgs,
    network: profile.network,
    fee: feeValue,
    nonce: nonceValue,
    postConditionMode: PostConditionMode.Deny,
    postConditions,
    validateWithAbi: false,
  };
}

/** Belt and braces: inspect a built transaction before it is broadcast. */
export function assertTransactionIsSafe(tx, expected, profile = PROFILES.mainnet) {
  const payload = tx.payload;
  const problems = [];
  if (tx.postConditionMode !== PostConditionMode.Deny) problems.push("post-condition mode is not Deny");
  const actual = (tx.postConditions?.values ?? null)?.map((w) => serializePostConditionWire(w));
  const wanted = wireHex(expected.postConditions ?? []);
  if (!actual || actual.length !== wanted.length || actual.some((hex, i) => hex !== wanted[i])) {
    problems.push("post-conditions are not the rail post-conditions");
  }
  if (tx.transactionVersion !== profile.transactionVersion || tx.chainId !== profile.chainId) {
    problems.push(`transaction version is not ${profile.network}`);
  }
  // Payload type 2 = contract call.
  if (payload?.payloadType !== 2) problems.push("payload is not a contract call");
  let address = null;
  try {
    address = addressToString(payload.contractAddress);
  } catch {
    problems.push("payload contract address is unreadable");
  }
  const name = payload?.contractName?.content;
  const fn = payload?.functionName?.content;
  if (name !== expected.contractName || fn !== expected.functionName) problems.push("payload target mismatch");
  try {
    assertAllowedCall(address, name, fn, profile);
  } catch {
    problems.push("payload target is not on the allowlist");
  }
  const fee = BigInt(tx.auth?.spendingCondition?.fee ?? -1);
  if (fee <= 0n || fee > MAX_FEE_USTX) problems.push("fee outside the cap");
  if (problems.length) throw new RailError(`Refused to broadcast: ${problems.join("; ")}.`);
}

// ---------------------------------------------------------------------------
// Pre-sign state checks (pure; the caller supplies freshly read chain state, shaped by
// lib/chain.mjs: status labels, numeric heights, string amounts).
// ---------------------------------------------------------------------------

const need = (job, statuses, action) => {
  if (!statuses.includes(job.status)) {
    throw new RailError(`Refused: the job is ${job.status}; ${action} needs ${statuses.join(" or ")}.`);
  }
};
const beforeDeadline = (job, burnHeight, action) => {
  if (!(Number.isSafeInteger(burnHeight) && burnHeight > 0)) throw new RailError("Refused: the Bitcoin block height is not available.");
  if (burnHeight >= job.deliveryDeadline) {
    throw new RailError(`Refused: the job deadline (Bitcoin block ${job.deliveryDeadline}) has passed; ${action} is no longer possible.`);
  }
};
const PROTOCOL_ROLES = ["client", "evaluator", "treasury", "appealAuthority"];

export function checkRegisterPreconditions({ existingAgent }) {
  if (existingAgent) {
    throw new RailError(`Refused: this wallet already has an agent ("${existingAgent.name}"). nayori-agents allows one agent per wallet.`);
  }
}

export function checkApplyPreconditions({ job, agent, signerAddress, existingApplication, applications, deposit, burnHeight, sbtcBalance }) {
  if (!job) throw new RailError("Refused: sBTC job not found.");
  need(job, ACCEPTING, "an application");
  beforeDeadline(job, burnHeight, "applying");
  for (const role of PROTOCOL_ROLES) {
    if (job[role] === signerAddress) throw new RailError(`Refused: the signer is the ${role} of this job and cannot apply to it.`);
  }
  if (!agent) throw new RailError("Refused: this wallet has no agent in nayori-agents. Register first with nayori_register_agent.");
  if (existingApplication) throw new RailError("Refused: this wallet already applied to the job.");
  const list = applications ?? [];
  if (list.length >= LIMITS.maxApplications) {
    const lowest = list.reduce((min, a) => (BigInt(a.deposit) < min ? BigInt(a.deposit) : min), BigInt(list[0].deposit));
    if (BigInt(deposit) <= lowest) {
      throw new RailError(`Refused: the list is full (${LIMITS.maxApplications}) and the deposit must beat the lowest entry of ${lowest} sats.`);
    }
  }
  if (sbtcBalance !== undefined && sbtcBalance !== null && BigInt(sbtcBalance) < BigInt(deposit)) {
    throw new RailError(`Refused: the wallet holds ${sbtcBalance} sats of sBTC, less than the ${deposit} sats deposit.`);
  }
}

export function checkWithdrawPreconditions({ existingApplication }) {
  if (!existingApplication) throw new RailError("Refused: no application from this wallet on that job.");
}

export function checkAcceptPreconditions({ job, signerAddress, burnHeight }) {
  if (!job) throw new RailError("Refused: job not found.");
  need(job, ["offered"], "accept-job");
  if (job.provider !== signerAddress) throw new RailError("Refused: the job is offered to another provider, not to the signer.");
  beforeDeadline(job, burnHeight, "accepting");
}

export function checkSubmitPreconditions({ job, signerAddress, burnHeight }) {
  if (!job) throw new RailError("Refused: job not found.");
  if (job.provider !== signerAddress) throw new RailError("Refused: the signer is not the provider of this job.");
  if (job.status === "offered") throw new RailError("Refused: the job is offered but not accepted yet. Accept it first with nayori_accept_job.");
  need(job, ["accepted"], "submit-work");
  beforeDeadline(job, burnHeight, "delivering");
}

/** roles = { treasury, appealAuthority } read fresh from nayori-roles. */
export function checkCreateJobPreconditions({ signerAddress, evaluator, roles }) {
  if (evaluator === signerAddress) throw new RailError("Refused: the evaluator must differ from the signer (the client).");
  if (!roles?.treasury || !roles?.appealAuthority) throw new RailError("Refused: the Nayori roles (treasury, appeal authority) could not be read.");
  for (const role of ["treasury", "appealAuthority"]) {
    if (roles[role] === signerAddress) throw new RailError(`Refused: the signer is the ${role} and cannot be a client.`);
    if (roles[role] === evaluator) throw new RailError(`Refused: the evaluator is the ${role}.`);
  }
}

export function checkBudget(asset, budget) {
  const bounds = LIMITS.budget[asset];
  if (!bounds) throw new RailError(`Refused: unknown asset ${String(asset)}.`);
  if (!Number.isSafeInteger(budget) || budget < bounds.min || budget > bounds.max) {
    throw new RailError(`Refused: the ${asset} budget must be ${bounds.min} to ${bounds.max} ${ASSET_UNITS[asset]}.`);
  }
}

export function checkNameProviderPreconditions({ job, signerAddress, provider }) {
  if (!job) throw new RailError("Refused: job not found.");
  if (job.client !== signerAddress) throw new RailError("Refused: the signer is not the client of this job.");
  need(job, ["funded", "offered"], "name-provider");
  for (const role of PROTOCOL_ROLES) {
    if (job[role] === provider) throw new RailError(`Refused: the provider is the ${role} of this job.`);
  }
  if (job.status === "offered" && job.provider === provider) throw new RailError("Refused: the job is already offered to that provider.");
}

export function checkEvaluationRequestPreconditions({ job, submission, burnHeight }) {
  if (!job) throw new RailError("Refused: job not found.");
  need(job, ["submitted"], "an evaluation request");
  if (!job.provider || !submission?.deliverableHex || !submission?.reviewDeadline) {
    throw new RailError("Refused: the submitted job has no provider, deliverable or review deadline on-chain.");
  }
  if (Number.isSafeInteger(burnHeight) && burnHeight > submission.reviewDeadline) {
    throw new RailError(`Refused: the review window closed at Bitcoin block ${submission.reviewDeadline}; the job is approved by default.`);
  }
}

// appeal moves no funds: it only flags a recorded decision as disputed so the job's pinned
// appeal authority can resolve it. The contract lets the CLIENT appeal an approval and the
// PROVIDER appeal a rejection, once, until the on-chain appeal deadline (Bitcoin block).
export function checkAppealPreconditions({ job, decision, signerAddress, burnHeight }) {
  if (!job) throw new RailError("Refused: job not found.");
  need(job, ["decided"], "an appeal");
  if (!decision) throw new RailError("Refused: no decision recorded for this job.");
  const appellant = decision.decision === "approve" ? job.client : job.provider;
  if (appellant !== signerAddress) {
    throw new RailError(`Refused: only the ${decision.decision === "approve" ? "client may appeal an approval" : "provider may appeal a rejection"}, and the signer is not that party.`);
  }
  if (!(Number.isSafeInteger(burnHeight) && burnHeight > 0 && burnHeight <= decision.appealDeadline)) {
    throw new RailError("Refused: the on-chain appeal window is closed or the Bitcoin block height is unknown.");
  }
}

// ---------------------------------------------------------------------------
// Deliverable encoding for plain (not committed) submissions, as the Nayori web app does it:
//   digest = lowercase hex of SHA-256( UTF-8( reference.trim() ) )   -> 64 hex characters
//   deliverable = the 64 ASCII bytes of that digest                  -> (buff 64)
// Reading `deliverable` back as ASCII yields the hex digest.
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

/** SHA-256 of the trimmed appeal reference, as 32 raw bytes. */
export function appealEvidenceBytes(reference) {
  const trimmed = String(reference).trim();
  if (!trimmed) throw new RailError("appealReference is empty.");
  return new Uint8Array(createHash("sha256").update(Buffer.from(trimmed, "utf8")).digest());
}
