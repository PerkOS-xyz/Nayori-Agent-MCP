// Provider tools, read tools and the shared write path. No network, fixture keys only.
import test from "node:test";
import assert from "node:assert/strict";
import { deserializeTransaction, PostConditionMode, Cl, Pc, postConditionToWire, serializePostConditionWire } from "@stacks/transactions";
import { tools } from "../lib/tools.mjs";
import { schemas } from "../lib/schemas.mjs";
import * as signer from "../lib/signer.mjs";
import * as rails from "../lib/rails.mjs";
import { runTool, createServer } from "../server.mjs";
import { fakeKey, writeEnvFile, noNetworkChain } from "./helpers.mjs";

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const parse = (r) => JSON.parse(r.content[0].text);
const MAIN = rails.PROFILES.mainnet;
const C = "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7";
const E = MAIN.managedEvaluator;
const T = "SMFE58EKCK5ZPD7YCYM1CQY7K3H8SEXQH7C3YT8S";
const R = "SM3950RVR364J25ZRFFNHB5TCNJ7VKPKKGD4N2RP9";
const job = (o = {}) => ({
  asset: "sbtc", jobId: 4, escrowContract: `${MAIN.deployer}.nayori-escrow-sbtc`, status: "funded", statusCode: 1, client: C, provider: null, evaluator: E,
  treasury: T, appealAuthority: R, budget: "5000", budgetUnit: "sats", description: "Plain job", deliveryDeadline: 1000, deliveryBlocks: 144, reviewBlocks: 144, ...o,
});
const wireOf = (tx) => deserializeTransaction(tx.serialize());
const pcHex = (pcs) => pcs.map((p) => serializePostConditionWire(postConditionToWire(p)));

test("exactly fifteen tools, with the accept step, and none that funds, settles or transfers", () => {
  assert.deepEqual(tools.map((t) => t.name), [
    "nayori_agent_context", "nayori_open_jobs", "nayori_get_job", "nayori_list_applications", "nayori_register_agent",
    "nayori_apply_to_job", "nayori_withdraw_application", "nayori_accept_job", "nayori_submit_work", "nayori_provider_submit_committed",
    "nayori_evaluation_request", "nayori_appeal_decision", "nayori_client_create_job", "nayori_client_name_provider", "nayori_tx_status",
  ]);
  for (const t of tools) assert.ok(!/transfer|send|pay|fund|swap|settle|refund|decide/i.test(t.name), t.name);
  for (const t of tools) assert.ok(!/—/.test(t.description), `${t.name} has an em dash`);
  assert.deepEqual(tools.filter((t) => t.readOnly).map((t) => t.name), [
    "nayori_agent_context", "nayori_open_jobs", "nayori_get_job", "nayori_list_applications", "nayori_evaluation_request", "nayori_tx_status",
  ]);
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
  for (const jobId of [0, -1, 1.5, "1"]) no("nayori_get_job", { asset: "stx", jobId });
  no("nayori_get_job", { jobId: 1 });
  ok("nayori_register_agent", { name: "Brief Writer" });
  ok("nayori_register_agent", { name: "Brief Writer", uri: "https://example.com/agent.json" });
  no("nayori_register_agent", { name: "" });
  no("nayori_register_agent", { name: "   " });
  no("nayori_register_agent", { name: "x".repeat(65) });
  no("nayori_register_agent", { name: "ok", uri: "x".repeat(257) });
  no("nayori_register_agent", { name: "café" });
  no("nayori_register_agent", { name: "line\nbreak" });
  // Unknown keys are rejected, so input can never smuggle a wallet, fee, contract or post-condition.
  no("nayori_register_agent", { name: "ok", wallet: "SP000000000000000000002Q6VF78" });
  no("nayori_register_agent", { name: "ok", description: "the old registry field" });
  ok("nayori_apply_to_job", { jobId: 1, deposit: 100 });
  ok("nayori_apply_to_job", { asset: "sbtc", jobId: 1, deposit: 1_000_000 });
  for (const deposit of [99, 1_000_001, 1.5, "500"]) no("nayori_apply_to_job", { jobId: 1, deposit });
  no("nayori_apply_to_job", { asset: "stx", jobId: 1, deposit: 500 });
  no("nayori_apply_to_job", { jobId: 1, deposit: 500, fee: 1 });
  no("nayori_apply_to_job", { jobId: 1, deposit: 500, sender: C });
  no("nayori_apply_to_job", { jobId: 1, agentId: 1 });
  ok("nayori_withdraw_application", { jobId: 1 });
  no("nayori_withdraw_application", { asset: "stx", jobId: 1 });
  ok("nayori_accept_job", { asset: "stx", jobId: 1 });
  no("nayori_accept_job", { asset: "stx", jobId: 1, provider: C });
  no("nayori_submit_work", { asset: "sbtc", jobId: 1, deliverableReference: "x", contract: "evil" });
  no("nayori_submit_work", { asset: "sbtc", jobId: 1, deliverableReference: "  " });
  ok("nayori_tx_status", { txid: "0x" + "ab".repeat(32) });
  ok("nayori_tx_status", { txid: "ab".repeat(32) });
  no("nayori_tx_status", { txid: "0x1234" });
});

test("read-only mode: every write tool returns a clear error and touches no network", async () => {
  const deps = { chain: noNetworkChain(), signer, env: {} };
  const inputs = {
    nayori_register_agent: { name: "Agent" },
    nayori_apply_to_job: { jobId: 1, deposit: 500 },
    nayori_withdraw_application: { jobId: 1 },
    nayori_accept_job: { asset: "sbtc", jobId: 1 },
    nayori_submit_work: { asset: "sbtc", jobId: 1, deliverableReference: "ipfs://x" },
    nayori_appeal_decision: { asset: "sbtc", jobId: 1, appealReference: "ipfs://why" },
    nayori_client_name_provider: { asset: "sbtc", jobId: 1, provider: C },
  };
  for (const [name, input] of Object.entries(inputs)) {
    const r = await runTool(byName[name], input, deps);
    assert.equal(r.isError, true, name);
    assert.match(parse(r).error, /Read-only mode: NAYORI_AGENT_ENV_FILE is not set/, name);
  }
  const ctx = parse(await runTool(byName.nayori_agent_context, {}, deps));
  assert.equal(ctx.mode, "read-only");
  assert.equal(ctx.address, null);
  assert.equal(ctx.network, "mainnet");
  assert.equal(ctx.feeMicroStx, "3000");
  assert.equal(ctx.maxApplicationDepositSats, "10000");
  assert.equal(ctx.contracts.escrowSbtc, "SP2BM4WCNQM286PFHPGA1BG2YXER0PCG1PKQ5MF1X.nayori-escrow-sbtc");
  assert.equal(ctx.committedEvaluations.sdkSupportsNetwork, true);
  const t = parse(await runTool(byName.nayori_agent_context, {}, { ...deps, env: { NAYORI_AGENT_NETWORK: "testnet" } }));
  assert.equal(t.network, "testnet");
  assert.equal(t.contracts.agents, "ST3MRPNX0VNWYRSJ07PNTASE5BZ9K5XE57ARZ39DY.nayori-agents");
  assert.equal(t.managedEvaluator, rails.PROFILES.testnet.managedEvaluator);
});

test("invalid input is rejected before any handler runs", async () => {
  const r = await runTool(byName.nayori_accept_job, { asset: "doge", jobId: 1 }, { chain: noNetworkChain(), signer, env: {} });
  assert.equal(r.isError, true);
  assert.equal(parse(r).error, "Invalid input");
});

function stubChain(k, overrides = {}) {
  const sent = [];
  const chain = noNetworkChain({
    getPendingMempoolCount: async () => 0,
    getNextNonce: async () => 12,
    broadcast: async (tx) => (sent.push(tx), "0x" + tx.txid()),
    getBurnHeight: async () => 900,
    getJob: async () => job(),
    getAgent: async () => ({ wallet: k.address, name: "Fixture Agent", uri: "", registeredAt: 1 }),
    getApplication: async () => null,
    getApplications: async () => [],
    getSbtcBalance: async () => "50000",
    ...overrides,
  });
  return { chain, sent };
}
const signing = (k, extra = {}) => ({ [signer.ENV_VAR]: writeEnvFile(k), ...extra });

test("register: one agent per wallet, name and uri on nayori-agents, no post-conditions", async () => {
  const k = fakeKey();
  const { chain, sent } = stubChain(k, { getAgent: async () => null });
  const r = await runTool(byName.nayori_register_agent, { name: "Brief Writer", uri: "https://example.com/a.json" }, { chain, signer, env: signing(k) });
  assert.equal(r.isError, undefined, r.content[0].text);
  const out = parse(r);
  assert.equal(out.contract, "SP2BM4WCNQM286PFHPGA1BG2YXER0PCG1PKQ5MF1X.nayori-agents");
  assert.equal(out.function, "register");
  const wire = wireOf(sent[0]);
  assert.equal(wire.postConditionMode, PostConditionMode.Deny);
  assert.equal(wire.postConditions.values.length, 0);
  assert.deepEqual(wire.payload.functionArgs, [Cl.stringAscii("Brief Writer"), Cl.stringAscii("https://example.com/a.json")]);

  const again = stubChain(k);
  const no = await runTool(byName.nayori_register_agent, { name: "Again" }, { chain: again.chain, signer, env: signing(k) });
  assert.equal(no.isError, true);
  assert.match(parse(no).error, /one agent per wallet/);
  assert.equal(again.sent.length, 0);
});

test("apply: the signer sends exactly the deposit and the applications contract at most the deposit", async () => {
  const k = fakeKey();
  const { chain, sent } = stubChain(k);
  const r = await runTool(byName.nayori_apply_to_job, { jobId: 4, deposit: 2500 }, { chain, signer, env: signing(k, { NAYORI_AGENT_FEE_USTX: "4000" }) });
  assert.equal(r.isError, undefined, r.content[0].text);
  const out = parse(r);
  assert.match(out.txid, /^0x[0-9a-f]{64}$/);
  assert.ok(out.explorerUrl.endsWith(`${out.txid}?chain=mainnet`));
  assert.match(out.note, /NOT confirmation/);
  assert.equal(out.deposit, "2500");
  assert.equal(out.postConditions, 2);
  assert.ok(!r.content[0].text.includes(k.privateKey));
  assert.equal(sent.length, 1);
  const wire = wireOf(sent[0]);
  assert.equal(wire.postConditionMode, PostConditionMode.Deny);
  assert.equal(wire.payload.contractName.content, "nayori-applications");
  assert.equal(wire.payload.functionName.content, "apply-to-job");
  assert.deepEqual(wire.payload.functionArgs, [Cl.uint(4), Cl.uint(2500)]);
  assert.deepEqual(wire.postConditions.values.map((w) => serializePostConditionWire(w)), pcHex([
    Pc.principal(k.address).willSendEq(2500n).ft(MAIN.sbtcToken, "sbtc-token"),
    Pc.principal(`${MAIN.deployer}.nayori-applications`).willSendLte(2500n).ft(MAIN.sbtcToken, "sbtc-token"),
  ]));
  assert.equal(BigInt(wire.auth.spendingCondition.fee), 4000n);
  assert.equal(BigInt(wire.auth.spendingCondition.nonce), 12n);
});

test("apply refusals never sign", async () => {
  const k = fakeKey();
  const cases = [
    [{ deposit: 10_001 }, {}, {}, /exceeds NAYORI_AGENT_MAX_DEPOSIT_SATS/],
    [{}, { getPendingMempoolCount: async () => 1 }, {}, /pending mempool/],
    [{}, { getJob: async () => null }, {}, /job not found/],
    [{}, { getJob: async () => job({ status: "accepted", provider: C }) }, {}, /needs open or funded or offered/],
    [{}, { getBurnHeight: async () => 1000 }, {}, /deadline .* has passed/],
    [{}, { getAgent: async () => null }, {}, /Register first/],
    [{}, { getApplication: async () => ({ applicant: "x", deposit: "100" }) }, {}, /already applied/],
    [{}, { getSbtcBalance: async () => "100" }, {}, /holds 100 sats/],
    [{}, { getJob: async () => job({ evaluator: k.address }) }, {}, /signer is the evaluator/],
    [{}, {}, { NAYORI_AGENT_MAX_DEPOSIT_SATS: "100" }, /exceeds NAYORI_AGENT_MAX_DEPOSIT_SATS \(100 sats\)/],
    [{}, {}, { NAYORI_AGENT_MAX_DEPOSIT_SATS: "5" }, /must be 100 to 1000000/],
  ];
  for (const [input, overrides, env, re] of cases) {
    const { chain, sent } = stubChain(k, overrides);
    const r = await runTool(byName.nayori_apply_to_job, { jobId: 4, deposit: 500, ...input }, { chain, signer, env: signing(k, env) });
    assert.equal(r.isError, true, String(re));
    assert.match(parse(r).error, re);
    assert.equal(sent.length, 0);
  }
});

test("withdraw: the applications contract sends back exactly the recorded deposit", async () => {
  const k = fakeKey();
  const { chain, sent } = stubChain(k, { getApplication: async () => ({ applicant: k.address, deposit: "777" }) });
  const out = parse(await runTool(byName.nayori_withdraw_application, { jobId: 4 }, { chain, signer, env: signing(k) }));
  assert.equal(out.refundSats, "777");
  const wire = wireOf(sent[0]);
  assert.equal(wire.payload.functionName.content, "withdraw");
  assert.deepEqual(wire.payload.functionArgs, [Cl.uint(4)]);
  assert.deepEqual(wire.postConditions.values.map((w) => serializePostConditionWire(w)), pcHex([
    Pc.principal(`${MAIN.deployer}.nayori-applications`).willSendEq(777n).ft(MAIN.sbtcToken, "sbtc-token"),
  ]));
  const none = stubChain(k);
  const r = await runTool(byName.nayori_withdraw_application, { jobId: 4 }, { chain: none.chain, signer, env: signing(k) });
  assert.match(parse(r).error, /no application/);
  assert.equal(none.sent.length, 0);
});

test("accept: only the offered provider, before the deadline, no post-conditions", async () => {
  const k = fakeKey();
  const offered = job({ asset: "stx", status: "offered", provider: k.address });
  const { chain, sent } = stubChain(k, { getJob: async () => offered });
  const out = parse(await runTool(byName.nayori_accept_job, { asset: "stx", jobId: 4 }, { chain, signer, env: signing(k) }));
  assert.equal(out.function, "accept-job");
  assert.equal(out.contract, `${MAIN.deployer}.nayori-escrow-stx`);
  assert.equal(out.deliverByAboutBurnHeight, 900 + 144);
  assert.equal(out.committedCriteria, false);
  const wire = wireOf(sent[0]);
  assert.equal(wire.postConditions.values.length, 0);
  assert.deepEqual(wire.payload.functionArgs, [Cl.uint(4)]);
  for (const [o, re] of [
    [{ getJob: async () => ({ ...offered, provider: C }) }, /offered to another provider/],
    [{ getJob: async () => ({ ...offered, status: "funded", provider: null }) }, /accept-job needs offered/],
    [{ getBurnHeight: async () => 1000, getJob: async () => offered }, /has passed/],
  ]) {
    const s = stubChain(k, o);
    const r = await runTool(byName.nayori_accept_job, { asset: "stx", jobId: 4 }, { chain: s.chain, signer, env: signing(k) });
    assert.match(parse(r).error, re);
    assert.equal(s.sent.length, 0);
  }
});

test("submit_work: plain deliverable on an accepted job; refused before acceptance and on committed jobs", async () => {
  const k = fakeKey();
  const accepted = job({ asset: "stx", status: "accepted", provider: k.address });
  const { chain, sent } = stubChain(k, { getJob: async () => accepted });
  const r = await runTool(byName.nayori_submit_work, { asset: "stx", jobId: 3, deliverableReference: "ipfs://bafy" }, { chain, signer, env: signing(k) });
  assert.equal(r.isError, undefined, r.content[0].text);
  const wire = wireOf(sent[0]);
  assert.equal(wire.postConditions.values.length, 0);
  assert.equal(wire.payload.contractName.content, "nayori-escrow-stx");
  assert.equal(wire.payload.functionName.content, "submit-work");
  assert.equal(Buffer.from(wire.payload.functionArgs[1].value, "hex").toString("ascii"), rails.deliverableDigestHex("ipfs://bafy"));
  for (const [j, re] of [
    [{ ...accepted, status: "offered" }, /Accept it first with nayori_accept_job/],
    [{ ...accepted, description: `Plain\nnayori-criteria-v1:${"ab".repeat(32)}` }, /use nayori_provider_submit_committed|Deliver with nayori_provider_submit_committed/],
  ]) {
    const s = stubChain(k, { getJob: async () => j });
    const bad = await runTool(byName.nayori_submit_work, { asset: "stx", jobId: 3, deliverableReference: "x" }, { chain: s.chain, signer, env: signing(k) });
    assert.match(parse(bad).error, re);
    assert.equal(s.sent.length, 0);
  }
});

test("testnet when configured: testnet contracts, chain id and explorer link", async () => {
  const k = fakeKey("testnet");
  const { chain, sent } = stubChain(k, { getAgent: async () => null });
  const out = parse(await runTool(byName.nayori_register_agent, { name: "T" }, { chain, signer, env: signing(k, { NAYORI_AGENT_NETWORK: "testnet" }) }));
  assert.equal(out.network, "testnet");
  assert.equal(out.contract, "ST3MRPNX0VNWYRSJ07PNTASE5BZ9K5XE57ARZ39DY.nayori-agents");
  assert.ok(out.explorerUrl.endsWith("?chain=testnet"));
  assert.equal(wireOf(sent[0]).chainId, rails.PROFILES.testnet.chainId);
  // A mainnet key is refused on testnet and nothing is signed.
  const m = fakeKey();
  const s = stubChain(m, { getAgent: async () => null });
  const r = await runTool(byName.nayori_register_agent, { name: "T" }, { chain: s.chain, signer, env: signing(m, { NAYORI_AGENT_NETWORK: "testnet" }) });
  assert.match(parse(r).error, /testnet single-sig address/);
  assert.equal(s.sent.length, 0);
});

test("an over-cap fee env blocks every write", async () => {
  const k = fakeKey();
  const { chain, sent } = stubChain(k);
  const r = await runTool(byName.nayori_register_agent, { name: "A" }, { chain, signer, env: signing(k, { NAYORI_AGENT_FEE_USTX: "50001" }) });
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /hard cap/);
  assert.equal(sent.length, 0);
});

test("read tools: open jobs, job status and applications", async () => {
  const k = fakeKey();
  const jobs = {
    sbtc: { 1: job({ jobId: 1, status: "completed" }), 2: job({ jobId: 2, status: "offered", provider: k.address }), 3: job({ jobId: 3, status: "open", deliveryDeadline: 800 }), 4: job({ jobId: 4 }) },
    stx: { 1: job({ asset: "stx", jobId: 1, budgetUnit: "microSTX" }) },
  };
  const apps = [{ applicant: C, deposit: "900" }, { applicant: k.address, deposit: "300" }];
  const chain = noNetworkChain({
    getBurnHeight: async () => 900,
    getJobCount: async (asset) => Object.keys(jobs[asset]).length,
    getJob: async (asset, id) => jobs[asset][id] ?? null,
    getApplications: async () => apps,
    getSubmission: async () => null,
    getDecision: async () => null,
    getEscrowBalance: async () => "5000",
  });
  const deps = { chain, signer, env: signing(k) };
  const open = parse(await runTool(byName.nayori_open_jobs, {}, deps));
  assert.deepEqual(open.openJobs.map((j) => `${j.asset}#${j.jobId}`), ["sbtc#4", "sbtc#2", "stx#1"]);
  const [four, two, stx] = open.openJobs;
  assert.deepEqual(four.applications, { count: 2, highestDeposit: "900", lowestDeposit: "300", full: false, youApplied: true });
  assert.equal(four.blocksLeft, 100);
  assert.equal(two.offeredToYou, true);
  assert.equal(four.offeredToYou, false);
  assert.equal(stx.applications, null);
  assert.match(stx.howToGetHired, /no applications/);

  const status = parse(await runTool(byName.nayori_get_job, { asset: "sbtc", jobId: 2 }, deps));
  assert.equal(status.found, true);
  assert.equal(status.job.status, "offered");
  assert.equal(status.escrowBalance, "5000");
  assert.equal(status.burnHeight, 900);
  assert.equal(status.committedCriteria, false);
  assert.match(status.next, /accepts with nayori_accept_job/);
  assert.deepEqual(parse(await runTool(byName.nayori_get_job, { asset: "sbtc", jobId: 9 }, deps)), { found: false, asset: "sbtc", jobId: 9 });

  const list = parse(await runTool(byName.nayori_list_applications, { jobId: 4 }, deps));
  assert.equal(list.applicationCount, 2);
  assert.equal(list.takesApplications, true);
  assert.deepEqual(list.applications, apps);
});

test("tx_status explains Nayori errors and links the configured network", async () => {
  const chain = noNetworkChain({ getTxStatus: async (txid) => ({ txid, found: true, status: "abort_by_response", result: "(err u607)" }) });
  const out = parse(await runTool(byName.nayori_tx_status, { txid: "0x" + "ab".repeat(32) }, { chain, signer, env: {} }));
  assert.deepEqual(out.error, { code: 607, name: "ERR_LIST_FULL", message: "The list is full and the deposit does not beat the lowest entry." });
  assert.ok(out.explorerUrl.endsWith("?chain=mainnet"));
});
