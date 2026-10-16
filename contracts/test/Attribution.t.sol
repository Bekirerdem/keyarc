// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CollectiveBase} from "./CollectiveBase.t.sol";
import {Collective} from "../src/Collective.sol";

contract AttributionTest is CollectiveBase {
    function _plainTransfer(uint256 amount) internal {
        vm.prank(client);
        usdc.transfer(address(c), amount); // money sent to the chest address without the pay link
    }

    function test_plainTransferShowsAsUnattributed() public {
        _plainTransfer(30 * USDC);
        assertEq(c.unattributed(), 30 * USDC);
    }

    function test_agentAttributesWithinCapAndTheMemberIsPaid() public {
        _plainTransfer(30 * USDC);
        vm.prank(agent);
        c.attribute(mehmet, 30 * USDC, keccak256("template-sale-17"));
        assertEq(c.unattributed(), 0);
        assertEq(c.reserve(), 3 * USDC);
        assertEq(usdc.balanceOf(mehmet), 27 * USDC);
        assertEq(usdc.balanceOf(address(c)), _accounted());
    }

    function test_agentCannotAttributeMoreThanUnattributed() public {
        _plainTransfer(10 * USDC);
        vm.prank(agent);
        vm.expectRevert(Collective.ExceedsUnattributed.selector);
        c.attribute(mehmet, 11 * USDC, keccak256("inflow-1"));
    }

    function test_agentCannotAttributeAboveCap() public {
        _plainTransfer(150 * USDC);
        vm.prank(agent);
        vm.expectRevert(Collective.AboveCap.selector);
        c.attribute(mehmet, 150 * USDC, keccak256("inflow-2"));
    }

    function test_agentCannotAttributeToNonMember() public {
        _plainTransfer(10 * USDC);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(Collective.NotAMember.selector, client));
        c.attribute(client, 10 * USDC, keccak256("inflow-3"));
    }

    function test_memberCannotUseAgentPath() public {
        _plainTransfer(10 * USDC);
        vm.prank(ali);
        vm.expectRevert(Collective.NotAgent.selector);
        c.attribute(ali, 10 * USDC, keccak256("inflow-4"));
    }

    function test_aboveCapGoesThroughVote() public {
        _plainTransfer(150 * USDC);
        vm.prank(agent);
        uint256 id = c.propose(Collective.Kind.Attribute, abi.encode(mehmet, 150 * USDC), keccak256("big-sale"));
        vm.prank(ali);
        c.vote(id);
        vm.prank(ayse);
        c.vote(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        c.execute(id);
        assertEq(usdc.balanceOf(mehmet), 135 * USDC);
    }

    function test_agentCannotProposeRuleChange() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(Collective.AgentCannotPropose.selector, Collective.Kind.SetRules));
        c.propose(Collective.Kind.SetRules, abi.encode(defaultRules()), bytes32(0));
    }
}
