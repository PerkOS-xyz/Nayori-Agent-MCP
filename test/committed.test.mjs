// Client tools and committed-evaluation tools. No network, fixture keys only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { deserializeTransaction, PostConditionMode, Cl, cvToValue } from "@stacks/transactions";
import { tools } from "../lib/tools.mjs";
import { schemas } from "../lib/schemas.mjs";
import * as signer from "../lib/signer.mjs";
import * as rails from "../lib/rails.mjs";
import { sdkCommitments, MAX_PLAIN_DESCRIPTION } from "../lib/commitments.mjs";
import { runTool } from "../server.mjs";
import { fakeKey, writeEnvFile, noNetworkChain, testnetShimCommitments } from "./helpers.mjs";

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const parse = (r) => JSON.parse(r.content[0].text);

const EVALUATOR = rails.MANAGED_EVALUATOR;
const APPEAL = "SP2R584GC8W2A921080TY8CQ8P1GZ6JNXYXS65DA6";
const TREASURY = "SP1NT1V4X6GQR6T32Z8MSMNECZ6GSWX9HZ81SM1Y8";
const criteria = [
  { id: "brief", requirement: "A 300 word brief about Clarity post-conditions.", verification: "Count the words and check the topic." },
  { id: "format", requirement: "Markdown file.", verification: "The media type is text/markdown." },
];
const evidence = [{ id: "brief-md", uri: "https://example.com/brief.md", sha256: "ab".repeat(32), mediaType: "text/markdown", sizeBytes: 2048 }];
const DESCRIPTION = "Write a short brief about Clarity post-conditions.";

function setup(overrides = {}) {
  const k = fakeKey();
  const sent = [];
  const commitments = testnetShimCommitments();
  const chain = noNetworkChain({
    getPendingMempoolCount: async () => 0,
    getNextNonce: async () => 7,
    broadcast: async (tx) => (sent.push(tx), "0x" + tx.txid()),
    getProtocolConfig: async () => ({ appealAuthority: APPEAL, treasury: TREASURY }),
    getTenureHeight: async () => 256_000,
    getApplication: async () => null,
    ...overrides,
  });
  return { k, sent, commitments, deps: { chain, signer, commitments, env: { [signer.ENV_VAR]: writeEnvFile(k) } } };
}
const wireOf = (tx) => deserializeTransaction(tx.serialize());
function assertSafeWire(wire, contractName, functionName) {
  assert.equal(wire.postConditionMode, PostConditionMode.Deny);
  assert.equal(wire.postConditions.values.length, 0);
  assert.equal(wire.payload.contractName.content, contractName);
  assert.equal(wire.payload.functionName.content, functionName);
  rails.assertTransactionIsSafe(wire, { contractName, functionName });
}

/** A job as lib/chain.mjs would return it, committed with the same shim the tools use. */
async function committedJob({ client, provider = null, status = 1, asset = "sbtc", jobId = 9, deliverableHex = null }) {
  const c = testnetShimCommitments();
  const contract = `${rails.DEPLOYER}.${rails.ASSETS[asset].escrow}`;
  const { description } = await c.prepareEvaluationJob({ network: "mainnet", asset, contract, client, evaluator: EVALUATOR, description: DESCRIPTION, acceptanceCriteria: criteria });
  return {
    asset, jobId, client, provider, evaluator: EVALUATOR, appealAuthority: APPEAL, treasury: TREASURY, description, status,
    budget: "5000", budgetUnit: "sats", deliverableHex, reviewDeadline: status === 2 ? 967_700 : null,
  };
}

test("only lib/commitments.mjs imports the SDK, and only the four commitment functions", () => {
  for (const f of readdirSync(new URL("../lib/", import.meta.url))) {
    const src = readFileSync(new URL(`../lib/${f}`, import.meta.url), "utf8");
    if (f !== "commitments.mjs") assert.ok(!/from\s+"@perkos\/agent-sdk"/.test(src), f);
  }
  const src = readFileSync(new URL("../lib/commitments.mjs", import.meta.url), "utf8");
  const imported = src.match(/import\s*{([^}]+)}\s*from\s*"@perkos\/agent-sdk"/)[1].split(",").map((s) => s.trim()).filter(Boolean).sort();
  assert.deepEqual(imported, ["evaluationJobId", "parseEvaluationDescription", "prepareEvaluationJob", "prepareEvaluationSubmission"]);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies["@perkos/agent-sdk"], "0.9.1");
});

test("input validation for the new tools", () => {
  const ok = (n, v) => assert.ok(schemas[n].safeParse(v).success, `${n} ${JSON.stringify(v)}`);
  const no = (n, v) => assert.ok(!schemas[n].safeParse(v).success, `${n} ${JSON.stringify(v)}`);
  const create = { asset: "sbtc", description: DESCRIPTION, acceptanceCriteria: criteria };
  ok("nayori_client_create_job", create);
  ok("nayori_client_create_job", { ...create, evaluator: EVALUATOR, provider: APPEAL, expiresInTenures: 12 });
  ok("nayori_client_create_job", { ...create, description: "x".repeat(MAX_PLAIN_DESCRIPTION), expiresInTenures: 4320 });
  assert.equal(MAX_PLAIN_DESCRIPTION, 428);
  no("nayori_client_create_job", { ...create, description: "x".repeat(MAX_PLAIN_DESCRIPTION + 1) });
  no("nayori_client_create_job", { ...create, description: "line\nbreak" });
  no("nayori_client_create_job", { ...create, description: "café" });
  no("nayori_client_create_job", { ...create, description: "x nayori-criteria-v1:" + "0".repeat(64) });
  no("nayori_client_create_job", { ...create, expiresInTenures: 11 });
  no("nayori_client_create_job", { ...create, expiresInTenures: 4321 });
  no("nayori_client_create_job", { ...create, acceptanceCriteria: [] });
  no("nayori_client_create_job", { ...create, acceptanceCriteria: Array.from({ length: 21 }, (_, i) => ({ ...criteria[0], id: `c${i}` })) });
  no("nayori_client_create_job", { ...create, acceptanceCriteria: [criteria[0], criteria[0]] });
  no("nayori_client_create_job", { ...create, acceptanceCriteria: [{ ...criteria[0], extra: 1 }] });
  no("nayori_client_create_job", { ...create, evaluator: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5" });
  no("nayori_client_create_job", { ...create, evaluator: `${rails.DEPLOYER}.agent-registry` });
  // No input can smuggle an amount, a fee, an expiry height or a post-condition.
  for (const extra of [{ budget: 1 }, { amount: 1 }, { fee: 1 }, { expiredAt: 1 }, { postConditionMode: "allow" }]) no("nayori_client_create_job", { ...create, ...extra });
  ok("nayori_client_set_budget", { asset: "stx", jobId: 1, amount: 1 });
  for (const amount of [0, -1, 1.5, "5", Number.MAX_SAFE_INTEGER + 1]) no("nayori_client_set_budget", { asset: "stx", jobId: 1, amount });
  no("nayori_client_set_budget", { asset: "stx", jobId: 0, amount: 1 });
  ok("nayori_client_assign_provider", { asset: "stx", jobId: 1, provider: APPEAL });
  no("nayori_client_assign_provider", { asset: "stx", jobId: 1, provider: "SP123" });
  const submit = { asset: "sbtc", jobId: 1, acceptanceCriteria: criteria, evidence };
  ok("nayori_provider_submit_committed", submit);
  ok("nayori_evaluation_request", submit);
  no("nayori_provider_submit_committed", { ...submit, evidence: [] });
  no("nayori_provider_submit_committed", { ...submit, evidence: Array.from({ length: 6 }, (_, i) => ({ ...evidence[0], id: `e${i}` })) });
  for (const bad of [{ uri: "http://example.com/x" }, { uri: "https://user:pw@example.com/x" }, { uri: "https://example.com/x#frag" }, { uri: "ipfs://x" },
    { sha256: "AB".repeat(32) }, { sha256: "0".repeat(64) }, { sha256: "ab" }, { sizeBytes: -1 }, { sizeBytes: 25_000_001 }, { mediaType: "" }]) {
    no("nayori_provider_submit_committed", { ...submit, evidence: [{ ...evidence[0], ...bad }] });
  }
});

test("read-only mode: the new write tools return a clear error and touch no network or SDK", async () => {
  const deps = { chain: noNetworkChain(), signer, env: {} };
  const inputs = {
    nayori_client_create_job: { asset: "sbtc", description: DESCRIPTION, acceptanceCriteria: criteria },
    nayori_client_set_budget: { asset: "sbtc", jobId: 1, amount: 1000 },
    nayori_client_assign_provider: { asset: "sbtc", jobId: 1, provider: APPEAL },
    nayori_provider_submit_committed: { asset: "sbtc", jobId: 1, acceptanceCriteria: criteria, evidence },
  };
  for (const [name, input] of Object.entries(inputs)) {
    const r = await runTool(byName[name], input, deps);
    assert.equal(r.isError, true, name);
    assert.match(parse(r).error, /Read-only mode: NAYORI_AGENT_ENV_FILE is not set/);
  }
});

test("computeExpiredAt adds the window to the tenure height and is bounded", () => {
  assert.equal(rails.computeExpiredAt(256_000), 256_144);
  assert.equal(rails.computeExpiredAt(256_000, 12), 256_012);
  assert.equal(rails.computeExpiredAt(256_000, 4320), 260_320);
  for (const bad of [11, 4321, 1.5, NaN]) assert.throws(() => rails.computeExpiredAt(256_000, bad), rails.RailError);
  for (const bad of [0, -1, NaN, undefined, "256000"]) assert.throws(() => rails.computeExpiredAt(bad, 144), rails.RailError);
});

test("create_job sends the SDK's committed description and an expiry from the tenure height, never the stacks height", async () => {
  for (const asset of ["sbtc", "stx"]) {
    // A chain stub with NO stacks-height reader at all: reaching for one fails the test.
    const { k, sent, commitments, deps } = setup({ getTenureHeight: async () => 256_335 });
    const r = await runTool(byName.nayori_client_create_job, { asset, description: DESCRIPTION, acceptanceCriteria: criteria }, deps);
    assert.equal(r.isError, undefined, r.content[0].text);
    const out = parse(r);
    const escrow = rails.ASSETS[asset].escrow;

    // The SDK was called with mainnet, the escrow id, client = signer, default managed evaluator.
    assert.deepEqual(commitments.calls, [{ fn: "prepareEvaluationJob", input: {
      network: "mainnet", asset, contract: `${rails.DEPLOYER}.${escrow}`, client: k.address, evaluator: EVALUATOR, description: DESCRIPTION, acceptanceCriteria: criteria,
    } }]);
    assert.match(out.criteriaHash, /^[0-9a-f]{64}$/);
    assert.equal(out.committedDescription, `${DESCRIPTION}\nnayori-criteria-v1:${out.criteriaHash}`);
    assert.equal(out.description, DESCRIPTION);
    assert.deepEqual(out.acceptanceCriteria, criteria);
    assert.equal(out.tenureHeight, 256_335);
    assert.equal(out.expiredAt, 256_335 + 144);
    assert.ok(out.expiredAt < 1_000_000, "a stacks block height (millions) was never used");
    assert.equal(out.evaluator, EVALUATOR);
    assert.ok(!r.content[0].text.includes(k.privateKey));

    assert.equal(sent.length, 1);
    const wire = wireOf(sent[0]);
    assertSafeWire(wire, escrow, "create-job");
    const args = wire.payload.functionArgs;
    assert.deepEqual(args[0], Cl.none());
    assert.deepEqual(args[1], Cl.principal(EVALUATOR));
    assert.deepEqual(args[2], Cl.uint(256_335 + 144));
    assert.equal(cvToValue(args[3]), out.committedDescription);
  }
  const { sent, deps } = setup();
  const out = parse(await runTool(byName.nayori_client_create_job, { asset: "stx", description: DESCRIPTION, acceptanceCriteria: criteria, provider: fakeKey().address, expiresInTenures: 12 }, deps));
  assert.equal(out.expiredAt, 256_012);
  assert.equal(wireOf(sent[0]).payload.functionArgs[0].type, Cl.some(Cl.uint(1)).type);
});

test("create_job pre-sign refusals never sign", async () => {
  const other = fakeKey().address;
  const base = { asset: "sbtc", description: DESCRIPTION, acceptanceCriteria: criteria };
  const cases = [
    [(k) => ({ ...base, evaluator: k.address }), {}, /evaluator must differ from the signer/],
    [(k) => ({ ...base, provider: k.address }), {}, /provider must differ from the signer/],
    [() => ({ ...base, evaluator: other, provider: other }), {}, /evaluator must differ from the provider/],
    [() => ({ ...base, provider: TREASURY }), {}, /provider is the escrow treasury/],
    [() => ({ ...base, evaluator: APPEAL }), {}, /evaluator is the escrow appealAuthority/],
    [() => base, (k) => ({ getProtocolConfig: async () => ({ appealAuthority: k.address, treasury: TREASURY }) }), /signer is the escrow appealAuthority/],
    [() => base, (k) => ({ getProtocolConfig: async () => ({ appealAuthority: APPEAL, treasury: k.address }) }), /signer is the escrow treasury/],
    [() => base, () => ({ getProtocolConfig: async () => ({}) }), /protocol configuration could not be read/],
    [() => base, () => ({ getTenureHeight: async () => undefined }), /tenure height is not available/],
    [() => base, () => ({ getPendingMempoolCount: async () => 2 }), /pending mempool/],
  ];
  for (const [input, overrides, re] of cases) {
    const k0 = setup();
    const s = { ...k0, deps: { ...k0.deps, chain: noNetworkChain({ ...k0.deps.chain, ...(typeof overrides === "function" ? overrides(k0.k) : overrides) }) } };
    const r = await runTool(byName.nayori_client_create_job, input(s.k), s.deps);
    assert.equal(r.isError, true, String(re));
    assert.match(parse(r).error, re);
    assert.equal(s.sent.length, 0);
  }
});

test("with the real pinned SDK (0.9.1) mainnet commitments work and match the cross-repository fixture", async () => {
  assert.equal(await sdkCommitments.supportsMainnet(), true);
  // Fixture pinned in the SDK and produced by the Evaluator reference implementation.
  const fixture = await sdkCommitments.prepareEvaluationSubmission({
    network: "mainnet", asset: "sbtc", contract: "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH.sbtc-commerce-v5",
    client: "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH", evaluator: "SP3GRG5CKEFNYM5BV0NPPHCM51FT176JQ02QWQ9T3",
    provider: "SP1NT1V4X6GQR6T32Z8MSMNECZ6GSWX9HZ81SM1Y8", description: "Return the verified count", jobId: "7",
    acceptanceCriteria: [{ id: "count", requirement: "Count is 3", verification: "Parse JSON and compare count" }],
    evidence: [{ id: "result", uri: "https://example.com/result.json", sha256: "11".repeat(32), mediaType: "application/json", sizeBytes: 11 }],
  });
  assert.equal(fixture.criteriaHash, "cda522ab7de4f1f9f392021baf6b2d1f349a7ee2ebcd5f26b5d5c3068113b413");
  assert.equal(fixture.evidenceHash, "6f85484d03505343f8bd6827781fb9cd3dbfb70f978c1e14d3931ee94c898b51");
  assert.equal(await sdkCommitments.evaluationJobId({ network: "mainnet", contract: "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH.sbtc-commerce-v5", jobId: "7" }),
    "55e44561-9516-59df-ae28-4134a0d61b52");

  // End to end through the tool with the REAL SDK (stubbed chain, fixture key): the committed description goes on-chain.
  const { sent, deps } = setup();
  delete deps.commitments; // default = lib/commitments.mjs over the real SDK
  const r = await runTool(byName.nayori_client_create_job, { asset: "sbtc", description: DESCRIPTION, acceptanceCriteria: criteria }, deps);
  assert.notEqual(r.isError, true, JSON.stringify(parse(r)));
  const out = parse(r);
  assert.match(out.criteriaHash, /^[0-9a-f]{64}$/);
  assert.equal(out.committedDescription ?? out.description, DESCRIPTION + "\nnayori-criteria-v1:" + out.criteriaHash);
  assert.equal(sent.length, 1);
  assertSafeWire(wireOf(sent[0]), "sbtc-commerce-v5", "create-job");
  assert.deepEqual(sdkCommitments.parseEvaluationDescription(`d\nnayori-criteria-v1:${"ab".repeat(32)}`), { description: "d", criteriaHash: "ab".repeat(32) });
  assert.throws(() => sdkCommitments.parseEvaluationDescription("no commitment here"), /not a committed evaluation job/);
});

test("set_budget: Deny + zero post-conditions; refused unless signer is the client and status is 0", async () => {
  const { k, sent, deps } = setup();
  deps.chain = noNetworkChain({ ...deps.chain, getJob: async () => ({ client: k.address, status: 0 }) });
  const out = parse(await runTool(byName.nayori_client_set_budget, { asset: "sbtc", jobId: 4, amount: 5000 }, deps));
  assert.equal(out.amount, "5000");
  assert.equal(out.amountUnit, "sats");
  const wire = wireOf(sent[0]);
  assertSafeWire(wire, "sbtc-commerce-v5", "set-budget");
  assert.deepEqual(wire.payload.functionArgs, [Cl.uint(4), Cl.uint(5000)]);

  const cases = [
    [async () => null, /job not found/],
    [async () => ({ client: fakeKey().address, status: 0 }), /signer is not the client/],
    ...[1, 2, 3, 5, 8].map((status) => [async () => ({ client: k.address, status }), /set-budget needs 0/]),
  ];
  for (const [getJob, re] of cases) {
    const before = sent.length;
    const r = await runTool(byName.nayori_client_set_budget, { asset: "stx", jobId: 4, amount: 1 }, { ...deps, chain: noNetworkChain({ ...deps.chain, getJob }) });
    assert.equal(r.isError, true);
    assert.match(parse(r).error, re);
    assert.equal(sent.length, before);
  }
});

test("assign_provider: Deny + zero post-conditions, reports hadActiveApplication, and its refusals", async () => {
  const provider = fakeKey().address;
  const { k, sent, deps } = setup();
  const job = { client: k.address, status: 1, provider: null, evaluator: EVALUATOR, appealAuthority: APPEAL, treasury: TREASURY };
  const chainWith = (o) => noNetworkChain({ ...deps.chain, getJob: async () => job, ...o });

  let out = parse(await runTool(byName.nayori_client_assign_provider, { asset: "stx", jobId: 2, provider }, { ...deps, chain: chainWith({}) }));
  assert.equal(out.hadActiveApplication, false);
  const wire = wireOf(sent[0]);
  assertSafeWire(wire, "agentic-commerce-v6", "assign-provider");
  assert.deepEqual(wire.payload.functionArgs, [Cl.uint(2), Cl.principal(provider)]);

  const asked = [];
  out = parse(await runTool(byName.nayori_client_assign_provider, { asset: "stx", jobId: 2, provider }, { ...deps, chain: chainWith({ getApplication: async (...a) => (asked.push(a), { active: true }) }) }));
  assert.equal(out.hadActiveApplication, true);
  assert.deepEqual(asked, [["stx", 2, provider]]);
  out = parse(await runTool(byName.nayori_client_assign_provider, { asset: "stx", jobId: 2, provider }, { ...deps, chain: chainWith({ getApplication: async () => ({ active: false }) }) }));
  assert.equal(out.hadActiveApplication, false);

  const cases = [
    [{ getJob: async () => null }, provider, /job not found/],
    [{ getJob: async () => ({ ...job, client: fakeKey().address }) }, provider, /signer is not the client/],
    [{ getJob: async () => ({ ...job, status: 0 }) }, provider, /assign-provider needs 1/],
    [{ getJob: async () => ({ ...job, status: 2 }) }, provider, /assign-provider needs 1/],
    [{ getJob: async () => ({ ...job, provider: fakeKey().address }) }, provider, /already has a provider/],
    [{}, k.address, /provider is the client/],
    [{}, EVALUATOR, /provider is the evaluator/],
    [{}, APPEAL, /provider is the appealAuthority/],
    [{}, TREASURY, /provider is the treasury/],
  ];
  for (const [o, p, re] of cases) {
    const before = sent.length;
    const r = await runTool(byName.nayori_client_assign_provider, { asset: "stx", jobId: 2, provider: p }, { ...deps, chain: chainWith(o) });
    assert.equal(r.isError, true, String(re));
    assert.match(parse(r).error, re);
    assert.equal(sent.length, before);
  }
});

test("submit_committed: refuses on criteria mismatch, sends the 36-byte ny1: deliverable on match", async () => {
  const { k, sent, commitments, deps } = setup();
  const client = fakeKey().address;
  const job = await committedJob({ client, provider: k.address });
  deps.chain = noNetworkChain({ ...deps.chain, getJob: async () => job });
  const input = { asset: "sbtc", jobId: 9, acceptanceCriteria: criteria, evidence };

  // Any change to the criteria (text, id or order) breaks the commitment: nothing is signed.
  const changed = [
    [{ ...criteria[0], requirement: "A 100 word brief." }, criteria[1]],
    [criteria[1], criteria[0]],
    [criteria[0]],
  ];
  for (const acceptanceCriteria of changed) {
    const r = await runTool(byName.nayori_provider_submit_committed, { ...input, acceptanceCriteria }, deps);
    assert.equal(r.isError, true);
    assert.match(parse(r).error, /acceptance criteria do not match the job's commitment/);
  }
  assert.equal(sent.length, 0);

  const r = await runTool(byName.nayori_provider_submit_committed, input, deps);
  assert.equal(r.isError, undefined, r.content[0].text);
  const out = parse(r);
  const submission = commitments.calls.findLast((c) => c.fn === "prepareEvaluationSubmission").input;
  assert.deepEqual(submission, {
    network: "mainnet", asset: "sbtc", contract: `${rails.DEPLOYER}.sbtc-commerce-v5`, jobId: "9", client, provider: k.address,
    evaluator: EVALUATOR, description: DESCRIPTION, acceptanceCriteria: criteria, evidence,
  });
  assert.match(out.evidenceHash, /^[0-9a-f]{64}$/);
  assert.equal(out.criteriaHash, job.description.split("nayori-criteria-v1:")[1]);
  assert.equal(out.deliverableHex, Buffer.from("ny1:", "ascii").toString("hex") + out.evidenceHash);
  assert.match(out.evaluationId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);

  assert.equal(sent.length, 1);
  const wire = wireOf(sent[0]);
  assertSafeWire(wire, "sbtc-commerce-v5", "submit-work");
  assert.deepEqual(wire.payload.functionArgs[0], Cl.uint(9));
  const bytes = Buffer.from(wire.payload.functionArgs[1].value, "hex");
  assert.equal(bytes.length, 36);
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "ny1:");
  assert.equal(bytes.subarray(4).toString("hex"), out.evidenceHash);
});

test("submit_committed pre-sign refusals", async () => {
  const { k, sent, deps } = setup();
  const client = fakeKey().address;
  const input = { asset: "sbtc", jobId: 9, acceptanceCriteria: criteria, evidence };
  const good = await committedJob({ client, provider: k.address });
  const cases = [
    [null, /job not found/],
    [{ ...good, provider: fakeKey().address }, /not the assigned provider/],
    [{ ...good, provider: null }, /not the assigned provider/],
    [{ ...good, status: 0 }, /submit-work needs 1/],
    [{ ...good, status: 2 }, /submit-work needs 1/],
    [{ ...good, description: "A plain job with no commitment." }, /not a committed evaluation job/],
    [{ ...good, description: `${DESCRIPTION}\nnayori-criteria-v1:${"cd".repeat(32)}` }, /do not match the job's commitment/],
  ];
  for (const [job, re] of cases) {
    const r = await runTool(byName.nayori_provider_submit_committed, input, { ...deps, chain: noNetworkChain({ ...deps.chain, getJob: async () => job }) });
    assert.equal(r.isError, true, String(re));
    assert.match(parse(r).error, re);
  }
  assert.equal(sent.length, 0);
});

test("evaluation_request: read-only, exact body shape, refused unless submitted and the deliverable matches", async () => {
  const client = fakeKey().address;
  const provider = fakeKey().address;
  // Produce the on-chain deliverable the way the provider tool would.
  const c = testnetShimCommitments();
  const funded = await committedJob({ client, provider });
  const prepared = await c.prepareEvaluationSubmission({
    network: "mainnet", asset: "sbtc", contract: `${rails.DEPLOYER}.sbtc-commerce-v5`, jobId: "9", client, provider, evaluator: EVALUATOR,
    description: DESCRIPTION, acceptanceCriteria: criteria, evidence,
  });
  const submitted = { ...funded, status: 2, reviewDeadline: 967_700, deliverableHex: Buffer.from(prepared.deliverable).toString("hex") };

  // No signer, no env file, and a chain stub that only allows getJob.
  const deps = (job) => ({ chain: noNetworkChain({ getJob: async () => job }), signer, commitments: testnetShimCommitments(), env: {} });
  const input = { asset: "sbtc", jobId: 9, acceptanceCriteria: criteria, evidence };
  assert.equal(byName.nayori_evaluation_request.readOnly, true);

  const r = await runTool(byName.nayori_evaluation_request, input, deps(submitted));
  assert.equal(r.isError, undefined, r.content[0].text);
  const out = parse(r);
  assert.equal(out.method, "POST");
  assert.equal(out.path, "/v1/evaluations");
  assert.equal(out.sent, false);
  assert.deepEqual(Object.keys(out.body), ["commitmentVersion", "evaluationId", "network", "asset", "contract", "jobId", "job", "acceptanceCriteria", "evidence"]);
  assert.deepEqual(out.body, {
    commitmentVersion: "1",
    evaluationId: await c.evaluationJobId({ network: "mainnet", contract: `${rails.DEPLOYER}.sbtc-commerce-v5`, jobId: "9" }),
    network: "mainnet",
    asset: "sbtc",
    contract: `${rails.DEPLOYER}.sbtc-commerce-v5`,
    jobId: "9",
    job: { client, provider, evaluator: EVALUATOR, status: "submitted", reviewDeadlineBurn: "967700", description: submitted.description },
    acceptanceCriteria: criteria,
    evidence,
  });
  assert.match(out.body.evaluationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(out.evidenceHash, prepared.evidenceHash);
  assert.equal(out.statusPath, `/v1/evaluations/${out.body.evaluationId}`);
  assert.equal(out.evaluatorMatchesManaged, true);

  const cases = [
    [null, input, /job not found/],
    [funded, input, /needs 2 \(submitted\)/],
    [{ ...submitted, status: 3 }, input, /needs 2 \(submitted\)/],
    [{ ...submitted, reviewDeadline: null }, input, /no provider, deliverable or review deadline/],
    [submitted, { ...input, acceptanceCriteria: [criteria[0]] }, /do not match the job's commitment/],
    [submitted, { ...input, evidence: [{ ...evidence[0], sha256: "cd".repeat(32) }] }, /deliverable on-chain is not the evidence commitment/],
    // A job submitted with the plain nayori_submit_work encoding (64 ASCII hex bytes) is not evaluable.
    [{ ...submitted, deliverableHex: Buffer.from(rails.deliverableBufferBytes("https://example.com/brief.md")).toString("hex") }, input, /deliverable on-chain is not the evidence commitment/],
  ];
  for (const [job, inp, re] of cases) {
    const bad = await runTool(byName.nayori_evaluation_request, inp, deps(job));
    assert.equal(bad.isError, true, String(re));
    assert.match(parse(bad).error, re);
  }

  // send:true posts the identical body to the relay and reports the answer; the body is never altered.
  const calls = [];
  const fetchOk = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: out.body.evaluationId, status: "queued" }), { status: 202 }); };
  const sent = parse(await runTool(byName.nayori_evaluation_request, { ...input, send: true }, { ...deps(submitted), fetch: fetchOk }));
  assert.equal(sent.sent, true);
  assert.equal(sent.relay, rails.EVALUATION_RELAY);
  assert.equal(sent.httpStatus, 202);
  assert.deepEqual(sent.response, { id: out.body.evaluationId, status: "queued" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, rails.EVALUATION_RELAY);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].init.body), out.body);
  const custom = parse(await runTool(byName.nayori_evaluation_request, { ...input, send: true }, { ...deps(submitted), fetch: fetchOk, env: { NAYORI_EVALUATION_RELAY: "https://qa.nayori.ai/api/evaluations" } }));
  assert.equal(custom.relay, "https://qa.nayori.ai/api/evaluations");
  const down = await runTool(byName.nayori_evaluation_request, { ...input, send: true }, { ...deps(submitted), fetch: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(down.isError, true);
  assert.match(parse(down).error, /relay did not answer/);
  const built = parse(await runTool(byName.nayori_evaluation_request, input, { ...deps(submitted), fetch: async () => { throw new Error("must not be called"); } }));
  assert.equal(built.sent, false);
});
