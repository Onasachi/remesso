// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RemessoAgentAllowance
 * @notice Lets a person give an AI agent a key that can spend from their wallet,
 *         but only inside limits this contract enforces: one token, a cap per
 *         payment, a cap per day, an expiry and, optionally, a list of the only
 *         addresses it may pay.
 *
 * Why a contract and not a prompt: an agent that can send money will be told
 * to by a webpage or an email sooner or later. Nothing written in its
 * instructions survives that. A cap enforced here does.
 *
 * Why not a smart account: the money stays in the person's own wallet, which
 * is what MiniPay shows them. They grant an ERC-20 allowance to this contract
 * and create a policy, the same two steps as a Remesso schedule, and revoke
 * either at any time from that wallet.
 *
 * No owner, no admin, no pause, no upgrade. Nobody but a policy's owner can
 * change it, and nobody but its agent can spend under it.
 *
 * The day is a fixed window that opens at the first payment after the last one
 * closed, not a rolling 24h: up to 2 x perDay can move in a short span across a
 * window boundary. perDay bounds what moves per window; the expiry and the
 * allowance bound the rest.
 */
contract RemessoAgentAllowance is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Policy {
        address owner; //       whose wallet pays
        address agent; //       the only key that may call pay()
        address token;
        uint64 expiresAt; //    pay() refused at or after this
        bool allowlistOnly; //  when true, only `allowed` recipients
        bool revoked;
        uint128 perPayment;
        uint128 perDay;
        uint128 spentInWindow;
        uint64 windowStart;
    }

    uint256 public constant WINDOW = 1 days;
    /// A policy that lasts longer than this is a key nobody remembers handing out.
    uint256 public constant MAX_DURATION = 365 days;
    uint256 public constant MAX_RECIPIENTS = 50;

    uint256 public nextPolicyId = 1;
    mapping(uint256 => Policy) private _policies;
    mapping(uint256 => mapping(address => bool)) public allowed;

    event PolicyCreated(
        uint256 indexed id,
        address indexed owner,
        address indexed agent,
        address token,
        uint128 perPayment,
        uint128 perDay,
        uint64 expiresAt,
        bool allowlistOnly
    );
    event RecipientSet(uint256 indexed id, address indexed recipient, bool allowed);
    event PolicyRevoked(uint256 indexed id);
    event Paid(uint256 indexed id, address indexed to, uint256 amount, bytes32 memo);

    error ZeroAddress();
    error ZeroAmount();
    error BadLimits();
    error BadExpiry();
    error TooManyRecipients();
    error NotOwner();
    error NotAgent();
    error Revoked();
    error Expired();
    error OverPerPayment();
    error OverPerDay();
    error RecipientNotAllowed();
    error SelfPayment();

    function createPolicy(
        address agent,
        address token,
        uint128 perPayment,
        uint128 perDay,
        uint64 expiresAt,
        bool allowlistOnly,
        address[] calldata recipients
    ) external returns (uint256 id) {
        if (agent == address(0) || token == address(0)) revert ZeroAddress();
        // The agent paying from the owner's wallet to the owner is a no-op at
        // best; an agent that IS the owner needs no policy.
        if (agent == msg.sender) revert SelfPayment();
        if (perPayment == 0 || perDay == 0 || perPayment > perDay) revert BadLimits();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_DURATION) revert BadExpiry();
        if (recipients.length > MAX_RECIPIENTS) revert TooManyRecipients();

        id = nextPolicyId++;
        _policies[id] = Policy({
            owner: msg.sender,
            agent: agent,
            token: token,
            expiresAt: expiresAt,
            allowlistOnly: allowlistOnly,
            revoked: false,
            perPayment: perPayment,
            perDay: perDay,
            spentInWindow: 0,
            windowStart: 0
        });
        emit PolicyCreated(id, msg.sender, agent, token, perPayment, perDay, expiresAt, allowlistOnly);

        for (uint256 i; i < recipients.length; ++i) {
            _setRecipient(id, recipients[i], true);
        }
    }

    function setRecipient(uint256 id, address recipient, bool ok) external {
        if (_policies[id].owner != msg.sender) revert NotOwner();
        _setRecipient(id, recipient, ok);
    }

    /// One-way. A new key or new limits is a new policy, so a revoked one can
    /// never be quietly brought back.
    function revoke(uint256 id) external {
        Policy storage p = _policies[id];
        if (p.owner != msg.sender) revert NotOwner();
        p.revoked = true;
        emit PolicyRevoked(id);
    }

    /// @param memo free 32 bytes for the agent's own reference (an invoice id,
    ///        a hash of the request); recorded in the event, never interpreted.
    function pay(uint256 id, address to, uint256 amount, bytes32 memo) external nonReentrant {
        Policy storage p = _policies[id];
        if (p.agent != msg.sender) revert NotAgent();
        if (p.revoked) revert Revoked();
        if (block.timestamp >= p.expiresAt) revert Expired();
        if (to == address(0)) revert ZeroAddress();
        if (to == p.owner) revert SelfPayment();
        if (amount == 0) revert ZeroAmount();
        if (amount > p.perPayment) revert OverPerPayment();
        if (p.allowlistOnly && !allowed[id][to]) revert RecipientNotAllowed();

        uint256 spent = p.spentInWindow;
        if (block.timestamp >= uint256(p.windowStart) + WINDOW) {
            p.windowStart = uint64(block.timestamp);
            spent = 0;
        }
        // amount <= perPayment <= uint128 max, so the cast below is safe.
        if (spent + amount > p.perDay) revert OverPerDay();
        p.spentInWindow = uint128(spent + amount);

        emit Paid(id, to, amount, memo);
        IERC20(p.token).safeTransferFrom(p.owner, to, amount);
    }

    function policy(uint256 id) external view returns (Policy memory) {
        return _policies[id];
    }

    /// What the agent could still send right now under this policy, ignoring
    /// the owner's balance and allowance (read those from the token).
    function remainingToday(uint256 id) external view returns (uint256) {
        Policy storage p = _policies[id];
        if (p.revoked || block.timestamp >= p.expiresAt || p.agent == address(0)) return 0;
        if (block.timestamp >= uint256(p.windowStart) + WINDOW) return p.perDay;
        return p.perDay - p.spentInWindow;
    }

    function _setRecipient(uint256 id, address recipient, bool ok) private {
        if (recipient == address(0)) revert ZeroAddress();
        allowed[id][recipient] = ok;
        emit RecipientSet(id, recipient, ok);
    }
}
