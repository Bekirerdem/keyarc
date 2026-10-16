import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { agentWallet, collectiveAbi, isHex32, publicClient } from "./chain";
import { fastFeeBps, queueBurn, relayBurns, SOURCE_DOMAINS } from "./cctp";
import { runCollections, setInvoiceNote } from "./collections";
import type { Env } from "./env";
import { ClaudeJudge, NoJudge, type Judge } from "./llm";
import { listDecisions } from "./log";
import { chestLogs, isCurrentClone, NotAChest } from "./logindex";
import { getVendors, handleInvoiceEmail, putVendors, setInbox, type Vendor } from "./payables";
import { draftReminder, rememberLang, runReminders } from "./reminders";
import deployment from "../../deployments/arc-mainnet.json";
import { runTreasuryNote } from "./treasury";

const judgeFor = (env: Env): Judge => (env.ANTHROPIC_API_KEY ? new ClaudeJudge(env.ANTHROPIC_API_KEY) : new NoJudge());
// CHESTS can name extra chests; the demo chest from the deployments file is always run
const chestsOf = (env: Env): Address[] => [deployment.demo.collective, ...env.CHESTS.split(",")].map((c) => c.trim()).filter((c) => isAddress(c)).map((c) => getAddress(c));
const REGISTRY = "managed";

/** Chests in CHESTS plus every chest that named this agent when it was opened. */
async function managedChests(env: Env): Promise<Address[]> {
  const joined = JSON.parse((await env.AGENT_KV.get(REGISTRY)) ?? "[]") as Address[];
  return [...new Set([...chestsOf(env), ...joined])];
}

/**
 * "Let the treasury agent collect for us" on the bill page writes this agent's address into the new chest.
 * The first request about such a chest registers it, so the agent runs it without a redeploy.
 */
async function isManaged(env: Env, chest: Address): Promise<boolean> {
  if ((await managedChests(env)).includes(chest)) return true;
  const [code, agent] = await Promise.all([
    publicClient.getCode({ address: chest }),
    publicClient.readContract({ address: chest, abi: collectiveAbi, functionName: "agent" }).catch(() => null),
  ]);
  if (!code || !isCurrentClone(code) || !agent || getAddress(agent) !== agentWallet(env).account.address) return false;
  const joined = JSON.parse((await env.AGENT_KV.get(REGISTRY)) ?? "[]") as Address[];
  await env.AGENT_KV.put(REGISTRY, JSON.stringify([...joined, chest].slice(-200)));
  return true;
}

/** One pass over a chest. Each step is isolated so one failure doesn't stop the others. */
async function cycle(env: Env, chest: Address, opts: { forceNote?: boolean } = {}) {
  const judge = judgeFor(env);
  const steps: [string, () => Promise<void>][] = [
    ["relay", () => relayBurns(env)],
    ["collections", () => runCollections(env, chest, judge)],
    ["reminders", () => runReminders(env, chest, judge)],
    ["treasury", () => runTreasuryNote(env, chest, judge, opts.forceNote)],
  ];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (e) {
      console.error(`[${name}] ${chest}:`, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * Carry a contributor's signed agreement to the chest, so agreeing to a share costs them no gas. The signature is the
 * authorisation; the call is simulated first, so a bad or repeated signature costs the agent nothing.
 */
async function relayApproval(env: Env, chest: Address, id: Hex, member: Address, signature: Hex): Promise<Hex> {
  const { account, wallet } = agentWallet(env);
  const { request } = await publicClient.simulateContract({ address: chest, abi: collectiveAbi, functionName: "approveInvoiceFor", args: [id, member, signature], account });
  const tx = await wallet.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash: tx });
  return tx;
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
  const managed = await isManaged(env, chest);

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
  if (req.method === "POST" && url.pathname === "/approve") {
    const body = (await req.json()) as { id?: string; member?: string; signature?: string };
    if (!isHex32(body.id) || !isAddress(String(body.member)) || !/^0x[0-9a-fA-F]{130,}$/.test(String(body.signature))) {
      return json({ error: "id, member and signature required" }, 400, h);
    }
    try {
      return json({ ok: true, tx: await relayApproval(env, chest, body.id, getAddress(String(body.member)), body.signature as Hex) }, 200, h);
    } catch (e) {
      const why = e instanceof Error ? (/BadSignature|AlreadyApproved|NotAContributor|InvoiceNotOpen/.exec(e.message)?.[0] ?? "could not relay") : "could not relay";
      return json({ error: why }, 400, h);
    }
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
      // the agent's own overdue reminders are written in the language members use
      await rememberLang(env, chest, lang === "tr" ? "tr" : "en");
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
  async scheduled(event, env, ctx) {
    // One chest per run: every subrequest of a run counts against the same 50, so chests take turns by the minute.
    const chests = await managedChests(env);
    if (chests.length === 0) return;
    ctx.waitUntil(cycle(env, chests[Math.floor(event.scheduledTime / 60_000) % chests.length]));
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
