/// The slice of RemessoExecutor the sender's browser needs.
///
/// Only sender-facing entry points are here. `executeRun` is deliberately
/// absent: it is `onlyExecutor`, and putting it in the frontend ABI would
/// suggest the browser has any business calling it.
export const executorAbi = [
  // Custom errors. viem can only name a revert whose error is present in the
  // ABI — without these every failed createSchedule/executeRun surfaces as
  // "reverted with the following reason:" followed by nothing, and the contract's
  // actual complaint is discarded at the worst possible moment.
  { type: "error", name: "NotExecutor", inputs: [] },
  { type: "error", name: "NotScheduleOwner", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "InvalidAmount", inputs: [] },
  { type: "error", name: "InvalidInterval", inputs: [] },
  { type: "error", name: "InvalidRate", inputs: [] },
  { type: "error", name: "ScheduleInactive", inputs: [] },
  { type: "error", name: "ScheduleIsCancelled", inputs: [] },
  { type: "error", name: "ScheduleExpired", inputs: [] },
  { type: "error", name: "RunCapReached", inputs: [] },
  { type: "error", name: "NotDue", inputs: [{ name: "nextRunAt", type: "uint64" }] },
  {
    type: "error",
    name: "SlippageBoundBelowFloor",
    inputs: [{ name: "provided", type: "uint256" }, { name: "floor", type: "uint256" }],
  },
  {
    type: "error",
    name: "InsufficientOutput",
    inputs: [{ name: "received", type: "uint256" }, { name: "floor", type: "uint256" }],
  },
  { type: "error", name: "InvalidDestination", inputs: [] },
  { type: "error", name: "DegenerateFloor", inputs: [] },
  { type: "error", name: "ScheduleLifetimeTooLong", inputs: [] },
  { type: "error", name: "RenounceDisabled", inputs: [] },
  { type: "error", name: "TokenNotAllowed", inputs: [] },
  { type: "error", name: "WrongTokenForPayoutType", inputs: [] },
  { type: "error", name: "SameToken", inputs: [] },
  { type: "error", name: "NotTrigger", inputs: [] },
  { type: "error", name: "NoTriggersLeft", inputs: [] },
  // V5
  { type: "error", name: "InvalidTrigger", inputs: [] },
  { type: "error", name: "FirstRunAfterExpiry", inputs: [] },
  { type: "error", name: "NoFloorOnDirect", inputs: [] },
  {
    type: "error",
    name: "TriggeredTooSoon",
    inputs: [{ name: "nextAllowed", type: "uint64" }],
  },
  {
    type: "error",
    name: "FeeTooHigh",
    inputs: [
      { name: "provided", type: "uint16" },
      { name: "max", type: "uint16" },
    ],
  },

  {
    type: "function",
    name: "createSchedule",
    stateMutability: "nonpayable",
    inputs: [
      { name: "destination", type: "address" },
      { name: "amountIn", type: "uint128" },
      { name: "interval", type: "uint64" },
      { name: "minRateE6", type: "uint96" },
      { name: "maxRuns", type: "uint32" },
      { name: "expiresAt", type: "uint64" },
      { name: "firstRunAt", type: "uint64" },
      { name: "payoutType", type: "uint8" },
      { name: "token", type: "address" },
      // V4. `payoutToken` is what the recipient is paid in on the swap rails
      // and is ignored on Direct; `trigger` and `triggersLeft` are the
      // sender's grant of early sends, and zero means the schedule only ever
      // runs on its own cadence.
      { name: "payoutToken", type: "address" },
      { name: "trigger", type: "address" },
      { name: "triggersLeft", type: "uint16" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "setScheduleActive",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "active", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelSchedule",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "feeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "setTrigger",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "trigger", type: "address" },
      { name: "triggersLeft", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "directTokenAllowed",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "schedulesOf",
    stateMutability: "view",
    inputs: [{ name: "sender", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getSchedule",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "interval", type: "uint64" },
          { name: "maxRuns", type: "uint32" },
          { name: "destination", type: "address" },
          { name: "nextRunAt", type: "uint64" },
          { name: "runsExecuted", type: "uint32" },
          { name: "amountIn", type: "uint128" },
          { name: "minRateE6", type: "uint96" },
          { name: "poolFee", type: "uint24" },
          { name: "expiresAt", type: "uint64" },
          { name: "payoutType", type: "uint8" },
          { name: "active", type: "bool" },
          { name: "cancelled", type: "bool" },
          { name: "token", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "feeBps", type: "uint16" },
          { name: "lastRunAt", type: "uint64" },
          { name: "triggersLeft", type: "uint16" },
          { name: "trigger", type: "address" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "runnability",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "due", type: "bool" },
      { name: "funded", type: "bool" },
      { name: "approved", type: "bool" },
      { name: "floor", type: "uint256" },
      { name: "nextRunAt", type: "uint64" },
    ],
  },
  {
    type: "event",
    name: "ScheduleCreated",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "destination", type: "address", indexed: true },
      { name: "amountIn", type: "uint128" },
      { name: "interval", type: "uint64" },
      { name: "minRateE6", type: "uint96" },
      { name: "maxRuns", type: "uint32" },
      { name: "expiresAt", type: "uint64" },
      { name: "payoutType", type: "uint8" },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/// Matches the PayoutType enum in RemessoExecutorV3.sol.
/// Direct forwards the funding asset with no swap.
export const PayoutType = { Wallet: 0, BankRedemption: 1, Direct: 2 } as const;

/// QuoterV2. `quoteExactInputSingle` is non-view (it reverts to return data),
/// so it must be simulated rather than read.
export const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/// `executor()` on its own, deliberately not folded into `executorAbi`.
///
/// Adding one more entry there pushes viem past the point where it can infer
/// return types from the array, and every other read silently degrades to `{}`
/// — `triggerability` and `getSchedule` included. A one-line ABI costs nothing
/// and keeps that inference intact.
///
/// Read from the contract rather than kept in an env var: `setExecutor` can
/// change it, and a grant the sender signs has to name the address that will
/// actually do the sending.
export const executorAddressAbi = [
  "function executor() view returns (address)",
] as const;
