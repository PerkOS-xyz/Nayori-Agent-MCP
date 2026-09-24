// Signer: loads the agent key from a locked-down env file, re-verified before EVERY
// signature. The key never leaves this module: it is not cached, not returned, not logged
// and never included in an error message.

import { lstatSync, openSync, fstatSync, readFileSync, closeSync, constants as FS } from "node:fs";
import { isAbsolute } from "node:path";
import { makeContractCall, privateKeyToAddress } from "@stacks/transactions";
import { NETWORK, RailError, buildCallOptions, assertTransactionIsSafe } from "./rails.mjs";

export const ENV_VAR = "NAYORI_AGENT_ENV_FILE";

export class SignerError extends Error {
  constructor(message) {
    super(message);
    this.name = "SignerError";
  }
}

export function signerConfigured(env = process.env) {
  return typeof env[ENV_VAR] === "string" && env[ENV_VAR].length > 0;
}

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Verifies the env file and returns { address, privateKey }. INTERNAL: callers outside
 * this module must use verifySigner() or signContractCall(), which never expose the key.
 */
function loadVerified(env) {
  const path = env[ENV_VAR];
  if (!path) {
    throw new SignerError(`Read-only mode: ${ENV_VAR} is not set, so this server cannot sign transactions.`);
  }
  if (!isAbsolute(path)) throw new SignerError(`${ENV_VAR} must be an absolute path.`);

  let link;
  try {
    link = lstatSync(path);
  } catch {
    throw new SignerError(`${ENV_VAR} does not point to a readable file.`);
  }
  if (link.isSymbolicLink()) throw new SignerError("Signer env file must not be a symlink.");
  if (!link.isFile()) throw new SignerError("Signer env file must be a regular file.");

  // Open with O_NOFOLLOW and re-check on the descriptor so the checks and the read apply
  // to the same inode.
  let fd;
  let text;
  try {
    fd = openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SignerError("Signer env file must be a regular file.");
    if ((st.mode & 0o7777) !== 0o600) {
      throw new SignerError("Signer env file mode must be exactly 0600 (chmod 600).");
    }
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new SignerError("Signer env file must be owned by the user running this server.");
    }
    if (st.ino !== link.ino || st.dev !== link.dev) {
      throw new SignerError("Signer env file changed while it was being verified.");
    }
    if (st.size > 4096) throw new SignerError("Signer env file is unexpectedly large.");
    text = readFileSync(fd, "utf8");
  } catch (err) {
    if (err instanceof SignerError) throw err;
    throw new SignerError("Signer env file could not be opened safely.");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  const vars = parseEnvFile(text);
  const address = vars.AGENT_ADDRESS;
  const privateKey = vars.AGENT_PRIVATE_KEY;
  if (!address || !/^SP[0-9A-Z]{30,50}$/.test(address)) {
    throw new SignerError("Signer env file must define AGENT_ADDRESS as a mainnet single-sig address (SP...).");
  }
  if (!privateKey || !/^(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{64}01)$/.test(privateKey)) {
    throw new SignerError("Signer env file must define AGENT_PRIVATE_KEY as a 64 or 66 character hex string.");
  }
  let derived;
  try {
    derived = privateKeyToAddress(privateKey, NETWORK);
  } catch {
    throw new SignerError("AGENT_PRIVATE_KEY could not be parsed.");
  }
  if (derived !== address) {
    throw new SignerError("AGENT_ADDRESS does not match the mainnet address derived from AGENT_PRIVATE_KEY.");
  }
  return { address, privateKey };
}

/** Runs every check and returns only the address. */
export function verifySigner(env = process.env) {
  return { address: loadVerified(env).address };
}

/**
 * Re-verifies the env file, builds the options through the rails, signs, inspects the
 * result and returns the signed transaction. `call` = { contractName, functionName,
 * functionArgs, nonce, fee } (contractAddress optional, checked against the allowlist).
 * `expectedAddress`, when given, must equal the verified signer address (guards against the
 * file being swapped between the pre-sign chain reads and the signature).
 */
export async function signContractCall(call, { env = process.env, expectedAddress } = {}) {
  const options = buildCallOptions(call); // throws RailError before the key is touched
  const { address, privateKey } = loadVerified(env);
  if (expectedAddress !== undefined && expectedAddress !== address) {
    throw new SignerError("Signer address changed during the operation; nothing was signed.");
  }
  let tx;
  try {
    tx = await makeContractCall({ ...options, senderKey: privateKey });
  } catch {
    // Never forward the underlying message: it could echo option values.
    throw new SignerError("Transaction could not be built or signed.");
  }
  assertTransactionIsSafe(tx, options);
  return { tx, address };
}

export { RailError };
