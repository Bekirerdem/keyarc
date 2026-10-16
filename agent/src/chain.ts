import { createPublicClient, createWalletClient, defineChain, fallback, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { collectiveAbi, erc20Abi } from "../../web/src/lib/abi";
import type { Env } from "./env";

export { collectiveAbi, erc20Abi };

export const USDC: Address = "0x3600000000000000000000000000000000000000";

export const arc = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://arc-rpc.publicnode.com"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

// Same provider order as the web relay: Arc's own RPC rate-limits eth_call hard.
const opts = { retryCount: 3, retryDelay: 400 } as const;
const transport = fallback([
  http("https://arc-rpc.publicnode.com", opts),
  http("https://5042.rpc.thirdweb.com", opts),
  http("https://arc.drpc.org", opts),
  http("https://rpc.mainnet.arc.io", opts),
]);

export const publicClient = createPublicClient({ chain: arc, transport });

export function agentWallet(env: Env) {
  const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY);
  return { account, wallet: createWalletClient({ account, chain: arc, transport }) };
}

export type ChestState = {
  address: Address;
  name: string;
  agent: Address;
  members: readonly Address[];
  /** Set aside for shared costs; the agent pays allowlisted bills from it. */
  reserve: bigint;
  unattributed: bigint;
  /** What the agent may still attribute or spend in the current window without a vote. */
  attributeLeft: bigint;
  expenseLeft: bigint;
  rules: {
    reserveBps: number;
    reserveTarget: bigint;
    autoAttributeCap: bigint;
    expenseCapPerPeriod: bigint;
    quorumBps: number;
    timelock: number;
    periodLength: number;
  };
};

export async function readChest(address: Address): Promise<ChestState> {
  const c = { address, abi: collectiveAbi } as const;
  const [name, agent, members, reserve, unattributed, room, rules] =
    await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...c, functionName: "name" },
        { ...c, functionName: "agent" },
        { ...c, functionName: "members" },
        { ...c, functionName: "reserve" },
        { ...c, functionName: "unattributed" },
        { ...c, functionName: "agentRoom" },
        { ...c, functionName: "rules" },
      ],
    });
  return {
    address, name, agent, members, reserve, unattributed,
    attributeLeft: room[0],
    expenseLeft: room[1],
    rules: { ...rules },
  };
}

export const isHex32 = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

export type OnChainInvoice = {
  amount: bigint;
  creator: Address;
  payer: Address;
  /** 0 none · 1 open · 2 paid · 3 cancelled */
  status: number;
  dueAt: bigint;
  reserveBps: number;
  /** contributors who haven't agreed to their share yet */
  pending: number;
  contributors: readonly Address[];
  sharesBps: readonly number[];
};

/** The invoice view by name: its fields are mostly numbers, so positional reads are easy to get wrong silently. */
export async function readInvoice(chest: Address, id: Hex): Promise<OnChainInvoice> {
  const [amount, creator, payer, status, dueAt, reserveBps, pending, contributors, sharesBps] =
    await publicClient.readContract({ address: chest, abi: collectiveAbi, functionName: "invoice", args: [id] });
  return { amount, creator, payer, status, dueAt, reserveBps, pending, contributors, sharesBps };
}
