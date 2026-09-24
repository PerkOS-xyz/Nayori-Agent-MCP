// Nayori evaluation commitments (criteria + evidence). This is the ONLY module that imports
// @perkos/agent-sdk, and it imports exactly four pure functions. Nothing here signs,
// broadcasts or touches a key, and the hashing is never reimplemented: if the SDK refuses
// an input, the tool refuses too.

import {
  prepareEvaluationJob,
  prepareEvaluationSubmission,
  parseEvaluationDescription,
  evaluationJobId,
} from "@perkos/agent-sdk";
import { NETWORK, CONTRACT_IDS, RailError } from "./rails.mjs";

export const SDK_PACKAGE = "@perkos/agent-sdk";
export const CRITERIA_MARKER = "\nnayori-criteria-v1:";
export const EVIDENCE_PREFIX = "ny1:";
// (string-ascii 512) minus the marker and the 64-character hash.
export const MAX_PLAIN_DESCRIPTION = 512 - CRITERIA_MARKER.length - 64;

const INPUT_RULES =
  `description 1..${MAX_PLAIN_DESCRIPTION} printable ASCII without "nayori-criteria-"; 1..20 acceptance criteria with unique ids ` +
  "([a-zA-Z0-9._-], max 64), requirement and verification 1..1024 characters; evidence with unique ids, https URIs without " +
  "credentials or fragment, lowercase non-zero sha256, mediaType 1..128, sizeBytes 0..25000000; client, provider and evaluator all different";

let mainnetSupport;
/** Probes the installed SDK once: does it accept mainnet commitments at all? */
export async function sdkSupportsMainnet() {
  if (mainnetSupport === undefined) {
    mainnetSupport = await evaluationJobId({ network: NETWORK, contract: CONTRACT_IDS.sbtcEscrow, jobId: "1" }).then(
      () => true,
      () => false
    );
  }
  return mainnetSupport;
}

const UNSUPPORTED =
  `Refused: the installed ${SDK_PACKAGE} does not produce ${NETWORK} evaluation commitments (it only accepts network "testnet" and ST principals). ` +
  "Nothing was signed. Pin an SDK release with mainnet commitment support to use the committed-evaluation tools; the hashing is never reimplemented here.";

async function guarded(label, fn) {
  if (!(await sdkSupportsMainnet())) throw new RailError(UNSUPPORTED);
  try {
    return await fn();
  } catch (err) {
    // The SDK throws one opaque code; never echo input back.
    throw new RailError(`Refused: ${SDK_PACKAGE} rejected the ${label} (${err?.message ?? "error"}). Rules: ${INPUT_RULES}.`);
  }
}

/** Default implementation used by the tools; tests inject their own through deps.commitments. */
export const sdkCommitments = Object.freeze({
  supportsMainnet: sdkSupportsMainnet,
  prepareEvaluationJob: (input) => guarded("criteria commitment input", () => prepareEvaluationJob(input)),
  prepareEvaluationSubmission: (input) => guarded("evidence commitment input", () => prepareEvaluationSubmission(input)),
  evaluationJobId: (input) => guarded("evaluation id input", () => evaluationJobId(input)),
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
