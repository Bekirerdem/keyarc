// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CollectiveBase} from "./CollectiveBase.t.sol";
import {Collective} from "../src/Collective.sol";
import {Rules} from "../src/CollectiveTypes.sol";

contract GovernanceTest is CollectiveBase {
    function _pass(Collective.Kind kind, bytes memory payload) internal {
        vm.prank(ali);
        uint256 id = c.propose(kind, payload, bytes32(0));
        vm.prank(ayse);
        c.vote(id);
        if (c.isMember(mehmet)) {
            vm.prank(mehmet);
            c.vote(id);
        }
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        c.execute(id);
    }

    function test_quorumGrowsWithMembers() public {
        _pass(Collective.Kind.AddMember, abi.encode(makeAddr("zeynep")));
        vm.prank(ali);
        uint256 id = c.propose(Collective.Kind.SetAgent, abi.encode(address(0)), bytes32(0));
        vm.prank(ayse);
        c.vote(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        vm.expectRevert(Collective.NoQuorum.selector);
        c.execute(id); // 2 of 4 is not a majority
    }

    function test_singleVoteIsNotQuorum() public {
        vm.prank(ali);
        uint256 id = c.propose(Collective.Kind.SetAgent, abi.encode(address(0)), bytes32(0));
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        vm.expectRevert(Collective.NoQuorum.selector);
        c.execute(id);
    }

    function test_timelockEnforced() public {
        vm.prank(ali);
        uint256 id = c.propose(Collective.Kind.SetAgent, abi.encode(address(0)), bytes32(0));
        vm.prank(ayse);
        c.vote(id);
        vm.prank(ali);
        vm.expectRevert(Collective.TimelockActive.selector);
        c.execute(id);
    }

    function test_doubleVoteReverts() public {
        vm.prank(ali);
        uint256 id = c.propose(Collective.Kind.SetAgent, abi.encode(address(0)), bytes32(0));
        vm.prank(ali);
        vm.expectRevert(Collective.AlreadyVoted.selector);
        c.vote(id);
    }

    function test_cannotExecuteTwice() public {
        vm.prank(ali);
        uint256 id = c.propose(Collective.Kind.SetAgent, abi.encode(address(0)), bytes32(0));
        vm.prank(ayse);
        c.vote(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        c.execute(id);
        vm.prank(ali);
        vm.expectRevert(Collective.AlreadyExecuted.selector);
        c.execute(id);
    }

    function test_changeRules() public {
        Rules memory r = defaultRules();
        r.reserveBps = 2000;
        _pass(Collective.Kind.SetRules, abi.encode(r));
        assertEq(c.rules().reserveBps, 2000);
    }

    function test_invalidRulesRejected() public {
        Rules memory r = defaultRules();
        r.periodLength = 0;
        vm.prank(ali);
        uint256 id = c.propose(Collective.Kind.SetRules, abi.encode(r), bytes32(0));
        vm.prank(ayse);
        c.vote(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(ali);
        vm.expectRevert(Collective.BadRules.selector);
        c.execute(id);
    }

    function test_addAndRemoveMember() public {
        address zeynep = makeAddr("zeynep");
        _pass(Collective.Kind.AddMember, abi.encode(zeynep));
        assertTrue(c.isMember(zeynep));
        assertEq(c.members().length, 4);
        _pass(Collective.Kind.RemoveMember, abi.encode(zeynep));
        assertFalse(c.isMember(zeynep));
        assertEq(c.members().length, 3);
    }

    function test_removedMemberStillPaidForWorkTheyAgreedTo() public {
        bytes32 id = _invoice(keccak256("job"), 1000 * USDC, mehmet, 5000, ali, 5000);
        _pass(Collective.Kind.RemoveMember, abi.encode(mehmet));
        _pay(id);
        assertEq(usdc.balanceOf(mehmet), 450 * USDC); // half of 900
    }

    function test_releaseReserveOnlyByVote() public {
        _pay(_invoice(keccak256("job"), 1000 * USDC, ali, 5000, ayse, 5000));
        address[] memory to = new address[](1);
        uint256[] memory amt = new uint256[](1);
        to[0] = ayse; amt[0] = 100 * USDC;
        _pass(Collective.Kind.ReleaseReserve, abi.encode(to, amt));
        assertEq(c.reserve(), 0);
        assertEq(usdc.balanceOf(ayse), 550 * USDC); // 450 share + 100 released
    }

    function test_strangerCannotPropose() public {
        vm.prank(client);
        vm.expectRevert(Collective.NotMemberOrAgent.selector);
        c.propose(Collective.Kind.SetAgent, abi.encode(client), bytes32(0));
    }
}
