import test from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { verifySigner, signContractCall, signerConfigured, SignerError, ENV_VAR } from "../lib/signer.mjs";
import { fakeKey, writeEnvFile, tempDir } from "./helpers.mjs";

const envFor = (path) => ({ [ENV_VAR]: path });

test("accepts a 0600 regular file owned by the current user and returns only the address", () => {
  const k = fakeKey();
  const out = verifySigner(envFor(writeEnvFile(k)));
  assert.deepEqual(out, { address: k.address });
  assert.ok(!JSON.stringify(out).includes(k.privateKey));
});

test("missing env var means read-only", () => {
  assert.equal(signerConfigured({}), false);
  assert.throws(() => verifySigner({}), (e) => e instanceof SignerError && /Read-only mode/.test(e.message));
});

test("rejects a relative path", () => {
  assert.throws(() => verifySigner(envFor("agent.env")), /absolute path/);
});

test("rejects a missing file", () => {
  assert.throws(() => verifySigner(envFor(join(tempDir(), "nope.env"))), /readable file/);
});

for (const mode of [0o644, 0o640, 0o400, 0o700, 0o660]) {
  test(`rejects mode ${mode.toString(8)}`, () => {
    assert.throws(() => verifySigner(envFor(writeEnvFile({ ...fakeKey(), mode }))), /0600/);
  });
}

test("rejects a symlink even when the target is a valid 0600 file", () => {
  const dir = tempDir();
  const real = writeEnvFile({ ...fakeKey(), dir });
  const link = join(dir, "link.env");
  symlinkSync(real, link);
  assert.throws(() => verifySigner(envFor(link)), /symlink/);
});

test("rejects a directory", () => {
  const dir = join(tempDir(), "d");
  mkdirSync(dir, { mode: 0o600 });
  assert.throws(() => verifySigner(envFor(dir)), /regular file/);
});

test("rejects a file owned by another uid", (t) => {
  const path = writeEnvFile(fakeKey());
  const realUid = process.getuid();
  t.mock.method(process, "getuid", () => realUid + 1);
  assert.throws(() => verifySigner(envFor(path)), /owned by the user/);
});

test("rejects an address that does not match the key, without leaking the key", () => {
  const a = fakeKey();
  const b = fakeKey();
  const path = writeEnvFile({ address: b.address, privateKey: a.privateKey });
  assert.throws(
    () => verifySigner(envFor(path)),
    (e) => /does not match/.test(e.message) && !e.message.includes(a.privateKey) && !e.message.includes(a.privateKey.slice(0, 16))
  );
});

test("rejects an address of the other network and a malformed key without echoing them", () => {
  const k = fakeKey();
  assert.throws(() => verifySigner(envFor(writeEnvFile({ address: "ST" + k.address.slice(2), privateKey: k.privateKey }))), /mainnet single-sig address \(SP\.\.\.\)/);
  const bad = "zz" + k.privateKey.slice(2);
  assert.throws(
    () => verifySigner(envFor(writeEnvFile({ address: k.address, privateKey: bad }))),
    (e) => /hex string/.test(e.message) && !e.message.includes(bad)
  );
  // NAYORI_AGENT_NETWORK=testnet expects an ST address derived on testnet, and refuses SP.
  const t = fakeKey("testnet");
  assert.deepEqual(verifySigner({ ...envFor(writeEnvFile(t)), NAYORI_AGENT_NETWORK: "testnet" }), { address: t.address });
  assert.throws(() => verifySigner({ ...envFor(writeEnvFile(k)), NAYORI_AGENT_NETWORK: "testnet" }), /testnet single-sig address \(ST\.\.\.\)/);
  assert.throws(() => verifySigner({ ...envFor(writeEnvFile(k)), NAYORI_AGENT_NETWORK: "devnet" }), /NAYORI_AGENT_NETWORK/);
});

test("signContractCall re-verifies the file before every signature", async () => {
  const k = fakeKey();
  const path = writeEnvFile(k);
  const call = { contractName: "nayori-agents", functionName: "register", functionArgs: [], nonce: 0, fee: 3000 };
  const { address } = await signContractCall(call, { env: envFor(path) });
  assert.equal(address, k.address);
  const { chmodSync } = await import("node:fs");
  chmodSync(path, 0o644);
  await assert.rejects(signContractCall(call, { env: envFor(path) }), /0600/);
});

test("signContractCall refuses when the verified address differs from the expected one", async () => {
  const path = writeEnvFile(fakeKey());
  const call = { contractName: "nayori-agents", functionName: "register", functionArgs: [], nonce: 0, fee: 3000 };
  await assert.rejects(signContractCall(call, { env: envFor(path), expectedAddress: fakeKey().address }), /address changed/);
});

test("signContractCall refuses an apply-to-job without the signer address or above the deposit cap, before the key is read", async () => {
  const k = fakeKey();
  const apply = { contractName: "nayori-applications", functionName: "apply-to-job", functionArgs: [], nonce: 0, fee: 3000, amount: 500 };
  await assert.rejects(signContractCall(apply, { env: envFor("relative/not/read.env") }), /needs the signer address/);
  await assert.rejects(signContractCall({ ...apply, amount: 10_001 }, { env: envFor("relative/not/read.env"), expectedAddress: k.address }), /outside 100\.\.10000/);
  const { tx } = await signContractCall({ ...apply, amount: 10_001 }, { env: { ...envFor(writeEnvFile(k)), NAYORI_AGENT_MAX_DEPOSIT_SATS: "20000" }, expectedAddress: k.address });
  assert.equal(tx.postConditions.values.length, 2);
});
