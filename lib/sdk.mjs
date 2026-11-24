// The only module that imports @perkos/agent-sdk. Everything this server takes from the SDK
// is listed here: the read client and transaction builder for the live Nayori contracts,
// their limits and error table, and the four pure evaluation-commitment functions. Nothing
// here signs, broadcasts or touches a key: signing stays in lib/signer.mjs behind the rails.

export {
  NayoriNextClient,
  NayoriNextTransactionBuilder,
  resolveNayoriNextConfig,
  NAYORI_NEXT_DEPLOYMENTS,
  NAYORI_NEXT_LIMITS,
  describeNayoriNextError,
  quoteNayoriNextFee,
  prepareEvaluationJob,
  prepareEvaluationSubmission,
  parseEvaluationDescription,
  evaluationJobId,
} from "@perkos/agent-sdk";
