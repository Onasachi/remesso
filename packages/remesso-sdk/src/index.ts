/// remesso-sdk: recurring and agent payments on Celo.
///
/// Celo mainnet only: there is no testnet. The contracts are live and have
/// not been audited by a person, so start with small amounts.
export { createRemesso, type Remesso, type RemessoOptions } from "./client.js";
export { RemessoError, type RemessoErrorCode } from "./errors.js";

export {
  ALLOWANCE,
  CHAIN_ID,
  CURRENT_EXECUTOR,
  deployment,
  EXECUTOR,
  FEE_BPS,
  findToken,
  formatAmount,
  REGISTRY,
  runLimits,
  type Token,
  token,
  toUnits,
} from "./deployment.js";
export { feeOf, grossFor, netOf } from "./vendor/fee.js";
export { allowanceAbi, erc20Abi, executorAbi, registryAbi } from "./abi.js";
export { ATTRIBUTION, attributionFor } from "./attribution.js";

export { CADENCES, type Cadence, type CreatedSchedule, type CreateScheduleInput, type Schedule } from "./schedules.js";
export { memo32, type PayInput, type PaymentResult } from "./payments.js";
export type { CreatePolicyInput, Policy } from "./policies.js";
export type { CreateRequestInput, RequestState, RequestStatus, RequestSummary } from "./requests.js";
export type { EventKind, EventQuery, PaymentEvent } from "./events.js";
export {
  parseWebhook,
  verifyWebhook,
  webhookHandler,
  type WebhookHandlerOptions,
  type WebhookMessage,
  type WebhookType,
} from "./webhooks.js";
export type { FoundAgent } from "./agents.js";
export type { PayeeProfile } from "./vendor/payee-profile.js";
export { type PayLink, type PayLinkInput, parsePayLink, payLink } from "./links.js";
export { memoryStore, type PaymentRecord, type PaymentStore } from "./store.js";
