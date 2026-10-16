// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Collective} from "../src/Collective.sol";
import {Rules} from "../src/CollectiveTypes.sol";
import {BlocklistUSDC} from "./mocks/BlocklistUSDC.sol";

contract Handler is Test {
    Collective public c;
    BlocklistUSDC public usdc;
    address[3] public m;
    address public agent;
    address public client = address(0xC1);
    address public payee = address(0xB1);
    uint256 public n;
    /// every USDC a member was paid or is owed, against every USDC paid in minus what the reserve kept
    uint256 public paidIn;
    uint256 public spent;

    constructor(Collective c_, BlocklistUSDC usdc_, address[3] memory m_, address agent_) {
        c = c_; usdc = usdc_; m = m_; agent = agent_;
        usdc.mint(client, type(uint128).max);
        vm.prank(client);
        usdc.approve(address(c), type(uint256).max);
    }

    function payInvoice(uint96 amount, uint16 shareA) public {
        amount = uint96(bound(amount, 1, 1e15));
        shareA = uint16(bound(shareA, 1, 9_999));
        address[] memory who = new address[](2);
        uint16[] memory sh = new uint16[](2);
        who[0] = m[0]; who[1] = m[1]; sh[0] = shareA; sh[1] = 10_000 - shareA;
        vm.prank(m[0]);
        bytes32 id = c.createInvoice(keccak256(abi.encode(n++)), amount, address(0), 0, who, sh, "");
        vm.prank(m[1]);
        c.approveInvoice(id);
        vm.prank(client);
        c.payInvoice(id, amount);
        paidIn += amount;
    }

    function sendUnattributed(uint96 amount) public {
        amount = uint96(bound(amount, 1, 1e15));
        vm.prank(client);
        usdc.transfer(address(c), amount);
    }

    function attribute(uint96 amount) public {
        uint256 u = c.unattributed();
        (uint256 room,) = c.agentRoom();
        if (u == 0 || room == 0) return;
        uint256 a = bound(amount, 1, u < room ? u : room);
        vm.prank(agent);
        c.attribute(m[2], a, keccak256(abi.encode("inflow", n++)));
        paidIn += a;
    }

    function payBill(uint96 amount) public {
        (, uint256 room) = c.agentRoom();
        uint256 r = c.reserve();
        if (room == 0 || r == 0) return;
        uint256 a = bound(amount, 1, r < room ? r : room);
        vm.prank(agent);
        c.payExpense(payee, a, keccak256(abi.encode("bill", n++)));
        spent += a;
    }

    function claim() public {
        if (c.owed(m[1]) == 0 || usdc.blocked(m[1])) return;
        vm.prank(m[1]);
        c.claim(m[1]);
    }

    function toggleBlock(bool blocked) public {
        usdc.setBlocked(m[1], blocked);
    }

    function wait() public {
        vm.warp(block.timestamp + 31 days);
    }
}

contract InvariantTest is Test {
    Collective c;
    BlocklistUSDC usdc;
    Handler h;
    address[3] m = [address(0xA1), address(0xA2), address(0xA3)];

    function setUp() public {
        usdc = new BlocklistUSDC();
        c = Collective(Clones.clone(address(new Collective())));
        address[] memory list = new address[](3);
        list[0] = m[0]; list[1] = m[1]; list[2] = m[2];
        Rules memory r = Rules(1000, 5e12, 1e12, 1e11, 5001, 1 days, 30 days);
        c.initialize(IERC20(address(usdc)), "Fuzz", list, r, address(0xA9));
        h = new Handler(c, usdc, m, address(0xA9));
        // the allowlist is set by vote; done here directly through the chest's own governance
        address payee = h.payee();
        vm.prank(m[0]);
        uint256 id = c.propose(Collective.Kind.SetPayee, abi.encode(payee, true), bytes32(0));
        vm.prank(m[1]);
        c.vote(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(m[0]);
        c.execute(id);
        targetContract(address(h));
    }

    function invariant_everyUsdcIsAccountedFor() public view {
        assertEq(usdc.balanceOf(address(c)), c.reserve() + c.totalOwed() + c.unattributed());
        assertGe(usdc.balanceOf(address(c)), c.reserve() + c.totalOwed());
    }

    /// Nothing that was paid in stays behind except the reserve the team chose: members got (or are owed) the rest.
    function invariant_onlyTheReserveStaysBehind() public view {
        uint256 toMembers = usdc.balanceOf(m[0]) + usdc.balanceOf(m[1]) + usdc.balanceOf(m[2]) + c.totalOwed();
        assertEq(toMembers + c.reserve() + h.spent(), h.paidIn());
    }
}
