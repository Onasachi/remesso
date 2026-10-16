// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISwapRouter02} from "./ISwapRouter02.sol";

/**
 * @title  RemessoExecutor
 * @notice Recurring, policy-bound remittances on Celo.
 *
 * The problem this solves: a sender wants to set up a remittance once and have
 * it run unattended, without handing anyone a spending key.
 *
 * The shape of the answer:
 *
 *   1. The sender calls `approve()` on the funding token (USDT) for this
 *      contract, then `createSchedule()` with a policy — destination, amount
 *      per run, minimum interval, floor exchange rate, expiry, run cap.
 *   2. Remesso's backend (the `executor`) calls `executeRun()` when a schedule
 *      is due. It supplies only a slippage bound. It cannot change the amount,
 *      the destination, the cadence, or anything else.
 *   3. Each run pulls exactly `amountIn` from the sender, swaps it to cNGN on
 *      Uniswap V3, and delivers straight to the schedule's destination.
 *
 * What the executor CANNOT do, by construction:
 *   - send to any address other than the one the sender fixed at creation
 *   - move more than `amountIn` per run, or run more often than `interval`
 *   - accept a worse rate than the sender's `minRateE6` floor
 *   - keep running after `expiresAt` or past `maxRuns`
 *   - touch a schedule the sender has paused or cancelled
 *
 * The sender's ERC20 allowance is the outermost cap and is revocable at any
 * time without our cooperation. The contract custodies nothing: funds move
 * from sender to destination inside a single transaction.
 *
 * @dev V5. Fixes from the 2026-10-16 solidity-auditor scans of V4
 *      (`.solidity-auditor/runs/20261016-*`). Same storage layout, same ABI
 *      apart from one added constant and three added errors.
 *
 *      - An early send MOVES a run, it does not ADD one. V4 set `nextRunAt`
 *        to now + interval after `runNow`, so on a schedule with no run cap
 *        every trigger was one more `amountIn` on top of the cadence. Now an
 *        early send uses up the next scheduled slot, and a trigger on a run
 *        that is already due costs no early send at all.
 *      - `CURRENT_EXECUTOR` (address(1)) as `trigger` means "whoever is the
 *        executor now". V4 stored the executor's literal address, so a key
 *        rotated out by `setExecutor` kept `runNow` on every schedule naming
 *        it. Naming the executor's literal address is now refused.
 *      - On the swap rails the only third-party trigger allowed is the
 *        executor. A trigger chooses the time of the swap and its slippage
 *        bound, so an arbitrary one could sandwich its own early send down to
 *        the floor.
 *      - The commission rounds UP, so no amount runs commission-free, and the
 *        degenerate-floor check in `createSchedule` and `setMinRate` uses the
 *        NET amount — the one `_run` enforces the floor on.
 *      - `setMinRate` refuses a Direct schedule (it has no floor), and
 *        `createSchedule` refuses a first run after the expiry.
 *
 * @dev V4 adds three things and keeps the contract immutable. Every owner
 *      setting below is PINNED INTO THE SCHEDULE at consent, so changing one
 *      can never alter a remittance somebody already authorised — the same
 *      rule V2 introduced for `poolFee`, applied to everything new.
 *
 *      1. `tokenOut` per schedule, from an owner allowlist. The swap rails are
 *         no longer hardwired to cNGN: a sender can be paid in any allowed
 *         asset, which is what makes a corridor other than naira possible
 *         without redeploying.
 *      2. `runNow` — a payment can be TRIGGERED early, by the sender or by an
 *         address the sender nominates, up to a number of early sends they
 *         authorise at consent. It changes nothing else: same destination,
 *         same amount, same floor, same run cap, same expiry. This is what
 *         lets another app, or an agent, ask Remesso to pay rather than only
 *         watch it pay.
 *      3. A commission, in basis points, capped at MAX_FEE_BPS in code and
 *         pinned per schedule. Taken from the funding amount before the rail
 *         runs, paid to `treasury`. A sender sees the exact rate they are
 *         agreeing to, and no later owner action can raise it on them.
 *
 * @dev V3 adds a second rail. `Direct` forwards the funding asset itself with
 *      no swap: the sender funds in USDT, USDC or cUSD and the recipient
 *      receives that same asset. There is no conversion, so no floor rate, no
 *      slippage, no pool and no dependency on the single cNGN venue.
 *
 *      This exists because MiniPay — the wallet this product targets — displays
 *      only USDm (cUSD), USDC and USDT. A recipient paid in cNGN sees nothing,
 *      and MiniPay has no custom-token import. The swap rails remain for bank
 *      payouts, where the recipient never touches a wallet.
 *
 *      Note the assets differ in decimals: USDT and USDC are 6dp, cUSD is 18dp.
 *      The contract is decimal-agnostic (it moves `amountIn` base units), but
 *      anything formatting these values is not.
 *
 * @dev V2. Changes from the deployed V1 (0xC7eF75fC…1189), all from the
 *      2026-09-14 security review:
 *
 *      - The swap now lands in this contract and is forwarded with an explicit
 *        `safeTransfer`. V1 paid the recipient straight from the Uniswap pool,
 *        which made the POOL the cNGN sender-of-record — and cNGN only burns
 *        (its signal to pay naira) when the transferor is on its
 *        external-sender whitelist. A public pool is not and cannot be, so
 *        every bank payout would have silently never paid out.
 *      - Delivery is asserted on the recipient's measured balance delta, not
 *        on the router's self-reported return value.
 *      - `destination` rejects the router's MSG_SENDER/ADDRESS_THIS sentinels.
 *      - The floor is validated at creation, not merely `minRateE6 != 0`.
 *      - `poolFee` is pinned per schedule at consent time.
 *      - Schedules must expire, and the sender can refresh their floor.
 *      - `renounceOwnership` is disabled.
 *
 * @dev Destination is deliberately immutable. For wallet payouts it is the
 *      recipient's address. For bank payouts it is the cNGN redemption address
 *      the sender consented to at setup — the bank details themselves live off
 *      chain, in the cNGN API. Changing where money goes requires cancelling
 *      and creating a new schedule, which is the point.
 */
contract RemessoExecutorV5 is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Where the swapped cNGN ends up. Purely informational on-chain —
    /// the envelope is enforced through `destination` either way — but it lets
    /// indexers and the backend tell the two flows apart.
    enum PayoutType {
        Wallet, // swap to cNGN, straight to the recipient's own wallet
        BankRedemption, // swap to cNGN, to a redemption address; naira lands in a bank
        Direct // no swap at all: the funding asset itself is forwarded
    }

    struct Schedule {
        address sender; //  slot 0
        uint64 interval; //  minimum seconds between runs
        uint32 maxRuns; //  0 = unlimited
        address destination; //  slot 1  — immutable after creation
        uint64 nextRunAt; //  earliest timestamp the next run may execute
        uint32 runsExecuted;
        uint128 amountIn; //  slot 2  — funding-token units pulled per run
        uint96 minRateE6; //  floor: min tokenOut per 1e6 tokenIn
        uint24 poolFee; //  pinned at consent: 16+12+3 = 31 bytes, still slot 2
        uint64 expiresAt; //  slot 3  — always set; schedules must expire
        PayoutType payoutType;
        bool active; //  sender's pause switch
        bool cancelled; //  terminal; cannot be undone by anyone
        /// The asset pulled from the sender. For the swap rails this is always
        /// `tokenIn`. For Direct it is whichever allowed stablecoin the sender
        /// chose, pinned here at consent so a later allowlist change cannot
        /// alter what a live schedule moves.
        /// 8 + 1 + 1 + 1 + 20 = 31 bytes: still slot 3.
        address token;
        /// What the recipient is paid in on the swap rails, pinned at consent.
        /// Zero on Direct, which converts nothing.
        address tokenOut; //  slot 4
        /// Commission in basis points, pinned at consent. An owner who later
        /// raises `feeBps` changes nothing here.
        uint16 feeBps;
        /// When the last run fired. Only `runNow` reads it, to keep an early
        /// send from being repeated inside the same minute.
        uint64 lastRunAt; //  20 + 2 + 8 = 30 bytes: slot 4 holds
        /// Early sends the sender authorised, decremented per `runNow`.
        /// Zero — the default — means the schedule can only run on its own
        /// cadence, exactly as V3 did.
        uint16 triggersLeft; //  32 bytes exactly
        /// Who else may call `runNow`, chosen by the sender. Zero means only
        /// the sender can. Bounded by `triggersLeft`, and it can never change
        /// the destination or the amount. `CURRENT_EXECUTOR` means whoever
        /// the executor is at call time; on the swap rails that is the only
        /// grant a third party may hold.
        address trigger; //  slot 5
    }

    // --- immutable config -------------------------------------------------

    IERC20 public immutable tokenIn; // USDT on Celo
    /// @notice Default output asset for new swap-rail schedules (cNGN on Celo).
    /// @dev Immutable, but no longer the only option: a schedule may name any
    ///      allowed `tokenOut`, pinned at consent.
    IERC20 public immutable tokenOut;
    ISwapRouter02 public immutable router;

    // --- mutable config (owner) -------------------------------------------

    /// @notice The only address allowed to trigger runs.
    address public executor;

    /// @notice Uniswap V3 fee tier for the tokenIn/tokenOut pool. 100 = 0.01%.
    uint24 public poolFee;

    /// @notice Commission applied to NEW schedules, in basis points.
    /// @dev Pinned per schedule at consent. Hard-capped by MAX_FEE_BPS: the
    ///      cap is in code precisely so "the owner can raise the fee" has a
    ///      ceiling a sender can read before signing.
    uint16 public feeBps;

    /// @notice Where commission is paid. Read at execution, not pinned — it
    ///         routes Remesso's own revenue and touches no sender funds, so a
    ///         key rotation must not strand it.
    address public treasury;

    // --- state ------------------------------------------------------------

    /// @notice Longest a schedule may run before the sender must re-consent.
    /// @dev The floor is denominated in a currency that has lost most of its
    ///      value against USD within a single schedule's plausible lifetime. A
    ///      perpetual schedule is a perpetual standing order at a price nobody
    ///      has looked at since signup, so V1's `expiresAt == 0` is gone.
    uint64 public constant MAX_LIFETIME = 365 days;

    /// @notice Upper bound on `interval`. V1 checked only `!= 0`, so a near-max
    ///         value passed every gate and then panicked on the checked add in
    ///         executeRun, wedging the schedule permanently "due".
    uint64 public constant MAX_INTERVAL = 365 days;

    /// @notice Assets permitted on the Direct rail.
    /// @dev Checked only at createSchedule, never at execution: a schedule
    ///      carries the token it was authorised with. Removing an asset here
    ///      stops new schedules, it does not retroactively change live ones —
    ///      the lesson from V1's mutable poolFee.
    mapping(address => bool) public directTokenAllowed;

    /// @notice Assets a swap-rail schedule may be paid out in.
    /// @dev Same rule as the Direct allowlist: consulted at createSchedule and
    ///      never at execution, so removing one stops new schedules without
    ///      touching live ones.
    mapping(address => bool) public swapTokenAllowed;

    /// @notice Ceiling on commission, in basis points. 50 = 0.5%.
    /// @dev A constant, not a setting. The owner can move `feeBps` within this
    ///      and nowhere near it matters anyway — what matters is that a sender
    ///      can verify the worst case from the source, once.
    uint16 public constant MAX_FEE_BPS = 50;

    /// @notice Shortest gap between two early sends on one schedule.
    /// @dev `runNow` skips the cadence by design; this stops it being looped
    ///      inside a block. `triggersLeft` is the real bound.
    uint64 public constant MIN_TRIGGER_GAP = 60;

    /// @notice Stored as `trigger` to mean "whoever is the executor now".
    /// @dev Resolved at call time, so `setExecutor` moves the grant with the
    ///      key and a rotated-out key keeps nothing. address(1) can never be a
    ///      caller: nobody holds its private key.
    address public constant CURRENT_EXECUTOR = address(1);

    uint256 public nextScheduleId = 1;
    mapping(uint256 => Schedule) private _schedules;
    mapping(address => uint256[]) private _schedulesBySender;

    // --- events -----------------------------------------------------------

    event ScheduleCreated(
        uint256 indexed id,
        address indexed sender,
        address indexed destination,
        uint128 amountIn,
        uint64 interval,
        uint96 minRateE6,
        uint32 maxRuns,
        uint64 expiresAt,
        PayoutType payoutType
    );
    event RunExecuted(
        uint256 indexed id,
        address indexed sender,
        address indexed destination,
        uint128 amountIn,
        uint256 amountOut,
        uint32 runsExecuted,
        uint64 nextRunAt
    );
    event ScheduleActiveSet(uint256 indexed id, bool active);
    event MinRateUpdated(uint256 indexed id, uint96 previous, uint96 current);
    event ScheduleCancelled(uint256 indexed id);
    event ExecutorUpdated(address indexed previous, address indexed current);
    event PoolFeeUpdated(uint24 previous, uint24 current);
    event DirectTokenSet(address indexed token, bool allowed);
    event SwapTokenSet(address indexed token, bool allowed);
    event FeeBpsUpdated(uint16 previous, uint16 current);
    event TreasuryUpdated(address indexed previous, address indexed current);
    event FeeCharged(uint256 indexed id, address indexed token, uint256 amount);
    event TriggerSet(uint256 indexed id, address indexed trigger, uint16 triggersLeft);
    /// @dev Emitted alongside RunExecuted so an indexer can tell an early send
    ///      from one the cadence produced.
    event RunTriggered(uint256 indexed id, address indexed by, uint16 triggersLeft);

    // --- errors -----------------------------------------------------------

    error NotExecutor();
    error NotScheduleOwner();
    error ZeroAddress();
    error InvalidAmount();
    error InvalidInterval();
    error InvalidRate();
    error ScheduleInactive();
    error ScheduleIsCancelled();
    error ScheduleExpired();
    error RunCapReached();
    error NotDue(uint64 nextRunAt);
    error SlippageBoundBelowFloor(uint256 provided, uint256 floor);
    error InsufficientOutput(uint256 received, uint256 floor);
    error InvalidDestination();
    error DegenerateFloor();
    error ScheduleLifetimeTooLong();
    error RenounceDisabled();
    error TokenNotAllowed();
    error WrongTokenForPayoutType();
    error FeeTooHigh(uint16 provided, uint16 max);
    error NotTrigger();
    error NoTriggersLeft();
    error TriggeredTooSoon(uint64 nextAllowed);
    error SameToken();
    error InvalidTrigger();
    error FirstRunAfterExpiry();
    error NoFloorOnDirect();

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    constructor(
        address _tokenIn,
        address _tokenOut,
        address _router,
        address _executor,
        uint24 _poolFee,
        address _treasury,
        uint16 _feeBps
    ) Ownable(msg.sender) {
        if (
            _tokenIn == address(0) || _tokenOut == address(0) || _router == address(0) || _executor == address(0)
                || _treasury == address(0)
        ) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh(_feeBps, MAX_FEE_BPS);

        tokenIn = IERC20(_tokenIn);
        tokenOut = IERC20(_tokenOut);
        router = ISwapRouter02(_router);
        executor = _executor;
        poolFee = _poolFee;
        treasury = _treasury;
        feeBps = _feeBps;

        // The default output asset is allowed from the start; anything else is
        // an owner decision made deliberately.
        swapTokenAllowed[_tokenOut] = true;

        emit ExecutorUpdated(address(0), _executor);
        emit TreasuryUpdated(address(0), _treasury);
        emit SwapTokenSet(_tokenOut, true);
    }

    // =====================================================================
    //                              SENDER
    // =====================================================================

    /**
     * @notice Authorise a recurring remittance. Called once, by the sender.
     * @param destination  Where cNGN is delivered. Immutable for the life of
     *                     the schedule.
     * @param amountIn     Funding-token units pulled per run (USDT, 6dp).
     * @param interval     Minimum seconds between runs.
     * @param minRateE6    Floor rate: minimum tokenOut per 1e6 tokenIn. With
     *                     both tokens at 6dp and a market near 1368 NGN/USD,
     *                     a 2% floor is about 1_340_000_000.
     * @param maxRuns      Hard cap on executions. 0 = unlimited.
     * @param expiresAt    Unix timestamp after which no run may fire. 0 = never.
     * @param firstRunAt   Earliest timestamp for run #1. 0 = immediately.
     */
    function createSchedule(
        address destination,
        uint128 amountIn,
        uint64 interval,
        uint96 minRateE6,
        uint32 maxRuns,
        uint64 expiresAt,
        uint64 firstRunAt,
        PayoutType payoutType,
        address token,
        address payoutToken,
        address trigger,
        uint16 triggersLeft
    ) external whenNotPaused returns (uint256 id) {
        // SwapRouter02 reserves address(1) as MSG_SENDER and address(2) as
        // ADDRESS_THIS and rewrites the recipient before paying out. V1 checked
        // only address(0) — the sentinel of the ORIGINAL SwapRouter — so a
        // schedule pointed at address(2) paid the router, where the
        // permissionless sweepToken let anyone take it, while RunExecuted
        // reported a clean delivery.
        if (
            uint160(destination) < 0x10000 || destination == address(this)
                || destination == address(router)
        ) revert InvalidDestination();
        if (amountIn == 0) revert InvalidAmount();
        if (interval == 0 || interval > MAX_INTERVAL) revert InvalidInterval();
        if (payoutType == PayoutType.Direct) {
            // No conversion happens, so there is no rate to floor. The sender
            // receives exactly what the sender sent.
            if (!directTokenAllowed[token]) revert TokenNotAllowed();
            minRateE6 = 0;
        } else {
            // The swap rails only ever move the configured funding asset.
            if (token != address(tokenIn)) revert WrongTokenForPayoutType();
            // V4: the payout asset is the sender's choice from an allowlist,
            // not a constant. Everything downstream reads the pinned value.
            //
            // Same-token first, so a schedule that would convert USDT to USDT
            // says so, rather than reporting whatever the allowlist happens to
            // hold for the funding asset.
            if (payoutToken == token) revert SameToken();
            if (!swapTokenAllowed[payoutToken]) revert TokenNotAllowed();
            if (minRateE6 == 0) revert InvalidRate();

            // Validate the number actually enforced, not just its input. Integer
            // division means amount * minRateE6 < 1e6 yields floor == 0, and
            // both guards then read `x < 0` and can never fire. V5: on the NET
            // amount, because that is what `_run` floors — V4 checked the gross
            // and so let through floors that were zero where they applied.
            _checkFloor(amountIn, feeBps, minRateE6);
        }
        // Something must reach the recipient once the commission is taken.
        if (amountIn - _feeOf(amountIn, feeBps) == 0) revert InvalidAmount();

        // Every schedule expires. See MAX_LIFETIME.
        if (expiresAt == 0) revert ScheduleExpired();
        if (expiresAt <= block.timestamp) revert ScheduleExpired();
        if (expiresAt > block.timestamp + MAX_LIFETIME) revert ScheduleLifetimeTooLong();
        // A first run after the expiry can never come round on the cadence.
        if (firstRunAt > expiresAt) revert FirstRunAfterExpiry();
        _checkTrigger(payoutType, trigger);

        uint24 pinnedFee = poolFee;
        if (payoutType == PayoutType.Direct) {
            pinnedFee = 0;
            payoutToken = address(0); // nothing is converted
        }

        // Pinned, like every other consent-time value: whatever the owner does
        // to `feeBps` afterwards applies to later schedules, never this one.
        uint16 pinnedFeeBps = feeBps;

        id = nextScheduleId++;

        // Written field by field rather than as a struct literal: V4's extra
        // consent values push a literal past the stack limit, and `via_ir`
        // would be a compiler change for the whole project to avoid one
        // assignment.
        Schedule storage sch = _schedules[id];
        sch.sender = msg.sender;
        sch.interval = interval;
        sch.maxRuns = maxRuns;
        sch.destination = destination;
        sch.nextRunAt = firstRunAt == 0 ? uint64(block.timestamp) : firstRunAt;
        sch.amountIn = amountIn;
        sch.minRateE6 = minRateE6;
        sch.poolFee = pinnedFee; //  pinned: setPoolFee must not re-route live schedules
        sch.token = token;
        sch.tokenOut = payoutToken; //  pinned: setSwapToken cannot redirect a live payout
        sch.feeBps = pinnedFeeBps; //  pinned: setFeeBps cannot raise an agreed rate
        sch.triggersLeft = triggersLeft;
        sch.trigger = trigger;
        sch.expiresAt = expiresAt;
        sch.payoutType = payoutType;
        sch.active = true;

        _schedulesBySender[msg.sender].push(id);

        // Read back from storage rather than from the arguments: V4 consents
        // to enough values that keeping them all live for the emit is what
        // finally exceeded the stack.
        emit ScheduleCreated(
            id,
            msg.sender,
            sch.destination,
            sch.amountIn,
            sch.interval,
            sch.minRateE6,
            sch.maxRuns,
            sch.expiresAt,
            sch.payoutType
        );
        if (sch.trigger != address(0) || sch.triggersLeft != 0) {
            emit TriggerSet(id, sch.trigger, sch.triggersLeft);
        }
    }

    /// @notice Change who may trigger an early send, and how many remain.
    /// @dev Sender only, and it can only ever affect early sends: the
    ///      destination, amount, floor, cadence, cap and expiry are untouched.
    ///      Setting `triggersLeft` to 0 withdraws the permission entirely.
    function setTrigger(uint256 id, address trigger, uint16 triggersLeft) external {
        Schedule storage s = _schedules[id];
        if (s.sender != msg.sender) revert NotScheduleOwner();
        if (s.cancelled) revert ScheduleIsCancelled();
        _checkTrigger(s.payoutType, trigger);
        s.trigger = trigger;
        s.triggersLeft = triggersLeft;
        emit TriggerSet(id, trigger, triggersLeft);
    }

    /// @notice Pause or resume a schedule. Sender only.
    /// @dev A cancelled schedule is terminal and cannot be resumed here.
    function setScheduleActive(uint256 id, bool active) external {
        Schedule storage s = _schedules[id];
        if (s.sender != msg.sender) revert NotScheduleOwner();
        if (s.cancelled) revert ScheduleIsCancelled();
        s.active = active;
        emit ScheduleActiveSet(id, active);
    }

    /// @notice Refresh the floor rate on a live schedule. Sender only.
    /// @dev V1 had no setter, so a floor set against one market protected a
    ///      remittance executed against another. Cancelling and recreating was
    ///      the only remedy, which requires the sender to be watching — the
    ///      opposite of an unattended standing order.
    function setMinRate(uint256 id, uint96 minRateE6) external {
        Schedule storage s = _schedules[id];
        if (s.sender != msg.sender) revert NotScheduleOwner();
        if (s.cancelled) revert ScheduleIsCancelled();
        // Direct converts nothing, so `_run` never reads a floor there. V4
        // stored one anyway, and `runnability` then reported it.
        if (s.payoutType == PayoutType.Direct) revert NoFloorOnDirect();
        if (minRateE6 == 0) revert InvalidRate();
        _checkFloor(s.amountIn, s.feeBps, minRateE6);
        emit MinRateUpdated(id, s.minRateE6, minRateE6);
        s.minRateE6 = minRateE6;
    }

    /// @notice Permanently retire a schedule. Sender only.
    /// @dev Revoking the ERC20 allowance is the belt-and-braces version and
    ///      needs nothing from this contract.
    function cancelSchedule(uint256 id) external {
        Schedule storage s = _schedules[id];
        if (s.sender != msg.sender) revert NotScheduleOwner();
        s.active = false;
        s.cancelled = true; // terminal — `setScheduleActive` will not undo this
        emit ScheduleCancelled(id);
    }

    // =====================================================================
    //                             EXECUTOR
    // =====================================================================

    /**
     * @notice Execute one run of a due schedule.
     * @param id                 Schedule to run.
     * @param amountOutMinimum   Backend's slippage bound, from a live quote.
     *                           Must be at least the sender's stored floor —
     *                           so a compromised executor cannot set it to 0
     *                           and hand the trade to a sandwich bot.
     */
    function executeRun(uint256 id, uint256 amountOutMinimum)
        external
        onlyExecutor
        whenNotPaused
        nonReentrant
        returns (uint256 amountOut)
    {
        Schedule storage s = _schedules[id];
        // The cadence the sender signed. `runNow` is the only path that may
        // skip it, and only with permission the sender granted.
        if (block.timestamp < s.nextRunAt) revert NotDue(s.nextRunAt);
        // Cadence is measured from now, not from the scheduled time. A schedule
        // that was down for a week resumes; it does not fire seven catch-up
        // runs.
        s.nextRunAt = uint64(block.timestamp) + s.interval;
        return _run(id, s, amountOutMinimum);
    }

    /**
     * @notice Send the next transfer now, ahead of its cadence.
     * @dev This is the whole of V4's "triggerable" claim, and it is
     *      deliberately narrow. It moves ONE run forward in time. It cannot
     *      change the destination, the amount, the floor, the expiry or the
     *      run cap, it consumes a run exactly as a scheduled one does, and it
     *      is bounded twice over: by `triggersLeft`, which the sender set, and
     *      by the ERC20 allowance they granted.
     *
     *      Callable by the sender, or by the address they nominated — an app,
     *      a bot, another agent. That nomination is revocable with
     *      `setTrigger` and worth nothing on its own: a hostile trigger can
     *      only pay the recipient early, at the sender's floor, until the
     *      early sends run out.
     */
    function runNow(uint256 id, uint256 amountOutMinimum)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 amountOut)
    {
        Schedule storage s = _schedules[id];
        if (msg.sender != s.sender && msg.sender != _triggerOf(s)) revert NotTrigger();
        if (s.triggersLeft == 0) revert NoTriggersLeft();

        // Not a rate limit so much as a loop guard: without it, a nominated
        // trigger could spend every remaining early send in one block.
        uint64 earliest = s.lastRunAt + MIN_TRIGGER_GAP;
        if (s.lastRunAt != 0 && block.timestamp < earliest) revert TriggeredTooSoon(earliest);

        if (block.timestamp < s.nextRunAt) {
            // Early: this run IS the next scheduled one, brought forward, so
            // the one after it keeps its own date. V4 restarted the cadence
            // from now instead, which made every early send an extra payment
            // — unbounded on a schedule with no run cap.
            s.nextRunAt += s.interval;
            unchecked {
                s.triggersLeft -= 1;
            }
        } else {
            // Already due: the cadence would have paid it anyway, so it costs
            // no early send.
            s.nextRunAt = uint64(block.timestamp) + s.interval;
        }
        emit RunTriggered(id, msg.sender, s.triggersLeft);
        return _run(id, s, amountOutMinimum);
    }

    /// @dev One body for both entry points, so a rule can never hold on the
    ///      scheduled path and be missing from the triggered one. The caller
    ///      has already moved `nextRunAt` — the one thing the two paths do
    ///      differently — and a revert in here undoes that with everything else.
    function _run(uint256 id, Schedule storage s, uint256 amountOutMinimum) private returns (uint256 amountOut) {
        if (s.cancelled) revert ScheduleIsCancelled();
        if (!s.active) revert ScheduleInactive();
        if (s.expiresAt != 0 && block.timestamp > s.expiresAt) revert ScheduleExpired();
        if (s.maxRuns != 0 && s.runsExecuted >= s.maxRuns) revert RunCapReached();

        uint128 amount = s.amountIn;
        address dest = s.destination;
        address from = s.sender;

        // Commission first, at the rate pinned when the sender consented, so
        // what reaches the rail is what the sender was shown.
        uint256 fee = _feeOf(amount, s.feeBps);
        uint256 net = amount - fee;

        // --- effects before interactions ---
        unchecked {
            s.runsExecuted += 1;
        }
        s.lastRunAt = uint64(block.timestamp);
        if (s.maxRuns != 0 && s.runsExecuted >= s.maxRuns) s.active = false;

        // --- Direct rail: no swap, no floor, no pool ------------------------
        // The asset the sender funded is the asset the recipient receives, so
        // there is no price, nothing to slip, and no liquidity to depend on.
        if (s.payoutType == PayoutType.Direct) {
            IERC20 t = IERC20(s.token);
            if (fee != 0) {
                t.safeTransferFrom(from, treasury, fee);
                emit FeeCharged(id, address(t), fee);
            }
            t.safeTransferFrom(from, dest, net);

            emit RunExecuted(id, from, dest, amount, net, s.runsExecuted, s.nextRunAt);
            return net;
        }

        // The floor is a RATE, so it is applied to what is actually converted.
        // Charging it against the gross amount would quietly tighten the
        // sender's floor by the fee and start failing runs that met their rate.
        uint256 floor = (net * uint256(s.minRateE6)) / 1e6;
        if (amountOutMinimum < floor) revert SlippageBoundBelowFloor(amountOutMinimum, floor);

        if (fee != 0) {
            tokenIn.safeTransferFrom(from, treasury, fee);
            emit FeeCharged(id, address(tokenIn), fee);
        }

        amountOut = _swapAndForward(s, net, amountOutMinimum, floor);

        emit RunExecuted(id, from, dest, amount, amountOut, s.runsExecuted, s.nextRunAt);
    }

    /// @dev The swap half of a run, split out only because keeping it inline
    ///      with V4's fee arithmetic exceeded the stack. Reads what it needs
    ///      from the schedule, which is pinned and therefore safe to trust.
    function _swapAndForward(Schedule storage s, uint256 net, uint256 amountOutMinimum, uint256 floor)
        private
        returns (uint256 received)
    {
        tokenIn.safeTransferFrom(s.sender, address(this), net);
        tokenIn.forceApprove(address(router), net);

        // The swap lands HERE, not at the destination. Two reasons, both from
        // the security review:
        //
        //   1. cNGN only burns — its signal to pay naira — when the transferor
        //      is on its external-sender whitelist. Paying straight from the
        //      pool made the POOL the transferor, and a public pool is not
        //      whitelisted, so bank payouts would have silently never paid.
        //      Forwarding from here makes this contract the sender-of-record:
        //      one stable address that can be whitelisted.
        //   2. It lets delivery be asserted on a measured balance delta rather
        //      than on the router's self-reported return value.
        IERC20 out = IERC20(s.tokenOut);
        uint256 balanceBefore = out.balanceOf(address(this));

        router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(tokenIn),
                tokenOut: address(out),
                fee: s.poolFee, // pinned at consent, not read from mutable config
                recipient: address(this),
                amountIn: net,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );

        received = out.balanceOf(address(this)) - balanceBefore;
        if (received < floor) revert InsufficientOutput(received, floor);

        tokenIn.forceApprove(address(router), 0);

        // Nothing rests here: what arrived is forwarded in the same call.
        out.safeTransfer(s.destination, received);
    }

    // =====================================================================
    //                              VIEWS
    // =====================================================================

    function getSchedule(uint256 id) external view returns (Schedule memory) {
        return _schedules[id];
    }

    function schedulesOf(address sender) external view returns (uint256[] memory) {
        return _schedulesBySender[sender];
    }

    /// @notice Everything the backend needs to decide whether to attempt a run.
    /// @dev Checked off-chain first so a doomed run never costs gas.
    function runnability(uint256 id)
        external
        view
        returns (bool due, bool funded, bool approved, uint256 floor, uint64 nextRunAt)
    {
        Schedule memory s = _schedules[id];
        // Against the net amount, because that is what the rail converts —
        // the same arithmetic `_run` uses, or the backend would quote a floor
        // the contract does not enforce.
        uint256 net = uint256(s.amountIn) - _feeOf(s.amountIn, s.feeBps);
        floor = (net * uint256(s.minRateE6)) / 1e6;
        nextRunAt = s.nextRunAt;
        // !paused() included deliberately. V1 omitted it, so while the
        // contract was paused this reported due == true and the backend — which
        // opens a cNGN redemption BEFORE calling executeRun — committed an
        // irreversible off-chain payout instruction for a run that then
        // reverted, every cycle, for the duration of the incident.
        due = !paused() && s.active && !s.cancelled && block.timestamp >= s.nextRunAt
            && (s.expiresAt == 0 || block.timestamp <= s.expiresAt) && (s.maxRuns == 0 || s.runsExecuted < s.maxRuns);
        // Against the schedule's own asset: a Direct schedule may be funded in
        // USDC or cUSD, not the swap rails' tokenIn.
        IERC20 t = s.token == address(0) ? tokenIn : IERC20(s.token);
        funded = t.balanceOf(s.sender) >= s.amountIn;
        approved = t.allowance(s.sender, address(this)) >= s.amountIn;
    }

    /// @notice Whether `caller` could trigger an early send right now, and why
    ///         not if they could not.
    /// @dev Mirrors `runNow`'s own checks. Read this before spending gas on a
    ///      trigger that would revert — an agent paying for its own calls
    ///      cares about that more than the backend does.
    function triggerability(uint256 id, address caller)
        external
        view
        returns (bool canTrigger, uint16 triggersLeft, uint64 earliestTrigger)
    {
        Schedule memory s = _schedules[id];
        triggersLeft = s.triggersLeft;
        earliestTrigger = s.lastRunAt == 0 ? uint64(block.timestamp) : s.lastRunAt + MIN_TRIGGER_GAP;
        canTrigger = !paused() && s.active && !s.cancelled && triggersLeft != 0
            && (caller == s.sender || (s.trigger != address(0) && caller == _triggerOfMem(s)))
            && block.timestamp >= earliestTrigger && (s.expiresAt == 0 || block.timestamp <= s.expiresAt)
            && (s.maxRuns == 0 || s.runsExecuted < s.maxRuns);
    }

    // =====================================================================
    //                             INTERNAL
    // =====================================================================

    /// @dev Commission, rounded UP. V4 rounded down, so any amount under
    ///      10_000 / feeBps base units (400 at 25bps) paid no commission at
    ///      all while the executor still paid the gas.
    function _feeOf(uint256 amount, uint16 bps) private pure returns (uint256) {
        return Math.mulDiv(amount, bps, 10_000, Math.Rounding.Ceil);
    }

    /// @dev The floor `_run` will enforce must be non-zero.
    function _checkFloor(uint256 amount, uint16 bps, uint96 minRateE6) private pure {
        uint256 net = amount - _feeOf(amount, bps);
        if ((net * uint256(minRateE6)) / 1e6 == 0) revert DegenerateFloor();
    }

    /// @dev Who a schedule's grant names, with the sentinel resolved now.
    function _triggerOf(Schedule storage s) private view returns (address) {
        return s.trigger == CURRENT_EXECUTOR ? executor : s.trigger;
    }

    function _triggerOfMem(Schedule memory s) private view returns (address) {
        return s.trigger == CURRENT_EXECUTOR ? executor : s.trigger;
    }

    /// @dev Two rules for a grant.
    ///
    ///      1. The executor is named by the sentinel, never by its literal
    ///         address, or `setExecutor` cannot take the grant back from a
    ///         rotated-out key.
    ///      2. On a swap rail, a trigger picks the moment of the swap and its
    ///         slippage bound, so an arbitrary one can trade around its own
    ///         early send down to the floor. There only the executor — whose
    ///         bound comes from a live quote — may hold the grant. Direct
    ///         converts nothing and keeps any trigger.
    function _checkTrigger(PayoutType payoutType, address trigger) private view {
        if (trigger == address(0) || trigger == CURRENT_EXECUTOR) return;
        if (trigger == executor) revert InvalidTrigger();
        if (payoutType != PayoutType.Direct) revert InvalidTrigger();
    }

    // =====================================================================
    //                              ADMIN
    // =====================================================================

    function setExecutor(address _executor) external onlyOwner {
        if (_executor == address(0)) revert ZeroAddress();
        emit ExecutorUpdated(executor, _executor);
        executor = _executor;
    }

    /// @notice Default fee tier for NEW schedules only.
    /// @dev Live schedules keep the tier pinned at their creation. In V1 this
    ///      was read at swap time, so one owner write re-routed every existing
    ///      schedule — and since only the 0.01% pool exists, any other value
    ///      silently bricked them all while emitting no Paused event.
    /// @notice Permit or forbid an asset on the Direct rail.
    /// @dev Affects new schedules only — live ones carry the token they were
    ///      created with.
    function setDirectToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        directTokenAllowed[token] = allowed;
        emit DirectTokenSet(token, allowed);
    }

    /// @notice Permit or forbid an asset as a swap-rail payout.
    /// @dev New schedules only; a live one carries the `tokenOut` it was
    ///      authorised with. This is how a corridor is added — an allowed
    ///      local stablecoin — without redeploying.
    function setSwapToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        swapTokenAllowed[token] = allowed;
        emit SwapTokenSet(token, allowed);
    }

    /// @notice Commission for NEW schedules, in basis points.
    /// @dev Capped by MAX_FEE_BPS in code, and pinned into every schedule at
    ///      consent. Raising it cannot touch a remittance already authorised,
    ///      which is the whole reason the rate lives in the struct.
    function setFeeBps(uint16 _feeBps) external onlyOwner {
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh(_feeBps, MAX_FEE_BPS);
        emit FeeBpsUpdated(feeBps, _feeBps);
        feeBps = _feeBps;
    }

    /// @notice Where commission is paid.
    /// @dev Read at execution rather than pinned: it moves Remesso's own
    ///      revenue, never a sender's funds, and a rotated key should not
    ///      strand it.
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    function setPoolFee(uint24 _poolFee) external onlyOwner {
        emit PoolFeeUpdated(poolFee, _poolFee);
        poolFee = _poolFee;
    }

    /// @notice Global stop. Blocks new schedules and all runs; senders can
    /// still pause and cancel their own.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Disabled. Ownable2Step guards transferOwnership but leaves the
    ///         strictly more destructive renounceOwnership as a single
    ///         unconfirmed call; pause() followed by renounce would strand
    ///         every schedule with unpause() permanently unreachable.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice Sweep tokens stranded by a failed interaction.
    /// @dev The contract holds no user funds between transactions, so this can
    ///      only ever recover dust or a mistaken direct transfer.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }
}
