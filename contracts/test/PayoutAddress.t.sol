// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CollectiveBase} from "./CollectiveBase.t.sol";
import {Collective} from "../src/Collective.sol";

/// Members choose where their share lands (their own wallet, another wallet, an exchange deposit address).
contract PayoutAddressTest is CollectiveBase {
    address exchange = makeAddr("exchange-deposit");
    bytes32 id;

    function setUp() public override {
        super.setUp();
        id = _invoice(keccak256("a"), 2000 * USDC, ali, 6000, ayse, 4000); // net 1800: ali 1080, ayse 720
    }

    function test_shareGoesToChosenAddress() public {
        vm.prank(ayse);
        c.setPayoutAddress(exchange);
        assertEq(c.payoutTo(ayse), exchange);
        _pay(id);
        assertEq(usdc.balanceOf(exchange), 720 * USDC);
        assertEq(usdc.balanceOf(ayse), 0);
        assertEq(usdc.balanceOf(ali), 1080 * USDC);
    }

    function test_paidEventNamesTheDestination() public {
        vm.prank(ayse);
        c.setPayoutAddress(exchange);
        vm.expectEmit(true, true, false, true, address(c));
        emit Collective.Paid(id, ali, ali, 1080 * USDC);
        vm.expectEmit(true, true, false, true, address(c));
        emit Collective.Paid(id, ayse, exchange, 720 * USDC);
        _pay(id);
    }

    function test_resetGoesBackToOwnWallet() public {
        vm.startPrank(ayse);
        c.setPayoutAddress(exchange);
        c.setPayoutAddress(address(0));
        vm.stopPrank();
        _pay(id);
        assertEq(usdc.balanceOf(ayse), 720 * USDC);
        assertEq(usdc.balanceOf(exchange), 0);
    }

    function test_onlyMembersSetAPayoutAddress() public {
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Collective.NotAMember.selector, client));
        c.setPayoutAddress(exchange);
    }

    function test_emitsPayoutAddressSet() public {
        vm.expectEmit(true, false, false, true, address(c));
        emit Collective.PayoutAddressSet(ayse, exchange);
        vm.prank(ayse);
        c.setPayoutAddress(exchange);
    }

    function test_blockedDestinationIsOwedToTheMember() public {
        vm.prank(ayse);
        c.setPayoutAddress(exchange);
        usdc.setBlocked(exchange, true);
        _pay(id);
        // the member, not the destination, can claim it to a working address
        assertEq(c.owed(ayse), 720 * USDC);
        assertEq(c.owed(exchange), 0);
        assertEq(usdc.balanceOf(address(c)), _accounted());
        vm.prank(ayse);
        c.claim(ayse);
        assertEq(usdc.balanceOf(ayse), 720 * USDC);
    }
}
