import test from "node:test";
import assert from "node:assert/strict";
import { deserializeTransaction, PostConditionMode } from "@stacks/transactions";
import { tools } from "../lib/tools.mjs";
import { schemas } from "../lib/schemas.mjs";
import * as signer from "../lib/signer.mjs";
import { runTool, createServer } from "../server.mjs";
import { fakeKey, writeEnvFile, noNetworkChain } from "./helpers.mjs";

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const parse = (r) => JSON.parse(r.content[0].text);

test("exactly the fifteen tools (the original nine unchanged), and none that transfers value", () => {
  assert.deepEqual(tools.map((t) => t.name), [
    "nayori_agent_context", "nayori_open_jobs", "nayori_get_job", "nayori_list_applications", "nayori_register_agent",
    "nayori_apply_to_job", "nayori_withdraw_application", "nayori_submit_work",
    "nayori_client_create_job", "nayori_client_set_budget", "nayori_appeal_decision", "nayori_client_assign_provider", "nayori_provider_submit_committed",
    "nayori_evaluation_request", "nayori_tx_status",
  ]);
  for (const t of tools) assert.ok(!/transfer|send|pay|fund|swap/i.test(t.name), t.name);
  assert.ok(createServer({ chain: noNetworkChain(), signer, env: {} }));
});

test("input validation", () => {
  const ok = (n, v) => assert.ok(schemas[n].safeParse(v).success, `${n} ${JSON.stringify(v)}`);
  const no = (n, v) => assert.ok(!schemas[n].safeParse(v).success, `${n} ${JSON.stringify(v)}`);
  ok("nayori_open_jobs", {});
  ok("nayori_open_jobs", { asset: "sbtc", limit: 5 });
  no("nayori_open_jobs", { asset: "btc" });
  no("nayori_open_jobs", { limit: 0 });
  no("nayori_open_jobs", { limit: 51 });
  ok("nayori_get_job", { asset: "stx", jobId: 1 });
  no("nayori_get_job", { asset: "stx", jobId: -1 });
  no("nayori_get_job", { asset: "stx", jobId: 1.5 });
  no("nayori_get_job", { asset: "stx", jobId: "1" });
  no("nayori_get_job", { jobId: 1 });
  ok("nayori_register_agent", { name: "Brief Writer", description: "" });
  no("nayori_register_agent", { name: "", description: "x" });
  no("nayori_register_agent", { name: "   ", description: "x" });
  no("nayori_register_agent", { name: "x".repeat(65), description: "x" });
  no("nayori_register_agent", { name: "ok", description: "x".repeat(257) });
  no("nayori_register_agent", { name: "café", description: "x" });
  no("nayori_register_agent", { name: "line\nbreak", description: "x" });
  // Unknown keys are rejected, so input can never smuggle a wallet, fee, contract or post-condition.
  no("nayori_register_agent", { name: "ok", description: "x", wallet: "SP000000000000000000002Q6VF78" });
  no("nayori_apply_to_job", { asset: "sbtc", jobId: 1, agentId: 1, fee: 1 });
  no("nayori_submit_work", { asset: "sbtc", jobId: 1, deliverableReference: "x", contract: "evil" });
  ok("nayori_apply_to_job", { asset: "sbtc", jobId: 1, agentId: 1 });
  ok("nayori_apply_to_job", { asset: "sbtc", jobId: 1, agentId: 1, note: "x".repeat(140) });
  no("nayori_apply_to_job", { asset: "sbtc", jobId: 1, agentId: 1, note: "x".repeat(141) });
  no("nayori_apply_to_job", { asset: "sbtc", jobId: 1, agentId: 1, note: "tab\there" });
  no("nayori_submit_work", { asset: "sbtc", jobId: 1, deliverableReference: "  " });
  ok("nayori_tx_status", { txid: "0x" + "ab".repeat(32) });
  ok("nayori_tx_status", { txid: "ab".repeat(32) });
  no("nayori_tx_status", { txid: "0x1234" });
});

test("read-only mode: every write tool returns a clear error and touches no network", async () => {
  const deps = { chain: noNetworkChain(), signer, env: {} };
  const inputs = {
    nayori_register_agent: { name: "Agent", description: "d" },
    nayori_apply_to_job: { asset: "sbtc", jobId: 1, agentId: 1 },
    nayori_withdraw_application: { asset: "sbtc", jobId: 1 },
    nayori_submit_work: { asset: "sbtc", jobId: 1, deliverableReference: "ipfs://x" },
  };
  for (const [name, input] of Object.entries(inputs)) {
    const r = await runTool(byName[name], input, deps);
    assert.equal(r.isError, true, name);
    assert.match(parse(r).error, /Read-only mode: NAYORI_AGENT_ENV_FILE is not set/);
  }
  const ctx = parse(await runTool(byName.nayori_agent_context, {}, deps));
  assert.equal(ctx.mode, "read-only");
  assert.equal(ctx.address, null);
  assert.equal(ctx.feeMicroStx, "3000");
});

test("invalid input is rejected before any handler runs", async () => {
  const r = await runTool(byName.nayori_apply_to_job, { asset: "doge", jobId: 1, agentId: 1 }, { chain: noNetworkChain(), signer, env: {} });
  assert.equal(r.isError, true);
  assert.equal(parse(r).error, "Invalid input");
});

function stubChain(k, overrides = {}) {
  const sent = [];
  const chain = noNetworkChain({
    getPendingMempoolCount: async () => 0,
    getNextNonce: async () => 12,
    broadcast: async (tx) => (sent.push(tx), "0x" + tx.txid()),
    getJob: async () => ({ status: 1, provider: null, client: "c", evaluator: "e", appealAuthority: "a", treasury: "t" }),
    getAgent: async () => ({ wallet: k.address, active: true }),
    getApplication: async () => null,
    ...overrides,
  });
  return { chain, sent };
}

test("write path with a stubbed chain: refuses on pending mempool tx, never broadcasts", async () => {
  const k = fakeKey();
  const { chain, sent } = stubChain(k, { getPendingMempoolCount: async () => 1 });
  const r = await runTool(byName.nayori_apply_to_job, { asset: "sbtc", jobId: 1, agentId: 1 }, { chain, signer, env: { [signer.ENV_VAR]: writeEnvFile(k) } });
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /pending mempool/);
  assert.equal(sent.length, 0);
});

test("write path with a stubbed chain: refusals from fresh state never sign", async () => {
  const k = fakeKey();
  const env = { [signer.ENV_VAR]: writeEnvFile(k) };
  const cases = [
    [byName.nayori_apply_to_job, { asset: "sbtc", jobId: 1, agentId: 1 }, { getAgent: async () => ({ wallet: fakeKey().address, active: true }) }, /wallet is not the signer/],
    [byName.nayori_apply_to_job, { asset: "sbtc", jobId: 1, agentId: 1 }, { getJob: async () => ({ status: 2, provider: null }) }, /job status is 2/],
    [byName.nayori_submit_work, { asset: "sbtc", jobId: 1, deliverableReference: "x" }, {}, /not the assigned provider/],
    [byName.nayori_withdraw_application, { asset: "stx", jobId: 1 }, {}, /no active application/],
  ];
  for (const [tool, input, overrides, re] of cases) {
    const { chain, sent } = stubChain(k, overrides);
    const r = await runTool(tool, input, { chain, signer, env });
    assert.equal(r.isError, true);
    assert.match(parse(r).error, re);
    assert.equal(sent.length, 0);
  }
});

test("write path with a stubbed chain: the broadcast transaction is Deny + zero post-conditions and the result has no key", async () => {
  const k = fakeKey();
  const env = { [signer.ENV_VAR]: writeEnvFile(k), NAYORI_AGENT_FEE_USTX: "4000" };
  const { chain, sent } = stubChain(k, { getJob: async () => ({ status: 1, provider: k.address }) });
  const r = await runTool(byName.nayori_submit_work, { asset: "stx", jobId: 3, deliverableReference: "ipfs://bafy" }, { chain, signer, env });
  assert.equal(r.isError, undefined);
  const out = parse(r);
  assert.match(out.txid, /^0x[0-9a-f]{64}$/);
  assert.ok(out.explorerUrl.includes(out.txid));
  assert.match(out.note, /NOT confirmation/);
  assert.ok(!r.content[0].text.includes(k.privateKey));
  assert.equal(sent.length, 1);
  const wire = deserializeTransaction(sent[0].serialize());
  assert.equal(wire.postConditionMode, PostConditionMode.Deny);
  assert.equal(wire.postConditions.values.length, 0);
  assert.equal(wire.payload.contractName.content, "agentic-commerce-v6");
  assert.equal(wire.payload.functionName.content, "submit-work");
  assert.equal(BigInt(wire.auth.spendingCondition.fee), 4000n);
  assert.equal(BigInt(wire.auth.spendingCondition.nonce), 12n);
});

test("an over-cap fee env blocks every write", async () => {
  const k = fakeKey();
  const { chain, sent } = stubChain(k);
  const r = await runTool(byName.nayori_register_agent, { name: "A", description: "" }, { chain, signer, env: { [signer.ENV_VAR]: writeEnvFile(k), NAYORI_AGENT_FEE_USTX: "50001" } });
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /hard cap/);
  assert.equal(sent.length, 0);
});
