import PostalMime from "postal-mime";
import { formatUnits, isAddress, parseUnits, type Address } from "viem";
import { agentWallet, collectiveAbi, publicClient, readChest } from "./chain";
import type { Env } from "./env";
import type { InvoiceReading, Judge } from "./llm";
import { saveDecision, seal, type Check } from "./log";

/** A supplier the members registered: who they are, where they get paid, what they usually bill. */
export type Vendor = { name: string; emailDomain: string; payTo: Address; typicalUsdc: string; maxUsdc: string };

export type Assessment = {
  checks: Check[];
  outcome: "paid" | "vote" | "held" | "rejected";
  amount: bigint;
  payTo: Address | null;
};

const usdc = (v: bigint) => formatUnits(v, 6);

/**
 * Pure decision: what to do with an invoice, given what the model read, what the members registered and the chain.
 * Amount comes from the document but must sit inside the vendor's registered range; the address never comes from the
 * document — only from the registry.
 */
export function assessInvoice(args: {
  reading: InvoiceReading;
  senderDomain: string;
  vendor: Vendor | undefined;
  seenNumbers: string[];
  isPayee: boolean;
  capLeft: bigint;
  /** The shared-costs reserve: bills are paid from it, never from anyone's share. */
  reserve: bigint;
}): Assessment {
  const { reading, vendor } = args;
  let amount = 0n;
  try {
    amount = parseUnits(reading.amount.replace(/[^0-9.]/g, "") || "0", 6);
  } catch {
    amount = 0n;
  }
  const typical = vendor ? parseUnits(vendor.typicalUsdc, 6) : 0n;
  const max = vendor ? parseUnits(vendor.maxUsdc, 6) : 0n;
  const docAddress = reading.payToAddress.trim();

  const checks: Check[] = [
    { name: "known supplier", ok: !!vendor, detail: vendor ? `${vendor.name} (${vendor.emailDomain})` : `nobody registered for ${args.senderDomain}` },
    { name: "currency", ok: /^(usd|usdc)$/i.test(reading.currency.trim()), detail: reading.currency || "not stated" },
    { name: "amount in usual range", ok: !!vendor && amount > 0n && amount <= max && amount <= typical * 3n, detail: vendor ? `${usdc(amount)} USDC; usual ${vendor.typicalUsdc}, max ${vendor.maxUsdc}` : `${usdc(amount)} USDC` },
    { name: "not a duplicate", ok: !reading.invoiceNumber || !args.seenNumbers.includes(reading.invoiceNumber), detail: reading.invoiceNumber || "no number" },
    { name: "payment details unchanged", ok: !reading.asksToChangePaymentDetails && (!docAddress || (!!vendor && isAddress(docAddress) && docAddress.toLowerCase() === vendor.payTo.toLowerCase())), detail: reading.asksToChangePaymentDetails ? "asks to pay a new wallet" : docAddress ? `document names ${docAddress}` : "no wallet named" },
    { name: "no pressure or hidden instructions", ok: !reading.pressure && !reading.embeddedInstructions, detail: [reading.pressure && "urgency pressure", reading.embeddedInstructions && "instructions aimed at an AI"].filter(Boolean).join(", ") || "clean" },
    { name: "payee allowed on chain", ok: args.isPayee, detail: vendor ? (args.isPayee ? "allowlisted by vote" : "not allowlisted yet") : "—" },
    { name: "within agent limit", ok: amount <= args.capLeft, detail: `${usdc(args.capLeft)} USDC left this month` },
    { name: "covered by shared costs", ok: amount <= args.reserve, detail: `${usdc(args.reserve)} USDC set aside for shared costs` },
  ];

  const byName = Object.fromEntries(checks.map((c) => [c.name, c.ok]));
  const fraud = !byName["payment details unchanged"] || !byName["no pressure or hidden instructions"] || !byName["not a duplicate"];
  if (fraud) return { checks, outcome: "rejected", amount, payTo: null };
  const sound = byName["known supplier"] && byName["currency"] && byName["amount in usual range"] && byName["payee allowed on chain"] && byName["covered by shared costs"];
  if (!sound) return { checks, outcome: "held", amount, payTo: vendor?.payTo ?? null };
  if (!byName["within agent limit"]) return { checks, outcome: "vote", amount, payTo: vendor!.payTo };
  return { checks, outcome: "paid", amount, payTo: vendor!.payTo };
}

// ── storage ─────────────────────────────────────────────

const vendorsKey = (c: Address) => `vendors:${c.toLowerCase()}`;
const numbersKey = (c: Address) => `invnums:${c.toLowerCase()}`;
const inboxKey = (addr: string) => `inbox:${addr.toLowerCase()}`;

export async function getVendors(env: Env, chest: Address): Promise<Vendor[]> {
  return JSON.parse((await env.AGENT_KV.get(vendorsKey(chest))) ?? "[]") as Vendor[];
}
export async function putVendors(env: Env, chest: Address, vendors: Vendor[]) {
  await env.AGENT_KV.put(vendorsKey(chest), JSON.stringify(vendors));
}
export async function setInbox(env: Env, mailbox: string, chest: Address) {
  await env.AGENT_KV.put(inboxKey(mailbox), chest);
}

// ── email entry point ───────────────────────────────────

export async function handleInvoiceEmail(env: Env, message: ForwardableEmailMessage, judge: Judge) {
  const chest = (await env.AGENT_KV.get(inboxKey(message.to))) as Address | null;
  if (!chest) {
    message.setReject("Unknown mailbox");
    return;
  }
  const parsed = await PostalMime.parse(message.raw);
  const pdf = parsed.attachments.find((a) => a.mimeType === "application/pdf");
  const pdfBase64 = pdf ? toBase64(pdf.content) : undefined;
  const sender = (parsed.from?.address ?? message.from).toLowerCase();
  const senderDomain = sender.split("@")[1] ?? "";

  let reading: InvoiceReading;
  try {
    reading = await judge.readInvoice({ from: sender, subject: parsed.subject ?? "", text: parsed.text ?? "", pdfBase64 });
  } catch (e) {
    const d = seal({ chest, at: Date.now(), kind: "invoice", title: `Held an invoice from ${senderDomain}`, facts: { from: sender, subject: parsed.subject ?? "" }, checks: [{ name: "read the document", ok: false, detail: String(e) }], model: null, outcome: "held" });
    await saveDecision(env, d);
    return;
  }

  const vendors = await getVendors(env, chest);
  const vendor = vendors.find((v) => senderDomain === v.emailDomain.toLowerCase() || senderDomain.endsWith(`.${v.emailDomain.toLowerCase()}`));
  const state = await readChest(chest);
  const isPayee = vendor ? await publicClient.readContract({ address: chest, abi: collectiveAbi, functionName: "isPayee", args: [vendor.payTo] }) : false;
  const seenNumbers = JSON.parse((await env.AGENT_KV.get(numbersKey(chest))) ?? "[]") as string[];
  const a = assessInvoice({
    reading, senderDomain, vendor, seenNumbers, isPayee,
    capLeft: state.expenseLeft,
    reserve: state.reserve,
  });

  const facts = { from: sender, subject: parsed.subject ?? "", invoice: reading.invoiceNumber, amount: `${usdc(a.amount)} USDC`, billed: reading.summary };
  const titles = {
    paid: `Paid ${vendor?.name ?? senderDomain} ${usdc(a.amount)} USDC`,
    vote: `Asked members to approve ${usdc(a.amount)} USDC to ${vendor?.name ?? senderDomain}`,
    held: `Held an invoice from ${vendor?.name ?? senderDomain}`,
    rejected: `Refused an invoice from ${senderDomain}`,
  } as const;
  const d = seal({ chest, at: Date.now(), kind: "invoice", title: titles[a.outcome], facts, checks: a.checks, model: { name: judge.name, output: reading }, outcome: a.outcome });

  const { account, wallet } = agentWallet(env);
  let tx: `0x${string}` | undefined;
  if (a.outcome === "paid" && a.payTo) {
    tx = await wallet.writeContract({ address: chest, abi: collectiveAbi, functionName: "payExpense", args: [a.payTo, a.amount, d.ref], account });
    await publicClient.waitForTransactionReceipt({ hash: tx });
  } else if (a.outcome === "vote" && a.payTo) {
    const payload = `0x${a.payTo.slice(2).toLowerCase().padStart(64, "0")}${a.amount.toString(16).padStart(64, "0")}` as `0x${string}`;
    tx = await wallet.writeContract({ address: chest, abi: collectiveAbi, functionName: "propose", args: [7, payload, d.ref], account });
  }
  await saveDecision(env, { ...d, tx });
  if (reading.invoiceNumber && (a.outcome === "paid" || a.outcome === "vote")) {
    await env.AGENT_KV.put(numbersKey(chest), JSON.stringify([...seenNumbers, reading.invoiceNumber].slice(-500)));
  }
}

function toBase64(content: ArrayBuffer | Uint8Array | string): string {
  if (typeof content === "string") return btoa(content);
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
