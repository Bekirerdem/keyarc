// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CollectiveBase} from "./CollectiveBase.t.sol";
import {Collective} from "../src/Collective.sol";
import {Rules} from "../src/CollectiveTypes.sol";

/// @notice Regression tests for the pre-deploy security review (I1-I5).
contract HardeningTest is CollectiveBase {
    // ── I1: proposals snapshot their quorum, expire, die when membership/rules change ──

    function test_I1_proposalExpires() public {
        vm.prank(ali);
        uint256 id = c.propose(Collective.Kind.SetAgent, abi.encode(address(0)), bytes32(0));
        vm.prank(ayse);
        c.vote(id);
        vm.warp(block.timestamp + 1 days + 7 days + 1);
        vm.prank(ali);
        vm.expectRevert(Collective.ProposalExpired.selector);
        c.execute(id);
    }

    function test_I1_removedMembersVoteCannotCarryOldProposal() public {
        vm.prank(ali);
        uint256 stale = c.propose(Collective.Kind.SetAgent, abi.encode(ali), bytes32(0));
        vm.prank(mehmet);
        c.vote(stale);
        // remove mehmet through a separate proposal (bumps the governance epoch)
        vm.prank(ali);
        uint256 rm = c.propose(Collective.Kind.RemoveMember, abi.encode(mehmet), bytes32(0));
        vm.prank(ayse);
        c.vote(rm);
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        c.execute(rm);
        vm.prank(ali);
        vm.expectRevert(Collective.ProposalStale.selector);
        c.execute(stale);
    }

    function test_I1_rulesChangeDoesNotLowerPendingQuorum() public {
        vm.prank(ali);
        uint256 pending = c.propose(Collective.Kind.SetAgent, abi.encode(ali), bytes32(0));
        // pending has 1 of 3 votes; a rules change must not make it executable
        Rules memory r = defaultRules();
        r.quorumBps = 5001;
        vm.prank(ali);
        uint256 rid = c.propose(Collective.Kind.SetRules, abi.encode(r), bytes32(0));
        vm.prank(ayse);
        c.vote(rid);
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        c.execute(rid);
        vm.prank(ali);
        vm.expectRevert(Collective.ProposalStale.selector);
        c.execute(pending);
    }

    function test_I1_proposerCanCancel_voterCanUnvote() public {
        vm.prank(ali);
        uint256 id = c.propose(Collective.Kind.SetAgent, abi.encode(address(0)), bytes32(0));
        vm.prank(ayse);
        c.vote(id);
        vm.prank(ayse);
        c.unvote(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        vm.expectRevert(Collective.NoQuorum.selector);
        c.execute(id);
        vm.prank(ayse);
        vm.expectRevert(Collective.NotProposer.selector);
        c.cancel(id);
        vm.prank(ali);
        c.cancel(id);
        vm.prank(ayse);
        vm.expectRevert(Collective.ProposalCancelled.selector);
        c.vote(id);
    }

    // ── I2: no rules that let one person act alone ──

    function test_I2_quorumMustExceedHalf() public {
        Rules memory r = defaultRules();
        r.quorumBps = 5000;
        _expectBadRules(r);
    }

    function test_I2_timelockHasFloor() public {
        Rules memory r = defaultRules();
        r.timelock = 59 minutes;
        _expectBadRules(r);
    }

    function test_I2_twoMemberTeamNeedsBothVotes() public {
        Collective two = Collective(Clones.clone(address(new Collective())));
        address[] memory m = new address[](2);
        m[0] = ali; m[1] = ayse;
        two.initialize(IERC20(address(usdc)), "Two", m, defaultRules(), agent);
        vm.prank(ali);
        uint256 id = two.propose(Collective.Kind.SetAgent, abi.encode(ali), bytes32(0));
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        vm.expectRevert(Collective.NoQuorum.selector);
        two.execute(id);
    }

    function _expectBadRules(Rules memory r) internal {
        Collective fresh = Collective(Clones.clone(address(new Collective())));
        address[] memory m = new address[](1);
        m[0] = ali;
        vm.expectRevert(Collective.BadRules.selector);
        fresh.initialize(IERC20(address(usdc)), "x", m, r, agent);
    }

    // ── I3: agent attribution cap is per period, not per call ──

    function test_I3_attributionCapIsPerPeriod() public {
        vm.prank(client);
        usdc.transfer(address(c), 300 * USDC);
        vm.startPrank(agent);
        c.attribute(mehmet, 60 * USDC, keccak256("inflow-5"));
        vm.expectRevert(Collective.AboveCap.selector);
        c.attribute(mehmet, 60 * USDC, keccak256("inflow-6")); // 120 > 100 cap this period
        vm.stopPrank();
        vm.warp(block.timestamp + 30 days);
        vm.prank(agent);
        c.attribute(mehmet, 60 * USDC, keccak256("inflow-7")); // new window, cap reset
    }

    // ── I4: invoice ids are bound to their creator; payment is bound to the amount ──

    function test_I4_sameSaltDifferentCreatorsDifferentIds() public {
        bytes32 salt = keccak256("site-v2");
        bytes32 a = _invoiceFrom(ali, salt, 10 * USDC);
        bytes32 b = _invoiceFrom(ayse, salt, 999 * USDC);
        assertTrue(a != b);
        assertEq(a, c.invoiceId(ali, salt));
    }

    function test_I4_payRequiresExpectedAmount() public {
        bytes32 id = _invoiceFrom(ali, keccak256("x"), 10 * USDC);
        vm.prank(client);
        vm.expectRevert(Collective.AmountMismatch.selector);
        c.payInvoice(id, 9 * USDC);
    }

    function _invoiceFrom(address creator, bytes32 salt, uint256 amount) internal returns (bytes32 id) {
        address[] memory who = new address[](1);
        uint16[] memory sh = new uint16[](1);
        who[0] = creator; sh[0] = 10_000;
        vm.prank(creator);
        id = c.createInvoice(salt, amount, address(0), 0, who, sh, "");
    }

    // ── I5: released reserve goes only to the recipients named in the vote ──

    function test_I5_releasedReserveGoesToNamedRecipients() public {
        _pay(_invoice(keccak256("a"), 5000 * USDC, ali, 5000, ayse, 5000)); // reserve fills to 500

        address[] memory to = new address[](3);
        uint256[] memory amt = new uint256[](3);
        to[0] = ali; to[1] = ayse; to[2] = mehmet;
        amt[0] = 200 * USDC; amt[1] = 200 * USDC; amt[2] = 100 * USDC;
        vm.prank(ali);
        uint256 id = c.propose(Collective.Kind.ReleaseReserve, abi.encode(to, amt), bytes32(0));
        vm.prank(ayse);
        c.vote(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        c.execute(id);

        assertEq(c.reserve(), 0);
        assertEq(usdc.balanceOf(mehmet), 100 * USDC);
        assertEq(usdc.balanceOf(ayse), 2450 * USDC); // 2250 from the invoice + 200 released
        assertEq(usdc.balanceOf(address(c)), _accounted());
    }

    function test_I5_releaseCannotExceedReserve() public {
        address[] memory to = new address[](1);
        uint256[] memory amt = new uint256[](1);
        to[0] = ali; amt[0] = 1;
        vm.prank(ali);
        uint256 id = c.propose(Collective.Kind.ReleaseReserve, abi.encode(to, amt), bytes32(0));
        vm.prank(ayse);
        c.vote(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        vm.expectRevert(Collective.InsufficientReserve.selector);
        c.execute(id);
    }
}
