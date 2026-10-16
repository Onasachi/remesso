// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RemessoExecutorV5} from "../src/RemessoExecutorV5.sol";
import {MockERC20, MockRouter} from "./mocks/Mocks.sol";

/// V4's suite carried over to V5, plus a regression test per fix from the
/// 2026-10-16 audit (bottom of the file). Three V4 tests changed, each because
/// V4's behaviour there was the bug: they are marked "V5:".
///
/// What V4 adds, and — more importantly — what it must not have changed.
///
/// The three new powers (a payout asset per schedule, an early send, a
/// commission) are all owner-configurable, and every one of them is pinned at
/// consent. So most of this file is the same shape of test twice: the owner
/// changes a setting, and the schedule somebody already authorised does not
/// move.
contract RemessoExecutorV5Test is Test {
    RemessoExecutorV5 exec;
    MockERC20 usdt;
    MockERC20 usdc;
    MockERC20 cngn;
    MockERC20 ckes;
    MockRouter router;

    address sender = makeAddr("sender");
    address recipient = makeAddr("recipient");
    address executor = makeAddr("executor");
    address treasury = makeAddr("treasury");
    address agent = makeAddr("agent");
    address stranger = makeAddr("stranger");

    uint96 constant FLOOR = 1_340_000_000;
    uint16 constant FEE_BPS = 25; // 0.25%
    uint64 EXP;

    function setUp() public {
        usdt = new MockERC20("Tether USD", "USDT", 6);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        cngn = new MockERC20("cNGN", "cNGN", 6);
        ckes = new MockERC20("Celo Kenyan Shilling", "cKES", 18);
        router = new MockRouter(1_368_000_000);
        exec = new RemessoExecutorV5(
            address(usdt), address(cngn), address(router), executor, 100, treasury, FEE_BPS
        );
        EXP = uint64(block.timestamp) + 30 days;

        exec.setDirectToken(address(usdt), true);
        exec.setDirectToken(address(usdc), true);

        usdt.mint(sender, 10_000e6);
        usdc.mint(sender, 10_000e6);
        vm.startPrank(sender);
        usdt.approve(address(exec), type(uint256).max);
        usdc.approve(address(exec), type(uint256).max);
        vm.stopPrank();
    }

    function _direct(uint128 amount, uint16 triggers, address trigger) internal returns (uint256 id) {
        vm.prank(sender);
        id = exec.createSchedule(
            recipient,
            amount,
            7 days,
            0,
            0,
            EXP,
            0,
            RemessoExecutorV5.PayoutType.Direct,
            address(usdt),
            address(0),
            trigger,
            triggers
        );
    }

    function _swap(address payoutToken, uint128 amount) internal returns (uint256 id) {
        vm.prank(sender);
        id = exec.createSchedule(
            recipient,
            amount,
            7 days,
            FLOOR,
            0,
            EXP,
            0,
            RemessoExecutorV5.PayoutType.Wallet,
            address(usdt),
            payoutToken,
            address(0),
            0
        );
    }

    // ---------------------------------------------------------------- fee

    function test_CommissionGoesToTreasuryAndTheRestToTheRecipient() public {
        uint256 id = _direct(200e6, 0, address(0));
        vm.prank(executor);
        exec.executeRun(id, 0);

        // 0.25% of 200 USDT.
        assertEq(usdt.balanceOf(treasury), 0.5e6, "treasury takes the commission");
        assertEq(usdt.balanceOf(recipient), 199.5e6, "recipient receives the rest");
        assertEq(usdt.balanceOf(sender), 10_000e6 - 200e6, "sender pays exactly what they signed");
    }

    /// The reason the rate lives in the struct.
    function test_RaisingTheFeeCannotTouchALiveSchedule() public {
        uint256 id = _direct(200e6, 0, address(0));
        exec.setFeeBps(exec.MAX_FEE_BPS());

        vm.prank(executor);
        exec.executeRun(id, 0);
        assertEq(usdt.balanceOf(treasury), 0.5e6, "still the rate consented to");
        assertEq(exec.getSchedule(id).feeBps, FEE_BPS);
    }

    function test_FeeCannotExceedTheCapAnywhere() public {
        uint16 max = exec.MAX_FEE_BPS();
        vm.expectRevert(abi.encodeWithSelector(RemessoExecutorV5.FeeTooHigh.selector, max + 1, max));
        exec.setFeeBps(max + 1);

        vm.expectRevert(abi.encodeWithSelector(RemessoExecutorV5.FeeTooHigh.selector, 10_000, max));
        new RemessoExecutorV5(address(usdt), address(cngn), address(router), executor, 100, treasury, 10_000);
    }

    function test_ZeroFeeMovesTheWholeAmount() public {
        exec.setFeeBps(0);
        uint256 id = _direct(200e6, 0, address(0));
        vm.prank(executor);
        exec.executeRun(id, 0);
        assertEq(usdt.balanceOf(treasury), 0);
        assertEq(usdt.balanceOf(recipient), 200e6);
    }

    /// The floor is a rate on what is actually converted. Applied to the gross
    /// amount it would silently demand more output than the trade can produce
    /// and fail runs that met the sender's rate exactly.
    function test_FloorIsMeasuredAgainstTheConvertedAmount() public {
        uint256 id = _swap(address(cngn), 100e6);
        (,,, uint256 floor,) = exec.runnability(id);

        uint256 net = 100e6 - (100e6 * FEE_BPS) / 10_000;
        assertEq(floor, (net * FLOOR) / 1e6, "floor follows the net amount");

        // A quote at exactly the floor must go through.
        vm.prank(executor);
        exec.executeRun(id, floor);
        assertGe(cngn.balanceOf(recipient), floor);
        assertEq(usdt.balanceOf(treasury), 0.25e6);
    }

    // ------------------------------------------------------- payout token

    function test_ASchedulePaysOutInTheAssetItNamed() public {
        exec.setSwapToken(address(ckes), true);
        uint256 id = _swap(address(ckes), 100e6);
        (,,, uint256 floor,) = exec.runnability(id);

        vm.prank(executor);
        exec.executeRun(id, floor);

        assertGt(ckes.balanceOf(recipient), 0, "paid in the corridor's asset");
        assertEq(cngn.balanceOf(recipient), 0, "not in the default one");
    }

    function test_PayoutAssetMustBeAllowedAndDifferent() public {
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV5.TokenNotAllowed.selector);
        exec.createSchedule(
            recipient, 100e6, 7 days, FLOOR, 0, EXP, 0,
            RemessoExecutorV5.PayoutType.Wallet, address(usdt), address(ckes), address(0), 0
        );

        // Allowed or not, converting an asset into itself is not a payout.
        exec.setSwapToken(address(usdt), true);
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV5.SameToken.selector);
        exec.createSchedule(
            recipient, 100e6, 7 days, FLOOR, 0, EXP, 0,
            RemessoExecutorV5.PayoutType.Wallet, address(usdt), address(usdt), address(0), 0
        );
    }

    function test_RemovingAPayoutAssetLeavesLiveSchedulesAlone() public {
        exec.setSwapToken(address(ckes), true);
        uint256 id = _swap(address(ckes), 100e6);
        (,,, uint256 floor,) = exec.runnability(id);
        exec.setSwapToken(address(ckes), false);

        vm.prank(executor);
        exec.executeRun(id, floor);
        assertGt(ckes.balanceOf(recipient), 0, "authorised before the change, honoured after it");
    }

    // ------------------------------------------------------------ runNow

    /// V5: the early send takes the next slot; the cadence does not restart.
    function test_SenderCanSendEarlyAndTheNextSlotIsUsedUp() public {
        uint256 id = _direct(50e6, 3, address(0));
        uint64 t0 = uint64(block.timestamp);

        vm.prank(executor);
        exec.executeRun(id, 0); // run 1, on cadence
        vm.warp(block.timestamp + MIN_GAP());

        vm.prank(sender);
        exec.runNow(id, 0); // run 2, days early

        RemessoExecutorV5.Schedule memory s = exec.getSchedule(id);
        assertEq(s.runsExecuted, 2, "an early send is a run, not an extra");
        assertEq(s.triggersLeft, 2, "one early send spent");
        assertEq(s.nextRunAt, t0 + 14 days, "the run after keeps its own date");
        assertEq(usdt.balanceOf(recipient), 2 * 49.875e6, "same amount, same destination");
    }

    function test_ANominatedAgentCanTriggerAndAStrangerCannot() public {
        uint256 id = _direct(50e6, 2, agent);

        vm.prank(stranger);
        vm.expectRevert(RemessoExecutorV5.NotTrigger.selector);
        exec.runNow(id, 0);

        vm.prank(agent);
        exec.runNow(id, 0);
        assertEq(usdt.balanceOf(recipient), 49.875e6, "the agent can only pay the recipient");
    }

    /// V5: run 1 on cadence first, so the trigger is genuinely early — a run
    /// that is already due costs no early send.
    function test_TriggeringIsBoundedByWhatTheSenderAuthorised() public {
        uint256 id = _direct(10e6, 1, agent);
        vm.prank(executor);
        exec.executeRun(id, 0);
        vm.warp(block.timestamp + MIN_GAP());

        vm.prank(agent);
        exec.runNow(id, 0);

        vm.warp(block.timestamp + MIN_GAP());
        vm.prank(agent);
        vm.expectRevert(RemessoExecutorV5.NoTriggersLeft.selector);
        exec.runNow(id, 0);
    }

    function test_TriggersCannotBeLoopedInsideAMinute() public {
        uint256 id = _direct(10e6, 5, agent);

        vm.prank(agent);
        exec.runNow(id, 0);

        // Computed before the prank: a call to read MIN_TRIGGER_GAP would
        // itself consume it, and the second runNow would arrive from the test
        // contract rather than the agent.
        uint64 earliest = uint64(block.timestamp) + MIN_GAP();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(RemessoExecutorV5.TriggeredTooSoon.selector, earliest));
        exec.runNow(id, 0);
    }

    function test_SenderCanWithdrawAnAgentsPermission() public {
        uint256 id = _direct(10e6, 5, agent);

        vm.prank(sender);
        exec.setTrigger(id, address(0), 0);

        vm.prank(agent);
        vm.expectRevert(RemessoExecutorV5.NotTrigger.selector);
        exec.runNow(id, 0);
    }

    /// An early send is still bound by every limit the sender signed.
    function test_TriggerObeysTheEnvelope() public {
        // Run cap
        vm.prank(sender);
        uint256 capped = exec.createSchedule(
            recipient, 10e6, 7 days, 0, 1, EXP, 0,
            RemessoExecutorV5.PayoutType.Direct, address(usdt), address(0), agent, 5
        );
        vm.prank(agent);
        exec.runNow(capped, 0);
        vm.warp(block.timestamp + MIN_GAP());
        vm.prank(agent);
        vm.expectRevert(RemessoExecutorV5.ScheduleInactive.selector);
        exec.runNow(capped, 0);

        // Expiry
        uint256 id = _direct(10e6, 5, agent);
        vm.warp(EXP + 1);
        vm.prank(agent);
        vm.expectRevert(RemessoExecutorV5.ScheduleExpired.selector);
        exec.runNow(id, 0);

        // The sender's own pause
        vm.warp(EXP - 1 days);
        uint256 paused = _direct(10e6, 5, agent);
        vm.prank(sender);
        exec.setScheduleActive(paused, false);
        vm.prank(agent);
        vm.expectRevert(RemessoExecutorV5.ScheduleInactive.selector);
        exec.runNow(paused, 0);
    }

    function test_GlobalPauseStopsTriggersToo() public {
        uint256 id = _direct(10e6, 5, agent);
        exec.pause();
        vm.prank(agent);
        vm.expectRevert();
        exec.runNow(id, 0);
    }

    /// V5: as above, made early so the send is spent.
    function test_TriggerabilityMatchesWhatRunNowDoes() public {
        uint256 id = _direct(10e6, 1, agent);
        vm.prank(executor);
        exec.executeRun(id, 0);
        vm.warp(block.timestamp + MIN_GAP());

        (bool can, uint16 left,) = exec.triggerability(id, agent);
        assertTrue(can, "agent may trigger");
        assertEq(left, 1);

        (can,,) = exec.triggerability(id, stranger);
        assertFalse(can, "a stranger may not");

        vm.prank(agent);
        exec.runNow(id, 0);

        (can, left,) = exec.triggerability(id, agent);
        assertFalse(can, "nothing left to spend");
        assertEq(left, 0);
    }

    function test_WithoutTriggersASchedulesBehavesExactlyAsV3() public {
        uint256 id = _direct(10e6, 0, address(0));

        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV5.NoTriggersLeft.selector);
        exec.runNow(id, 0);

        // And the executor still cannot run it before it is due.
        vm.prank(executor);
        exec.executeRun(id, 0);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                RemessoExecutorV5.NotDue.selector, uint64(block.timestamp) + 7 days
            )
        );
        exec.executeRun(id, 0);
    }

    // ================================================= V5 audit regressions

    function _triggered(uint128 amount, uint32 maxRuns, uint16 triggers, address trigger)
        internal
        returns (uint256 id)
    {
        vm.prank(sender);
        id = exec.createSchedule(
            recipient, amount, 7 days, 0, maxRuns, EXP, 0,
            RemessoExecutorV5.PayoutType.Direct, address(usdt), address(0), trigger, triggers
        );
    }

    /// [85] early-send adds a payment. On an uncapped schedule, V4 let every
    /// trigger add one `amountIn` on top of the cadence. Over any window, V5
    /// pays no more than the cadence would, plus the early sends granted.
    function test_EarlySendsCannotPayMoreThanTheCadenceAllows() public {
        uint256 id = _triggered(10e6, 0, 10, agent);
        vm.prank(executor);
        exec.executeRun(id, 0); // run 1 at t0, next due t0 + 7d
        uint64 t0 = uint64(block.timestamp);

        // Ten early sends in ten minutes.
        for (uint256 i; i < 10; i++) {
            vm.warp(block.timestamp + MIN_GAP());
            vm.prank(agent);
            exec.runNow(id, 0);
        }
        // Each one used up a future slot instead of restarting the clock.
        assertEq(exec.getSchedule(id).nextRunAt, t0 + 11 * 7 days, "eleven slots are spent");

        // So the cadence pays nothing until the eleventh slot comes round.
        vm.warp(t0 + 10 * 7 days);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(RemessoExecutorV5.NotDue.selector, t0 + 11 * 7 days));
        exec.executeRun(id, 0);
    }

    /// A trigger on a run that is due anyway costs no early send.
    function test_TriggeringADueRunSpendsNothing() public {
        uint256 id = _triggered(10e6, 0, 1, agent);
        vm.prank(agent);
        exec.runNow(id, 0); // due from creation
        assertEq(exec.getSchedule(id).triggersLeft, 1, "still one early send");
        assertEq(exec.getSchedule(id).nextRunAt, uint64(block.timestamp) + 7 days);
    }

    /// [75] stale-privileged-trigger. The sentinel follows setExecutor, so a
    /// rotated-out key loses runNow with the rotation.
    function test_ExecutorGrantFollowsTheKey() public {
        uint256 id = _triggered(10e6, 0, 5, exec.CURRENT_EXECUTOR());

        vm.prank(executor);
        exec.runNow(id, 0);

        address fresh = makeAddr("freshExecutor");
        exec.setExecutor(fresh);
        vm.warp(block.timestamp + MIN_GAP());

        vm.prank(executor);
        vm.expectRevert(RemessoExecutorV5.NotTrigger.selector);
        exec.runNow(id, 0);

        vm.prank(fresh);
        exec.runNow(id, 0);

        (bool can,,) = exec.triggerability(id, fresh);
        assertFalse(can, "too soon, but recognised");
        vm.warp(block.timestamp + MIN_GAP());
        (can,,) = exec.triggerability(id, fresh);
        assertTrue(can, "the new key holds the grant");
        (can,,) = exec.triggerability(id, executor);
        assertFalse(can, "the old one does not");
    }

    /// The executor's literal address is refused: that is the V4 shape.
    function test_NamingTheExecutorLiterallyIsRefused() public {
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV5.InvalidTrigger.selector);
        exec.createSchedule(
            recipient, 10e6, 7 days, 0, 0, EXP, 0,
            RemessoExecutorV5.PayoutType.Direct, address(usdt), address(0), executor, 1
        );

        uint256 id = _direct(10e6, 0, address(0));
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV5.InvalidTrigger.selector);
        exec.setTrigger(id, executor, 1);
    }

    /// [75] trigger-sandwich-to-floor. On the swap rails only the executor may
    /// hold a grant; the sender can still send early themselves.
    function test_SwapRailsTakeNoThirdPartyTrigger() public {
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV5.InvalidTrigger.selector);
        exec.createSchedule(
            recipient, 100e6, 7 days, FLOOR, 0, EXP, 0,
            RemessoExecutorV5.PayoutType.Wallet, address(usdt), address(cngn), agent, 1
        );

        uint256 id = _swap(address(cngn), 100e6);
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV5.InvalidTrigger.selector);
        exec.setTrigger(id, agent, 1);

        address current = exec.CURRENT_EXECUTOR(); // read before the prank
        vm.prank(sender);
        exec.setTrigger(id, current, 1);
        (,,, uint256 floor,) = exec.runnability(id);
        vm.prank(executor);
        exec.runNow(id, floor);
        assertGt(cngn.balanceOf(recipient), 0);
    }

    /// [75] fee-rounds-to-zero. 399 base units at 25bps paid nothing in V4.
    function test_CommissionRoundsUp() public {
        uint256 id = _direct(399, 0, address(0));
        vm.prank(executor);
        exec.executeRun(id, 0);
        assertEq(usdt.balanceOf(treasury), 1, "the smallest amount still pays");
        assertEq(usdt.balanceOf(recipient), 398);

        // Exact multiples are unchanged: 0.25% of 200 USDT is still 0.5.
        uint256 big = _direct(200e6, 0, address(0));
        vm.warp(block.timestamp + 1);
        vm.prank(executor);
        exec.executeRun(big, 0);
        assertEq(usdt.balanceOf(treasury), 1 + 0.5e6);
    }

    /// Nothing at all reaching the recipient is not a payment.
    function test_AmountThatIsAllCommissionIsRefused() public {
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV5.InvalidAmount.selector);
        exec.createSchedule(
            recipient, 1, 7 days, 0, 0, EXP, 0,
            RemessoExecutorV5.PayoutType.Direct, address(usdt), address(0), address(0), 0
        );
    }

    /// [75] floor-check-gross-vs-net, createSchedule and setMinRate. Pick an
    /// amount and rate whose floor is 1 on the gross and 0 on the net.
    function test_DegenerateFloorIsCheckedOnTheNetAmount() public {
        // Gross 1000 at rate 1000 floors at 1; net 997 floors at 0.
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV5.DegenerateFloor.selector);
        exec.createSchedule(
            recipient, 1000, 7 days, 1000, 0, EXP, 0,
            RemessoExecutorV5.PayoutType.Wallet, address(usdt), address(cngn), address(0), 0
        );

        // fee = ceil(1003 * 25 / 10_000) = 3, so net = 1000.
        vm.prank(sender);
        uint256 small = exec.createSchedule(
            recipient, 1003, 7 days, 1_000_000, 0, EXP, 0,
            RemessoExecutorV5.PayoutType.Wallet, address(usdt), address(cngn), address(0), 0
        );
        // Rate 998: gross 1003 * 998 / 1e6 = 1, which V4 accepted; net
        // 1000 * 998 / 1e6 = 0, which is what a run would enforce.
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV5.DegenerateFloor.selector);
        exec.setMinRate(small, 998);
    }

    /// setMinRate on Direct stored a floor nothing reads.
    function test_DirectSchedulesTakeNoFloor() public {
        uint256 id = _direct(10e6, 0, address(0));
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV5.NoFloorOnDirect.selector);
        exec.setMinRate(id, FLOOR);
    }

    /// A first run after the expiry could never come round.
    function test_FirstRunMustComeBeforeTheExpiry() public {
        vm.prank(sender);
        vm.expectRevert(RemessoExecutorV5.FirstRunAfterExpiry.selector);
        exec.createSchedule(
            recipient, 10e6, 7 days, 0, 0, EXP, EXP + 1,
            RemessoExecutorV5.PayoutType.Direct, address(usdt), address(0), address(0), 0
        );
    }

    function MIN_GAP() internal view returns (uint64) {
        return exec.MIN_TRIGGER_GAP();
    }
}
