// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Collective} from "../src/Collective.sol";
import {Rules} from "../src/CollectiveTypes.sol";
import {BlocklistUSDC} from "./mocks/BlocklistUSDC.sol";

abstract contract CollectiveBase is Test {
    BlocklistUSDC usdc;
    Collective c;
    address ali;
    uint256 aliKey;
    address ayse;
    uint256 ayseKey;
    address mehmet;
    uint256 mehmetKey;
    address agent = makeAddr("agent");
    address client = makeAddr("client");
    uint256 constant USDC = 1e6;

    function defaultRules() internal pure returns (Rules memory) {
        return Rules({
            reserveBps: 1000,           // 10% to shared costs
            reserveTarget: 500 * USDC,
            autoAttributeCap: 100 * USDC,
            expenseCapPerPeriod: 200 * USDC,
            quorumBps: 5001,            // majority
            timelock: 1 days,
            periodLength: 30 days
        });
    }

    function setUp() public virtual {
        (ali, aliKey) = makeAddrAndKey("ali");
        (ayse, ayseKey) = makeAddrAndKey("ayse");
        (mehmet, mehmetKey) = makeAddrAndKey("mehmet");
        usdc = new BlocklistUSDC();
        c = Collective(Clones.clone(address(new Collective())));
        address[] memory m = new address[](3);
        m[0] = ali; m[1] = ayse; m[2] = mehmet;
        c.initialize(IERC20(address(usdc)), "Test Guild", m, defaultRules(), agent);
        usdc.mint(client, 100_000 * USDC);
        vm.prank(client);
        usdc.approve(address(c), type(uint256).max);
    }

    /// @dev ali writes a two-person invoice; nobody else has agreed yet.
    function _draft(bytes32 salt, uint256 amount, address a, uint16 sa, address b, uint16 sb) internal returns (bytes32 id) {
        address[] memory who = new address[](2);
        uint16[] memory sh = new uint16[](2);
        who[0] = a; who[1] = b; sh[0] = sa; sh[1] = sb;
        vm.prank(ali);
        id = c.createInvoice(salt, amount, address(0), 0, who, sh, "");
    }

    /// @dev ali writes a two-person invoice and everyone on it agrees, so it can be paid.
    function _invoice(bytes32 salt, uint256 amount, address a, uint16 sa, address b, uint16 sb) internal returns (bytes32 id) {
        id = _draft(salt, amount, a, sa, b, sb);
        _agreeAll(id);
    }

    /// @dev ali writes a one-person invoice.
    function _solo(bytes32 salt, uint256 amount, address who_) internal returns (bytes32 id) {
        address[] memory who = new address[](1);
        uint16[] memory sh = new uint16[](1);
        who[0] = who_; sh[0] = 10_000;
        vm.prank(ali);
        id = c.createInvoice(salt, amount, address(0), 0, who, sh, "");
        _agreeAll(id);
    }

    function _agreeAll(bytes32 id) internal {
        (,,,,,,, address[] memory who,) = c.invoice(id);
        for (uint256 i; i < who.length; ++i) {
            if (!c.approved(id, who[i])) {
                vm.prank(who[i]);
                c.approveInvoice(id);
            }
        }
    }

    /// @dev client pays an invoice at its stated amount.
    function _pay(bytes32 id) internal {
        (uint256 amount,,,,,,,,) = c.invoice(id);
        vm.prank(client);
        c.payInvoice(id, amount);
    }

    function _accounted() internal view returns (uint256) {
        return c.reserve() + c.totalOwed() + c.unattributed();
    }
}
