// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RemessoAgentAllowance} from "../src/RemessoAgentAllowance.sol";
import {MockERC20} from "./mocks/Mocks.sol";

/// An agent key that can spend only inside what its owner signed — and what a
/// prompt-injected agent still cannot do.
contract RemessoAgentAllowanceTest is Test {
    RemessoAgentAllowance aa;
    MockERC20 usdt;

    address owner = address(0xA11CE);
    address agent = address(0xA6E);
    address bob = address(0xB0B);
    address eve = address(0xE7E);

    uint128 constant PER_PAYMENT = 1e6; // 1 USDT
    uint128 constant PER_DAY = 5e6; //     5 USDT

    function setUp() public {
        vm.warp(1_800_000_000);
        aa = new RemessoAgentAllowance();
        usdt = new MockERC20("Tether USD", "USDT", 6);
        usdt.mint(owner, 100e6);
        vm.prank(owner);
        usdt.approve(address(aa), type(uint256).max);
    }

    function _policy(bool allowlistOnly, address[] memory recipients) internal returns (uint256 id) {
        vm.prank(owner);
        id = aa.createPolicy(
            agent, address(usdt), PER_PAYMENT, PER_DAY, uint64(block.timestamp + 30 days), allowlistOnly, recipients
        );
    }

    function _open() internal returns (uint256) {
        return _policy(false, new address[](0));
    }

    // ---- the happy path ----

    function test_agentPaysFromOwnersWallet() public {
        uint256 id = _open();
        vm.prank(agent);
        aa.pay(id, bob, 1e6, bytes32("inv-1"));
        assertEq(usdt.balanceOf(bob), 1e6);
        assertEq(usdt.balanceOf(owner), 99e6);
        assertEq(usdt.balanceOf(address(aa)), 0, "contract never holds funds");
        assertEq(aa.remainingToday(id), 4e6);
    }

    // ---- what an injected agent still cannot do ----

    function test_onlyTheAgentCanPay() public {
        uint256 id = _open();
        vm.prank(eve);
        vm.expectRevert(RemessoAgentAllowance.NotAgent.selector);
        aa.pay(id, eve, 1e6, 0);
        // not even the owner: the owner pays from their own wallet directly
        vm.prank(owner);
        vm.expectRevert(RemessoAgentAllowance.NotAgent.selector);
        aa.pay(id, bob, 1e6, 0);
    }

    function test_perPaymentCap() public {
        uint256 id = _open();
        vm.prank(agent);
        vm.expectRevert(RemessoAgentAllowance.OverPerPayment.selector);
        aa.pay(id, bob, 1e6 + 1, 0);
    }

    function test_perDayCap() public {
        uint256 id = _open();
        vm.startPrank(agent);
        for (uint256 i; i < 5; ++i) aa.pay(id, bob, 1e6, 0);
        vm.expectRevert(RemessoAgentAllowance.OverPerDay.selector);
        aa.pay(id, bob, 1, 0);
        vm.stopPrank();
        assertEq(aa.remainingToday(id), 0);
    }

    function test_windowReopensAfterADay() public {
        uint256 id = _open();
        vm.startPrank(agent);
        for (uint256 i; i < 5; ++i) aa.pay(id, bob, 1e6, 0);
        vm.warp(block.timestamp + 1 days - 1);
        vm.expectRevert(RemessoAgentAllowance.OverPerDay.selector);
        aa.pay(id, bob, 1e6, 0);
        vm.warp(block.timestamp + 1);
        aa.pay(id, bob, 1e6, 0);
        vm.stopPrank();
        assertEq(aa.remainingToday(id), 4e6);
    }

    function test_expiry() public {
        uint256 id = _open();
        vm.warp(block.timestamp + 30 days);
        vm.prank(agent);
        vm.expectRevert(RemessoAgentAllowance.Expired.selector);
        aa.pay(id, bob, 1e6, 0);
        assertEq(aa.remainingToday(id), 0);
    }

    function test_revokeIsImmediateAndFinal() public {
        uint256 id = _open();
        vm.prank(owner);
        aa.revoke(id);
        vm.prank(agent);
        vm.expectRevert(RemessoAgentAllowance.Revoked.selector);
        aa.pay(id, bob, 1e6, 0);
        assertEq(aa.remainingToday(id), 0);
    }

    function test_onlyOwnerRevokesOrEditsRecipients() public {
        uint256 id = _open();
        vm.startPrank(agent);
        vm.expectRevert(RemessoAgentAllowance.NotOwner.selector);
        aa.revoke(id);
        vm.expectRevert(RemessoAgentAllowance.NotOwner.selector);
        aa.setRecipient(id, eve, true);
        vm.stopPrank();
    }

    function test_allowlist() public {
        address[] memory r = new address[](1);
        r[0] = bob;
        uint256 id = _policy(true, r);
        vm.startPrank(agent);
        aa.pay(id, bob, 1e6, 0);
        vm.expectRevert(RemessoAgentAllowance.RecipientNotAllowed.selector);
        aa.pay(id, eve, 1e6, 0);
        vm.stopPrank();

        vm.prank(owner);
        aa.setRecipient(id, bob, false);
        vm.prank(agent);
        vm.expectRevert(RemessoAgentAllowance.RecipientNotAllowed.selector);
        aa.pay(id, bob, 1e6, 0);
    }

    function test_cannotPayTheOwnerOrZero() public {
        uint256 id = _open();
        vm.startPrank(agent);
        vm.expectRevert(RemessoAgentAllowance.SelfPayment.selector);
        aa.pay(id, owner, 1e6, 0);
        vm.expectRevert(RemessoAgentAllowance.ZeroAddress.selector);
        aa.pay(id, address(0), 1e6, 0);
        vm.expectRevert(RemessoAgentAllowance.ZeroAmount.selector);
        aa.pay(id, bob, 0, 0);
        vm.stopPrank();
    }

    function test_policiesAreIsolated() public {
        uint256 a = _open();
        uint256 b = _open();
        vm.startPrank(agent);
        for (uint256 i; i < 5; ++i) aa.pay(a, bob, 1e6, 0);
        aa.pay(b, bob, 1e6, 0); // a's spend does not count against b
        vm.stopPrank();
        // another owner's policy cannot be spent by this agent
        vm.prank(eve);
        uint256 c = aa.createPolicy(bob, address(usdt), 1, 1, uint64(block.timestamp + 1), false, new address[](0));
        vm.prank(agent);
        vm.expectRevert(RemessoAgentAllowance.NotAgent.selector);
        aa.pay(c, bob, 1, 0);
    }

    function test_revokingTheAllowanceStopsEverything() public {
        uint256 id = _open();
        vm.prank(owner);
        usdt.approve(address(aa), 0);
        vm.prank(agent);
        vm.expectRevert();
        aa.pay(id, bob, 1e6, 0);
    }

    function test_failedTransferDoesNotSpendTheDay() public {
        uint256 id = _open();
        vm.prank(owner);
        usdt.approve(address(aa), 0);
        vm.prank(agent);
        vm.expectRevert();
        aa.pay(id, bob, 1e6, 0);
        assertEq(aa.remainingToday(id), PER_DAY);
    }

    // ---- creation rules ----

    function test_createRejectsBadInput() public {
        address[] memory none = new address[](0);
        uint64 exp = uint64(block.timestamp + 1 days);
        vm.startPrank(owner);
        vm.expectRevert(RemessoAgentAllowance.ZeroAddress.selector);
        aa.createPolicy(address(0), address(usdt), 1, 1, exp, false, none);
        vm.expectRevert(RemessoAgentAllowance.SelfPayment.selector);
        aa.createPolicy(owner, address(usdt), 1, 1, exp, false, none);
        vm.expectRevert(RemessoAgentAllowance.BadLimits.selector);
        aa.createPolicy(agent, address(usdt), 0, 1, exp, false, none);
        vm.expectRevert(RemessoAgentAllowance.BadLimits.selector);
        aa.createPolicy(agent, address(usdt), 2, 1, exp, false, none);
        vm.expectRevert(RemessoAgentAllowance.BadExpiry.selector);
        aa.createPolicy(agent, address(usdt), 1, 1, uint64(block.timestamp), false, none);
        vm.expectRevert(RemessoAgentAllowance.BadExpiry.selector);
        aa.createPolicy(agent, address(usdt), 1, 1, uint64(block.timestamp + 366 days), false, none);
        vm.expectRevert(RemessoAgentAllowance.TooManyRecipients.selector);
        aa.createPolicy(agent, address(usdt), 1, 1, exp, true, new address[](51));
        vm.stopPrank();
    }

    function testFuzz_neverMoreThanPerDayInAWindow(uint8 n, uint64 seed) public {
        uint256 id = _open();
        uint256 sent;
        vm.startPrank(agent);
        for (uint256 i; i < n; ++i) {
            uint256 amt = (uint256(keccak256(abi.encode(seed, i))) % PER_PAYMENT) + 1;
            try aa.pay(id, bob, amt, 0) {
                sent += amt;
            } catch {}
        }
        vm.stopPrank();
        assertLe(sent, PER_DAY);
        assertEq(usdt.balanceOf(bob), sent);
    }
}
