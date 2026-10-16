// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CollectiveBase} from "./CollectiveBase.t.sol";
import {Collective} from "../src/Collective.sol";

/// Shared costs (tools, hosting) come out of the reserve the team chose to fill, never out of anyone's share.
contract ExpensesTest is CollectiveBase {
    address hosting = makeAddr("hosting");

    function setUp() public override {
        super.setUp();
        _pay(_invoice(keccak256("job"), 5000 * USDC, ali, 5000, ayse, 5000)); // reserve fills to 500
        _allowPayee(hosting);
    }

    function _allowPayee(address who) internal {
        vm.prank(ali);
        uint256 id = c.propose(Collective.Kind.SetPayee, abi.encode(who, true), bytes32(0));
        vm.prank(ayse);
        c.vote(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        c.execute(id);
    }

    function test_agentPaysAllowlistedBillFromTheReserve() public {
        uint256 aliBefore = usdc.balanceOf(ali);
        vm.prank(agent);
        c.payExpense(hosting, 50 * USDC, keccak256("vps-oct"));
        assertEq(usdc.balanceOf(hosting), 50 * USDC);
        assertEq(c.reserve(), 450 * USDC);
        assertEq(usdc.balanceOf(ali), aliBefore); // nobody's share pays for it
        assertEq(usdc.balanceOf(address(c)), _accounted());
    }

    function test_nonAllowlistedPayeeReverts() public {
        address rando = makeAddr("rando");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(Collective.NotPayee.selector, rando));
        c.payExpense(rando, 1 * USDC, keccak256("r"));
    }

    function test_agentBillNeedsAFreshRef() public {
        vm.startPrank(agent);
        vm.expectRevert(Collective.RefRequired.selector);
        c.payExpense(hosting, 1 * USDC, bytes32(0));
        c.payExpense(hosting, 1 * USDC, keccak256("decision-1"));
        vm.expectRevert(Collective.RefAlreadyUsed.selector);
        c.payExpense(hosting, 1 * USDC, keccak256("decision-1"));
        vm.stopPrank();
    }

    function test_periodCapEnforced() public {
        vm.startPrank(agent);
        c.payExpense(hosting, 150 * USDC, keccak256("a"));
        vm.expectRevert(Collective.AboveCap.selector);
        c.payExpense(hosting, 51 * USDC, keccak256("b"));
        vm.stopPrank();
    }

    function test_cannotSpendMoreThanTheReserve() public {
        vm.prank(ali);
        uint256 id = c.propose(Collective.Kind.Expense, abi.encode(hosting, 501 * USDC), bytes32(0));
        vm.prank(ayse);
        c.vote(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        vm.expectRevert(Collective.InsufficientReserve.selector);
        c.execute(id);
    }

    function test_capResetsNextWindow() public {
        vm.prank(agent);
        c.payExpense(hosting, 200 * USDC, keccak256("a"));
        (, uint256 left) = c.agentRoom();
        assertEq(left, 0);
        vm.warp(block.timestamp + 30 days);
        (, left) = c.agentRoom();
        assertEq(left, 200 * USDC);
        vm.prank(agent);
        c.payExpense(hosting, 200 * USDC, keccak256("b"));
        assertEq(c.expensesThisPeriod(), 200 * USDC);
        assertEq(c.period(), 1);
    }
}
