// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CollectiveBase} from "./CollectiveBase.t.sol";
import {Collective} from "../src/Collective.sol";

/// @notice v2 guards from the agent-layer review: a fooled agent can't route money to an unlisted
///         payee through a vote, can't cancel other people's invoices, and can't attribute twice.
contract AgentGuardsTest is CollectiveBase {
    address attacker = makeAddr("attacker");

    function _fundReserve() internal {
        _pay(_invoice(keccak256("job"), 5000 * USDC, ali, 5000, ayse, 5000)); // reserve 500
    }

    function _passAs(address proposer, Collective.Kind kind, bytes memory payload, bytes32 ref) internal returns (uint256 id) {
        vm.prank(proposer);
        id = c.propose(kind, payload, ref);
        if (proposer != ali) {
            vm.prank(ali);
            c.vote(id);
        }
        vm.prank(ayse);
        c.vote(id);
        vm.warp(block.timestamp + 1 days);
    }

    // ── agent-proposed expenses must still go to an allowlisted payee ──

    function test_agentProposedExpenseToUnlistedPayeeReverts() public {
        _fundReserve();
        uint256 id = _passAs(agent, Collective.Kind.Expense, abi.encode(attacker, 480 * USDC), keccak256("wallet-changed"));
        vm.prank(ali);
        vm.expectRevert(abi.encodeWithSelector(Collective.NotPayee.selector, attacker));
        c.execute(id);
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_memberProposedExpenseCanPayAnyoneByVote() public {
        _fundReserve();
        uint256 id = _passAs(ali, Collective.Kind.Expense, abi.encode(attacker, 10 * USDC), bytes32(0));
        vm.prank(ali);
        c.execute(id);
        assertEq(usdc.balanceOf(attacker), 10 * USDC);
    }

    // ── only the creator or a member may cancel an invoice ──

    function test_agentCannotCancelMembersInvoice() public {
        bytes32 id = _invoice(keccak256("job"), 10 * USDC, ali, 5000, ayse, 5000); // created by ali
        vm.prank(agent);
        vm.expectRevert(Collective.NotInvoiceOwner.selector);
        c.cancelInvoice(id);
    }

    function test_agentCanCancelItsOwnInvoice() public {
        address[] memory who = new address[](1);
        uint16[] memory sh = new uint16[](1);
        who[0] = ali; sh[0] = 10_000;
        vm.prank(agent);
        bytes32 id = c.createInvoice(keccak256("agent-made"), 10 * USDC, address(0), 0, who, sh, "");
        vm.prank(agent);
        c.cancelInvoice(id);
        (,,, Collective.InvoiceStatus status,,,,,) = c.invoice(id);
        assertEq(uint8(status), uint8(Collective.InvoiceStatus.Cancelled));
    }

    function test_memberCanCancelAnyInvoice() public {
        bytes32 id = _invoice(keccak256("job"), 10 * USDC, ali, 5000, ayse, 5000);
        vm.prank(mehmet);
        c.cancelInvoice(id);
    }

    // ── each inflow can be attributed once ──

    function test_sameRefCannotBeAttributedTwice() public {
        vm.prank(client);
        usdc.transfer(address(c), 40 * USDC);
        bytes32 inflowTx = keccak256("0xinflow-tx-hash");
        vm.startPrank(agent);
        c.attribute(mehmet, 20 * USDC, inflowTx);
        vm.expectRevert(Collective.RefAlreadyUsed.selector);
        c.attribute(ali, 20 * USDC, inflowTx); // a retried cron must not credit the same inflow again
        vm.stopPrank();
    }

    function test_agentAttributionNeedsARef() public {
        vm.prank(client);
        usdc.transfer(address(c), 10 * USDC);
        vm.prank(agent);
        vm.expectRevert(Collective.RefRequired.selector);
        c.attribute(mehmet, 10 * USDC, bytes32(0));
    }
}
