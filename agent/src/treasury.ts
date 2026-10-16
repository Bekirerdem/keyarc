import { formatUnits, type Address } from "viem";
import { readChest } from "./chain";
import { getStats } from "./collections";
import type { Env } from "./env";
import type { Judge } from "./llm";
import { saveDecision, seal } from "./log";

const usdc = (v: bigint) => formatUnits(v, 6);
const lastNoteKey = (c: Address) => `note:last:${c.toLowerCase()}`;
const WEEK = 7 * 24 * 60 * 60 * 1000;

/** Weekly: income, what was paid out, whether the shared-costs share covers the bills, at most one suggestion for a vote. */
export async function runTreasuryNote(env: Env, chest: Address, judge: Judge, force = false) {
  const last = Number((await env.AGENT_KV.get(lastNoteKey(chest))) ?? "0");
  if (!force && Date.now() - last < WEEK) return;

  const [state, stats] = await Promise.all([readChest(chest), getStats(env, chest)]);
  const days = Object.values(stats.days);
  const monthlyOut = (days.reduce((s, d) => s + BigInt(d.out), 0n) * 30n) / BigInt(Math.max(days.length, 1));
  const monthlyIn = (days.reduce((s, d) => s + BigInt(d.in), 0n) * 30n) / BigInt(Math.max(days.length, 1));
  // shares go out the moment a client pays, so the chest holds only the shared-costs reserve
  const runway = monthlyOut > 0n ? Number((state.reserve * 100n) / monthlyOut) / 100 : null;

  const facts = {
    chest: state.name,
    "set aside for shared costs": state.rules.reserveBps === 0
      ? "nothing: the team keeps no shared-costs share"
      : `${usdc(state.reserve)} USDC (fills to ${usdc(state.rules.reserveTarget)}, ${state.rules.reserveBps / 100}% of each payment)`,
    "income per month (observed)": `${usdc(monthlyIn)} USDC over ${days.length} day(s) of data`,
    "costs per month (observed)": `${usdc(monthlyOut)} USDC`,
    "months of shared costs covered": runway === null ? "no shared costs paid yet" : String(runway),
    "invoices paid so far": String(stats.invoicesPaid),
    "paid out to members so far": `${usdc(BigInt(stats.paidOut))} USDC`,
  };

  try {
    const note = await judge.treasuryNote({ facts });
    const d = seal({ chest, at: Date.now(), kind: "note", title: note.headline, facts, checks: [], model: { name: judge.name, output: note }, outcome: "noted" });
    await saveDecision(env, d);
  } catch {
    // no model: still publish the plain numbers so members see them
    const d = seal({ chest, at: Date.now(), kind: "note", title: "Weekly numbers", facts, checks: [], model: null, outcome: "noted" });
    await saveDecision(env, d);
  }
  await env.AGENT_KV.put(lastNoteKey(chest), String(Date.now()));
}
