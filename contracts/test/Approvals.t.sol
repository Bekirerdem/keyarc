// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CollectiveBase} from "./CollectiveBase.t.sol";
import {Collective} from "../src/Collective.sol";

/// Everyone on an invoice agrees to the shares before the client can pay: "fixed before payment" means agreed, not
/// just written down by whoever made the invoice.
contract ApprovalsTest is CollectiveBase {
    bytes32 constant SALT = keccak256("store-rebuild");

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_cannotPayBeforeEveryoneAgrees() public {
        bytes32 id = _draft(SALT, 1000 * USDC, ali, 9000, ayse, 1000);
        (,,,,,, uint8 pending,,) = c.invoice(id);
        assertEq(pending, 1); // ali wrote it, ayse hasn't agreed
        vm.prank(client);
        vm.expectRevert(Collective.AwaitingApproval.selector);
        c.payInvoice(id, 1000 * USDC);
    }

    function test_contributorAgreesThenClientPays() public {
        bytes32 id = _draft(SALT, 1000 * USDC, ali, 6000, ayse, 4000);
        vm.expectEmit(true, true, false, false, address(c));
        emit Collective.InvoiceApproved(id, ayse);
        vm.prank(ayse);
        c.approveInvoice(id);
        _pay(id);
        assertEq(usdc.balanceOf(ayse), 360 * USDC);
    }

    function test_disagreeingContributorCancels() public {
        bytes32 id = _draft(SALT, 1000 * USDC, ali, 9900, ayse, 100);
        vm.prank(ayse);
        c.cancelInvoice(id);
        vm.prank(ayse);
        vm.expectRevert(Collective.InvoiceNotOpen.selector);
        c.approveInvoice(id);
    }

    function test_onlyPeopleOnTheInvoiceCanAgree() public {
        bytes32 id = _draft(SALT, 1000 * USDC, ali, 6000, ayse, 4000);
        vm.prank(mehmet);
        vm.expectRevert(Collective.NotAContributor.selector);
        c.approveInvoice(id);
    }

    function test_agreeingTwiceReverts() public {
        bytes32 id = _draft(SALT, 1000 * USDC, ali, 6000, ayse, 4000);
        vm.startPrank(ayse);
        c.approveInvoice(id);
        vm.expectRevert(Collective.AlreadyApproved.selector);
        c.approveInvoice(id);
        vm.stopPrank();
        vm.prank(ali);
        vm.expectRevert(Collective.AlreadyApproved.selector);
        c.approveInvoice(id); // the creator agreed by creating it
    }

    function test_signedAgreementCostsTheContributorNoGas() public {
        bytes32 id = _draft(SALT, 1000 * USDC, ali, 6000, ayse, 4000);
        bytes memory sig = _sign(ayseKey, c.approvalDigest(id));
        vm.prank(agent); // anyone can carry it; here the agent relays it
        c.approveInvoiceFor(id, ayse, sig);
        assertTrue(c.approved(id, ayse));
        _pay(id);
    }

    function test_signatureFromSomeoneElseIsRefused() public {
        bytes32 id = _draft(SALT, 1000 * USDC, ali, 6000, ayse, 4000);
        bytes memory sig = _sign(mehmetKey, c.approvalDigest(id));
        vm.expectRevert(Collective.BadSignature.selector);
        c.approveInvoiceFor(id, ayse, sig);
    }

    function test_signatureIsBoundToItsInvoice() public {
        bytes32 a = _draft(SALT, 1000 * USDC, ali, 6000, ayse, 4000);
        bytes32 b = _draft(keccak256("other"), 1000 * USDC, ali, 6000, ayse, 4000);
        bytes memory sig = _sign(ayseKey, c.approvalDigest(a));
        vm.expectRevert(Collective.BadSignature.selector);
        c.approveInvoiceFor(b, ayse, sig);
    }

    function test_signatureIsBoundToItsChest() public {
        Collective other = Collective(Clones.clone(address(new Collective())));
        address[] memory m = new address[](3);
        m[0] = ali; m[1] = ayse; m[2] = mehmet;
        other.initialize(IERC20(address(usdc)), "Other", m, defaultRules(), agent);
        bytes32 id = _draft(SALT, 1000 * USDC, ali, 6000, ayse, 4000);
        address[] memory who = new address[](2);
        uint16[] memory sh = new uint16[](2);
        who[0] = ali; who[1] = ayse; sh[0] = 6000; sh[1] = 4000;
        vm.prank(ali);
        bytes32 id2 = other.createInvoice(SALT, 1000 * USDC, address(0), 0, who, sh, "");
        bytes memory sig = _sign(ayseKey, c.approvalDigest(id));
        vm.expectRevert(Collective.BadSignature.selector);
        other.approveInvoiceFor(id2, ayse, sig);
    }

    function test_agentWrittenInvoiceNeedsEveryone() public {
        address[] memory who = new address[](2);
        uint16[] memory sh = new uint16[](2);
        who[0] = ali; who[1] = ayse; sh[0] = 5000; sh[1] = 5000;
        vm.prank(agent);
        bytes32 id = c.createInvoice(SALT, 100 * USDC, address(0), 0, who, sh, "");
        (,,,,,, uint8 pending,,) = c.invoice(id);
        assertEq(pending, 2);
    }

    function test_settleWaitsForAgreementToo() public {
        bytes32 id = _draft(SALT, 80 * USDC, ali, 7000, ayse, 3000);
        vm.prank(client);
        usdc.transfer(address(c), 80 * USDC); // paid from Base before the team agreed
        vm.prank(agent);
        vm.expectRevert(Collective.AwaitingApproval.selector);
        c.settleInvoice(id, keccak256("cctp"));
        _agreeAll(id);
        vm.prank(agent);
        c.settleInvoice(id, keccak256("cctp"));
        assertEq(usdc.balanceOf(ali), 50_400_000);
    }

    /// The digest matches an independent EIP-712 implementation, so wallets (viem, MetaMask) sign what the chest checks.
    function test_digestMatchesStandardTypedData() public {
        bytes32 id = _draft(SALT, 1234 * USDC, ali, 6000, ayse, 4000);
        string memory json = string.concat(
            '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},',
            '{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],',
            '"ApproveInvoice":[{"name":"id","type":"bytes32"},{"name":"amount","type":"uint256"},{"name":"payer","type":"address"},',
            '{"name":"dueAt","type":"uint64"},{"name":"reserveBps","type":"uint16"},{"name":"contributors","type":"address[]"},{"name":"sharesBps","type":"uint16[]"}]},',
            '"primaryType":"ApproveInvoice",',
            '"domain":{"name":"Keyarc","version":"4","chainId":', vm.toString(block.chainid), ',"verifyingContract":"', vm.toString(address(c)), '"},',
            '"message":{"id":"', vm.toString(id), '","amount":"1234000000","payer":"0x0000000000000000000000000000000000000000","dueAt":0,"reserveBps":1000,',
            '"contributors":["', vm.toString(ali), '","', vm.toString(ayse), '"],"sharesBps":[6000,4000]}}'
        );
        assertEq(c.approvalDigest(id), vm.eip712HashTypedData(json));
    }
}
