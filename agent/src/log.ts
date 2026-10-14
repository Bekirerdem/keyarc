import { keccak256, toHex, type Address, type Hex } from "viem";
import type { Env } from "./env";

export type Check = { name: string; ok: boolean; detail: string };

export type Decision = {
  id: string;
  chest: Address;
  at: number;
  kind: "inflow" | "invoice" | "note" | "payout" | "reminder";
  title: string;
  /** Plain facts read from the chain or the document — never written by the model. */
  facts: Record<string, string>;
  checks: Check[];
  model: { name: string; output: unknown } | null;
  outcome: "paid" | "settled" | "vote" | "held" | "rejected" | "noted" | "distributed" | "drafted";
  /** keccak256 of the canonical record, written on chain as the `ref` of any transaction it led to. */
  ref: Hex;
  tx?: Hex;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

/** Seal a decision: its hash covers everything but the tx it later produced. */
export function seal(d: Omit<Decision, "ref" | "id" | "tx">): Decision {
  const ref = keccak256(toHex(canonical(d)));
  return { ...d, ref, id: ref.slice(2, 14) };
}

const key = (chest: Address, at: number, id: string) => `dec:${chest.toLowerCase()}:${String(9_999_999_999_999 - at).padStart(13, "0")}:${id}`;

export async function saveDecision(env: Env, d: Decision) {
  await env.AGENT_KV.put(key(d.chest, d.at, d.id), JSON.stringify(d));
}

export async function listDecisions(env: Env, chest: Address, limit = 50): Promise<Decision[]> {
  const res = await env.AGENT_KV.list({ prefix: `dec:${chest.toLowerCase()}:`, limit });
  const values = await Promise.all(res.keys.map((k) => env.AGENT_KV.get(k.name)));
  return values.filter((v): v is string => !!v).map((v) => JSON.parse(v) as Decision);
}
