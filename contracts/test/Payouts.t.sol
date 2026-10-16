// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CollectiveBase} from "./CollectiveBase.t.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Collective} from "../src/Collective.sol";
import {Rules} from "../src/CollectiveTypes.sol";

/// Shares are paid the moment the client pays; nothing waits for a month end.
contract PayoutsTest is CollectiveBase {
    function test_sharesArePaidInThePaymentTransaction() public {
        _pay(_invoice(keccak256("a"), 2000 * USDC, ali, 6000, ayse, 4000));
        assertEq(c.reserve(), 200 * USDC);            // 10% to shared costs
        assertEq(usdc.balanceOf(ali), 1080 * USDC);   // 60% of 1800
        assertEq(usdc.balanceOf(ayse), 720 * USDC);
        assertEq(usdc.balanceOf(address(c)), 200 * USDC);
        assertEq(usdc.balanceOf(address(c)), _accounted());
    }

    function test_nobodyGetsLessThanTheInvoiceShowed() public {
        // the shared-costs cut is at most what the invoice showed; once the reserve is full it is less
        _pay(_invoice(keccak256("a"), 4500 * USDC, ali, 10_000 - 1, ayse, 1)); // reserve fills to 450
        uint256 before = usdc.balanceOf(mehmet);
        _pay(_solo(keccak256("b"), 1000 * USDC, mehmet));                     // 50 to fill the reserve, 950 to mehmet
        assertEq(usdc.balanceOf(mehmet) - before, 950 * USDC);
        assertEq(c.reserve(), 500 * USDC);
        _pay(_solo(keccak256("c"), 1000 * USDC, mehmet));                     // reserve full: all 1000
        assertEq(usdc.balanceOf(mehmet) - before, 1950 * USDC);
    }

    function test_ruleChangeAfterAgreementDoesNotChangeTheCut() public {
        bytes32 id = _invoice(keccak256("a"), 1000 * USDC, ali, 5000, ayse, 5000); // agreed at 10%
        Rules memory greedy = defaultRules();
        greedy.reserveBps = 10_000;
        greedy.reserveTarget = 1_000_000 * USDC;
        vm.prank(ali);
        uint256 pid = c.propose(Collective.Kind.SetRules, abi.encode(greedy), bytes32(0));
        vm.prank(mehmet);
        c.vote(pid);
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        c.execute(pid);
        _pay(id);
        assertEq(c.reserve(), 100 * USDC);           // still the 10% everyone signed
        assertEq(usdc.balanceOf(ayse), 450 * USDC);
    }

    function test_payoutAddressCannotBeTheChestOrTheToken() public {
        vm.startPrank(ayse);
        vm.expectRevert(Collective.BadPayout.selector);
        c.setPayoutAddress(address(c));
        vm.expectRevert(Collective.BadPayout.selector);
        c.setPayoutAddress(address(usdc));
        vm.stopPrank();
    }

    function test_noReserveWhenTheTeamDidNotAskForOne() public {
        Collective free = _freshTeam(0);
        address[] memory who = new address[](1);
        uint16[] memory sh = new uint16[](1);
        who[0] = ali; sh[0] = 10_000;
        vm.prank(ali);
        bytes32 id = free.createInvoice(keccak256("x"), 500 * USDC, address(0), 0, who, sh, "");
        vm.startPrank(client);
        usdc.approve(address(free), 500 * USDC);
        free.payInvoice(id, 500 * USDC);
        vm.stopPrank();
        assertEq(free.reserve(), 0);
        assertEq(usdc.balanceOf(ali), 500 * USDC);
        assertEq(usdc.balanceOf(address(free)), 0);
    }

    function test_roundingRemainderGoesToTheLastPerson() public {
        address[] memory who = new address[](3);
        uint16[] memory sh = new uint16[](3);
        who[0] = ali; who[1] = ayse; who[2] = mehmet; sh[0] = 3333; sh[1] = 3333; sh[2] = 3334;
        vm.prank(ali);
        bytes32 id = c.createInvoice(keccak256("odd"), 101, address(0), 0, who, sh, "");
        _agreeAll(id);
        _pay(id);
        // 101 - 10 reserve = 91: 30 + 30 + 31, nothing left in the chest but the reserve
        assertEq(usdc.balanceOf(ali), 30);
        assertEq(usdc.balanceOf(ayse), 30);
        assertEq(usdc.balanceOf(mehmet), 31);
        assertEq(usdc.balanceOf(address(c)), c.reserve());
    }

    function test_blocklistedMemberDoesNotBlockOthers() public {
        usdc.setBlocked(ayse, true);
        _pay(_invoice(keccak256("a"), 2000 * USDC, ali, 6000, ayse, 4000));
        assertEq(usdc.balanceOf(ali), 1080 * USDC);
        assertEq(c.owed(ayse), 720 * USDC);
        assertEq(usdc.balanceOf(address(c)), _accounted());

        address ayseNew = makeAddr("ayse-new-wallet");
        vm.prank(ayse);
        c.claim(ayseNew);
        assertEq(usdc.balanceOf(ayseNew), 720 * USDC);
        assertEq(c.totalOwed(), 0);
    }

    function test_paidEventNamesTheInvoice() public {
        bytes32 id = _invoice(keccak256("a"), 2000 * USDC, ali, 6000, ayse, 4000);
        vm.expectEmit(true, true, false, true, address(c));
        emit Collective.Paid(id, ali, ali, 1080 * USDC);
        _pay(id);
    }

    function _freshTeam(uint16 reserveBps) internal returns (Collective t) {
        t = Collective(Clones.clone(address(new Collective())));
        address[] memory m = new address[](2);
        m[0] = ali; m[1] = ayse;
        t.initialize(IERC20(address(usdc)), "Free", m, _rulesWith(reserveBps), agent);
    }

    function _rulesWith(uint16 reserveBps) internal pure returns (Rules memory r) {
        r = defaultRules();
        r.reserveBps = reserveBps;
    }
}

