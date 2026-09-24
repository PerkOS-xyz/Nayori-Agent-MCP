// Chain access (Hiro API, mainnet only): read-only contract calls, account state,
// broadcast of an already-signed and already-inspected transaction, and tx status.

import { Cl, ClarityType, fetchCallReadOnlyFunction, broadcastTransaction } from "@stacks/transactions";
import { NETWORK, HIRO_API, DEPLOYER, CONTRACTS, ASSETS, JOB_STATUS } from "./rails.mjs";

const TIMEOUT_MS = 20000;

async function timedFetch(input, init = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Hiro API request failed: ${lastError?.message ?? "rate limited"}`);
}

const client = { baseUrl: HIRO_API, fetch: timedFetch };

async function getJson(path) {
  const res = await timedFetch(`${HIRO_API}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Hiro API ${path} returned HTTP ${res.status}`);
  return res.json();
}

async function readOnly(contractName, functionName, functionArgs) {
  return fetchCallReadOnlyFunction({
    contractAddress: DEPLOYER,
    contractName,
    functionName,
    functionArgs,
    senderAddress: DEPLOYER,
    network: NETWORK,
    client,
  });
}

// Flatten a Clarity value to plain JS: uints -> decimal strings, buffers -> hex (no 0x),
// none -> null, some/ok/err -> inner value, tuples -> objects, lists -> arrays.
export function plain(cv) {
  switch (cv.type) {
    case ClarityType.BoolTrue:
      return true;
    case ClarityType.BoolFalse:
      return false;
    case ClarityType.Int:
    case ClarityType.UInt:
      return cv.value.toString();
    case ClarityType.Buffer:
      return String(cv.value);
    case ClarityType.OptionalNone:
      return null;
    case ClarityType.OptionalSome:
    case ClarityType.ResponseOk:
    case ClarityType.ResponseErr:
      return plain(cv.value);
    case ClarityType.List:
      return cv.value.map(plain);
    case ClarityType.Tuple:
      return Object.fromEntries(Object.entries(cv.value).map(([k, v]) => [k, plain(v)]));
    default:
      return cv.value; // principals and strings
  }
}
const toNum = (v) => (v === null || v === undefined ? null : Number(v));
const toStr = (v) => (v === null || v === undefined ? null : String(v));

function unwrapResponse(cv) {
  if (cv.type === ClarityType.ResponseOk) return { ok: true, value: cv.value };
  if (cv.type === ClarityType.ResponseErr) return { ok: false, value: cv.value };
  return { ok: true, value: cv };
}

export function assetInfo(asset) {
  const info = ASSETS[asset];
  if (!info) throw new Error(`Unknown asset ${String(asset)}`);
  return info;
}

export async function getJobCount(asset) {
  const r = unwrapResponse(await readOnly(assetInfo(asset).escrow, "get-job-count", []));
  return toNum(plain(r.value));
}

export async function getJob(asset, jobId) {
  const info = assetInfo(asset);
  const r = unwrapResponse(await readOnly(info.escrow, "get-job", [Cl.uint(jobId)]));
  if (!r.ok) return null;
  const j = plain(r.value);
  const status = toNum(j.status);
  const deliverableHex = j.deliverable ?? null;
  return {
    asset,
    assetId: info.id,
    jobId: Number(jobId),
    escrowContract: `${DEPLOYER}.${info.escrow}`,
    client: j.client,
    provider: j.provider ?? null,
    evaluator: j.evaluator,
    appealAuthority: j["appeal-authority"],
    treasury: j.treasury,
    description: j.description,
    budget: toStr(j.budget),
    budgetUnit: info.unit,
    expiredAt: toNum(j["expired-at"]),
    status,
    statusLabel: JOB_STATUS[status] ?? "unknown",
    deliverableHex,
    deliverableAscii: deliverableHex ? Buffer.from(deliverableHex, "hex").toString("latin1") : null,
    submittedAtBurn: toNum(j["submitted-at-burn"]),
    reviewDeadline: toNum(j["review-deadline"]),
  };
}

export async function getDecision(asset, jobId) {
  const info = assetInfo(asset);
  const r = unwrapResponse(await readOnly(info.escrow, "get-decision", [Cl.uint(jobId)]));
  if (!r.ok) return null;
  const d = plain(r.value);
  return {
    originalDecision: toNum(d["original-decision"]),
    finalDecision: d["final-decision"] == null ? null : toNum(d["final-decision"]),
    decidedAtBurn: toNum(d["decided-at-burn"]),
    appealDeadline: toNum(d["appeal-deadline"]),
    appealedBy: d["appealed-by"] ?? null,
    resolutionDeadline: d["resolution-deadline"] == null ? null : toNum(d["resolution-deadline"]),
  };
}

export async function getBurnHeight() {
  const info = await getJson("/v2/info");
  if (info?.network_id !== 1) throw new Error("Hiro /v2/info did not report mainnet.");
  return Number(info.burn_block_height);
}

export async function getAgentCount() {
  const r = unwrapResponse(await readOnly(CONTRACTS.registry, "get-agent-count", []));
  return toNum(plain(r.value));
}

export async function getAgent(agentId) {
  const r = unwrapResponse(await readOnly(CONTRACTS.registry, "get-agent", [Cl.uint(agentId)]));
  if (!r.ok) return null;
  const a = plain(r.value);
  return {
    agentId: Number(agentId),
    name: a.name,
    description: a.description,
    creator: a.creator,
    wallet: a.wallet,
    active: a.active === true,
    endpoints: Array.isArray(a.endpoints) ? a.endpoints.map((e) => ({ name: e.name, url: e.url })) : [],
  };
}

function shapeApplication(applicant, app) {
  if (!app) return null;
  return {
    applicant,
    agentId: toNum(app["agent-id"]),
    note: app.note,
    appliedAtBurn: toNum(app["applied-at-burn"]),
    active: app.active === true,
  };
}

export async function getApplicationCount(asset, jobId) {
  const cv = await readOnly(CONTRACTS.applications, "get-application-count", [Cl.uint(assetInfo(asset).id), Cl.uint(jobId)]);
  return toNum(plain(cv));
}

export async function getApplication(asset, jobId, applicant) {
  const cv = await readOnly(CONTRACTS.applications, "get-application", [
    Cl.uint(assetInfo(asset).id),
    Cl.uint(jobId),
    Cl.principal(applicant),
  ]);
  return shapeApplication(applicant, plain(cv));
}

export async function getApplicantAt(asset, jobId, index) {
  const cv = await readOnly(CONTRACTS.applications, "get-applicant-at", [
    Cl.uint(assetInfo(asset).id),
    Cl.uint(jobId),
    Cl.uint(index),
  ]);
  const v = plain(cv);
  if (!v) return null;
  return shapeApplication(v.applicant, v.application) ?? { applicant: v.applicant, active: false };
}

export async function getApplicationsConfiguration() {
  const r = unwrapResponse(await readOnly(CONTRACTS.applications, "get-configuration", []));
  const c = plain(r.value);
  return {
    owner: c.owner,
    configured: c.configured === true,
    agentRegistry: c["agent-registry"],
    stxEscrow: c["stx-escrow"],
    sbtcEscrow: c["sbtc-escrow"],
    maxApplicationsPerJob: toNum(c["max-applications-per-job"]),
  };
}

/** Pinned appeal authority and treasury of an escrow (get-protocol-config). */
export async function getProtocolConfig(asset) {
  const r = unwrapResponse(await readOnly(assetInfo(asset).escrow, "get-protocol-config", []));
  if (!r.ok) throw new Error("Escrow protocol configuration is unavailable.");
  const c = plain(r.value);
  return {
    configured: c.configured === true,
    appealAuthority: c["appeal-authority"],
    treasury: c.treasury,
    serviceFeeBps: toNum(c["service-fee-bps"]),
    reviewWindow: toNum(c["review-window"]),
    appealWindow: toNum(c["appeal-window"]),
  };
}

/**
 * Current TENURE height from /v2/info. The escrows are Clarity 2 contracts, so on current
 * mainnet their `block-height` (what `expired-at` is compared with) is the tenure height.
 * There is deliberately no fallback to stacks_tip_height.
 */
export async function getTenureHeight() {
  const info = await getJson("/v2/info");
  if (info.network_id !== 1) throw new Error("Hiro API /v2/info is not Stacks mainnet.");
  if (!Number.isSafeInteger(info.tenure_height) || info.tenure_height <= 0) {
    throw new Error("Hiro API /v2/info did not return a tenure_height.");
  }
  return info.tenure_height;
}

export async function getStxBalance(address) {
  const b = await getJson(`/extended/v1/address/${address}/stx`);
  return { microStx: String(b.balance), lockedMicroStx: String(b.locked ?? "0") };
}

export async function getPendingMempoolCount(address) {
  const m = await getJson(`/extended/v1/address/${address}/mempool?limit=1`);
  return Number(m.total ?? (m.results?.length ?? 0));
}

export async function getNextNonce(address) {
  const n = await getJson(`/extended/v1/address/${address}/nonces`);
  if (!Number.isSafeInteger(n.possible_next_nonce)) throw new Error("Could not determine the next nonce.");
  return n.possible_next_nonce;
}

export async function broadcast(tx) {
  const result = await broadcastTransaction({ transaction: tx, network: NETWORK, client });
  if (result?.error || !result?.txid) {
    const reason = [result?.error, result?.reason].filter(Boolean).join(": ") || "unknown broadcast error";
    throw new Error(`Broadcast rejected: ${reason}`);
  }
  return result.txid.startsWith("0x") ? result.txid : `0x${result.txid}`;
}

export async function getTxStatus(txid) {
  const id = txid.startsWith("0x") ? txid : `0x${txid}`;
  const res = await timedFetch(`${HIRO_API}/extended/v1/tx/${id}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return { txid: id, found: false, status: "not_found" };
  if (!res.ok) throw new Error(`Hiro API tx lookup returned HTTP ${res.status}`);
  const t = await res.json();
  return {
    txid: id,
    found: true,
    status: t.tx_status,
    confirmed: t.tx_status === "success",
    result: t.tx_result?.repr ?? null,
    blockHeight: t.block_height ?? null,
    sender: t.sender_address,
    nonce: t.nonce,
    feeMicroStx: t.fee_rate,
    contractCall: t.contract_call
      ? { contractId: t.contract_call.contract_id, functionName: t.contract_call.function_name }
      : null,
  };
}
