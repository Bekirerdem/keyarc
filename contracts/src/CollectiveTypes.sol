// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Rules a collective runs by. Changed only through an executed proposal.
struct Rules {
    uint16 reserveBps;           // share of every payment set aside for shared costs while reserve < reserveTarget (0 = none)
    uint256 reserveTarget;       // USDC (6 dec) the shared-costs reserve fills up to
    uint256 autoAttributeCap;    // max USDC the agent may attribute per period without a vote
    uint256 expenseCapPerPeriod; // max USDC the agent may spend per period without a vote
    uint16 quorumBps;            // share of members whose votes execute a proposal
    uint32 timelock;             // seconds between proposal creation and execution
    uint32 periodLength;         // seconds per window of the agent's limits
}
