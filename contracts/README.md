# Keyarc contracts

Solidity 0.8.28 · Foundry · OpenZeppelin v5. Deployed addresses are in [`../deployments/arc-mainnet.json`](../deployments/arc-mainnet.json).

- `src/Collective.sol`: one team's chest. Invoices whose shares everyone on them agrees to (on chain or by EIP-712 signature), payout in the payment transaction, an optional shared-costs reserve, member votes with a timelock, and the bounds the treasury agent works inside.
- `src/CollectiveFactory.sol`: opens a team as an EIP-1167 clone in one transaction.
- `test/`: 12 suites, 93 tests, including an invariant suite (every USDC is accounted for; only the shared-costs share stays behind), agreement and signature tests, and the hardening tests from the internal reviews.

```bash
forge test
forge script script/Deploy.s.sol --rpc-url arc --keystore <keystore> --broadcast --slow   # see script/README.md
```
