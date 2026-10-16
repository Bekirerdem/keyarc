# Deploy notes

- `forge script script/Deploy.s.sol --rpc-url arc --keystore ~/.orta/keystore/orta-deployer --password-file ~/.orta/pw --broadcast --slow`
- Arc explorer API sits behind a Cloudflare challenge, so `--verify` against `explorer.arc.io/api` fails from CLI. Verify on Sourcify instead (Arc mainnet is chain 5042 there): `forge verify-contract <addr> src/Collective.sol:Collective --chain 5042 --verifier sourcify --rpc-url https://rpc.mainnet.arc.io` (the factory also takes `--constructor-args $(cast abi-encode "constructor(address)" 0x3600000000000000000000000000000000000000)`). Opening the contract page on explorer.arc.io then imports it as verified (exact match).
- Verified live on 2026-10-09: paying an invoice **through Arc's Memo contract** works — CallFrom keeps the paying EOA as `msg.sender`, so `transferFrom(payer)` pulls the approved USDC and the Memo event lands in the same tx (`payViaMemoTx` in `deployments/arc-mainnet.json`).
