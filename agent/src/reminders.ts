import { formatUnits, isAddressEqual, parseEventLogs, type Address, type Hex } from "viem";
import { collectiveAbi, publicClient, readChest } from "./chain";
import { getInvoiceNote } from "./collections";
import type { Env } from "./env";
import type { Judge, Reminder } from "./llm";
import { saveDecision, seal } from "./log";

/** A member asking twice in a day gets the same draft back: no second model call, no KV write. */
const REUSE_MS = 12 * 60 * 60 * 1000;

const reminderKey = (c: Address, id: Hex) => `remind:${c.toLowerCase()}:${id.toLowerCase()}`;

export type Draft = Reminder & { payLink: string; model: string; at: number; daysOpen: number };

/** Join the model's words and the pay link. The link always comes from code, never from the model. */
export function withLink(message: string, payLink: string): string {
  return `${message.trim()}\n\n${payLink}`;
}

/**
 * Draft a payment reminder for an open invoice. The facts (amount, age, what it was for) are read from the chain and
 * the bill note; the model only words them. The team sends it themselves, through the channel they already use.
 */
export async function draftReminder(env: Env, chest: Address, id: Hex, createdTx: Hex, lang: "en" | "tr", judge: Judge): Promise<Draft> {
  const [amount, , , status] = await publicClient.readContract({ address: chest, abi: collectiveAbi, functionName: "invoice", args: [id] });
  if (status !== 1) throw new Error("invoice is not open");

  const cached = await env.AGENT_KV.get<Draft & { lang: string }>(reminderKey(chest, id), "json");
  if (cached && cached.lang === lang && Date.now() - cached.at < REUSE_MS) return cached;

  // the age comes from the block that created the invoice, checked to be this invoice of this chest
  const receipt = await publicClient.getTransactionReceipt({ hash: createdTx });
  const created = parseEventLogs({ abi: collectiveAbi, logs: receipt.logs, eventName: "InvoiceCreated" })
    .find((l) => isAddressEqual(l.address, chest) && (l.args as { id: Hex }).id.toLowerCase() === id.toLowerCase());
  if (!created) throw new Error("that transaction did not create this invoice");
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  const daysOpen = Math.max(0, Math.floor((Date.now() / 1000 - Number(block.timestamp)) / 86_400));

  const { name } = await readChest(chest);
  const job = (await getInvoiceNote(env, chest, id)).replace(/^Paid from Base.*$/, "");
  const amountUsdc = formatUnits(amount, 6);
  const input = { lang, team: name, job, amountUsdc, daysOpen };
  const words = await judge.draftReminder(input);
  const payLink = `${env.APP_URL}/pay/${chest}/${id}`;
  const draft: Draft = { ...words, message: withLink(words.message, payLink), payLink, model: judge.name, at: Date.now(), daysOpen };

  await env.AGENT_KV.put(reminderKey(chest, id), JSON.stringify({ ...draft, lang }), { expirationTtl: 60 * 60 * 24 * 30 });
  const d = seal({
    chest,
    at: draft.at,
    kind: "reminder",
    title: `Drafted a payment reminder for ${amountUsdc} USDC`,
    facts: { invoice: id, amount: `${amountUsdc} USDC`, "open for": `${daysOpen} day(s)`, for: job || "—" },
    checks: [
      { name: "invoice is open", ok: true, detail: "status read from the chest" },
      { name: "created by this chest", ok: true, detail: `InvoiceCreated in ${createdTx.slice(0, 10)}…` },
      { name: "pay link from code", ok: true, detail: payLink },
    ],
    model: { name: judge.name, output: words },
    outcome: "drafted",
  });
  await saveDecision(env, d);
  return draft;
}
