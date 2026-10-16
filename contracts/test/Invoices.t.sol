// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CollectiveBase} from "./CollectiveBase.t.sol";
import {Collective} from "../src/Collective.sol";

contract InvoicesTest is CollectiveBase {
    bytes32 constant INV = keccak256("site-v2/milestone-2");

    function _one(address who_) internal pure returns (address[] memory who, uint16[] memory sh) {
        who = new address[](1);
        sh = new uint16[](1);
        who[0] = who_; sh[0] = 10_000;
    }

    function test_payInvoice_setsReserveAsideAndPaysByShare() public {
        _pay(_invoice(INV, 2000 * USDC, ali, 6000, ayse, 4000));
        assertEq(c.reserve(), 200 * USDC);
        assertEq(usdc.balanceOf(ali), 1080 * USDC);
        assertEq(usdc.balanceOf(ayse), 720 * USDC);
        assertEq(usdc.balanceOf(address(c)), _accounted());
    }

    function test_reserveStopsAtTarget() public {
        _pay(_invoice(INV, 10_000 * USDC, ali, 5000, ayse, 5000));
        assertEq(c.reserve(), 500 * USDC);
        assertEq(usdc.balanceOf(ali), 4750 * USDC);
        assertEq(usdc.balanceOf(ayse), 4750 * USDC);
    }

    function test_noteAndDueDateAreRecorded() public {
        (address[] memory who, uint16[] memory sh) = _one(ali);
        uint64 due = uint64(block.timestamp + 14 days);
        bytes32 id = c.invoiceId(ali, INV);
        vm.expectEmit(true, true, false, true, address(c));
        emit Collective.InvoiceCreated(id, ali, 4800 * USDC, address(0), due, who, sh, "Shopify store rebuild");
        vm.prank(ali);
        c.createInvoice(INV, 4800 * USDC, address(0), due, who, sh, "Shopify store rebuild");
        (,,,, uint64 dueAt,, uint8 pending,,) = c.invoice(id);
        assertEq(dueAt, due);
        assertEq(pending, 0); // ali wrote it for herself
    }

    function test_noteHasALimit() public {
        (address[] memory who, uint16[] memory sh) = _one(ali);
        bytes memory long = new bytes(281);
        vm.prank(ali);
        vm.expectRevert(Collective.NoteTooLong.selector);
        c.createInvoice(INV, 10 * USDC, address(0), 0, who, sh, string(long));
    }

    function test_cannotPayTwice() public {
        bytes32 id = _invoice(INV, 10 * USDC, ali, 5000, ayse, 5000);
        vm.startPrank(client);
        c.payInvoice(id, 10 * USDC);
        vm.expectRevert(Collective.InvoiceNotOpen.selector);
        c.payInvoice(id, 10 * USDC);
        vm.stopPrank();
    }

    function test_wrongPayerReverts() public {
        (address[] memory who, uint16[] memory sh) = _one(ali);
        vm.prank(ali);
        bytes32 id = c.createInvoice(INV, 10 * USDC, client, 0, who, sh, "");
        address stranger = makeAddr("stranger");
        usdc.mint(stranger, 10 * USDC);
        vm.startPrank(stranger);
        usdc.approve(address(c), type(uint256).max);
        vm.expectRevert(Collective.WrongPayer.selector);
        c.payInvoice(id, 10 * USDC);
        vm.stopPrank();
    }

    function test_cancelledInvoiceCannotBePaid() public {
        bytes32 id = _invoice(INV, 10 * USDC, ali, 5000, ayse, 5000);
        vm.prank(ayse);
        c.cancelInvoice(id);
        vm.prank(client);
        vm.expectRevert(Collective.InvoiceNotOpen.selector);
        c.payInvoice(id, 10 * USDC);
    }

    function test_sharesMustSumTo10000() public {
        address[] memory who = new address[](2);
        uint16[] memory sh = new uint16[](2);
        who[0] = ali; who[1] = ayse; sh[0] = 5000; sh[1] = 4000;
        vm.prank(ali);
        vm.expectRevert(Collective.BadShares.selector);
        c.createInvoice(INV, 10 * USDC, address(0), 0, who, sh, "");
    }

    function test_zeroShareIsRefused() public {
        address[] memory who = new address[](2);
        uint16[] memory sh = new uint16[](2);
        who[0] = ali; who[1] = ayse; sh[0] = 10_000; sh[1] = 0;
        vm.prank(ali);
        vm.expectRevert(Collective.BadShares.selector);
        c.createInvoice(INV, 10 * USDC, address(0), 0, who, sh, "");
    }

    function test_samePersonTwiceIsRefused() public {
        address[] memory who = new address[](2);
        uint16[] memory sh = new uint16[](2);
        who[0] = ayse; who[1] = ayse; sh[0] = 5000; sh[1] = 5000;
        vm.prank(ali);
        vm.expectRevert(Collective.BadShares.selector);
        c.createInvoice(INV, 10 * USDC, address(0), 0, who, sh, "");
    }

    function test_contributorMustBeMember() public {
        (address[] memory who, uint16[] memory sh) = _one(client);
        vm.prank(ali);
        vm.expectRevert(abi.encodeWithSelector(Collective.NotAMember.selector, client));
        c.createInvoice(INV, 10 * USDC, address(0), 0, who, sh, "");
    }

    function test_strangerCannotCreateInvoice() public {
        (address[] memory who, uint16[] memory sh) = _one(ali);
        vm.prank(client);
        vm.expectRevert(Collective.NotMemberOrAgent.selector);
        c.createInvoice(INV, 10 * USDC, address(0), 0, who, sh, "");
    }

    function test_cannotInitializeTwice() public {
        address[] memory m = new address[](1);
        m[0] = ali;
        vm.expectRevert();
        c.initialize(IERC20(address(usdc)), "x", m, defaultRules(), agent);
    }
}
