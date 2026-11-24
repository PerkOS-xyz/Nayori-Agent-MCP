// Chain access for one network profile (Hiro API): read-only contract calls through the SDK's
// NayoriNextClient (its parsers know the live contracts' tuples), account state, broadcast of an
// already-signed and already-inspected transaction, and tx status.
//
// Every record is returned as plain JSON: status labels, numeric Bitcoin heights, amounts as
// decimal strings. No bigint leaves this module.

import { fetchCallReadOnlyFunction, broadcastTransaction } from "@stacks/transactions";
import { NayoriNextClient } from "./sdk.mjs";
import { PROFILES, ASSET_UNITS, escrowId } from "./rails.mjs";

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

const num = (v) => (v === null || v === undefined ? null : Number(v));
const str = (v) => (v === null || v === undefined ? null : v.toString());

export function shapeJob(job, profile) {
  if (!job) return null;
  return {
    asset: job.asset,
    jobId: Number(job.id),
    escrowContract: escrowId(profile, job.asset),
    status: job.status,
    statusCode: Number(job.statusCode),
    client: job.client,
    provider: job.provider ?? null,
    evaluator: job.evaluator,
    treasury: job.treasury,
    appealAuthority: job.appealAuthority,
    budget: str(job.budget),
    budgetUnit: ASSET_UNITS[job.asset],
    description: job.description,
    deliveryDeadline: num(job.deliveryDeadline),
    deliveryBlocks: num(job.deliveryBlocks),
    reviewBlocks: num(job.reviewBlocks),
  };
}

export function shapeSubmission(s) {
  if (!s) return null;
  const deliverableHex = String(s.deliverable).replace(/^0x/, "").toLowerCase();
  return { deliverableHex, reviewDeadline: num(s.reviewDeadline) };
}

export function shapeDecision(d) {
  if (!d) return null;
  return {
    decision: d.decision,
    byDefault: d.byDefault === true,
    evidenceHash: d.evidenceHash,
    appealDeadline: num(d.appealDeadline),
    appellant: d.appellant ?? null,
    resolutionDeadline: d.resolutionDeadline === undefined ? null : num(d.resolutionDeadline),
  };
}

export function shapeAgent(a) {
  if (!a) return null;
  return { wallet: a.wallet, name: a.name, uri: a.uri, registeredAt: num(a.registeredAt) };
}

export function shapeApplication(a) {
  return a ? { applicant: a.applicant, deposit: str(a.deposit) } : null;
}

/** All chain access for `profile` (default mainnet). */
export function createChain(profile = PROFILES.mainnet) {
  const hiro = { baseUrl: profile.hiroApi, fetch: timedFetch };

  async function getJson(path) {
    const res = await timedFetch(`${profile.hiroApi}${path}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Hiro API ${path} returned HTTP ${res.status}`);
    return res.json();
  }

  // The SDK builds the read-only calls and parses the results; the HTTP goes through the
  // retrying Hiro client above, pinned to this profile's API.
  const readOnlyTransport = ({ contract, functionName, functionArgs, senderAddress }) => {
    const [contractAddress, contractName] = contract.split(".");
    return fetchCallReadOnlyFunction({
      contractAddress, contractName, functionName, functionArgs: [...functionArgs], senderAddress, network: profile.network, client: hiro,
    });
  };
  const reader = new NayoriNextClient({ network: profile.network, deployer: profile.deployer, readOnlyTransport });

  async function getInfo() {
    const info = await getJson("/v2/info");
    if (info?.network_id !== profile.chainId) throw new Error(`Hiro API /v2/info is not Stacks ${profile.network}.`);
    return info;
  }

  return {
    profile,
    reader,
    async getJobCount(asset) {
      return Number(await reader.getJobCount(asset));
    },
    async getJob(asset, jobId) {
      return shapeJob(await reader.getJob(asset, jobId), profile);
    },
    async getSubmission(asset, jobId) {
      return shapeSubmission(await reader.getSubmission(asset, jobId));
    },
    async getDecision(asset, jobId) {
      return shapeDecision(await reader.getDecision(asset, jobId));
    },
    async getEscrowBalance(asset, jobId) {
      return str(await reader.getEscrowBalance(asset, jobId));
    },
    async getAgent(wallet) {
      return shapeAgent(await reader.getAgent(wallet));
    },
    async getAgentCount() {
      return Number(await reader.getAgentCount());
    },
    /** sBTC jobs only; sorted by deposit, highest first, ties by arrival. */
    async getApplications(jobId) {
      return (await reader.getApplications(jobId)).map(shapeApplication);
    },
    async getApplication(jobId, applicant) {
      return shapeApplication(await reader.getApplication(jobId, applicant));
    },
    async getRoles() {
      const [treasury, appealAuthority] = await Promise.all([reader.getTreasury(), reader.getAppealAuthority()]);
      return { treasury, appealAuthority };
    },
    async getProviderStats(provider) {
      const s = await reader.getProviderStats(provider);
      return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
    },
    /** Current Bitcoin (burn) block height: what every deadline in the live contracts is compared with. */
    async getBurnHeight() {
      return Number((await getInfo()).burn_block_height);
    },
    async getStxBalance(address) {
      const b = await getJson(`/extended/v1/address/${address}/stx`);
      return { microStx: String(b.balance), lockedMicroStx: String(b.locked ?? "0") };
    },
    /** sBTC held by `address`, in sats (string). */
    async getSbtcBalance(address) {
      const b = await getJson(`/extended/v1/address/${address}/balances`);
      const entry = b?.fungible_tokens?.[`${profile.sbtcToken}::${profile.sbtcAssetName}`];
      return String(entry?.balance ?? "0");
    },
    async getPendingMempoolCount(address) {
      const m = await getJson(`/extended/v1/address/${address}/mempool?limit=1`);
      return Number(m.total ?? (m.results?.length ?? 0));
    },
    async getNextNonce(address) {
      const n = await getJson(`/extended/v1/address/${address}/nonces`);
      if (!Number.isSafeInteger(n.possible_next_nonce)) throw new Error("Could not determine the next nonce.");
      return n.possible_next_nonce;
    },
    async broadcast(tx) {
      const result = await broadcastTransaction({ transaction: tx, network: profile.network, client: hiro });
      if (result?.error || !result?.txid) {
        const reason = [result?.error, result?.reason].filter(Boolean).join(": ") || "unknown broadcast error";
        throw new Error(`Broadcast rejected: ${reason}`);
      }
      return result.txid.startsWith("0x") ? result.txid : `0x${result.txid}`;
    },
    async getTxStatus(txid) {
      const id = txid.startsWith("0x") ? txid : `0x${txid}`;
      const res = await timedFetch(`${profile.hiroApi}/extended/v1/tx/${id}`, { headers: { accept: "application/json" } });
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
    },
  };
}
