import { formatUnits, isAddressEqual, parseEventLogs, type Address, type Hex } from "viem";
import { collectiveAbi, publicClient, readChest } from "./chain";
import { getInvoiceNote, openInvoices, type OpenInvoice } from "./collections";
import type { Env } from "./env";
import type { Judge, Reminder, ReminderInput } from "./llm";
import { saveDecision, seal } from "./log";

/** A member asking twice in a day gets the same draft back: no second model call, no KV write. */
const REUSE_MS = 12 * 60 * 60 * 1000;
/** After a due date passes, the agent drafts a reminder on its own, then again every few days while it stays unpaid. */
const AUTO_EVERY_S = 3 * 24 * 60 * 60;

const reminderKey = (c: Address, id: Hex) => `remind:${c.toLowerCase()}:${id.toLowerCase()}`;
const autoKey = (c: Address) => `remind:auto:${c.toLowerCase()}`;
const langKey = (c: Address) => `lang:${c.toLowerCase()}`;

export type Draft = Reminder & { payLink: string; model: string; at: number; daysOpen: number };

/** Join the model's words and the pay link. The link always comes from code, never from the model. */
export function withLink(message: string, payLink: string): string {
  return `${message.trim()}\n\n${payLink}`;
}

/** The team's language: what a member last asked in, else a guess from the invoice note. */
export async function teamLang(env: Env, chest: Address, note: string): Promise<"en" | "tr"> {
  const saved = await env.AGENT_KV.get(langKey(chest));
  if (saved === "tr" || saved === "en") return saved;
  return /[çğıöşüİ]/i.test(note) ? "tr" : "en";
}

export async function rememberLang(env: Env, chest: Address, lang: "en" | "tr") {
  if ((await env.AGENT_KV.get(langKey(chest))) !== lang) await env.AGENT_KV.put(langKey(chest), lang);
}

/** Overdue invoices the agent hasn't reminded about in the last few days, most overdue first. Pure, for tests. */
export function overdue<T extends Pick<OpenInvoice, "id" | "dueAt">>(invoices: T[], nowS: number, lastSent: Record<string, number>): T[] {
  return invoices
    .filter((i) => i.dueAt > 0 && nowS > i.dueAt && nowS - (lastSent[i.id.toLowerCase()] ?? 0) >= AUTO_EVERY_S)
    .sort((a, b) => a.dueAt - b.dueAt);
}

const isoDay = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);

/**
 * Draft a payment reminder for an open invoice a member asked about. The facts (amount, age, what it was for) are
 * read from the chain; the model only words them. The team sends it themselves, through the channel they already use.
 */
export async function draftReminder(env: Env, chest: Address, id: Hex, createdTx: Hex, lang: "en" | "tr", judge: Judge): Promise<Draft> {
  const [amount, , , status, dueAt] = await publicClient.readContract({ address: chest, abi: collectiveAbi, functionName: "invoice", args: [id] });
  if (status !== 1) throw new Error("invoice is not open");

  const cached = await env.AGENT_KV.get<Draft & { lang: string }>(reminderKey(chest, id), "json");
  if (cached && cached.lang === lang && Date.now() - cached.at < REUSE_MS) return cached;

  // the age comes from the block that created the invoice, checked to be this invoice of this chest
  const receipt = await publicClient.getTransactionReceipt({ hash: createdTx });
  const created = parseEventLogs({ abi: collectiveAbi, logs: receipt.logs, eventName: "InvoiceCreated" })
    .find((l) => isAddressEqual(l.address, chest) && (l.args as { id: Hex }).id.toLowerCase() === id.toLowerCase());
  if (!created) throw new Error("that transaction did not create this invoice");
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  const nowS = Math.floor(Date.now() / 1000);
  const daysOpen = Math.max(0, Math.floor((nowS - Number(block.timestamp)) / 86_400));
  const job = (created.args as { note?: string }).note || (await getInvoiceNote(env, chest, id)).replace(/^Paid from Base.*$/, "");

  const { name } = await readChest(chest);
  const input: ReminderInput = { lang, team: name, job, amountUsdc: formatUnits(amount, 6), daysOpen, ...due(Number(dueAt), nowS) };
  const draft = await compose(env, chest, id, input, judge, "member", [
    { name: "invoice is open", ok: true, detail: "status read from the chest" },
    { name: "created by this chest", ok: true, detail: `InvoiceCreated in ${createdTx.slice(0, 10)}…` },
  ]);
  await env.AGENT_KV.put(reminderKey(chest, id), JSON.stringify({ ...draft, lang }), { expirationTtl: 60 * 60 * 24 * 30 });
  return draft;
}

/**
 * The collections job the team would otherwise forget: once an invoice is past its due date, draft the reminder
 * before anyone asks and put it in the agent panel, ready to send. One per pass; nothing is sent by the agent.
 */
export async function runReminders(env: Env, chest: Address, judge: Judge) {
  const nowS = Math.floor(Date.now() / 1000);
  const lastSent = JSON.parse((await env.AGENT_KV.get(autoKey(chest))) ?? "{}") as Record<string, number>;
  const [next] = overdue(await openInvoices(env, chest), nowS, lastSent);
  if (!next) return;

  const [amount, , , status, dueAt, pending] = await publicClient.readContract({ address: chest, abi: collectiveAbi, functionName: "invoice", args: [next.id] });
  // paid, cancelled, or the team hasn't agreed to the shares yet (the client couldn't pay anyway): nothing to chase
  if (status !== 1 || pending > 0) {
    lastSent[next.id.toLowerCase()] = nowS;
    await env.AGENT_KV.put(autoKey(chest), JSON.stringify(lastSent));
    return;
  }
  const [{ name }, block] = await Promise.all([readChest(chest), publicClient.getBlock({ blockNumber: next.block })]);
  const lang = await teamLang(env, chest, next.note);
  const input: ReminderInput = {
    lang, team: name, job: next.note, amountUsdc: formatUnits(amount, 6),
    daysOpen: Math.max(0, Math.floor((nowS - Number(block.timestamp)) / 86_400)),
    ...due(Number(dueAt), nowS),
  };
  await compose(env, chest, next.id, input, judge, "overdue", [
    { name: "invoice is open", ok: true, detail: "status read from the chest" },
    { name: "past its due date", ok: true, detail: `due ${isoDay(Number(dueAt))}, ${input.daysLate} day(s) late` },
    { name: "everyone agreed to the shares", ok: true, detail: "the client can pay it now" },
  ]);
  lastSent[next.id.toLowerCase()] = nowS;
  // keep only what is still open, so the record doesn't grow
  const open = new Set((await openInvoices(env, chest)).map((i) => i.id.toLowerCase()));
  await env.AGENT_KV.put(autoKey(chest), JSON.stringify(Object.fromEntries(Object.entries(lastSent).filter(([k]) => open.has(k)))));
}

function due(dueAt: number, nowS: number): Pick<ReminderInput, "dueDate" | "daysLate"> {
  if (!dueAt) return {};
  return { dueDate: isoDay(dueAt), daysLate: Math.max(0, Math.floor((nowS - dueAt) / 86_400)) };
}

async function compose(env: Env, chest: Address, id: Hex, input: ReminderInput, judge: Judge, trigger: "member" | "overdue", checks: { name: string; ok: boolean; detail: string }[]): Promise<Draft> {
  const words = await judge.draftReminder(input);
  const payLink = `${env.APP_URL}/pay/${chest}/${id}`;
  const draft: Draft = { ...words, message: withLink(words.message, payLink), payLink, model: judge.name, at: Date.now(), daysOpen: input.daysOpen };
  const d = seal({
    chest,
    at: draft.at,
    kind: "reminder",
    title: trigger === "overdue"
      ? `Invoice ${input.daysLate} day(s) past due: drafted a reminder for ${input.amountUsdc} USDC`
      : `Drafted a payment reminder for ${input.amountUsdc} USDC`,
    facts: {
      invoice: id,
      amount: `${input.amountUsdc} USDC`,
      "open for": `${input.daysOpen} day(s)`,
      ...(input.dueDate ? { due: input.dueDate } : {}),
      for: input.job || "—",
      "pay link": payLink,
    },
    checks: [...checks, { name: "pay link from code", ok: true, detail: payLink }],
    model: { name: judge.name, output: { ...words, message: draft.message } },
    outcome: "drafted",
  });
  await saveDecision(env, d);
  return draft;
}
