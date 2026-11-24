// Client tools and committed-evaluation tools, with the real @perkos/agent-sdk. No network,
// fixture keys only.
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
import { fakeKey, writeEnvFile, noNetworkChain, recordingCommitments } from "./helpers.mjs";

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const parse = (r) => JSON.parse(r.content[0].text);

const MAIN = rails.PROFILES.mainnet;
const EVALUATOR = MAIN.managedEvaluator;
const APPEAL = "SM3950RVR364J25ZRFFNHB5TCNJ7VKPKKGD4N2RP9";
const TREASURY = "SMFE58EKCK5ZPD7YCYM1CQY7K3H8SEXQH7C3YT8S";
const ESCROW = { sbtc: `${MAIN.deployer}.nayori-escrow-sbtc`, stx: `${MAIN.deployer}.nayori-escrow-stx` };
const criteria = [
  { id: "brief", requirement: "A 300 word brief about Clarity post-conditions.", verification: "Count the words and check the topic." },
  { id: "format", requirement: "Markdown file.", verification: "The media type is text/markdown." },
];
const evidence = [{ id: "brief-md", uri: "https://example.com/brief.md", sha256: "ab".repeat(32), mediaType: "text/markdown", sizeBytes: 2048 }];
const DESCRIPTION = "Write a short brief about Clarity post-conditions.";

function setup(overrides = {}) {
  const k = fakeKey();
  const sent = [];
  const commitments = recordingCommitments();
  const chain = noNetworkChain({
    getPendingMempoolCount: async () => 0,
    getNextNonce: async () => 7,
    broadcast: async (tx) => (sent.push(tx), "0x" + tx.txid()),
    getRoles: async () => ({ appealAuthority: APPEAL, treasury: TREASURY }),
    getBurnHeight: async () => 900,
    getApplication: async () => null,
    ...overrides,
  });
  return { k, sent, commitments, deps: { chain, signer, commitments, env: { [signer.ENV_VAR]: writeEnvFile(k) } } };
}
const wireOf = (tx) => deserializeTransaction(tx.serialize());
function assertNoTransfer(wire, contractName, functionName) {
  assert.equal(wire.postConditionMode, PostConditionMode.Deny);
  assert.equal(wire.postConditions.values.length, 0);
  assert.equal(wire.payload.contractName.content, contractName);
  assert.equal(wire.payload.functionName.content, functionName);
  rails.assertTransactionIsSafe(wire, rails.buildCallOptions({ contractName, functionName, functionArgs: [], nonce: 0, fee: 3000 }));
}

/** A job as lib/chain.mjs returns it, committed with the real SDK. */
async function committedJob({ client, provider = null, status = "accepted", asset = "sbtc", jobId = 9 }) {
  const { description } = await sdkCommitments.prepareEvaluationJob({ network: "mainnet", asset, contract: ESCROW[asset], client, evaluator: EVALUATOR, description: DESCRIPTION, acceptanceCriteria: criteria });
  return {
    asset, jobId, escrowContract: ESCROW[asset], status, client, provider, evaluator: EVALUATOR, appealAuthority: APPEAL, treasury: TREASURY,
    description, budget: "5000", budgetUnit: "sats", deliveryDeadline: 1000, deliveryBlocks: 144, reviewBlocks: 144,
  };
}

test("only lib/sdk.mjs imports @perkos/agent-sdk, and the dependency is pinned to 0.10.0", () => {
  for (const dir of ["../lib/", "../"]) {
    for (const f of readdirSync(new URL(dir, import.meta.url)).filter((n) => n.endsWith(".mjs"))) {
      const src = readFileSync(new URL(`${dir}${f}`, import.meta.url), "utf8");
      if (f !== "sdk.mjs") assert.ok(!/from\s+"@perkos\/agent-sdk"/.test(src), f);
    }
  }
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies["@perkos/agent-sdk"], "0.10.0");
  const sdkPkg = JSON.parse(readFileSync(new URL("../node_modules/@perkos/agent-sdk/package.json", import.meta.url), "utf8"));
  assert.equal(sdkPkg.version, "0.10.0");
  // rails.mjs never imports the SDK: its constants are checked against the SDK in rails.test.mjs.
  assert.ok(!/sdk\.mjs/.test(readFileSync(new URL("../lib/rails.mjs", import.meta.url), "utf8")));
});

test("input validation for the client and committed tools", () => {
  const ok = (n, v) => assert.ok(schemas[n].safeParse(v).success, `${n} ${JSON.stringify(v)}`);
  const no = (n, v) => assert.ok(!schemas[n].safeParse(v).success, `${n} ${JSON.stringify(v)}`);
  const create = { asset: "sbtc", description: DESCRIPTION, acceptanceCriteria: criteria, budget: 5000 };
  ok("nayori_client_create_job", create);
  ok("nayori_client_create_job", { ...create, evaluator: EVALUATOR, deliveryBlocks: 144, reviewBlocks: 12 });
  ok("nayori_client_create_job", { ...create, description: "x".repeat(MAX_PLAIN_DESCRIPTION), deliveryBlocks: 4320, reviewBlocks: 1008 });
  assert.equal(MAX_PLAIN_DESCRIPTION, 428);
  no("nayori_client_create_job", { ...create, description: "x".repeat(MAX_PLAIN_DESCRIPTION + 1) });
  no("nayori_client_create_job", { ...create, description: "line\nbreak" });
  no("nayori_client_create_job", { ...create, description: "café" });
  no("nayori_client_create_job", { ...create, description: "x nayori-criteria-v1:" + "0".repeat(64) });
  for (const deliveryBlocks of [143, 4321]) no("nayori_client_create_job", { ...create, deliveryBlocks });
  for (const reviewBlocks of [11, 1009]) no("nayori_client_create_job", { ...create, reviewBlocks });
  for (const budget of [999, 100_000_000_001, 1.5, "5000"]) no("nayori_client_create_job", { ...create, budget });
  no("nayori_client_create_job", { asset: "sbtc", description: DESCRIPTION, acceptanceCriteria: criteria });
  no("nayori_client_create_job", { ...create, acceptanceCriteria: [] });
  no("nayori_client_create_job", { ...create, acceptanceCriteria: Array.from({ length: 21 }, (_, i) => ({ ...criteria[0], id: `c${i}` })) });
  no("nayori_client_create_job", { ...create, acceptanceCriteria: [criteria[0], criteria[0]] });
  no("nayori_client_create_job", { ...create, acceptanceCriteria: [{ ...criteria[0], extra: 1 }] });
  no("nayori_client_create_job", { ...create, evaluator: `${MAIN.deployer}.nayori-agents` });
  // No input can smuggle a fee, a provider, an expiry or a post-condition.
  for (const extra of [{ fee: 1 }, { provider: EVALUATOR }, { expiresInTenures: 144 }, { postConditionMode: "allow" }]) no("nayori_client_create_job", { ...create, ...extra });
  ok("nayori_client_name_provider", { asset: "stx", jobId: 1, provider: APPEAL });
  no("nayori_client_name_provider", { asset: "stx", jobId: 1, provider: "SP123" });
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

test("read-only mode: the client and committed write tools return a clear error and touch no network or SDK", async () => {
  const deps = { chain: noNetworkChain(), signer, env: {} };
  const inputs = {
    nayori_client_create_job: { asset: "sbtc", description: DESCRIPTION, acceptanceCriteria: criteria, budget: 5000 },
    nayori_client_name_provider: { asset: "sbtc", jobId: 1, provider: APPEAL },
    nayori_provider_submit_committed: { asset: "sbtc", jobId: 1, acceptanceCriteria: criteria, evidence },
  };
  for (const [name, input] of Object.entries(inputs)) {
    const r = await runTool(byName[name], input, deps);
    assert.equal(r.isError, true, name);
    assert.match(parse(r).error, /Read-only mode: NAYORI_AGENT_ENV_FILE is not set/);
  }
});

test("create_job: committed description, budget and windows on the live escrow; no post-conditions", async () => {
  for (const [asset, budget] of [["sbtc", 5000], ["stx", 2_000_000]]) {
    const { k, sent, commitments, deps } = setup();
    const r = await runTool(byName.nayori_client_create_job, { asset, description: DESCRIPTION, acceptanceCriteria: criteria, budget }, deps);
    assert.equal(r.isError, undefined, r.content[0].text);
    const out = parse(r);
    assert.deepEqual(commitments.calls, [{ fn: "prepareEvaluationJob", input: {
      network: "mainnet", asset, contract: ESCROW[asset], client: k.address, evaluator: EVALUATOR, description: DESCRIPTION, acceptanceCriteria: criteria,
    } }]);
    assert.match(out.criteriaHash, /^[0-9a-f]{64}$/);
    assert.equal(out.committedDescription, `${DESCRIPTION}\nnayori-criteria-v1:${out.criteriaHash}`);
    assert.equal(out.budget, String(budget));
    assert.equal(out.serviceFeeOnSettlement, String(budget / 50));
    assert.equal(out.providerReceivesOnApproval, String(budget - budget / 50));
    assert.equal(out.deliveryBlocks, 144);
    assert.equal(out.reviewBlocks, 144);
    assert.ok(!r.content[0].text.includes(k.privateKey));

    assert.equal(sent.length, 1);
    const wire = wireOf(sent[0]);
    assertNoTransfer(wire, `nayori-escrow-${asset}`, "create-job");
    const args = wire.payload.functionArgs;
    assert.deepEqual(args.slice(0, 4), [Cl.principal(EVALUATOR), Cl.uint(budget), Cl.uint(144), Cl.uint(144)]);
    assert.equal(cvToValue(args[4]), out.committedDescription);
  }
  const { sent, deps } = setup();
  parse(await runTool(byName.nayori_client_create_job, { asset: "stx", description: DESCRIPTION, acceptanceCriteria: criteria, budget: 1_000_000, deliveryBlocks: 4320, reviewBlocks: 12 }, deps));
  assert.deepEqual(wireOf(sent[0]).payload.functionArgs.slice(1, 4), [Cl.uint(1_000_000), Cl.uint(4320), Cl.uint(12)]);
});

test("create_job pre-sign refusals never sign", async () => {
  const base = { asset: "sbtc", description: DESCRIPTION, acceptanceCriteria: criteria, budget: 5000 };
  const cases = [
    [(k) => ({ ...base, evaluator: k.address }), {}, /evaluator must differ from the signer/],
    [() => ({ ...base, evaluator: APPEAL }), {}, /evaluator is the appealAuthority/],
    [() => ({ ...base, evaluator: TREASURY }), {}, /evaluator is the treasury/],
    [() => ({ ...base, asset: "stx", budget: 5000 }), {}, /stx budget must be 1000000 to 100000000000 microSTX/],
    [() => ({ ...base, budget: 100_000_001 }), {}, /sbtc budget must be 1000 to 100000000 sats/],
    [() => ({ ...base, evaluator: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5" }), {}, /evaluator must be a mainnet address/],
    [() => base, (k) => ({ getRoles: async () => ({ appealAuthority: k.address, treasury: TREASURY }) }), /signer is the appealAuthority/],
    [() => base, (k) => ({ getRoles: async () => ({ appealAuthority: APPEAL, treasury: k.address }) }), /signer is the treasury/],
    [() => base, () => ({ getRoles: async () => ({}) }), /roles .* could not be read/],
    [() => base, () => ({ getPendingMempoolCount: async () => 2 }), /pending mempool/],
  ];
  for (const [input, overrides, re] of cases) {
    const s0 = setup();
    const s = { ...s0, deps: { ...s0.deps, chain: noNetworkChain({ ...s0.deps.chain, ...(typeof overrides === "function" ? overrides(s0.k) : overrides) }) } };
    const r = await runTool(byName.nayori_client_create_job, input(s.k), s.deps);
    assert.equal(r.isError, true, String(re));
    assert.match(parse(r).error, re);
    assert.equal(s.sent.length, 0);
  }
});

test("the SDK produces mainnet commitments and still matches the cross-repository fixture", async () => {
  assert.equal(await sdkCommitments.supportsNetwork("mainnet"), true);
  assert.equal(await sdkCommitments.supportsNetwork("testnet"), true);
  assert.equal(await sdkCommitments.supportsNetwork("devnet"), false);
  // Fixture pinned in the SDK and produced by the Evaluator reference implementation (a pure function of its inputs).
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
  // The live escrow ids are accepted as commitment contracts.
  assert.match(await sdkCommitments.evaluationJobId({ network: "mainnet", contract: ESCROW.sbtc, jobId: "1" }), /^[0-9a-f-]{36}$/);
  assert.deepEqual(sdkCommitments.parseEvaluationDescription(`d\nnayori-criteria-v1:${"ab".repeat(32)}`), { description: "d", criteriaHash: "ab".repeat(32) });
  assert.throws(() => sdkCommitments.parseEvaluationDescription("no commitment here"), /not a committed evaluation job/);
});

test("name_provider: offers the job, reports the application, and its refusals", async () => {
  const provider = fakeKey().address;
  const { k, sent, deps } = setup();
  const job = { asset: "sbtc", jobId: 2, client: k.address, status: "funded", provider: null, evaluator: EVALUATOR, appealAuthority: APPEAL, treasury: TREASURY, deliveryDeadline: 1000 };
  const chainWith = (o) => noNetworkChain({ ...deps.chain, getJob: async () => job, ...o });

  let out = parse(await runTool(byName.nayori_client_name_provider, { asset: "stx", jobId: 2, provider }, { ...deps, chain: chainWith({ getApplication: async () => { throw new Error("stx jobs have no applications"); } }) }));
  assert.equal(out.applied, false);
  assert.match(out.next, /accepts with nayori_accept_job before Bitcoin block 1000/);
  const wire = wireOf(sent[0]);
  assertNoTransfer(wire, "nayori-escrow-stx", "name-provider");
  assert.deepEqual(wire.payload.functionArgs, [Cl.uint(2), Cl.principal(provider)]);

  const asked = [];
  out = parse(await runTool(byName.nayori_client_name_provider, { asset: "sbtc", jobId: 2, provider }, { ...deps, chain: chainWith({ getApplication: async (...a) => (asked.push(a), { applicant: provider, deposit: "400" }) }) }));
  assert.equal(out.applied, true);
  assert.equal(out.applicationDepositSats, "400");
  assert.deepEqual(asked, [[2, provider]]);

  const cases = [
    [{ getJob: async () => null }, provider, /job not found/],
    [{ getJob: async () => ({ ...job, client: fakeKey().address }) }, provider, /signer is not the client/],
    [{ getJob: async () => ({ ...job, status: "open" }) }, provider, /name-provider needs funded or offered/],
    [{ getJob: async () => ({ ...job, status: "accepted", provider }) }, provider, /name-provider needs funded or offered/],
    [{ getJob: async () => ({ ...job, status: "offered", provider }) }, provider, /already offered to that provider/],
    [{}, k.address, /provider is the client/],
    [{}, EVALUATOR, /provider is the evaluator/],
    [{}, APPEAL, /provider is the appealAuthority/],
    [{}, TREASURY, /provider is the treasury/],
    [{}, fakeKey("testnet").address, /provider must be a mainnet address/],
  ];
  for (const [o, p, re] of cases) {
    const before = sent.length;
    const r = await runTool(byName.nayori_client_name_provider, { asset: "stx", jobId: 2, provider: p }, { ...deps, chain: chainWith(o) });
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
  for (const acceptanceCriteria of [[{ ...criteria[0], requirement: "A 100 word brief." }, criteria[1]], [criteria[1], criteria[0]], [criteria[0]]]) {
    const r = await runTool(byName.nayori_provider_submit_committed, { ...input, acceptanceCriteria }, deps);
    assert.equal(r.isError, true);
    assert.match(parse(r).error, /acceptance criteria do not match the job's commitment/);
  }
  assert.equal(sent.length, 0);

  const r = await runTool(byName.nayori_provider_submit_committed, input, deps);
  assert.equal(r.isError, undefined, r.content[0].text);
  const out = parse(r);
  assert.deepEqual(commitments.calls.findLast((c) => c.fn === "prepareEvaluationSubmission").input, {
    network: "mainnet", asset: "sbtc", contract: ESCROW.sbtc, jobId: "9", client, provider: k.address,
    evaluator: EVALUATOR, description: DESCRIPTION, acceptanceCriteria: criteria, evidence,
  });
  assert.equal(out.criteriaHash, job.description.split("nayori-criteria-v1:")[1]);
  assert.equal(out.deliverableHex, Buffer.from("ny1:", "ascii").toString("hex") + out.evidenceHash);
  assert.match(out.evaluationId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  assert.equal(sent.length, 1);
  const wire = wireOf(sent[0]);
  assertNoTransfer(wire, "nayori-escrow-sbtc", "submit-work");
  assert.deepEqual(wire.payload.functionArgs[0], Cl.uint(9));
  const bytes = Buffer.from(wire.payload.functionArgs[1].value, "hex");
  assert.equal(bytes.length, 36);
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "ny1:");
  assert.equal(bytes.subarray(4).toString("hex"), out.evidenceHash);
});

test("submit_committed pre-sign refusals", async () => {
  const { k, sent, deps } = setup();
  const input = { asset: "sbtc", jobId: 9, acceptanceCriteria: criteria, evidence };
  const good = await committedJob({ client: fakeKey().address, provider: k.address });
  const cases = [
    [null, {}, /job not found/],
    [{ ...good, provider: fakeKey().address }, {}, /not the provider/],
    [{ ...good, provider: null }, {}, /not the provider/],
    [{ ...good, status: "offered" }, {}, /Accept it first with nayori_accept_job/],
    [{ ...good, status: "funded" }, {}, /submit-work needs accepted/],
    [{ ...good, status: "submitted" }, {}, /submit-work needs accepted/],
    [good, { getBurnHeight: async () => 1000 }, /deadline .* has passed/],
    [{ ...good, description: "A plain job with no commitment." }, {}, /not a committed evaluation job/],
    [{ ...good, description: `${DESCRIPTION}\nnayori-criteria-v1:${"cd".repeat(32)}` }, {}, /do not match the job's commitment/],
  ];
  for (const [job, o, re] of cases) {
    const r = await runTool(byName.nayori_provider_submit_committed, input, { ...deps, chain: noNetworkChain({ ...deps.chain, getJob: async () => job, ...o }) });
    assert.equal(r.isError, true, String(re));
    assert.match(parse(r).error, re);
  }
  assert.equal(sent.length, 0);
});

test("evaluation_request: read-only, exact body shape with the review deadline from get-submission", async () => {
  const client = fakeKey().address;
  const provider = fakeKey().address;
  const accepted = await committedJob({ client, provider });
  // Produce the on-chain deliverable the way the provider tool does.
  const prepared = await sdkCommitments.prepareEvaluationSubmission({
    network: "mainnet", asset: "sbtc", contract: ESCROW.sbtc, jobId: "9", client, provider, evaluator: EVALUATOR,
    description: DESCRIPTION, acceptanceCriteria: criteria, evidence,
  });
  const submitted = { ...accepted, status: "submitted" };
  const submission = { deliverableHex: Buffer.from(prepared.deliverable).toString("hex"), reviewDeadline: 1044 };

  // No signer, no env file, and a chain stub with only the three reads.
  const deps = (job, sub = submission, burn = 950) => ({
    chain: noNetworkChain({ getJob: async () => job, getSubmission: async () => sub, getBurnHeight: async () => burn }),
    signer, commitments: recordingCommitments(), env: {},
  });
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
    evaluationId: await sdkCommitments.evaluationJobId({ network: "mainnet", contract: ESCROW.sbtc, jobId: "9" }),
    network: "mainnet",
    asset: "sbtc",
    contract: ESCROW.sbtc,
    jobId: "9",
    job: { client, provider, evaluator: EVALUATOR, status: "submitted", reviewDeadlineBurn: "1044", description: submitted.description },
    acceptanceCriteria: criteria,
    evidence,
  });
  assert.equal(out.evidenceHash, prepared.evidenceHash);
  assert.equal(out.statusPath, `/v1/evaluations/${out.body.evaluationId}`);
  assert.equal(out.evaluatorMatchesManaged, true);

  const cases = [
    [null, submission, 950, input, /job not found/],
    [accepted, submission, 950, input, /needs submitted/],
    [{ ...submitted, status: "decided" }, submission, 950, input, /needs submitted/],
    [submitted, null, 950, input, /no provider, deliverable or review deadline/],
    [submitted, submission, 1045, input, /review window closed at Bitcoin block 1044/],
    [submitted, submission, 950, { ...input, acceptanceCriteria: [criteria[0]] }, /do not match the job's commitment/],
    [submitted, submission, 950, { ...input, evidence: [{ ...evidence[0], sha256: "cd".repeat(32) }] }, /deliverable on-chain is not the evidence commitment/],
    // A job submitted with the plain nayori_submit_work encoding (64 ASCII hex bytes) is not evaluable.
    [submitted, { ...submission, deliverableHex: Buffer.from(rails.deliverableBufferBytes("https://example.com/brief.md")).toString("hex") }, 950, input, /deliverable on-chain is not the evidence commitment/],
  ];
  for (const [job, sub, burn, inp, re] of cases) {
    const bad = await runTool(byName.nayori_evaluation_request, inp, deps(job, sub, burn));
    assert.equal(bad.isError, true, String(re));
    assert.match(parse(bad).error, re);
  }

  // send:true posts the identical body to the relay and reports the answer; the body is never altered.
  const calls = [];
  const fetchOk = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: out.body.evaluationId, status: "queued" }), { status: 202 }); };
  const posted = parse(await runTool(byName.nayori_evaluation_request, { ...input, send: true }, { ...deps(submitted), fetch: fetchOk }));
  assert.equal(posted.sent, true);
  assert.equal(posted.relay, "https://app.nayori.ai/api/evaluations");
  assert.equal(posted.httpStatus, 202);
  assert.deepEqual(posted.response, { id: out.body.evaluationId, status: "queued" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://app.nayori.ai/api/evaluations");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].init.body), out.body);
  const custom = parse(await runTool(byName.nayori_evaluation_request, { ...input, send: true }, { ...deps(submitted), fetch: fetchOk, env: { NAYORI_EVALUATION_RELAY: "https://relay.example.com/api/evaluations" } }));
  assert.equal(custom.relay, "https://relay.example.com/api/evaluations");
  const down = await runTool(byName.nayori_evaluation_request, { ...input, send: true }, { ...deps(submitted), fetch: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(down.isError, true);
  assert.match(parse(down).error, /relay did not answer/);
  const built = parse(await runTool(byName.nayori_evaluation_request, input, { ...deps(submitted), fetch: async () => { throw new Error("must not be called"); } }));
  assert.equal(built.sent, false);
});

test("evaluation_request on testnet: testnet escrow, network and the qa relay", async () => {
  const client = fakeKey("testnet").address;
  const provider = fakeKey("testnet").address;
  const T = rails.PROFILES.testnet;
  const escrow = `${T.deployer}.nayori-escrow-stx`;
  const { description } = await sdkCommitments.prepareEvaluationJob({ network: "testnet", asset: "stx", contract: escrow, client, evaluator: T.managedEvaluator, description: DESCRIPTION, acceptanceCriteria: criteria });
  const prepared = await sdkCommitments.prepareEvaluationSubmission({ network: "testnet", asset: "stx", contract: escrow, jobId: "3", client, provider, evaluator: T.managedEvaluator, description: DESCRIPTION, acceptanceCriteria: criteria, evidence });
  const job = { asset: "stx", jobId: 3, status: "submitted", client, provider, evaluator: T.managedEvaluator, description, budget: "2000000", budgetUnit: "microSTX" };
  const calls = [];
  const deps = {
    chain: noNetworkChain({ getJob: async () => job, getSubmission: async () => ({ deliverableHex: Buffer.from(prepared.deliverable).toString("hex"), reviewDeadline: 50 }), getBurnHeight: async () => 40 }),
    signer, env: { NAYORI_AGENT_NETWORK: "testnet" },
    fetch: async (url, init) => (calls.push(url), new Response("{}", { status: 202 })),
  };
  const out = parse(await runTool(byName.nayori_evaluation_request, { asset: "stx", jobId: 3, acceptanceCriteria: criteria, evidence, send: true }, deps));
  assert.equal(out.body.network, "testnet");
  assert.equal(out.body.contract, escrow);
  assert.equal(out.evaluatorMatchesManaged, true);
  assert.deepEqual(calls, ["https://qa.nayori.ai/api/evaluations"]);
});

test("appeal: only the losing party inside the window; the evidence hash goes on-chain; no post-conditions", async () => {
  const { k, sent, deps } = setup();
  const client = fakeKey().address;
  const job = { asset: "sbtc", jobId: 5, status: "decided", client, provider: k.address, evaluator: EVALUATOR, treasury: TREASURY, appealAuthority: APPEAL };
  const decision = { decision: "reject", byDefault: false, evidenceHash: "00", appealDeadline: 950, appellant: null, resolutionDeadline: null };
  const chain = (o = {}) => noNetworkChain({ ...deps.chain, getJob: async () => job, getDecision: async () => decision, ...o });
  const out = parse(await runTool(byName.nayori_appeal_decision, { asset: "sbtc", jobId: 5, appealReference: "https://example.com/why.md" }, { ...deps, chain: chain() }));
  assert.equal(out.decision, "reject");
  const wire = wireOf(sent[0]);
  assertNoTransfer(wire, "nayori-escrow-sbtc", "appeal");
  assert.deepEqual(wire.payload.functionArgs[0], Cl.uint(5));
  assert.equal(wire.payload.functionArgs[1].value, out.appealEvidenceSha256Hex);
  for (const [o, re] of [
    [{ getDecision: async () => ({ ...decision, decision: "approve" }) }, /client may appeal an approval/],
    [{ getBurnHeight: async () => 951 }, /window is closed/],
    [{ getJob: async () => ({ ...job, status: "disputed" }) }, /an appeal needs decided/],
  ]) {
    const before = sent.length;
    const r = await runTool(byName.nayori_appeal_decision, { asset: "sbtc", jobId: 5, appealReference: "x" }, { ...deps, chain: chain(o) });
    assert.match(parse(r).error, re);
    assert.equal(sent.length, before);
  }
});
