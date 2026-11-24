// Test fixtures. The key is random, generated per run, and obviously not a real wallet.
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRandomPrivKey, privateKeyToAddress } from "@stacks/transactions";
import { sdkCommitments } from "../lib/commitments.mjs";

export function fakeKey(network = "mainnet") {
  const privateKey = makeRandomPrivKey();
  return { privateKey, address: privateKeyToAddress(privateKey, network) };
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

/** The real SDK commitments (lib/commitments.mjs), recording every call. */
export function recordingCommitments() {
  const calls = [];
  const record = (fn) => (input) => (calls.push({ fn, input }), sdkCommitments[fn](input));
  return {
    calls,
    supportsNetwork: sdkCommitments.supportsNetwork,
    prepareEvaluationJob: record("prepareEvaluationJob"),
    prepareEvaluationSubmission: record("prepareEvaluationSubmission"),
    evaluationJobId: record("evaluationJobId"),
    parseEvaluationDescription: sdkCommitments.parseEvaluationDescription,
  };
}
