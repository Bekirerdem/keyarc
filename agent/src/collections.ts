import { formatUnits, parseAbiItem, type Address, type Hex } from "viem";
import { USDC, agentWallet, collectiveAbi, publicClient, readChest } from "./chain";
import type { Env } from "./env";
import type { Judge } from "./llm";
import { saveDecision, seal, type Check } from "./log";

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const CHUNK = 900n; // smallest eth_getLogs range the relay providers accept
const CURSOR_SLACK = CHUNK * 3n; // ~1h of Arc blocks
/** Arc emits native USDC movements (e.g. CCTP mints) from a system address as well as from the ERC-20 interface. */
const SYSTEM_EMITTER: Address = "0xfffffffffffffffffffffffffffffffffffffffe";
/** A fast CCTP transfer arrives slightly above the invoice when the payer covered the fee; the excess stays unlabelled. */
const TOLERANCE_BPS = 50n;

/** True when an inflow pays this invoice: at least the amount, at most 0.5% more. */
export function pays(inflow: bigint, invoice: bigint): boolean {
  return inflow >= invoice && inflow <= invoice + (invoice * TOLERANCE_BPS) / 10_000n;
}

/** `seen` = how many matching open invoices existed when it was last held; re-judged only when that changes. */
export type Inflow = { tx: Hex; from: Address; amount: bigint; block: bigint; seen?: number };
type OpenInvoice = { id: Hex; amount: bigint; payer: Address; creator: Address; block: bigint };

const usdc = (v: bigint) => formatUnits(v, 6);
const cursorKey = (c: Address) => `cursor:${c.toLowerCase()}`;
const pendingKey = (c: Address) => `pending:${c.toLowerCase()}`;
const noteKey = (c: Address, id: Hex) => `invnote:${c.toLowerCase()}:${id.toLowerCase()}`;
const statsKey = (c: Address) => `stats:${c.toLowerCase()}`;

/** Running totals the treasury note reads, accumulated from the blocks the inflow scan already reads. */
export type Stats = { since: number; income: string; expenses: string; paidOut: string; invoicesPaid: number; days: Record<string, { in: string; out: string }> };

export async function getStats(env: Env, chest: Address): Promise<Stats> {
  return JSON.parse((await env.AGENT_KV.get(statsKey(chest))) ?? `{"since":${Date.now()},"income":"0","expenses":"0","paidOut":"0","invoicesPaid":0,"days":{}}`) as Stats;
}

/** USDC that reached the chest outside payInvoice (CCTP mints, plain transfers, x402 settlements). */
export async function findInflows(env: Env, chest: Address): Promise<Inflow[]> {
  const head = await publicClient.getBlockNumber();
  const saved = await env.AGENT_KV.get(cursorKey(chest));
  let from = saved ? BigInt(saved) + 1n : head - CHUNK * 4n; // first run: look back ~1.5h
  const found: Inflow[] = [];
  const stats = await getStats(env, chest);
  const statsBefore = JSON.stringify(stats);
  while (from <= head) {
    const to = from + CHUNK > head ? head : from + CHUNK;
    const [transfers, events] = await Promise.all([
      publicClient.getLogs({ address: [USDC, SYSTEM_EMITTER], event: transferEvent, args: { to: chest }, fromBlock: from, toBlock: to }),
      publicClient.getContractEvents({ address: chest, abi: collectiveAbi, fromBlock: from, toBlock: to }),
    ]);
    const invoiceTxs = new Set(events.filter((e) => e.eventName === "InvoicePaid").map((p) => p.transactionHash));
    tally(stats, events);
    const seen = new Set<string>();
    for (const t of transfers) {
      if (invoiceTxs.has(t.transactionHash) || t.args.from?.toLowerCase() === chest.toLowerCase()) continue;
      // the same movement can appear from both emitters (ERC-20 and system); count it once
      const k = `${t.transactionHash}:${t.args.from}:${t.args.value}`;
      if (seen.has(k)) continue;
      seen.add(k);
      found.push({ tx: t.transactionHash, from: t.args.from!, amount: t.args.value!, block: t.blockNumber });
    }
    from = to + 1n;
  }
  // Free-plan KV allows 1,000 writes a day and this runs every 5 minutes, so write only what changed.
  // A quiet cursor is kept for up to ~1h of blocks: re-scanning a few chunks costs reads, not writes.
  const statsNow = JSON.stringify(stats);
  const quiet = found.length === 0 && statsNow === statsBefore;
  if (!quiet || !saved || head - BigInt(saved) > CURSOR_SLACK) await env.AGENT_KV.put(cursorKey(chest), head.toString());
  if (statsNow !== statsBefore) await env.AGENT_KV.put(statsKey(chest), statsNow);
  const pending = JSON.parse((await env.AGENT_KV.get(pendingKey(chest))) ?? "[]") as { tx: Hex; from: Address; amount: string; block: string; seen?: number }[];
  const known = new Set(pending.map((p) => p.tx));
  return [
    ...pending.map((p) => ({ ...p, amount: BigInt(p.amount), block: BigInt(p.block) })),
    ...found.filter((f) => !known.has(f.tx)),
  ];
}

async function savePending(env: Env, chest: Address, list: Inflow[]) {
  const next = JSON.stringify(list.map((i) => ({ ...i, amount: i.amount.toString(), block: i.block.toString() })));
  if (next === ((await env.AGENT_KV.get(pendingKey(chest))) ?? "[]")) return;
  await env.AGENT_KV.put(pendingKey(chest), next);
}

async function openInvoices(chest: Address): Promise<OpenInvoice[]> {
  const head = await publicClient.getBlockNumber();
  const fromBlock = head > 200_000n ? head - 200_000n : 0n; // ~3 days on Arc
  const open = new Map<Hex, OpenInvoice>();
  for (let from = fromBlock; from <= head; from += CHUNK + 1n) {
    const to = from + CHUNK > head ? head : from + CHUNK;
    const events = await publicClient.getContractEvents({ address: chest, abi: collectiveAbi, fromBlock: from, toBlock: to });
    for (const e of events) {
      if (e.eventName === "InvoiceCreated") {
        const a = e.args as { id: Hex; amount: bigint; payer: Address; creator: Address };
        open.set(a.id, { id: a.id, amount: a.amount, payer: a.payer, creator: a.creator, block: e.blockNumber });
      } else if (e.eventName === "InvoicePaid" || e.eventName === "InvoiceCancelled") {
        open.delete((e.args as { id: Hex }).id);
      }
    }
  }
  return [...open.values()];
}

/** Optional context the pay page leaves for an invoice ("paying from Base, ref ACME-12"). */
export async function setInvoiceNote(env: Env, chest: Address, id: Hex, note: string) {
  await env.AGENT_KV.put(noteKey(chest, id), note.slice(0, 280), { expirationTtl: 60 * 60 * 24 * 30 });
}

/**
 * Match each unlabelled inflow to an open invoice. Money moves only when the deterministic rule and the model agree
 * on the same single invoice; anything else is held or put to a member vote with the reasoning attached.
 */
export async function runCollections(env: Env, chest: Address, judge: Judge) {
  const inflows = await findInflows(env, chest);
  if (inflows.length === 0) return;
  const state = await readChest(chest);
  const invoices = await openInvoices(chest);
  const { account, wallet } = agentWallet(env);
  const stillPending: Inflow[] = [];

  for (const inflow of inflows) {
    const used = await publicClient.readContract({ address: chest, abi: collectiveAbi, functionName: "usedRef", args: [inflow.tx] });
    if (used) continue;

    const exact = invoices.filter((i) => pays(inflow.amount, i.amount) && i.block <= inflow.block);
    if (inflow.seen !== undefined && inflow.seen === exact.length) {
      stillPending.push(inflow); // nothing new to judge since it was held
      continue;
    }
    const capLeft = state.rules.autoAttributeCap - state.attributedThisPeriod;
    const candidates = await Promise.all(exact.map(async (i) => ({
      id: i.id, amountUsdc: usdc(i.amount), createdAt: `block ${i.block}`, payer: i.payer,
      note: (await env.AGENT_KV.get(noteKey(chest, i.id))) ?? "",
    })));
    const judgement = candidates.length
      ? await judge.pickInvoice({ inflow: { amountUsdc: usdc(inflow.amount), tx: inflow.tx, from: inflow.from, at: `block ${inflow.block}` }, candidates })
      : null;

    const checks: Check[] = [
      { name: "matching invoices", ok: exact.length === 1, detail: `${exact.length} open invoice(s) paid by ${usdc(inflow.amount)} USDC` },
      { name: "model agrees", ok: !!judgement && judgement.decision === "settle" && exact.length === 1 && judgement.invoiceId.toLowerCase() === exact[0].id.toLowerCase(), detail: judgement ? `${judgement.decision} (${Math.round(judgement.confidence * 100)}%)` : "no candidate to judge" },
      { name: "confidence", ok: (judgement?.confidence ?? 0) >= 0.8, detail: `${Math.round((judgement?.confidence ?? 0) * 100)}% (needs 80%)` },
      { name: "within agent limit", ok: exact.length === 1 && exact[0].amount <= capLeft, detail: `${usdc(capLeft)} USDC left this period` },
      { name: "money is in the chest", ok: exact.length === 1 && exact[0].amount <= state.unattributed, detail: `${usdc(state.unattributed)} USDC unlabelled` },
    ];
    const agree = checks[0].ok && checks[1].ok && checks[2].ok && checks[4].ok;
    const facts = { amount: `${usdc(inflow.amount)} USDC`, inflowTx: inflow.tx, from: inflow.from, candidates: String(exact.length) };
    const model = judgement ? { name: judge.name, output: judgement } : null;

    if (agree && checks[3].ok) {
      const d = seal({ chest, at: Date.now(), kind: "inflow", title: `Matched ${usdc(inflow.amount)} USDC to an invoice`, facts, checks, model, outcome: "settled" });
      const tx = await wallet.writeContract({ address: chest, abi: collectiveAbi, functionName: "settleInvoice", args: [exact[0].id, inflow.tx], account });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      await saveDecision(env, { ...d, tx });
      state.attributedThisPeriod += exact[0].amount;
    } else if (agree) {
      // Clear match, but above the agent's limit: the members decide.
      const d = seal({ chest, at: Date.now(), kind: "inflow", title: `Asked members to match ${usdc(inflow.amount)} USDC`, facts, checks, model, outcome: "vote" });
      const tx = await wallet.writeContract({ address: chest, abi: collectiveAbi, functionName: "propose", args: [8, encodeId(exact[0].id), inflow.tx], account });
      await saveDecision(env, { ...d, tx });
    } else {
      const d = seal({ chest, at: Date.now(), kind: "inflow", title: `Held ${usdc(inflow.amount)} USDC for the members`, facts, checks, model, outcome: "held" });
      await saveDecision(env, d);
      stillPending.push({ ...inflow, seen: exact.length });
    }
  }
  await savePending(env, chest, stillPending);
}

function encodeId(id: Hex): Hex {
  return id; // abi.encode(bytes32) is the 32-byte word itself
}

function tally(stats: Stats, events: { eventName: string; args: unknown }[]) {
  const day = new Date().toISOString().slice(0, 10);
  const bucket = (stats.days[day] ??= { in: "0", out: "0" });
  for (const e of events) {
    const a = e.args as { amount?: bigint; total?: bigint };
    if (e.eventName === "InvoicePaid" || e.eventName === "Attributed") {
      stats.income = (BigInt(stats.income) + (a.amount ?? 0n)).toString();
      bucket.in = (BigInt(bucket.in) + (a.amount ?? 0n)).toString();
      if (e.eventName === "InvoicePaid") stats.invoicesPaid += 1;
    } else if (e.eventName === "ExpensePaid") {
      stats.expenses = (BigInt(stats.expenses) + (a.amount ?? 0n)).toString();
      bucket.out = (BigInt(bucket.out) + (a.amount ?? 0n)).toString();
    } else if (e.eventName === "Distributed") {
      stats.paidOut = (BigInt(stats.paidOut) + (a.total ?? 0n)).toString();
    }
  }
  const keep = Object.keys(stats.days).sort().slice(-60);
  stats.days = Object.fromEntries(keep.map((k) => [k, stats.days[k]]));
}
