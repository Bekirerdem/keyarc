import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { agentWallet, collectiveAbi, isHex32, publicClient, readChest } from "./chain";
import { fastFeeBps, queueBurn, relayBurns, SOURCE_DOMAINS } from "./cctp";
import { runCollections, setInvoiceNote } from "./collections";
import type { Env } from "./env";
import { ClaudeJudge, NoJudge, type Judge } from "./llm";
import { listDecisions, saveDecision, seal } from "./log";
import { chestLogs, NotAChest } from "./logindex";
import { getVendors, handleInvoiceEmail, putVendors, setInbox, type Vendor } from "./payables";
import { draftReminder } from "./reminders";
import { runTreasuryNote } from "./treasury";

const judgeFor = (env: Env): Judge => (env.ANTHROPIC_API_KEY ? new ClaudeJudge(env.ANTHROPIC_API_KEY) : new NoJudge());
const chestsOf = (env: Env): Address[] => env.CHESTS.split(",").map((c) => c.trim()).filter((c) => isAddress(c)).map((c) => getAddress(c));

/** One pass over a chest. Each step is isolated so one failure doesn't stop the others. */
async function cycle(env: Env, chest: Address, opts: { forceNote?: boolean } = {}) {
  const judge = judgeFor(env);
  const steps: [string, () => Promise<void>][] = [
    ["relay", () => relayBurns(env)],
    ["collections", () => runCollections(env, chest, judge)],
    ["treasury", () => runTreasuryNote(env, chest, judge, opts.forceNote)],
    ["payout", () => maybeDistribute(env, chest)],
  ];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (e) {
      console.error(`[${name}] ${chest}:`, e instanceof Error ? e.message : e);
    }
  }
}

/** Housekeeping, not a judgement call: close the period when it's over and there is something to share. */
async function maybeDistribute(env: Env, chest: Address) {
  const s = await readChest(chest);
  const over = Date.now() / 1000 >= s.periodStart + s.rules.periodLength;
  if (!over || s.pool === 0n) return;
  const { account, wallet } = agentWallet(env);
  const tx = await wallet.writeContract({ address: chest, abi: collectiveAbi, functionName: "distribute", account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  const d = seal({ chest, at: Date.now(), kind: "payout", title: `Closed period #${s.period} and paid members`, facts: { pot: `${Number(s.pool) / 1e6} USDC` }, checks: [], model: null, outcome: "distributed" });
  await saveDecision(env, { ...d, tx });
}

// ── HTTP ────────────────────────────────────────────────

function cors(env: Env, req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  // preview deploys get their own subdomain on pages.dev
  const preview = /^https:\/\/[a-z0-9-]+\.keyarc\.pages\.dev$/.test(origin);
  return allowed.includes(origin) || preview ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type", "vary": "origin" } : {};
}

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { status, headers: { "content-type": "application/json", ...headers } });

/** Config changes must be signed by a current member of the chest, and be recent. */
async function memberSigned(body: { message?: string; signature?: Hex }, chest: Address): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  if (!body.message || !body.signature) return { ok: false, error: "missing signature" };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body.message);
  } catch {
    return { ok: false, error: "message must be JSON" };
  }
  if (String(data.chest).toLowerCase() !== chest.toLowerCase()) return { ok: false, error: "wrong chest" };
  if (typeof data.at !== "number" || Math.abs(Date.now() - data.at) > 10 * 60 * 1000) return { ok: false, error: "stale message" };
  const signer = await recoverMessageAddress({ message: body.message, signature: body.signature });
  const member = await publicClient.readContract({ address: chest, abi: collectiveAbi, functionName: "isMember", args: [signer] });
  return member ? { ok: true, data } : { ok: false, error: "signer is not a member" };
}

function parseVendors(v: unknown): Vendor[] | null {
  if (!Array.isArray(v) || v.length > 50) return null;
  const out: Vendor[] = [];
  for (const x of v as Record<string, unknown>[]) {
    if (typeof x.name !== "string" || typeof x.emailDomain !== "string" || !isAddress(String(x.payTo))) return null;
    if (!/^\d+(\.\d{1,6})?$/.test(String(x.typicalUsdc)) || !/^\d+(\.\d{1,6})?$/.test(String(x.maxUsdc))) return null;
    out.push({ name: x.name.slice(0, 60), emailDomain: x.emailDomain.toLowerCase().slice(0, 100), payTo: getAddress(String(x.payTo)), typicalUsdc: String(x.typicalUsdc), maxUsdc: String(x.maxUsdc) });
  }
  return out;
}

async function handleFetch(req: Request, env: Env): Promise<Response> {
  const h = cors(env, req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...h, "access-control-allow-methods": "GET, POST, OPTIONS" } });
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/cctp/fee") {
    const domain = Number(url.searchParams.get("source") ?? "6");
    if (!(domain in SOURCE_DOMAINS)) return json({ error: "unsupported source chain" }, 400, h);
    return json({ source: domain, feeBps: await fastFeeBps(domain) }, 200, h);
  }
  const chestParam = url.searchParams.get("chest") ?? "";
  if (!isAddress(chestParam)) return json({ error: "chest address required" }, 400, h);
  const chest = getAddress(chestParam);
  const managed = chestsOf(env).some((c) => c === chest);

  if (req.method === "GET" && url.pathname === "/decisions") {
    return json({ agent: agentWallet(env).account.address, managed, model: judgeFor(env).name, decisions: await listDecisions(env, chest) }, 200, h);
  }
  if (req.method === "GET" && url.pathname === "/vendors") return json({ vendors: await getVendors(env, chest) }, 200, h);
  if (req.method === "GET" && url.pathname === "/logs") {
    try {
      return json(await chestLogs(env, chest), 200, { ...h, "cache-control": "no-store" });
    } catch (e) {
      if (e instanceof NotAChest) return json({ error: e.message }, 404, h);
      throw e;
    }
  }
  if (!managed) return json({ error: "this agent does not operate that chest" }, 404, h);

  if (req.method === "POST" && url.pathname === "/cctp") {
    const body = (await req.json()) as { burnTx?: string; source?: number };
    const source = Number(body.source ?? 6);
    if (!isHex32(body.burnTx) || !(source in SOURCE_DOMAINS)) return json({ error: "burnTx and a supported source required" }, 400, h);
    await queueBurn(env, { sourceDomain: source, burnTx: body.burnTx, chest });
    return json({ ok: true }, 200, h);
  }
  if (req.method === "POST" && url.pathname === "/invoice-note") {
    const body = (await req.json()) as { id?: string; note?: string };
    if (!isHex32(body.id) || typeof body.note !== "string") return json({ error: "id and note required" }, 400, h);
    const result = await setInvoiceNote(env, chest, body.id, body.note);
    if (result === "closed") return json({ error: "no open invoice with that id" }, 404, h);
    if (result === "limit") return json({ error: "this invoice already has its notes" }, 429, h);
    return json({ ok: true }, 200, h);
  }

  if (req.method === "POST") {
    const body = (await req.json()) as { message?: string; signature?: Hex };
    const auth = await memberSigned(body, chest);
    if (!auth.ok) return json({ error: auth.error }, 403, h);
    if (url.pathname === "/vendors") {
      const vendors = parseVendors(auth.data.vendors);
      if (!vendors) return json({ error: "bad vendor list" }, 400, h);
      await putVendors(env, chest, vendors);
      return json({ ok: true, vendors }, 200, h);
    }
    if (url.pathname === "/inbox") {
      const mailbox = String(auth.data.mailbox ?? "");
      if (!/^[a-z0-9._+-]+@[a-z0-9.-]+$/i.test(mailbox)) return json({ error: "bad mailbox" }, 400, h);
      await setInbox(env, mailbox, chest);
      return json({ ok: true, mailbox }, 200, h);
    }
    if (url.pathname === "/reminder") {
      const { id, createdTx, lang } = auth.data;
      if (!isHex32(id) || !isHex32(createdTx)) return json({ error: "id and createdTx required" }, 400, h);
      try {
        return json(await draftReminder(env, chest, id, createdTx, lang === "tr" ? "tr" : "en", judgeFor(env)), 200, h);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "could not draft" }, 400, h);
      }
    }
    if (url.pathname === "/run") {
      await cycle(env, chest, { forceNote: auth.data.note === true });
      return json({ ok: true }, 200, h);
    }
  }
  return json({ error: "not found" }, 404, h);
}

export default {
  async scheduled(_event, env, ctx) {
    for (const chest of chestsOf(env)) ctx.waitUntil(cycle(env, chest));
  },
  async email(message, env) {
    await handleInvoiceEmail(env, message, judgeFor(env));
  },
  async fetch(req, env) {
    try {
      return await handleFetch(req, env);
    } catch (e) {
      // a malformed body or an RPC hiccup answers as an error instead of an uncaught 1101
      const bad = e instanceof SyntaxError;
      if (!bad) console.error("[http]", e instanceof Error ? e.message : e);
      return json({ error: bad ? "body must be JSON" : "agent error, try again" }, bad ? 400 : 500, cors(env, req));
    }
  },
} satisfies ExportedHandler<Env>;
