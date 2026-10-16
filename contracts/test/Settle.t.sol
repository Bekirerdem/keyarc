// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CollectiveBase} from "./CollectiveBase.t.sol";
import {Collective} from "../src/Collective.sol";

/// @notice Cross-chain collections land on Arc without an invoice reference (CCTP mints to the chest).
///         The agent matches them to an open invoice and the shares go out; above its cap the match goes to a vote.
contract SettleTest is CollectiveBase {
    bytes32 inflow = keccak256("base-cctp-tx");

    function _crossChainArrives(uint256 amount) internal {
        vm.prank(client);
        usdc.transfer(address(c), amount); // stands in for a CCTP mint to the chest
    }

    function test_agentSettlesInvoiceAndSharesGoOut() public {
        bytes32 id = _invoice(keccak256("job"), 80 * USDC, ali, 7000, ayse, 3000);
        _crossChainArrives(80 * USDC);
        vm.prank(agent);
        c.settleInvoice(id, inflow);

        (,,, Collective.InvoiceStatus status,,,,,) = c.invoice(id);
        assertEq(uint8(status), uint8(Collective.InvoiceStatus.Paid));
        assertEq(c.reserve(), 8 * USDC);
        assertEq(usdc.balanceOf(ali), 50_400_000);
        assertEq(usdc.balanceOf(ayse), 21_600_000);
        assertEq(c.unattributed(), 0);
        assertEq(usdc.balanceOf(address(c)), _accounted());
    }

    function test_cannotSettleWithoutTheMoney() public {
        bytes32 id = _invoice(keccak256("job"), 80 * USDC, ali, 7000, ayse, 3000);
        _crossChainArrives(79 * USDC);
        vm.prank(agent);
        vm.expectRevert(Collective.ExceedsUnattributed.selector);
        c.settleInvoice(id, inflow);
    }

    function test_settleCountsTowardAgentCap() public {
        bytes32 id = _invoice(keccak256("big"), 150 * USDC, ali, 5000, ayse, 5000); // cap is 100
        _crossChainArrives(150 * USDC);
        vm.prank(agent);
        vm.expectRevert(Collective.AboveCap.selector);
        c.settleInvoice(id, inflow);
    }

    function test_aboveCapSettleGoesThroughVote() public {
        bytes32 id = _invoice(keccak256("big"), 150 * USDC, ali, 5000, ayse, 5000);
        _crossChainArrives(150 * USDC);
        vm.prank(agent);
        uint256 pid = c.propose(Collective.Kind.SettleInvoice, abi.encode(id), inflow);
        vm.prank(ali);
        c.vote(pid);
        vm.prank(ayse);
        c.vote(pid);
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        c.execute(pid);
        (,,, Collective.InvoiceStatus status,,,,,) = c.invoice(id);
        assertEq(uint8(status), uint8(Collective.InvoiceStatus.Paid));
        assertEq(usdc.balanceOf(ali), 67_500_000);
    }

    function test_sameInflowCannotSettleTwoInvoices() public {
        bytes32 a = _invoice(keccak256("a"), 40 * USDC, ali, 5000, ayse, 5000);
        bytes32 b = _invoice(keccak256("b"), 40 * USDC, ali, 5000, ayse, 5000);
        _crossChainArrives(80 * USDC);
        vm.startPrank(agent);
        c.settleInvoice(a, inflow);
        vm.expectRevert(Collective.RefAlreadyUsed.selector);
        c.settleInvoice(b, inflow);
        vm.stopPrank();
    }

    function test_paidInvoiceCannotBeSettled() public {
        bytes32 id = _invoice(keccak256("job"), 10 * USDC, ali, 5000, ayse, 5000);
        _pay(id);
        _crossChainArrives(10 * USDC);
        vm.prank(agent);
        vm.expectRevert(Collective.InvoiceNotOpen.selector);
        c.settleInvoice(id, inflow);
    }

    function test_memberCannotUseAgentSettlePath() public {
        bytes32 id = _invoice(keccak256("job"), 10 * USDC, ali, 5000, ayse, 5000);
        _crossChainArrives(10 * USDC);
        vm.prank(ali);
        vm.expectRevert(Collective.NotAgent.selector);
        c.settleInvoice(id, inflow);
    }
}
