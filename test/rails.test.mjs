import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  Cl, Pc, PostConditionMode, deserializeTransaction, makeUnsignedContractCall, privateKeyToPublic, makeSTXTokenTransfer,
} from "@stacks/transactions";
import * as rails from "../lib/rails.mjs";
import { NAYORI_NEXT_DEPLOYMENTS, NAYORI_NEXT_LIMITS, NayoriNextTransactionBuilder, resolveNayoriNextConfig } from "../lib/sdk.mjs";
import { signContractCall, ENV_VAR } from "../lib/signer.mjs";
import { fakeKey, writeEnvFile } from "./helpers.mjs";

const { PROFILES, RailError } = rails;
const MAIN = PROFILES.mainnet;
const TEST = PROFILES.testnet;
const DEPLOYER = MAIN.deployer;

test("profiles pin the live Nayori deployments and agree with the SDK", () => {
  assert.equal(MAIN.deployer, "SP2BM4WCNQM286PFHPGA1BG2YXER0PCG1PKQ5MF1X");
  assert.equal(TEST.deployer, "ST3MRPNX0VNWYRSJ07PNTASE5BZ9K5XE57ARZ39DY");
  for (const network of ["mainnet", "testnet"]) {
    const ids = rails.contractIds(PROFILES[network]);
    const sdk = NAYORI_NEXT_DEPLOYMENTS[network];
    for (const key of Object.keys(rails.CONTRACT_NAMES)) assert.equal(ids[key], sdk[key], `${network} ${key}`);
    assert.equal(PROFILES[network].sbtcToken, sdk.sbtcToken);
    assert.equal(PROFILES[network].sbtcAssetName, sdk.sbtcAssetName);
  }
  assert.equal(MAIN.evaluationRelay, "https://app.nayori.ai/api/evaluations");
  assert.equal(TEST.evaluationRelay, "https://qa.nayori.ai/api/evaluations");
  assert.ok(Object.isFrozen(PROFILES) && Object.isFrozen(MAIN) && Object.isFrozen(TEST));
});

test("limits agree with the SDK", () => {
  const L = rails.LIMITS;
  for (const asset of ["sbtc", "stx"]) {
    assert.equal(BigInt(L.budget[asset].min), NAYORI_NEXT_LIMITS.budget[asset].min);
    assert.equal(BigInt(L.budget[asset].max), NAYORI_NEXT_LIMITS.budget[asset].max);
  }
  for (const k of ["deliveryBlocks", "reviewBlocks"]) {
    assert.equal(BigInt(L[k].min), NAYORI_NEXT_LIMITS[k].min);
    assert.equal(BigInt(L[k].max), NAYORI_NEXT_LIMITS[k].max);
  }
  assert.equal(BigInt(L.deposit.min), NAYORI_NEXT_LIMITS.applicationDeposit.min);
  assert.equal(BigInt(L.deposit.max), NAYORI_NEXT_LIMITS.applicationDeposit.max);
  assert.equal(L.maxApplications, NAYORI_NEXT_LIMITS.maxApplications);
});

test("network: mainnet by default, testnet only when configured", () => {
  assert.equal(rails.resolveProfile({}), MAIN);
  assert.equal(rails.resolveProfile({ NAYORI_AGENT_NETWORK: "" }), MAIN);
  assert.equal(rails.resolveProfile({ NAYORI_AGENT_NETWORK: "mainnet" }), MAIN);
  assert.equal(rails.resolveProfile({ NAYORI_AGENT_NETWORK: "testnet" }), TEST);
  for (const bad of ["Testnet", "devnet", "mocknet", " mainnet"]) assert.throws(() => rails.resolveProfile({ NAYORI_AGENT_NETWORK: bad }), RailError, bad);
});

test("allowlist is exactly four Nayori contracts and the agent-side functions", () => {
  assert.deepEqual(rails.WRITE_ALLOWLIST, {
    "nayori-agents": ["register"],
    "nayori-applications": ["apply-to-job", "withdraw"],
    "nayori-escrow-sbtc": ["create-job", "name-provider", "accept-job", "submit-work", "appeal"],
    "nayori-escrow-stx": ["create-job", "name-provider", "accept-job", "submit-work", "appeal"],
  });
  assert.ok(Object.isFrozen(rails.WRITE_ALLOWLIST));
  for (const fns of Object.values(rails.WRITE_ALLOWLIST)) assert.ok(Object.isFrozen(fns));
  for (const [c, fns] of Object.entries(rails.WRITE_ALLOWLIST)) {
    for (const f of fns) {
      rails.assertAllowedCall(DEPLOYER, c, f);
      rails.assertAllowedCall(TEST.deployer, c, f, TEST);
    }
  }
});

test("other deployers, contracts and functions are refused", () => {
  const other = "SP000000000000000000002Q6VF78";
  assert.throws(() => rails.assertAllowedCall(other, "nayori-agents", "register"), RailError);
  // The previous contract generation is no longer reachable.
  assert.throws(() => rails.assertAllowedCall("SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH", "sbtc-commerce-v5", "submit-work"), RailError);
  for (const old of ["sbtc-commerce-v5", "agentic-commerce-v6", "agent-registry", "job-applications-v1"]) {
    assert.throws(() => rails.assertAllowedCall(DEPLOYER, old, "submit-work"), RailError);
  }
  // A mainnet deployer is refused on testnet and the other way around.
  assert.throws(() => rails.assertAllowedCall(DEPLOYER, "nayori-agents", "register", TEST), RailError);
  assert.throws(() => rails.assertAllowedCall(TEST.deployer, "nayori-agents", "register", MAIN), RailError);
  for (const c of ["nayori-roles", "nayori-permissions", "nayori-reputation", "sbtc-token", "__proto__", "constructor"]) {
    assert.throws(() => rails.assertAllowedCall(DEPLOYER, c, "register"), RailError, c);
  }
  // Funding, decisions, settlement, refunds, handovers, allowances and transfers stay refused everywhere.
  const refused = ["fund-job", "record-decision", "record-default-approval", "resolve-appeal", "settle-job", "refund-no-delivery",
    "close-unfunded", "rate-provider", "retry-reputation", "decline", "release", "update", "allow-contract-caller",
    "propose-handover", "accept-handover", "transfer", "set-budget", "assign-provider", "appeal-decision"];
  for (const fn of refused) {
    for (const c of Object.values(rails.CONTRACT_NAMES)) assert.throws(() => rails.assertAllowedCall(DEPLOYER, c, fn), RailError, `${c}.${fn}`);
  }
  assert.throws(() => rails.assertAllowedCall("SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4", "sbtc-token", "transfer"), RailError);
  assert.throws(() => rails.buildCallOptions({ contractAddress: other, contractName: "nayori-agents", functionName: "register", functionArgs: [], nonce: 0, fee: 3000 }), RailError);
});

test("fee: default 3000, env override, hard cap 50000", () => {
  assert.equal(rails.resolveFee({}), 3000n);
  assert.equal(rails.resolveFee({ NAYORI_AGENT_FEE_USTX: "" }), 3000n);
  assert.equal(rails.resolveFee({ NAYORI_AGENT_FEE_USTX: "10000" }), 10000n);
  assert.equal(rails.resolveFee({ NAYORI_AGENT_FEE_USTX: "50000" }), 50000n);
  for (const bad of ["50001", "1000000", "0", "-1", "1e4", "3000.5", "abc", " 3000"]) {
    assert.throws(() => rails.resolveFee({ NAYORI_AGENT_FEE_USTX: bad }), RailError, bad);
  }
  const base = { contractName: "nayori-agents", functionName: "register", functionArgs: [], nonce: 0 };
  assert.throws(() => rails.buildCallOptions({ ...base, fee: 50001 }), RailError);
  assert.throws(() => rails.buildCallOptions({ ...base, fee: 0 }), RailError);
});

test("deposit cap: default 10000 sats, env override within the contract bounds", () => {
  assert.equal(rails.resolveMaxDeposit({}), 10_000n);
  assert.equal(rails.resolveMaxDeposit({ NAYORI_AGENT_MAX_DEPOSIT_SATS: "100" }), 100n);
  assert.equal(rails.resolveMaxDeposit({ NAYORI_AGENT_MAX_DEPOSIT_SATS: "1000000" }), 1_000_000n);
  for (const bad of ["99", "1000001", "0", "-5", "1e3", "abc"]) {
    assert.throws(() => rails.resolveMaxDeposit({ NAYORI_AGENT_MAX_DEPOSIT_SATS: bad }), RailError, bad);
  }
});

test("buildCallOptions: Deny always, rail post-conditions only, extra fields ignored", () => {
  const o = rails.buildCallOptions({
    contractName: "nayori-escrow-sbtc", functionName: "submit-work", functionArgs: [], nonce: 7, fee: 3000,
    postConditionMode: PostConditionMode.Allow, postConditions: ["x"], network: "testnet", sponsored: true,
  });
  assert.equal(o.network, "mainnet");
  assert.equal(o.postConditionMode, PostConditionMode.Deny);
  assert.deepEqual(o.postConditions, []);
  assert.equal(o.contractAddress, DEPLOYER);
  assert.equal(o.sponsored, undefined);
  assert.equal(o.fee, 3000n);
  assert.equal(o.nonce, 7n);
  const t = rails.buildCallOptions({ contractName: "nayori-agents", functionName: "register", functionArgs: [], nonce: 0, fee: 3000 }, TEST);
  assert.equal(t.network, "testnet");
  assert.equal(t.contractAddress, TEST.deployer);
});

test("post-conditions: exact deposit on apply, exact refund on withdraw, none elsewhere", () => {
  const me = fakeKey().address;
  const apps = `${DEPLOYER}.nayori-applications`;
  const apply = rails.railPostConditions(MAIN, { contractName: "nayori-applications", functionName: "apply-to-job", sender: me, amount: 5000 });
  assert.deepEqual(apply, [
    Pc.principal(me).willSendEq(5000n).ft(MAIN.sbtcToken, "sbtc-token"),
    Pc.principal(apps).willSendLte(5000n).ft(MAIN.sbtcToken, "sbtc-token"),
  ]);
  const withdraw = rails.railPostConditions(MAIN, { contractName: "nayori-applications", functionName: "withdraw", amount: "777" });
  assert.deepEqual(withdraw, [Pc.principal(apps).willSendEq(777n).ft(MAIN.sbtcToken, "sbtc-token")]);
  for (const [c, fns] of Object.entries(rails.WRITE_ALLOWLIST)) {
    for (const f of fns) if (!["apply-to-job", "withdraw"].includes(f)) assert.deepEqual(rails.railPostConditions(MAIN, { contractName: c, functionName: f, sender: me, amount: 5000 }), [], `${c}.${f}`);
  }
  // Bounds and the env cap.
  const applyWith = (o) => rails.railPostConditions(MAIN, { contractName: "nayori-applications", functionName: "apply-to-job", sender: me, ...o });
  assert.throws(() => applyWith({ amount: 99 }), /outside 100\.\.10000/);
  assert.throws(() => applyWith({ amount: 10_001 }), /outside 100\.\.10000/);
  assert.equal(applyWith({ amount: 20_000, maxDeposit: 20_000n }).length, 2);
  assert.throws(() => applyWith({ amount: 1_000_001, maxDeposit: 1_000_000n }), RailError);
  assert.throws(() => applyWith({ amount: "x" }), /not a whole number/);
  assert.throws(() => applyWith({ sender: undefined, amount: 500 }), /needs the signer address/);
  assert.throws(() => applyWith({ sender: fakeKey("testnet").address, amount: 500 }), /needs the signer address/);
  assert.throws(() => rails.railPostConditions(MAIN, { contractName: "nayori-applications", functionName: "withdraw", amount: 1_000_001 }), RailError);
  // Testnet uses its own sBTC token.
  const t = rails.railPostConditions(TEST, { contractName: "nayori-applications", functionName: "withdraw", amount: 100 });
  assert.equal(t[0].asset, `${TEST.sbtcToken}::sbtc-token`);
  assert.equal(t[0].address, `${TEST.deployer}.nayori-applications`);
});

test("the SDK plans carry exactly the rail post-conditions; a different plan is refused", () => {
  const me = fakeKey().address;
  const b = new NayoriNextTransactionBuilder(resolveNayoriNextConfig({ network: "mainnet", deployer: DEPLOYER }));
  const checks = [
    [b.applyToJob({ jobId: 3, deposit: 1500n, sender: me }), 1500],
    [b.withdrawApplication({ jobId: 3, applicant: me, deposit: 1500n }), 1500],
    [b.registerAgent({ name: "A", uri: "" }), undefined],
    [b.acceptJob({ asset: "stx", jobId: 3 }), undefined],
  ];
  for (const [plan, amount] of checks) {
    const [address, name] = plan.contract.split(".");
    const o = rails.buildCallOptions({ contractAddress: address, contractName: name, functionName: plan.functionName, functionArgs: plan.functionArgs, nonce: 0, fee: 3000, sender: me, amount, planPostConditions: plan.postConditions });
    assert.equal(o.postConditions.length, plan.postConditions.length);
  }
  const apply = b.applyToJob({ jobId: 3, deposit: 1500n, sender: me });
  const base = { contractName: "nayori-applications", functionName: "apply-to-job", functionArgs: apply.functionArgs, nonce: 0, fee: 3000, sender: me };
  assert.throws(() => rails.buildCallOptions({ ...base, amount: 1499, planPostConditions: apply.postConditions }), /differ from the rail/);
  assert.throws(() => rails.buildCallOptions({ ...base, amount: 1500, planPostConditions: [apply.postConditions[0]] }), /differ from the rail/);
  assert.throws(() => rails.buildCallOptions({ ...base, amount: 1500, planPostConditions: "none" }), /differ from the rail/);
  assert.throws(() => rails.buildCallOptions({ contractName: "nayori-agents", functionName: "register", functionArgs: [], nonce: 0, fee: 3000, planPostConditions: apply.postConditions }), /differ from the rail/);
});

test("signed transactions are contract calls with Deny mode and exactly the rail post-conditions (offline)", async () => {
  for (const network of ["mainnet", "testnet"]) {
    const profile = PROFILES[network];
    const k = fakeKey(network);
    const env = { [ENV_VAR]: writeEnvFile(k), ...(network === "testnet" ? { NAYORI_AGENT_NETWORK: "testnet" } : {}) };
    const calls = [
      [{ contractName: "nayori-agents", functionName: "register", functionArgs: [Cl.stringAscii("Test Agent"), Cl.stringAscii("")] }, 0],
      [{ contractName: "nayori-applications", functionName: "apply-to-job", functionArgs: [Cl.uint(1), Cl.uint(2500)], amount: 2500 }, 2],
      [{ contractName: "nayori-applications", functionName: "withdraw", functionArgs: [Cl.uint(1)], amount: "2500" }, 1],
      [{ contractName: "nayori-escrow-stx", functionName: "accept-job", functionArgs: [Cl.uint(1)] }, 0],
      [{ contractName: "nayori-escrow-sbtc", functionName: "submit-work", functionArgs: [Cl.uint(1), Cl.buffer(rails.deliverableBufferBytes("ipfs://example"))] }, 0],
    ];
    for (const [call, pcs] of calls) {
      const { tx } = await signContractCall({ ...call, nonce: 5, fee: 3000 }, { env, expectedAddress: k.address });
      // Round-trip through the wire format so the assertions are about the real bytes.
      const wire = deserializeTransaction(tx.serialize());
      assert.equal(wire.postConditionMode, PostConditionMode.Deny);
      assert.equal(wire.postConditions.values.length, pcs, `${network} ${call.functionName}`);
      assert.equal(wire.payload.contractName.content, call.contractName);
      assert.equal(wire.payload.functionName.content, call.functionName);
      assert.equal(wire.chainId, profile.chainId);
      assert.equal(BigInt(wire.auth.spendingCondition.fee), 3000n);
      assert.equal(BigInt(wire.auth.spendingCondition.nonce), 5n);
      assert.ok(!tx.serialize().includes(k.privateKey));
      rails.assertTransactionIsSafe(wire, rails.buildCallOptions({ ...call, nonce: 5, fee: 3000, sender: k.address }, profile), profile);
    }
  }
});

test("assertTransactionIsSafe rejects Allow mode, wrong post-conditions, transfers, wrong targets, deployers and networks", async () => {
  const k = fakeKey();
  const publicKey = privateKeyToPublic(k.privateKey);
  const expected = (contractName, functionName, o = {}) => rails.buildCallOptions({ contractName, functionName, functionArgs: [], nonce: 0, fee: 3000, sender: k.address, ...o });
  const unsigned = (o) => makeUnsignedContractCall({
    contractAddress: DEPLOYER, contractName: "nayori-escrow-sbtc", functionName: "submit-work", functionArgs: [],
    publicKey, network: "mainnet", fee: 3000, nonce: 0, postConditionMode: PostConditionMode.Deny, ...o,
  });
  rails.assertTransactionIsSafe(await unsigned({}), expected("nayori-escrow-sbtc", "submit-work"));
  assert.throws(() => rails.assertTransactionIsSafe({ payload: null }, expected("nayori-escrow-sbtc", "submit-work")), RailError);

  const allow = await unsigned({ postConditionMode: PostConditionMode.Allow });
  assert.throws(() => rails.assertTransactionIsSafe(allow, expected("nayori-escrow-sbtc", "submit-work")), /not Deny/);

  const extra = await unsigned({ postConditions: [Pc.principal(k.address).willSendLte(1n).ustx()] });
  assert.throws(() => rails.assertTransactionIsSafe(extra, expected("nayori-escrow-sbtc", "submit-work")), /not the rail post-conditions/);

  const apply = await unsigned({ contractName: "nayori-applications", functionName: "apply-to-job",
    postConditions: [Pc.principal(k.address).willSendEq(5000n).ft(MAIN.sbtcToken, "sbtc-token")] });
  assert.throws(() => rails.assertTransactionIsSafe(apply, expected("nayori-applications", "apply-to-job", { amount: 5000 })), /not the rail post-conditions/);

  const transfer = await makeSTXTokenTransfer({ recipient: DEPLOYER, amount: 1, senderKey: k.privateKey, network: "mainnet", fee: 3000, nonce: 0 });
  assert.throws(() => rails.assertTransactionIsSafe(transfer, expected("nayori-escrow-sbtc", "submit-work")), /not a contract call/);

  const fund = await unsigned({ functionName: "fund-job" });
  assert.throws(() => rails.assertTransactionIsSafe(fund, { ...expected("nayori-escrow-sbtc", "submit-work"), functionName: "fund-job" }), /allowlist/);

  const oldGen = await unsigned({ contractAddress: "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH" });
  assert.throws(() => rails.assertTransactionIsSafe(oldGen, expected("nayori-escrow-sbtc", "submit-work")), /allowlist/);

  const testnet = await unsigned({ contractAddress: TEST.deployer, network: "testnet" });
  assert.throws(() => rails.assertTransactionIsSafe(testnet, expected("nayori-escrow-sbtc", "submit-work")), /not mainnet/);
  rails.assertTransactionIsSafe(testnet, rails.buildCallOptions({ contractName: "nayori-escrow-sbtc", functionName: "submit-work", functionArgs: [], nonce: 0, fee: 3000 }, TEST), TEST);
  const mainTx = await unsigned({});
  assert.throws(() => rails.assertTransactionIsSafe(mainTx, expected("nayori-escrow-sbtc", "submit-work"), TEST), /not testnet/);
});

test("deliverable encoding: ASCII bytes of the hex SHA-256 of the trimmed reference", () => {
  const ref = "  https://example.com/brief.md \n";
  const hex = createHash("sha256").update("https://example.com/brief.md", "utf8").digest("hex");
  assert.equal(rails.deliverableDigestHex(ref), hex);
  const bytes = rails.deliverableBufferBytes(ref);
  assert.equal(bytes.length, 64);
  assert.equal(Buffer.from(bytes).toString("ascii"), hex);
  assert.deepEqual(Cl.buffer(bytes), Cl.bufferFromAscii(hex.slice(0, 64)));
  assert.throws(() => rails.deliverableDigestHex("   "), RailError);
  assert.equal(rails.appealEvidenceBytes("  ref  ").length, 32);
  assert.throws(() => rails.appealEvidenceBytes(" "), RailError);
});

// ---------------------------------------------------------------------------
// Pre-sign checks. Jobs are shaped like lib/chain.mjs returns them.
// ---------------------------------------------------------------------------

const A = "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE";
const C = "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7";
const E = "SP3GRG5CKEFNYM5BV0NPPHCM51FT176JQ02QWQ9T3";
const T = "SMFE58EKCK5ZPD7YCYM1CQY7K3H8SEXQH7C3YT8S";
const R = "SM3950RVR364J25ZRFFNHB5TCNJ7VKPKKGD4N2RP9";
const job = (o = {}) => ({ asset: "sbtc", jobId: 1, status: "funded", client: C, provider: null, evaluator: E, treasury: T, appealAuthority: R, deliveryDeadline: 1000, deliveryBlocks: 144, ...o });

test("register: one agent per wallet", () => {
  rails.checkRegisterPreconditions({ existingAgent: null });
  assert.throws(() => rails.checkRegisterPreconditions({ existingAgent: { name: "Old" } }), /one agent per wallet/);
});

test("apply preconditions", () => {
  const ok = { job: job(), agent: { name: "A" }, signerAddress: A, existingApplication: null, applications: [], deposit: 500, burnHeight: 999, sbtcBalance: "500" };
  for (const status of ["open", "funded", "offered"]) rails.checkApplyPreconditions({ ...ok, job: job({ status, provider: status === "offered" ? C : null }) });
  const bad = (o, re) => assert.throws(() => rails.checkApplyPreconditions({ ...ok, ...o }), re);
  bad({ job: null }, /job not found/);
  for (const status of ["accepted", "submitted", "decided", "disputed", "completed", "rejected", "refunded", "expired"]) bad({ job: job({ status }) }, /an application needs open or funded or offered/);
  bad({ burnHeight: 1000 }, /deadline .* has passed/);
  bad({ burnHeight: undefined }, /height is not available/);
  for (const [role, value] of [["client", A], ["evaluator", A], ["treasury", A], ["appealAuthority", A]]) bad({ job: job({ [role]: value }) }, new RegExp(`signer is the ${role}`));
  bad({ agent: null }, /Register first/);
  bad({ existingApplication: { applicant: A, deposit: "100" } }, /already applied/);
  bad({ sbtcBalance: "499" }, /holds 499 sats/);
  const full = Array.from({ length: 50 }, (_, i) => ({ applicant: `x${i}`, deposit: String(1000 - i) }));
  bad({ applications: full, deposit: 951 }, /list is full .* lowest entry of 951 sats/);
  rails.checkApplyPreconditions({ ...ok, applications: full, deposit: 952, sbtcBalance: "952" });
});

test("withdraw, accept and submit preconditions", () => {
  rails.checkWithdrawPreconditions({ existingApplication: { deposit: "100" } });
  assert.throws(() => rails.checkWithdrawPreconditions({ existingApplication: null }), /no application/);

  rails.checkAcceptPreconditions({ job: job({ status: "offered", provider: A }), signerAddress: A, burnHeight: 999 });
  assert.throws(() => rails.checkAcceptPreconditions({ job: null, signerAddress: A, burnHeight: 1 }), /not found/);
  assert.throws(() => rails.checkAcceptPreconditions({ job: job({ status: "offered", provider: C }), signerAddress: A, burnHeight: 1 }), /offered to another provider/);
  for (const status of ["funded", "accepted", "submitted"]) {
    assert.throws(() => rails.checkAcceptPreconditions({ job: job({ status, provider: A }), signerAddress: A, burnHeight: 1 }), /accept-job needs offered/);
  }
  assert.throws(() => rails.checkAcceptPreconditions({ job: job({ status: "offered", provider: A }), signerAddress: A, burnHeight: 1000 }), /has passed/);

  rails.checkSubmitPreconditions({ job: job({ status: "accepted", provider: A }), signerAddress: A, burnHeight: 999 });
  assert.throws(() => rails.checkSubmitPreconditions({ job: job({ status: "offered", provider: A }), signerAddress: A, burnHeight: 1 }), /Accept it first with nayori_accept_job/);
  assert.throws(() => rails.checkSubmitPreconditions({ job: job({ status: "accepted", provider: C }), signerAddress: A, burnHeight: 1 }), /not the provider/);
  assert.throws(() => rails.checkSubmitPreconditions({ job: job({ status: "accepted", provider: null }), signerAddress: A, burnHeight: 1 }), /not the provider/);
  for (const status of ["funded", "submitted", "decided"]) {
    assert.throws(() => rails.checkSubmitPreconditions({ job: job({ status, provider: A }), signerAddress: A, burnHeight: 1 }), /submit-work needs accepted/);
  }
  assert.throws(() => rails.checkSubmitPreconditions({ job: job({ status: "accepted", provider: A }), signerAddress: A, burnHeight: 1000 }), /has passed/);
  assert.throws(() => rails.checkSubmitPreconditions({ job: null, signerAddress: A, burnHeight: 1 }), /not found/);
});

test("client preconditions: create-job parties, budget bounds, name-provider", () => {
  const roles = { treasury: T, appealAuthority: R };
  rails.checkCreateJobPreconditions({ signerAddress: A, evaluator: E, roles });
  assert.throws(() => rails.checkCreateJobPreconditions({ signerAddress: A, evaluator: A, roles }), /evaluator must differ/);
  assert.throws(() => rails.checkCreateJobPreconditions({ signerAddress: T, evaluator: E, roles }), /signer is the treasury/);
  assert.throws(() => rails.checkCreateJobPreconditions({ signerAddress: A, evaluator: R, roles }), /evaluator is the appealAuthority/);
  assert.throws(() => rails.checkCreateJobPreconditions({ signerAddress: A, evaluator: E, roles: {} }), /could not be read/);

  rails.checkBudget("sbtc", 1000);
  rails.checkBudget("stx", 100_000_000_000);
  for (const [asset, b] of [["sbtc", 999], ["sbtc", 100_000_001], ["stx", 999_999], ["stx", 100_000_000_001], ["sbtc", 1.5], ["btc", 5000]]) {
    assert.throws(() => rails.checkBudget(asset, b), RailError, `${asset} ${b}`);
  }

  rails.checkNameProviderPreconditions({ job: job({ client: A }), signerAddress: A, provider: "SP1NT1V4X6GQR6T32Z8MSMNECZ6GSWX9HZ81SM1Y8" });
  rails.checkNameProviderPreconditions({ job: job({ client: A, status: "offered", provider: C }), signerAddress: A, provider: "SP1NT1V4X6GQR6T32Z8MSMNECZ6GSWX9HZ81SM1Y8" });
  const bad = (o, provider, re) => assert.throws(() => rails.checkNameProviderPreconditions({ job: job({ client: A, ...o }), signerAddress: A, provider }), re);
  bad({ client: C }, "SP1NT1V4X6GQR6T32Z8MSMNECZ6GSWX9HZ81SM1Y8", /not the client/);
  for (const status of ["open", "accepted", "submitted"]) bad({ status }, "SP1NT1V4X6GQR6T32Z8MSMNECZ6GSWX9HZ81SM1Y8", /name-provider needs funded or offered/);
  bad({}, A, /provider is the client/);
  bad({}, E, /provider is the evaluator/);
  bad({}, T, /provider is the treasury/);
  bad({}, R, /provider is the appealAuthority/);
  bad({ status: "offered", provider: C }, C, /already offered to that provider/);
  assert.throws(() => rails.checkNameProviderPreconditions({ job: null, signerAddress: A, provider: C }), /not found/);
});

test("evaluation request preconditions", () => {
  const sub = { deliverableHex: "ab", reviewDeadline: 2000 };
  const submitted = job({ status: "submitted", provider: A });
  rails.checkEvaluationRequestPreconditions({ job: submitted, submission: sub, burnHeight: 2000 });
  assert.throws(() => rails.checkEvaluationRequestPreconditions({ job: null, submission: sub }), /not found/);
  assert.throws(() => rails.checkEvaluationRequestPreconditions({ job: job({ status: "accepted", provider: A }), submission: sub }), /needs submitted/);
  assert.throws(() => rails.checkEvaluationRequestPreconditions({ job: submitted, submission: null }), /no provider, deliverable or review deadline/);
  assert.throws(() => rails.checkEvaluationRequestPreconditions({ job: submitted, submission: sub, burnHeight: 2001 }), /approved by default/);
});

test("appeal preconditions: only the losing party, only while decided, only inside the window", () => {
  const decided = job({ status: "decided", client: C, provider: A });
  const approve = { decision: "approve", appealDeadline: 100 };
  const reject = { decision: "reject", appealDeadline: 100 };
  rails.checkAppealPreconditions({ job: decided, decision: approve, signerAddress: C, burnHeight: 100 });
  rails.checkAppealPreconditions({ job: decided, decision: reject, signerAddress: A, burnHeight: 1 });
  assert.throws(() => rails.checkAppealPreconditions({ job: decided, decision: approve, signerAddress: A, burnHeight: 50 }), /client may appeal an approval/);
  assert.throws(() => rails.checkAppealPreconditions({ job: decided, decision: reject, signerAddress: C, burnHeight: 50 }), /provider may appeal a rejection/);
  assert.throws(() => rails.checkAppealPreconditions({ job: decided, decision: approve, signerAddress: C, burnHeight: 101 }), /window is closed/);
  assert.throws(() => rails.checkAppealPreconditions({ job: decided, decision: approve, signerAddress: C, burnHeight: 0 }), /window is closed/);
  assert.throws(() => rails.checkAppealPreconditions({ job: { ...decided, status: "disputed" }, decision: approve, signerAddress: C, burnHeight: 50 }), /needs decided/);
  assert.throws(() => rails.checkAppealPreconditions({ job: decided, decision: null, signerAddress: C, burnHeight: 50 }), /no decision/);
});
