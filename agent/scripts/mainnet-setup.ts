/**
 * Opens the demo team on the current factory and runs the end-to-end proof on Arc mainnet, then writes every address
 * and hash to deployments/arc-mainnet.json. Run it after `forge script script/Deploy.s.sol` printed the factory:
 *
 *   DEPLOYER_KEY=0x… bun scripts/mainnet-setup.ts <factory> <implementation>
 *
 * The proof: a two-person invoice where the second person agrees by signature (the deployer carries it, as the agent
 * would), paid through Arc's Memo contract, split on payment. Each step is recorded in ~/.orta/v4-state.json, so a
 * rerun continues where it stopped instead of paying twice.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, isAddress, keccak256, parseEventLogs, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { collectiveAbi, erc20Abi, factoryAbi, memoAbi } from "../../web/src/lib/abi";
import { arc, USDC } from "../src/chain";

const MEMO: Address = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";
const BEKIR: Address = "0x39AEfbC8388da12907A21d9De888B288a9fa5794";
const AGENT: Address = "0xBB682c02E3429d808499c1Ec5414b34113A21017";
// RPC, STATE and OUT can point a dry run at a local fork without touching the real record
const RPC = process.env.RPC ?? "https://rpc.mainnet.arc.io";
const DEPLOYMENTS = process.env.OUT ?? join(import.meta.dir, "../../deployments/arc-mainnet.json");
const STATE = process.env.STATE ?? join(homedir(), ".orta", "v4-state.json");
const MEMBER_KEY = process.env.MEMBER_KEY ?? join(homedir(), ".orta", "proof-member.key");
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const [factoryArg, implArg] = process.argv.slice(2);
if (!isAddress(factoryArg ?? "") || !isAddress(implArg ?? "")) throw new Error("usage: bun scripts/mainnet-setup.ts <factory> <implementation>");
const factory = getAddress(factoryArg);
const implementation = getAddress(implArg);
const key = process.env.DEPLOYER_KEY as Hex | undefined;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("DEPLOYER_KEY missing");

const deployer = privateKeyToAccount(key);
const transport = http(RPC, { retryCount: 4, retryDelay: 800 });
const wallet = createWalletClient({ account: deployer, chain: arc, transport });
const publicClient = createPublicClient({ chain: arc, transport });
type State = Record<string, string>;
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

if (!existsSync(MEMBER_KEY)) writeFileSync(MEMBER_KEY, generatePrivateKey());
const member = privateKeyToAccount(readFileSync(MEMBER_KEY, "utf8").trim() as Hex);

async function step(name: string, run: () => Promise<Hex>): Promise<Hex> {
  if (state[name]) return state[name] as Hex;
  const hash = await run();
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${name} reverted: ${hash}`);
  state[name] = hash;
  save();
  console.log(`${name}: ${hash}`);
  return hash;
}

async function logsOf(hash: Hex) {
  return (await publicClient.getTransactionReceipt({ hash })).logs;
}

type Rules = { reserveBps: number; reserveTarget: bigint; autoAttributeCap: bigint; expenseCapPerPeriod: bigint; quorumBps: number; timelock: number; periodLength: number };

async function openTeam(name: string, label: string, members: Address[], rules: Rules, agent: Address): Promise<Address> {
  const tx = await step(`${label}CreateTx`, () => wallet.writeContract({ address: factory, abi: factoryAbi, functionName: "create", args: [name, members, rules, agent] }));
  const [created] = parseEventLogs({ abi: factoryAbi, logs: await logsOf(tx), eventName: "CollectiveCreated" });
  return created.args.collective;
}

async function writeInvoice(label: string, chest: Address, amount: bigint, dueAt: bigint, who: Address[], shares: number[], note: string): Promise<Hex> {
  const salt = (state[`${label}Salt`] as Hex | undefined) ?? keccak256(toHex(`${label}-${Date.now()}`));
  state[`${label}Salt`] = salt;
  save();
  const tx = await step(`${label}InvoiceTx`, () => wallet.writeContract({ address: chest, abi: collectiveAbi, functionName: "createInvoice", args: [salt, amount, ZERO, dueAt, who, shares, note] }));
  const [inv] = parseEventLogs({ abi: collectiveAbi, logs: await logsOf(tx), eventName: "InvoiceCreated" });
  return inv.args.id;
}

const usdc = (n: number) => BigInt(Math.round(n * 1e6));
const DAY = 86_400;
const now = BigInt(Math.floor(Date.now() / 1000));

// ── the demo team: Bekir + the deployer, the hosted agent attached, 5% to shared tools ──
const demo = await openTeam("Keyarc Studio", "demo", [BEKIR, deployer.address], {
  reserveBps: 500, reserveTarget: usdc(5), autoAttributeCap: usdc(5), expenseCapPerPeriod: usdc(2), quorumBps: 6000, timelock: 3600, periodLength: 30 * DAY,
}, AGENT);
// a demo invoice Bekir still has to agree to; due in two hours, so the agent's overdue reminder shows up the same day
const demoInvoice = await writeInvoice("demo", demo, usdc(1), now + 2n * 3600n, [deployer.address, BEKIR], [6000, 4000], "Store upkeep + SEO, October (demo invoice)");

// ── the proof team: the deployer + a second wallet that agrees by signature ──
const proof = await openTeam("Keyarc proof · v4", "proof", [deployer.address, member.address], {
  reserveBps: 1000, reserveTarget: usdc(5), autoAttributeCap: usdc(1), expenseCapPerPeriod: usdc(1), quorumBps: 6000, timelock: 3600, periodLength: 30 * DAY,
}, ZERO);
const proofInvoice = await writeInvoice("proof", proof, usdc(0.1), 0n, [deployer.address, member.address], [7000, 3000], "End-to-end proof: agreed by signature, paid through Arc Memo, split on payment");

const [amount, , payer, , dueAt, reserveBps, , contributors, sharesBps] = await publicClient.readContract({ address: proof, abi: collectiveAbi, functionName: "invoice", args: [proofInvoice] });
const signature = await member.signTypedData({
  domain: { name: "Keyarc", version: "4", chainId: arc.id, verifyingContract: proof },
  types: {
    ApproveInvoice: [
      { name: "id", type: "bytes32" }, { name: "amount", type: "uint256" }, { name: "payer", type: "address" }, { name: "dueAt", type: "uint64" },
      { name: "reserveBps", type: "uint16" }, { name: "contributors", type: "address[]" }, { name: "sharesBps", type: "uint16[]" },
    ],
  },
  primaryType: "ApproveInvoice",
  message: { id: proofInvoice, amount, payer, dueAt, reserveBps, contributors: [...contributors], sharesBps: [...sharesBps] },
});
const agreeTx = await step("proofAgreeTx", () => wallet.writeContract({ address: proof, abi: collectiveAbi, functionName: "approveInvoiceFor", args: [proofInvoice, member.address, signature] }));
const allowTx = await step("proofAllowTx", () => wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [proof, amount] }));
const payTx = await step("proofPayTx", () => wallet.writeContract({
  address: MEMO, abi: memoAbi, functionName: "memo",
  args: [proof, encodeFunctionData({ abi: collectiveAbi, functionName: "payInvoice", args: [proofInvoice, amount] }), proofInvoice, "0x"],
}));
const paid = parseEventLogs({ abi: collectiveAbi, logs: await logsOf(payTx), eventName: "Paid" }).map((e) => `${e.args.member}: ${Number(e.args.amount) / 1e6} USDC`);
console.log("paid out in the payment tx:", paid.join(", "));

// ── record it ──
const d = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
d.factory = factory;
d.implementation = implementation;
d.deployedAt = new Date().toISOString().slice(0, 10);
d.version = "v4";
d.demo = { collective: demo, name: "Keyarc Studio", members: [BEKIR, deployer.address], agent: AGENT, createTx: state.demoCreateTx, invoiceId: demoInvoice, createInvoiceTx: state.demoInvoiceTx };
d.proof = {
  collective: proof, members: [deployer.address, member.address], createTx: state.proofCreateTx, invoiceId: proofInvoice,
  createInvoiceTx: state.proofInvoiceTx, agreeBySignatureTx: agreeTx, approveTx: allowTx, payViaMemoTx: payTx, paidOut: paid,
};
writeFileSync(DEPLOYMENTS, `${JSON.stringify(d, null, 2)}\n`);
console.log(`demo chest ${demo}\nproof chest ${proof}\ndeployments/arc-mainnet.json updated`);
