// Test fixtures. The key is random, generated per run, and obviously not a real wallet.
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRandomPrivKey, privateKeyToAddress, Address } from "@stacks/transactions";
import { prepareEvaluationJob, prepareEvaluationSubmission, evaluationJobId } from "@perkos/agent-sdk";
import { sdkCommitments } from "../lib/commitments.mjs";

export function fakeKey() {
  const privateKey = makeRandomPrivKey();
  return { privateKey, address: privateKeyToAddress(privateKey, "mainnet") };
}

export function tempDir() {
  return mkdtempSync(join(tmpdir(), "nayori-agent-mcp-test-"));
}

export function writeEnvFile({ address, privateKey, mode = 0o600, dir = tempDir(), name = "agent.env" }) {
  const path = join(dir, name);
  writeFileSync(path, `# FAKE TEST FIXTURE\nAGENT_ADDRESS=${address}\nAGENT_PRIVATE_KEY=${privateKey}\n`, { mode: 0o600 });
  chmodSync(path, mode);
  return path;
}

/** A chain stub that fails the test if any network-backed function is reached. */
export function noNetworkChain(overrides = {}) {
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => {
        throw new Error(`unexpected chain access: ${String(prop)}`);
      };
    },
  });
}

// TEST-ONLY adapter. @perkos/agent-sdk 0.9.0 only accepts network "testnet" and ST
// principals, so to exercise the REAL SDK functions offline the mainnet inputs are mapped to
// their testnet twins (same hash160, version 26). The hashes are therefore NOT the ones a
// mainnet-capable SDK would produce; the tests only rely on the SDK's output shape.
const toTestnet = (principal) => {
  const [address, name] = principal.split(".");
  const st = Address.stringify({ ...Address.parse(address), version: 26, contractName: undefined });
  return name ? `${st}.${name}` : st;
};
const shim = (input) => ({
  ...input,
  network: "testnet",
  contract: toTestnet(input.contract),
  ...(input.client ? { client: toTestnet(input.client) } : {}),
  ...(input.evaluator ? { evaluator: toTestnet(input.evaluator) } : {}),
  ...(input.provider ? { provider: toTestnet(input.provider) } : {}),
});
export function testnetShimCommitments() {
  const calls = [];
  const record = (fn, input) => (calls.push({ fn, input }), input);
  return {
    calls,
    supportsMainnet: async () => true,
    prepareEvaluationJob: (input) => prepareEvaluationJob(shim(record("prepareEvaluationJob", input))),
    prepareEvaluationSubmission: (input) => prepareEvaluationSubmission(shim(record("prepareEvaluationSubmission", input))),
    evaluationJobId: (input) => evaluationJobId(shim(record("evaluationJobId", input))),
    parseEvaluationDescription: sdkCommitments.parseEvaluationDescription, // network independent: the production path
  };
}
