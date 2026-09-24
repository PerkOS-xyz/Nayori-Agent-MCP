import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Cl, PostConditionMode, deserializeTransaction, makeUnsignedContractCall, privateKeyToPublic, makeSTXTokenTransfer } from "@stacks/transactions";
import * as rails from "../lib/rails.mjs";
import { signContractCall, ENV_VAR } from "../lib/signer.mjs";
import { fakeKey, writeEnvFile } from "./helpers.mjs";

const { DEPLOYER, RailError } = rails;

test("allowlist is exactly four contracts and eight function names under the Nayori deployer", () => {
  assert.equal(DEPLOYER, "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH");
  assert.equal(rails.NETWORK, "mainnet");
  assert.deepEqual(Object.values(rails.CONTRACTS).sort(), ["agent-registry", "agentic-commerce-v6", "job-applications-v1", "sbtc-commerce-v5"]);
  assert.deepEqual(rails.WRITE_ALLOWLIST, {
    "agent-registry": ["register-agent"],
    "job-applications-v1": ["apply-to-job", "withdraw-application"],
    "sbtc-commerce-v5": ["create-job", "set-budget", "assign-provider", "submit-work", "appeal-decision"],
    "agentic-commerce-v6": ["create-job", "set-budget", "assign-provider", "submit-work", "appeal-decision"],
  });
  assert.equal(new Set(Object.values(rails.WRITE_ALLOWLIST).flat()).size, 8);
  assert.ok(Object.isFrozen(rails.WRITE_ALLOWLIST["sbtc-commerce-v5"]) && Object.isFrozen(rails.WRITE_ALLOWLIST["agentic-commerce-v6"]));
  assert.ok(Object.isFrozen(rails.WRITE_ALLOWLIST) && Object.isFrozen(rails.WRITE_ALLOWLIST["agent-registry"]));
});

test("allowed calls pass", () => {
  for (const [c, fns] of Object.entries(rails.WRITE_ALLOWLIST)) for (const f of fns) rails.assertAllowedCall(DEPLOYER, c, f);
});

test("other deployers, contracts and functions are refused", () => {
  const other = "SP000000000000000000002Q6VF78";
  assert.throws(() => rails.assertAllowedCall(other, "agent-registry", "register-agent"), RailError);
  assert.throws(() => rails.assertAllowedCall(DEPLOYER, "sbtc-token", "transfer"), RailError);
  assert.throws(() => rails.assertAllowedCall(DEPLOYER, "sbtc-commerce-v4", "submit-work"), RailError);
  assert.throws(() => rails.assertAllowedCall(DEPLOYER, "__proto__", "submit-work"), RailError);
  assert.throws(() => rails.assertAllowedCall(DEPLOYER, "constructor", "name"), RailError);
  // Client functions that move no assets are allowed on both escrows and nowhere else.
  for (const fn of ["create-job", "set-budget", "assign-provider"]) {
    for (const escrow of ["sbtc-commerce-v5", "agentic-commerce-v6"]) rails.assertAllowedCall(DEPLOYER, escrow, fn);
    assert.throws(() => rails.assertAllowedCall(DEPLOYER, "job-applications-v1", fn), RailError);
    assert.throws(() => rails.assertAllowedCall(DEPLOYER, "agent-registry", fn), RailError);
  }
  // Funding, decisions, settlement and token transfers stay refused everywhere.
  const refused = ["fund-job", "finalize-decision", "record-decision", "complete-job", "reject-job", "claim-refund", "open-appeal",
    "resolve-appeal", "transfer", "transfer-memo", "stx-transfer", "configure"];
  for (const fn of refused) {
    for (const c of Object.values(rails.CONTRACTS)) assert.throws(() => rails.assertAllowedCall(DEPLOYER, c, fn), RailError, `${c}.${fn}`);
  }
  assert.throws(() => rails.assertAllowedCall("SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4", "sbtc-token", "transfer"), RailError);
  assert.throws(() => rails.assertAllowedCall(DEPLOYER, "agent-registry", "submit-work"), RailError);
  assert.throws(() => rails.buildCallOptions({ contractAddress: other, contractName: "agent-registry", functionName: "register-agent", functionArgs: [], nonce: 0, fee: 3000 }), RailError);
});

test("fee: default 3000, env override, hard cap 50000", () => {
  assert.equal(rails.resolveFee({}), 3000n);
  assert.equal(rails.resolveFee({ NAYORI_AGENT_FEE_USTX: "" }), 3000n);
  assert.equal(rails.resolveFee({ NAYORI_AGENT_FEE_USTX: "10000" }), 10000n);
  assert.equal(rails.resolveFee({ NAYORI_AGENT_FEE_USTX: "50000" }), 50000n);
  for (const bad of ["50001", "1000000", "0", "-1", "1e4", "3000.5", "abc", " 3000"]) {
    assert.throws(() => rails.resolveFee({ NAYORI_AGENT_FEE_USTX: bad }), RailError, bad);
  }
  const base = { contractName: "agent-registry", functionName: "register-agent", functionArgs: [], nonce: 0 };
  assert.throws(() => rails.buildCallOptions({ ...base, fee: 50001 }), RailError);
  assert.throws(() => rails.buildCallOptions({ ...base, fee: 0 }), RailError);
});

test("buildCallOptions always yields mainnet + Deny + zero post-conditions and ignores extra fields", () => {
  const o = rails.buildCallOptions({
    contractName: "sbtc-commerce-v5", functionName: "submit-work", functionArgs: [], nonce: 7, fee: 3000,
    postConditionMode: PostConditionMode.Allow, postConditions: ["x"], network: "testnet", sponsored: true,
  });
  assert.equal(o.network, "mainnet");
  assert.equal(o.postConditionMode, PostConditionMode.Deny);
  assert.deepEqual(o.postConditions, []);
  assert.equal(o.contractAddress, DEPLOYER);
  assert.equal(o.sponsored, undefined);
  assert.equal(o.fee, 3000n);
  assert.equal(o.nonce, 7n);
});

test("signed transactions are mainnet contract calls with Deny mode and zero post-conditions (offline)", async () => {
  const k = fakeKey();
  const env = { [ENV_VAR]: writeEnvFile(k) };
  const calls = [
    { contractName: "agent-registry", functionName: "register-agent", functionArgs: [Cl.stringAscii("Test Agent"), Cl.stringAscii("fixture"), Cl.principal(k.address), Cl.list([])] },
    { contractName: "job-applications-v1", functionName: "apply-to-job", functionArgs: [Cl.contractPrincipal(DEPLOYER, "sbtc-commerce-v5"), Cl.contractPrincipal(DEPLOYER, "agent-registry"), Cl.uint(1), Cl.uint(1), Cl.stringAscii("hi")] },
    { contractName: "job-applications-v1", functionName: "withdraw-application", functionArgs: [Cl.uint(2), Cl.uint(1)] },
    { contractName: "agentic-commerce-v6", functionName: "submit-work", functionArgs: [Cl.uint(1), Cl.buffer(rails.deliverableBufferBytes("ipfs://example"))] },
  ];
  for (const call of calls) {
    const { tx } = await signContractCall({ ...call, nonce: 5, fee: 3000 }, { env });
    // Round-trip through the wire format so the assertions are about the real bytes.
    const wire = deserializeTransaction(tx.serialize());
    assert.equal(wire.postConditionMode, PostConditionMode.Deny);
    assert.equal(wire.postConditions.values.length, 0);
    assert.equal(wire.payload.contractName.content, call.contractName);
    assert.equal(wire.payload.functionName.content, call.functionName);
    assert.equal(BigInt(wire.auth.spendingCondition.fee), 3000n);
    assert.equal(BigInt(wire.auth.spendingCondition.nonce), 5n);
    assert.ok(!tx.serialize().includes(k.privateKey));
    rails.assertTransactionIsSafe(wire, call);
  }
});

test("assertTransactionIsSafe rejects Allow mode, token transfers and wrong targets", async () => {
  const k = fakeKey();
  const unsigned = await makeUnsignedContractCall({
    contractAddress: DEPLOYER, contractName: "sbtc-commerce-v5", functionName: "submit-work", functionArgs: [],
    publicKey: privateKeyToPublic(k.privateKey), network: "mainnet", fee: 3000, nonce: 0,
    postConditionMode: PostConditionMode.Allow,
  });
  assert.throws(() => rails.assertTransactionIsSafe(unsigned, { contractName: "sbtc-commerce-v5", functionName: "submit-work" }), /not Deny/);

  const transfer = await makeSTXTokenTransfer({ recipient: DEPLOYER, amount: 1, senderKey: k.privateKey, network: "mainnet", fee: 3000, nonce: 0 });
  assert.throws(() => rails.assertTransactionIsSafe(transfer, { contractName: "x", functionName: "y" }), /not a contract call/);

  const wrong = await makeUnsignedContractCall({
    contractAddress: DEPLOYER, contractName: "sbtc-commerce-v5", functionName: "fund-job", functionArgs: [],
    publicKey: privateKeyToPublic(k.privateKey), network: "mainnet", fee: 3000, nonce: 0, postConditionMode: PostConditionMode.Deny,
  });
  assert.throws(() => rails.assertTransactionIsSafe(wrong, { contractName: "sbtc-commerce-v5", functionName: "fund-job" }), /allowlist/);

  const testnet = await makeUnsignedContractCall({
    contractAddress: "ST000000000000000000002AMW42H", contractName: "sbtc-commerce-v5", functionName: "submit-work", functionArgs: [],
    publicKey: privateKeyToPublic(k.privateKey), network: "testnet", fee: 3000, nonce: 0, postConditionMode: PostConditionMode.Deny,
  });
  assert.throws(() => rails.assertTransactionIsSafe(testnet, { contractName: "sbtc-commerce-v5", functionName: "submit-work" }), /not mainnet/);
});

test("deliverable encoding mirrors the web app: ASCII bytes of the hex SHA-256 of the trimmed reference", () => {
  const ref = "  https://example.com/brief.md \n";
  const hex = createHash("sha256").update("https://example.com/brief.md", "utf8").digest("hex");
  assert.equal(rails.deliverableDigestHex(ref), hex);
  const bytes = rails.deliverableBufferBytes(ref);
  assert.equal(bytes.length, 64);
  assert.equal(Buffer.from(bytes).toString("ascii"), hex);
  assert.deepEqual(Cl.buffer(bytes), Cl.bufferFromAscii(hex.slice(0, 64)));
  assert.throws(() => rails.deliverableDigestHex("   "), RailError);
});

const A = "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE";
const OTHER = "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7";
const openJob = { status: 1, provider: null, client: OTHER, evaluator: OTHER, appealAuthority: OTHER, treasury: OTHER };
const agent = { wallet: A, active: true };

test("apply preconditions", () => {
  rails.checkApplyPreconditions({ job: openJob, agent, signerAddress: A, existingApplication: null });
  rails.checkApplyPreconditions({ job: { ...openJob, status: 0 }, agent, signerAddress: A, existingApplication: { active: false } });
  const bad = (o, re) => assert.throws(() => rails.checkApplyPreconditions({ job: openJob, agent, signerAddress: A, ...o }), re);
  bad({ job: null }, /job not found/);
  for (const status of [2, 3, 4, 5, 6, 7, 8]) bad({ job: { ...openJob, status } }, /job status/);
  bad({ job: { ...openJob, provider: OTHER } }, /already has a provider/);
  bad({ job: { ...openJob, client: A } }, /client/);
  bad({ agent: null }, /agent id not found/);
  bad({ agent: { wallet: OTHER, active: true } }, /wallet is not the signer/);
  bad({ agent: { wallet: A, active: false } }, /not active/);
  bad({ existingApplication: { active: true } }, /already has an active application/);
});

test("submit and withdraw preconditions", () => {
  rails.checkSubmitPreconditions({ job: { status: 1, provider: A }, signerAddress: A });
  assert.throws(() => rails.checkSubmitPreconditions({ job: { status: 1, provider: OTHER }, signerAddress: A }), /not the assigned provider/);
  assert.throws(() => rails.checkSubmitPreconditions({ job: { status: 1, provider: null }, signerAddress: A }), /not the assigned provider/);
  for (const status of [0, 2, 3, 8]) assert.throws(() => rails.checkSubmitPreconditions({ job: { status, provider: A }, signerAddress: A }), /needs 1/);
  assert.throws(() => rails.checkSubmitPreconditions({ job: null, signerAddress: A }), /not found/);
  rails.checkWithdrawPreconditions({ existingApplication: { active: true } });
  assert.throws(() => rails.checkWithdrawPreconditions({ existingApplication: null }), /no active application/);
  assert.throws(() => rails.checkWithdrawPreconditions({ existingApplication: { active: false } }), /no active application/);
});

test("appeal preconditions: only the right party, only while decision-pending, only inside the window", () => {
  const job = { status: 7, client: "SPCLIENT", provider: "SPPROVIDER" };
  const approve = { originalDecision: 1, appealDeadline: 100 };
  const reject = { originalDecision: 2, appealDeadline: 100 };
  rails.checkAppealPreconditions({ job, decision: approve, signerAddress: "SPCLIENT", burnHeight: 100 });
  rails.checkAppealPreconditions({ job, decision: reject, signerAddress: "SPPROVIDER", burnHeight: 1 });
  assert.throws(() => rails.checkAppealPreconditions({ job, decision: approve, signerAddress: "SPPROVIDER", burnHeight: 50 }), /client may appeal an approval/);
  assert.throws(() => rails.checkAppealPreconditions({ job, decision: reject, signerAddress: "SPCLIENT", burnHeight: 50 }), /provider may appeal a rejection/);
  assert.throws(() => rails.checkAppealPreconditions({ job, decision: approve, signerAddress: "SPCLIENT", burnHeight: 101 }), /window is closed/);
  assert.throws(() => rails.checkAppealPreconditions({ job, decision: approve, signerAddress: "SPCLIENT", burnHeight: 0 }), /window is closed/);
  assert.throws(() => rails.checkAppealPreconditions({ job: { ...job, status: 2 }, decision: approve, signerAddress: "SPCLIENT", burnHeight: 50 }), /needs 7/);
  assert.throws(() => rails.checkAppealPreconditions({ job, decision: null, signerAddress: "SPCLIENT", burnHeight: 50 }), /no decision/);
  assert.equal(rails.appealEvidenceBytes("  ref  ").length, 32);
  // Settlement functions stay off the allowlist.
  for (const fn of ["fund-job", "finalize-decision", "resolve-appeal", "record-decision", "settle-review-timeout"]) {
    assert.throws(() => rails.assertAllowedCall(DEPLOYER, "sbtc-commerce-v5", fn));
  }
});
