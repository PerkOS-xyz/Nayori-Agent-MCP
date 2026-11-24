// Nayori evaluation commitments (criteria + evidence). The tools reach the four pure SDK
// commitment functions only through this wrapper. Nothing here signs, broadcasts or touches a
// key, and the hashing is never reimplemented: if the SDK refuses an input, the tool refuses too.

import { prepareEvaluationJob, prepareEvaluationSubmission, parseEvaluationDescription, evaluationJobId } from "./sdk.mjs";
import { PROFILES, escrowId, RailError } from "./rails.mjs";

export const SDK_PACKAGE = "@perkos/agent-sdk";
export const CRITERIA_MARKER = "\nnayori-criteria-v1:";
export const EVIDENCE_PREFIX = "ny1:";
// (string-ascii 512) minus the marker and the 64-character hash.
export const MAX_PLAIN_DESCRIPTION = 512 - CRITERIA_MARKER.length - 64;

const INPUT_RULES =
  `description 1..${MAX_PLAIN_DESCRIPTION} printable ASCII without "nayori-criteria-"; 1..20 acceptance criteria with unique ids ` +
  "([a-zA-Z0-9._-], max 64), requirement and verification 1..1024 characters; evidence with unique ids, https URIs without " +
  "credentials or fragment, lowercase non-zero sha256, mediaType 1..128, sizeBytes 0..25000000; client, provider and evaluator all different";

const support = new Map();
/** Probes the installed SDK once per network: does it produce commitments for that network? */
export async function sdkSupportsNetwork(network = "mainnet") {
  if (!support.has(network)) {
    const profile = PROFILES[network];
    const ok = profile
      ? await evaluationJobId({ network, contract: escrowId(profile, "sbtc"), jobId: "1" }).then(() => true, () => false)
      : false;
    support.set(network, ok);
  }
  return support.get(network);
}

const unsupported = (network) =>
  `Refused: the installed ${SDK_PACKAGE} does not produce ${network} evaluation commitments for the Nayori escrows. ` +
  "Nothing was signed. Install @perkos/agent-sdk 0.10.0 or later; the hashing is never reimplemented here.";

async function guarded(label, input, fn) {
  const network = input?.network ?? "mainnet";
  if (!(await sdkSupportsNetwork(network))) throw new RailError(unsupported(network));
  try {
    return await fn();
  } catch (err) {
    // The SDK throws one opaque code; never echo input back.
    throw new RailError(`Refused: ${SDK_PACKAGE} rejected the ${label} (${err?.message ?? "error"}). Rules: ${INPUT_RULES}.`);
  }
}

/** Default implementation used by the tools; tests inject their own through deps.commitments. */
export const sdkCommitments = Object.freeze({
  supportsNetwork: sdkSupportsNetwork,
  prepareEvaluationJob: (input) => guarded("criteria commitment input", input, () => prepareEvaluationJob(input)),
  prepareEvaluationSubmission: (input) => guarded("evidence commitment input", input, () => prepareEvaluationSubmission(input)),
  evaluationJobId: (input) => guarded("evaluation id input", input, () => evaluationJobId(input)),
  // Network independent in the SDK, so it works for every installed version.
  parseEvaluationDescription(description) {
    try {
      return parseEvaluationDescription(description);
    } catch {
      throw new RailError(`Refused: the job's on-chain description does not end with a "nayori-criteria-v1:" commitment, so it is not a committed evaluation job.`);
    }
  },
});

/** Belt and braces on what the SDK returned before it goes on-chain. */
export function assertCommittedDescription({ plainDescription, prepared }) {
  const expected = plainDescription + CRITERIA_MARKER + prepared?.criteriaHash;
  if (!/^[0-9a-f]{64}$/.test(prepared?.criteriaHash ?? "") || prepared.description !== expected || expected.length > 512) {
    throw new RailError("Refused: the SDK returned an unexpected committed description.");
  }
}

export function assertCommittedDeliverable(deliverable) {
  const bytes = deliverable instanceof Uint8Array ? deliverable : null;
  if (!bytes || bytes.length !== 36 || Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== EVIDENCE_PREFIX) {
    throw new RailError("Refused: the SDK returned an unexpected deliverable (expected 36 bytes starting with ny1:).");
  }
  return bytes;
}
