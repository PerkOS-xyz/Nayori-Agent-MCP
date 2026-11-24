// zod input shapes for every tool. Length limits match the live Nayori contracts:
// nayori-agents register name (string-ascii 64), uri (string-ascii 256); escrow create-job
// description (string-ascii 512), of which 84 characters are reserved for the criteria
// commitment the SDK appends; application deposits 100 to 1,000,000 sats.
// The criteria and evidence limits mirror @perkos/agent-sdk and the Evaluator schema.

import { z } from "zod";
import { validateStacksAddress } from "@stacks/transactions";
import { LIMITS } from "./rails.mjs";
import { MAX_PLAIN_DESCRIPTION } from "./commitments.mjs";

// Printable ASCII only (space .. tilde). No control characters, no newlines, no non-ASCII.
const PRINTABLE = /^[\x20-\x7E]*$/;

const printable = (max, { min = 0 } = {}) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(PRINTABLE, "must contain only printable ASCII characters (0x20-0x7E)");

const MAX_ID = 1_000_000_000;

const jobId1 = z.number().int().min(1).max(MAX_ID); // escrow job ids are 1-based

export const asset = z.enum(["sbtc", "stx"]);

// Standard (non-contract) principal: SP or SM on mainnet, ST or SN on testnet. The tools also
// require the network of the configured profile.
const principal = z
  .string()
  .max(64)
  .refine((s) => /^S[PMTN][0-9A-Z]+$/.test(s) && validateStacksAddress(s), "must be a standard principal (SP or SM on mainnet, ST or SN on testnet)");

const sbtcOnly = z.literal("sbtc").optional().describe('Applications exist on sBTC jobs only. Optional, "sbtc".');

const commitmentId = z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, "must match [a-zA-Z0-9._-]");
const uniqueIds = (items) => new Set(items.map((i) => i.id)).size === items.length;

const acceptanceCriteria = z
  .array(z.object({ id: commitmentId, requirement: z.string().min(1).max(1024), verification: z.string().min(1).max(1024) }).strict())
  .min(1)
  .max(20)
  .refine(uniqueIds, "criterion ids must be unique")
  .describe("The job's acceptance criteria. They are hashed into the on-chain commitment, so keep the exact text.");

const evidence = z
  .array(
    z
      .object({
        id: commitmentId,
        uri: z.string().max(2048).refine((s) => {
          try {
            const u = new URL(s);
            return u.protocol === "https:" && !u.username && !u.password && !u.hash;
          } catch {
            return false;
          }
        }, "must be an https URL without credentials or fragment"),
        sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters").refine((s) => !/^0+$/.test(s), "must be non-zero"),
        mediaType: z.string().min(1).max(128),
        sizeBytes: z.number().int().min(0).max(25_000_000),
      })
      .strict()
  )
  .min(1)
  .max(5)
  .refine(uniqueIds, "evidence ids must be unique")
  .describe("Evidence files: public https URI, SHA-256 of the exact bytes, media type and size.");

export const shapes = {
  nayori_agent_context: {},
  nayori_open_jobs: {
    asset: asset.optional().describe('Escrow to scan: "sbtc" or "stx". Omit to scan both.'),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum jobs to return per asset (default 20, max 50)."),
  },
  nayori_get_job: { asset, jobId: jobId1 },
  nayori_list_applications: { asset: sbtcOnly, jobId: jobId1 },
  nayori_register_agent: {
    name: printable(LIMITS.agentName, { min: 1 }).refine((s) => s.trim().length > 0, "must not be blank").describe("Agent name, printable ASCII, 1 to 64 characters."),
    uri: printable(LIMITS.agentUri).optional().describe("Optional link to the agent's profile or endpoint, printable ASCII, max 256."),
  },
  nayori_apply_to_job: {
    asset: sbtcOnly,
    jobId: jobId1,
    deposit: z
      .number()
      .int()
      .min(LIMITS.deposit.min)
      .max(LIMITS.deposit.max)
      .describe("Refundable sBTC deposit in sats (100 to 1,000,000, and at most NAYORI_AGENT_MAX_DEPOSIT_SATS, default 10,000). The list is sorted by deposit."),
  },
  nayori_withdraw_application: { asset: sbtcOnly, jobId: jobId1 },
  nayori_accept_job: { asset, jobId: jobId1 },
  nayori_submit_work: {
    asset,
    jobId: jobId1,
    deliverableReference: z
      .string()
      .max(2048)
      .refine((s) => s.trim().length > 0, "must not be blank")
      .describe("URL, CID or description of the deliverable. Only its SHA-256 digest goes on-chain."),
  },
  nayori_client_create_job: {
    asset,
    description: printable(MAX_PLAIN_DESCRIPTION, { min: 1 })
      .refine((s) => s.trim().length > 0, "must not be blank")
      .refine((s) => !s.includes("nayori-criteria-"), 'must not contain "nayori-criteria-"')
      .describe(`Plain job description, printable ASCII, max ${MAX_PLAIN_DESCRIPTION}. The criteria commitment is appended automatically.`),
    acceptanceCriteria,
    budget: z
      .number()
      .int()
      .min(LIMITS.budget.sbtc.min)
      .max(LIMITS.budget.stx.max)
      .describe("Budget in atomic units: sats for sbtc (1,000 to 100,000,000), microSTX for stx (1,000,000 to 100,000,000,000). Recorded at creation; funding is a human wallet action."),
    evaluator: principal.optional().describe("Evaluator principal. Default: the Nayori managed Evaluator."),
    deliveryBlocks: z
      .number()
      .int()
      .min(LIMITS.deliveryBlocks.min)
      .max(LIMITS.deliveryBlocks.max)
      .optional()
      .describe(`Bitcoin blocks to fund, offer and accept, then again to deliver after acceptance. Default ${LIMITS.deliveryBlocks.default}.`),
    reviewBlocks: z
      .number()
      .int()
      .min(LIMITS.reviewBlocks.min)
      .max(LIMITS.reviewBlocks.max)
      .optional()
      .describe(`Bitcoin blocks the evaluator has to decide after delivery. Default ${LIMITS.reviewBlocks.default}.`),
  },
  nayori_client_name_provider: { asset, jobId: jobId1, provider: principal },
  nayori_appeal_decision: {
    asset,
    jobId: jobId1,
    appealReference: z.string().trim().min(1).max(512).regex(/^[\x20-\x7e]+$/).describe("Appeal evidence URL, CID or concise reference. Only its SHA-256 goes on-chain."),
  },
  nayori_provider_submit_committed: { asset, jobId: jobId1, acceptanceCriteria, evidence },
  nayori_evaluation_request: { asset, jobId: jobId1, acceptanceCriteria, evidence,
    send: z.boolean().optional().describe("true: also POST the body to the Nayori evaluation relay (NAYORI_EVALUATION_RELAY, default https://app.nayori.ai/api/evaluations on mainnet, https://qa.nayori.ai/api/evaluations on testnet) and return its answer. Default false: build only.") },
  nayori_tx_status: {
    txid: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be a 32-byte hex transaction id"),
  },
};

export const schemas = Object.fromEntries(Object.entries(shapes).map(([k, shape]) => [k, z.object(shape).strict()]));
