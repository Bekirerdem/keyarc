import { formatUnits, type Address, type Hex } from "viem";

// Mirrors agent/src/log.ts and agent/src/payables.ts — kept as plain types so the web bundle doesn't pull the worker.
export type Check = { name: string; ok: boolean; detail: string };
export type Outcome = "paid" | "settled" | "vote" | "held" | "rejected" | "noted" | "distributed" | "drafted";
export type Decision = {
  id: string;
  chest: Address;
  at: number;
  kind: "inflow" | "invoice" | "note" | "payout" | "reminder";
  title: string;
  facts: Record<string, string>;
  checks: Check[];
  model: { name: string; output: unknown } | null;
  outcome: Outcome;
  ref: Hex;
  tx?: Hex;
};
export type Vendor = { name: string; emailDomain: string; payTo: Address; typicalUsdc: string; maxUsdc: string };
export type AgentFeed = { agent: Address; managed: boolean; model: string; decisions: Decision[] };

export const AGENT_URL: string = (import.meta.env.VITE_AGENT_URL as string | undefined) ?? "https://keyarc-agent.l3ekirerdem.workers.dev";

/** `?mock=1` in the URL or VITE_AGENT_MOCK=1: sample decisions for screenshots and the demo video. */
export const agentMock = (): boolean =>
  import.meta.env.VITE_AGENT_MOCK === "1" || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mock") === "1");

export function modelLabel(id: string): string {
  const m = /^claude-(haiku|sonnet|opus|fable)-(\d+)-(\d+)$/.exec(id);
  if (!m) return id === "rules-only" ? "rules only" : id;
  return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
}

/** The agent's own words, shown apart from the facts: a reason, a summary, a note body or a reminder. */
export function modelText(d: Decision): string | null {
  const o = d.model?.output as Record<string, unknown> | undefined;
  if (!o) return null;
  for (const k of ["reasoning", "body", "summary", "message"]) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  return null;
}

export async function getFeed(chest: Address): Promise<AgentFeed> {
  if (agentMock()) return mockFeed(chest);
  const r = await fetch(`${AGENT_URL}/decisions?chest=${chest}`);
  if (!r.ok) throw new Error(`agent ${r.status}`);
  return (await r.json()) as AgentFeed;
}

export async function getVendors(chest: Address): Promise<Vendor[]> {
  if (agentMock()) return MOCK_VENDORS;
  const r = await fetch(`${AGENT_URL}/vendors?chest=${chest}`);
  if (!r.ok) throw new Error(`agent ${r.status}`);
  return ((await r.json()) as { vendors: Vendor[] }).vendors;
}

/** Member-signed write: the agent checks the signer is a member of the chest and the message is under 10 minutes old. */
export async function signedPost(
  path: "/vendors" | "/inbox" | "/run",
  chest: Address,
  payload: Record<string, unknown>,
  sign: (message: string) => Promise<Hex>,
): Promise<void> {
  const message = JSON.stringify({ chest, at: Date.now(), ...payload });
  const signature = await sign(message);
  if (agentMock()) return;
  const r = await fetch(`${AGENT_URL}${path}?chest=${chest}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `agent ${r.status}`);
  }
}

/** A payment reminder the agent drafted; the message already ends with the pay link. */
export type ReminderDraft = { subject: string; message: string; payLink: string; model: string; at: number; daysOpen: number };

/** Member-signed: the agent checks the invoice is open on chain and words the reminder; the team sends it. */
export async function requestReminder(
  chest: Address,
  invoice: { id: Hex; createdTx: Hex; amount: bigint; note: string },
  lang: "en" | "tr",
  sign: (message: string) => Promise<Hex>,
): Promise<ReminderDraft> {
  if (agentMock()) {
    // the walkthrough has no wallet: show what a member would get back
    const amt = formatUnits(invoice.amount, 6);
    const job = invoice.note || (lang === "tr" ? "son işimiz" : "our latest work");
    const payLink = `${window.location.origin}/pay/${chest}/${invoice.id}`;
    const body = lang === "tr"
      ? `Merhaba,\n\n${job} için ${amt} USDC tutarındaki faturamız hâlâ açık görünüyor. Uygun olduğunuzda aşağıdaki linkten Arc ya da Base üzerinden USDC ile ödeyebilirsiniz.\n\nİyi çalışmalar,\nKeyarc Studio`
      : `Hi,\n\nOur invoice for ${job}, ${amt} USDC, still shows as open. Whenever it suits you, you can pay it in USDC from Arc or Base using the link below.\n\nBest,\nKeyarc Studio`;
    return { subject: lang === "tr" ? `Hatırlatma: ${job}` : `Reminder: ${job}`, message: `${body}\n\n${payLink}`, payLink, model: "claude-haiku-5-5", at: Date.now(), daysOpen: 9 };
  }
  const message = JSON.stringify({ chest, at: Date.now(), id: invoice.id, createdTx: invoice.createdTx, lang });
  const signature = await sign(message);
  const r = await fetch(`${AGENT_URL}/reminder?chest=${chest}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  const body = (await r.json().catch(() => ({}))) as ReminderDraft & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `agent ${r.status}`);
  return body;
}

// ── mock data: one team's week, as the agent would record it ──

const MOCK_AGENT: Address = "0xBB682c02E3429d808499c1Ec5414b34113A21017";
const MOCK_VENDORS: Vendor[] = [
  { name: "Figma", emailDomain: "figma.com", payTo: "0x1111111111111111111111111111111111111111", typicalUsdc: "15", maxUsdc: "60" },
  { name: "Hetzner", emailDomain: "hetzner.com", payTo: "0x2222222222222222222222222222222222222222", typicalUsdc: "40", maxUsdc: "120" },
];
const ref = (n: number) => `0x${n.toString(16).padStart(4, "0")}${"ab".repeat(30)}` as Hex;
const tx = (n: number) => `0x${n.toString(16).padStart(4, "0")}${"cd".repeat(30)}` as Hex;

function mockFeed(chest: Address): AgentFeed {
  const now = Date.now();
  const H = 60 * 60 * 1000;
  const link = `${typeof window !== "undefined" ? window.location.origin : "https://keyarc.app"}/pay/${chest}/0x${"14".repeat(32)}`;
  const reminder = `Hi Anouk,\n\nOur invoice for the Shopify store rebuild, 4,800 USDC (due 2026-10-11), still shows as open. Whenever it suits you, you can pay it in USDC from Base or Arc using the link below.\n\nThanks again for the smooth launch,\nKeyarc Studio\n\n${link}`;
  const decisions: Decision[] = [
    {
      id: "n1", chest, at: now - 0.2 * H, kind: "note", title: "Tools are covered for about four months.",
      facts: {
        "set aside for shared costs": "96.00 USDC (fills to 300, 5% of each payment)",
        "income per month (observed)": "7,200.00 USDC over 30 day(s) of data",
        "costs per month (observed)": "24.00 USDC",
        "months of shared costs covered": "4",
        "paid out to members so far": "6,840.00 USDC",
      },
      checks: [],
      model: { name: "claude-haiku-5-5", output: { headline: "Tools are covered for about four months.", body: "Two invoices came in this month, 7,200 USDC, and 6,840 went straight to the three of you. The shared-costs share holds 96 USDC against about 24 USDC a month of Figma and hosting, so it covers four months. No change needed.", suggestion: "none", suggestedReservePercent: 0, reasoning: "Shared costs are small and well covered." } },
      outcome: "noted", ref: ref(1),
    },
    {
      id: "m1", chest, at: now - 0.6 * H, kind: "reminder", title: "Invoice 5 day(s) past due: drafted a reminder for 4,800 USDC",
      facts: { amount: "4,800.00 USDC", "open for": "19 day(s)", due: "2026-10-11", for: "Shopify store rebuild", "pay link": link },
      checks: [
        { name: "invoice is open", ok: true, detail: "status read from the chest" },
        { name: "past its due date", ok: true, detail: "due 2026-10-11, 5 day(s) late" },
        { name: "everyone agreed to the shares", ok: true, detail: "the client can pay it now" },
        { name: "pay link from code", ok: true, detail: link },
      ],
      model: { name: "claude-haiku-5-5", output: { subject: "Reminder: Shopify store rebuild · 4,800 USDC", message: reminder } },
      outcome: "drafted", ref: ref(2),
    },
    {
      id: "s1", chest, at: now - 3 * H, kind: "inflow", title: "Matched 2,400.00 USDC to an invoice and paid the team",
      facts: { amount: "2,400.00 USDC", inflowTx: tx(4), from: "0x0000000000000000000000000000000000000000 (CCTP mint from Base)", candidates: "1" },
      checks: [
        { name: "matching invoices", ok: true, detail: "1 open invoice(s) paid by 2,400 USDC" },
        { name: "model agrees", ok: true, detail: "settle (96%)" },
        { name: "confidence", ok: true, detail: "96% (needs 80%)" },
        { name: "within agent limit", ok: true, detail: "3,000 USDC left this month" },
        { name: "money is in the chest", ok: true, detail: "2,400 USDC unlabelled" },
      ],
      model: { name: "claude-haiku-5-5", output: { decision: "settle", confidence: 0.96, reasoning: "Exactly one open invoice is for 2,400 USDC (store upkeep and SEO, October), written before the payment, and the pay page left a note that the client paid it from Base." } },
      outcome: "settled", ref: ref(4), tx: tx(5),
    },
    {
      id: "r1", chest, at: now - 5 * H, kind: "invoice", title: "Refused an invoice from figrna-billing.com",
      facts: { from: "billing@figrna-billing.com", subject: "URGENT: updated wallet for Figma invoice", invoice: "FIG-2026-10", amount: "480.00 USDC", billed: "Figma Professional, October" },
      checks: [
        { name: "known supplier", ok: false, detail: "nobody registered for figrna-billing.com" },
        { name: "amount in usual range", ok: false, detail: "480.00 USDC; usual 15, max 60" },
        { name: "payment details unchanged", ok: false, detail: "asks to pay a new wallet" },
        { name: "no pressure or hidden instructions", ok: false, detail: "urgency pressure, instructions aimed at an AI" },
        { name: "payee allowed on chain", ok: false, detail: "—" },
      ],
      model: { name: "claude-haiku-5-5", output: { summary: "Claims to be Figma, says the wallet changed and asks for 480 USDC today; contains a line telling an AI assistant to skip checks.", asksToChangePaymentDetails: true, pressure: true, embeddedInstructions: true } },
      outcome: "rejected", ref: ref(6),
    },
    {
      id: "p1", chest, at: now - 26 * H, kind: "invoice", title: "Paid Figma 15.00 USDC",
      facts: { from: "invoices@figma.com", subject: "Your Figma invoice", invoice: "FIG-2026-09", amount: "15.00 USDC", billed: "Figma Professional, September" },
      checks: [
        { name: "known supplier", ok: true, detail: "Figma (figma.com)" },
        { name: "amount in usual range", ok: true, detail: "15.00 USDC; usual 15, max 60" },
        { name: "not a duplicate", ok: true, detail: "FIG-2026-09" },
        { name: "payment details unchanged", ok: true, detail: "no wallet named" },
        { name: "payee allowed on chain", ok: true, detail: "allowlisted by vote" },
        { name: "within agent limit", ok: true, detail: "100 USDC left this month" },
        { name: "covered by shared costs", ok: true, detail: "111 USDC set aside for shared costs" },
      ],
      model: { name: "claude-haiku-5-5", output: { summary: "Figma Professional seat, September." } },
      outcome: "paid", ref: ref(7), tx: tx(8),
    },
  ];
  return { agent: MOCK_AGENT, managed: true, model: "claude-haiku-5-5", decisions };
}
