import { parseEventLogs, type Address, type Log } from "viem";
import { publicClient } from "./arc";
import { collectiveAbi } from "./abi";
import { AGENT_URL } from "./agent";

// Providers cap eth_getLogs ranges differently (Arc ~5k, thirdweb 1k, dRPC free tier lower still), so stay
// under the smallest cap; the local cache means only new blocks are scanned on later visits.
const CHUNK = 900n;
const PARALLEL = 8;

type Cached = { from: string; to: string; logs: SerializedLog[] };
type SerializedLog = { blockNumber: string; transactionHash: string; logIndex: number; data: `0x${string}`; topics: `0x${string}`[] };

const key = (a: Address) => `keyarc:logs:v1:${a.toLowerCase()}`;

function load(a: Address): Cached | null {
  try {
    const raw = localStorage.getItem(key(a));
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null;
  }
}

function save(a: Address, c: Cached) {
  try {
    localStorage.setItem(key(a), JSON.stringify(c));
  } catch {
    /* storage full or blocked: the page still works, it just rescans next time */
  }
}

/** First block where `a` has code (binary search on eth_getCode). */
export async function creationBlock(a: Address): Promise<bigint> {
  const cachedKey = `keyarc:born:${a.toLowerCase()}`;
  try {
    const hit = localStorage.getItem(cachedKey);
    if (hit) return BigInt(hit);
  } catch { /* ignore */ }
  let lo = 0n;
  let hi = await publicClient.getBlockNumber();
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const code = await publicClient.getCode({ address: a, blockNumber: mid });
    if (code && code !== "0x") hi = mid;
    else lo = mid + 1n;
  }
  try { localStorage.setItem(cachedKey, lo.toString()); } catch { /* ignore */ }
  return lo;
}

/** The agent keeps every chest's history indexed; on a chest it hasn't seen in a while, a few calls catch it up. */
async function fromIndex(a: Address): Promise<SerializedLog[]> {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${AGENT_URL}/logs?chest=${a}`);
    if (!r.ok) throw new Error(`log index answered ${r.status}`);
    const body = (await r.json()) as { done: boolean; logs: SerializedLog[] };
    if (body.done) return body.logs;
  }
  throw new Error("log index is still catching up");
}

/** All logs emitted by a collective, decoded, oldest first: from the agent's index, or scanned here if it's down. */
export async function collectiveLogs(a: Address) {
  let raw: SerializedLog[];
  try {
    raw = await fromIndex(a);
  } catch {
    raw = await scan(a);
  }
  return decode(a, raw);
}

/** Fallback scan from this browser. Incremental: only new blocks are fetched. */
async function scan(a: Address): Promise<SerializedLog[]> {
  const head = await publicClient.getBlockNumber();
  const cached = load(a);
  let from = cached ? BigInt(cached.to) + 1n : await creationBlock(a);
  const raw: SerializedLog[] = cached ? [...cached.logs] : [];
  const start = cached ? BigInt(cached.from) : from;

  const ranges: [bigint, bigint][] = [];
  for (; from <= head; from += CHUNK + 1n) ranges.push([from, from + CHUNK > head ? head : from + CHUNK]);
  // a first visit to a chest a few days old is a few hundred ranges: fetch them a handful at a time, keep block order
  for (let i = 0; i < ranges.length; i += PARALLEL) {
    const batch = await Promise.all(ranges.slice(i, i + PARALLEL).map(([f, t]) => publicClient.getLogs({ address: a, fromBlock: f, toBlock: t })));
    for (const l of batch.flat() as Log[]) {
      raw.push({
        blockNumber: (l.blockNumber ?? 0n).toString(),
        transactionHash: l.transactionHash ?? "0x",
        logIndex: l.logIndex ?? 0,
        data: l.data,
        topics: l.topics as `0x${string}`[],
      });
    }
  }
  save(a, { from: start.toString(), to: head.toString(), logs: raw });
  return raw;
}

function decode(a: Address, raw: SerializedLog[]) {
  const asLogs = raw.map((r) => ({
    address: a,
    blockHash: null,
    blockNumber: BigInt(r.blockNumber),
    data: r.data,
    logIndex: r.logIndex,
    removed: false,
    topics: r.topics as [`0x${string}`, ...`0x${string}`[]],
    transactionHash: r.transactionHash as `0x${string}`,
    transactionIndex: null,
  }));
  return parseEventLogs({ abi: collectiveAbi, logs: asLogs as never, strict: false });
}

export type CollectiveEvent = Awaited<ReturnType<typeof collectiveLogs>>[number];
