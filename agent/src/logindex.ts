import type { Address, Hex } from "viem";
import type { Env } from "./env";

// A chest's whole event history, indexed once and kept in KV, so the app reads it in one request.
// Keyless archive eth_getLogs on Arc is thin: publicnode answers only recent blocks, Arc's own RPC caps a range
// at 10k blocks and rate-limits bursts, thirdweb takes 1k-block ranges in batches of 25. Arc makes ~170k blocks a
// day, so a browser scanning a week-old chest on its own needs over a thousand calls.

const THIRDWEB = "https://5042.rpc.thirdweb.com";
const ARC = "https://rpc.mainnet.arc.io";
const SPAN = 1000n; // thirdweb's keyless range cap
const BATCH = 25; // thirdweb's keyless batch cap
export const WINDOW = SPAN * BigInt(BATCH); // blocks covered by one subrequest
const FETCHES = 40; // per request: Workers Free stops at 50 subrequests
const IN_FLIGHT = 6;
/** ~6h of blocks: an empty tail is rescanned rather than rewritten, so KV sees a write only when it pays. */
const STALE = 40_000n;

/** EIP-1167 clones of the Keyarc implementations (v3, v2, v1). Anything else is refused: the index is not a free scanner. */
const IMPLEMENTATIONS = [
  "95aaa5594942912d4d5011d64f876069f2d37cc9",
  "f14a2b78518e2bc92e085b4249b67a00aabcab24",
  "8af27fa90b013d2ec01404c7bccb882d27514061",
];

export type StoredLog = { blockNumber: string; transactionHash: Hex; logIndex: number; data: Hex; topics: Hex[] };
type Index = { from: string; to: string; logs: StoredLog[] };
type RawLog = { blockNumber: Hex; transactionHash: Hex; logIndex: Hex; data: Hex; topics: Hex[] };
type Call = { method: string; params: unknown[] };
type Budget = { left: number };

export class NotAChest extends Error {}

const hex = (n: bigint) => `0x${n.toString(16)}`;
const key = (c: Address) => `logs:${c.toLowerCase()}`;

export const isKeyarcClone = (code: string) => {
  const c = code.toLowerCase();
  return c.startsWith("0x363d3d373d3d3d363d73") && IMPLEMENTATIONS.some((i) => c.slice(22, 62) === i);
};

/** One JSON-RPC batch; any error in it fails the whole batch, so a window is either complete or not used. */
async function post<T>(url: string, calls: Call[], budget: Budget): Promise<T[]> {
  if (budget.left-- <= 0) throw new Error("out of subrequests");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: "2.0", id, ...c }))),
  });
  const replies = (await res.json()) as { id: number; result?: T; error?: { message?: string } }[];
  if (!Array.isArray(replies)) throw new Error(`${new URL(url).host}: ${res.status}`);
  replies.sort((a, b) => a.id - b.id);
  const bad = replies.find((r) => r.error || r.result === undefined);
  if (bad || replies.length !== calls.length) throw new Error(`${new URL(url).host}: ${bad?.error?.message ?? res.status}`);
  return replies.map((r) => r.result as T);
}

/** [from, to] cut into inclusive ranges of at most `span` blocks. */
export function spans(from: bigint, to: bigint, span: bigint): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let f = from; f <= to; f += span) out.push([f, f + span - 1n < to ? f + span - 1n : to]);
  return out;
}

/**
 * Smallest block in [0, head] where `has` turns true, given it stays true from there on (a chest's code never goes away).
 * Probes `k` blocks per round, so a 26M-block chain takes six batched calls instead of twenty-five sequential ones.
 */
export async function firstBlockWith(has: (blocks: bigint[]) => Promise<boolean[]>, head: bigint, k = BATCH): Promise<bigint> {
  let lo = 0n;
  let hi = head;
  while (lo < hi) {
    const n = hi - lo;
    const pts = n <= BigInt(k)
      ? Array.from({ length: Number(n) }, (_, i) => lo + BigInt(i))
      : Array.from({ length: k }, (_, i) => lo + (n * BigInt(i + 1)) / BigInt(k + 1));
    const got = await has(pts);
    const first = got.indexOf(true);
    if (first === -1) lo = pts[pts.length - 1] + 1n;
    else {
      hi = pts[first];
      if (first > 0) lo = pts[first - 1] + 1n;
    }
  }
  return lo;
}

async function head(budget: Budget): Promise<bigint> {
  const call = [{ method: "eth_blockNumber", params: [] }];
  const [n] = await post<Hex>(ARC, call, budget).catch(() => post<Hex>(THIRDWEB, call, budget));
  return BigInt(n);
}

async function codeAt(chest: Address, blocks: (bigint | "latest")[], budget: Budget): Promise<string[]> {
  const calls = blocks.map((b) => ({ method: "eth_getCode", params: [chest, b === "latest" ? b : hex(b)] }));
  return post<string>(THIRDWEB, calls, budget).catch(() => post<string>(ARC, calls, budget));
}

/** Logs in one window of at most WINDOW blocks: thirdweb in one batch, or Arc's own RPC in 10k ranges. */
async function logsIn(chest: Address, from: bigint, to: bigint, budget: Budget): Promise<StoredLog[]> {
  const ask = (s: [bigint, bigint][]) => s.map(([f, t]) => ({ method: "eth_getLogs", params: [{ address: chest, fromBlock: hex(f), toBlock: hex(t) }] }));
  let pages: RawLog[][];
  try {
    pages = await post<RawLog[]>(THIRDWEB, ask(spans(from, to, SPAN)), budget);
  } catch {
    pages = [];
    for (const s of spans(from, to, 10_000n)) pages.push(...(await post<RawLog[]>(ARC, ask([s]), budget)));
  }
  return pages.flat().map((l) => ({
    blockNumber: BigInt(l.blockNumber).toString(),
    transactionHash: l.transactionHash,
    logIndex: Number(l.logIndex),
    data: l.data,
    topics: l.topics,
  }));
}

/**
 * The chest's logs from its creation block, oldest first. Each request extends the index by up to ~1M blocks;
 * `done` is false while it is still catching up, and the caller asks again.
 */
export async function chestLogs(env: Env, chest: Address): Promise<{ from: string; to: string; done: boolean; logs: StoredLog[] }> {
  const stored = await env.AGENT_KV.get<Index>(key(chest), "json");
  const budget: Budget = { left: FETCHES };
  const tip = await head(budget);

  let index: Index;
  if (stored) index = stored;
  else {
    const [code] = await codeAt(chest, ["latest"], budget);
    if (!isKeyarcClone(code)) throw new NotAChest("not a Keyarc chest");
    const born = await firstBlockWith(async (bs) => (await codeAt(chest, bs, budget)).map((c) => c !== "0x"), tip);
    index = { from: born.toString(), to: (born - 1n).toString(), logs: [] };
  }

  // windows in block order, a few in flight; stop at the first failure so the index never has a gap
  let next = BigInt(index.to) + 1n;
  const fresh: StoredLog[] = [];
  scan: while (next <= tip && budget.left > 0) {
    const group = spans(next, tip, WINDOW).slice(0, Math.min(IN_FLIGHT, budget.left));
    const results = await Promise.allSettled(group.map(([f, t]) => logsIn(chest, f, t, budget)));
    for (let i = 0; i < group.length; i++) {
      const r = results[i];
      if (r.status === "rejected") break scan;
      fresh.push(...r.value);
      next = group[i][1] + 1n;
    }
  }

  const to = next - 1n;
  const updated: Index = { from: index.from, to: to.toString(), logs: [...index.logs, ...fresh] };
  if (!stored || fresh.length > 0 || to - BigInt(stored.to) > STALE) {
    try {
      await env.AGENT_KV.put(key(chest), JSON.stringify(updated));
    } catch {
      /* KV takes one write per key per second; a concurrent request already wrote the same blocks */
    }
  }
  return { from: updated.from, to: updated.to, done: to >= tip, logs: updated.logs };
}
