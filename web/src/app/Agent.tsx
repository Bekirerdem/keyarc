import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { encodeAbiParameters, isAddress, type Address, type Hex } from "viem";
import { useSignMessage } from "wagmi";
import { collectiveAbi } from "../lib/abi";
import { explorerAddress, explorerTx, publicClient } from "../lib/arc";
import { agentMock, getFeed, getVendors, modelLabel, modelText, signedPost, type Decision, type Vendor } from "../lib/agent";
import { kindIndex } from "../lib/contracts";
import { short } from "../lib/format";
import { useLang } from "../lib/i18n";
import { useTx } from "../lib/tx";
import type { Chest, Rules } from "./useChest";
import { SendRow } from "./Invoices";
import { OnArc } from "./Wallet";

const RULES_T = [{
  type: "tuple",
  components: [
    { name: "reserveBps", type: "uint16" }, { name: "reserveTarget", type: "uint256" }, { name: "autoAttributeCap", type: "uint256" },
    { name: "expenseCapPerPeriod", type: "uint256" }, { name: "quorumBps", type: "uint16" }, { name: "timelock", type: "uint32" },
    { name: "periodLength", type: "uint32" },
  ],
}] as const;
const ZERO_REF = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export function AgentPanel({ chest, isMember, onChange }: { chest: Chest; isMember: boolean; onChange: () => void }) {
  const { t } = useLang();
  const { send, busy } = useTx();
  const feed = useQuery({ queryKey: ["agent-feed", chest.address], queryFn: () => getFeed(chest.address), refetchInterval: 20_000, retry: 1 });

  const f = feed.data;
  // ?mock=1 is a walkthrough: show the panel as a connected member would see it
  const demo = agentMock();
  const canEdit = isMember || demo;
  const connected = !!f && f.managed && (demo || f.agent.toLowerCase() === chest.agent.toLowerCase());
  const note = f?.decisions.find((d) => d.kind === "note");
  const rest = f?.decisions.filter((d) => d !== note) ?? [];

  const connectVote = () =>
    f && send(t("tx.agentVote"), {
      address: chest.address, abi: collectiveAbi, functionName: "propose",
      args: [kindIndex("SetAgent"), encodeAbiParameters([{ type: "address" }], [f.agent]), ZERO_REF],
    }).then((r) => r && onChange());

  return (
    <div className="card agentcard pin-gold">
      <div className="between" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="label">{t("ag.label")}</div>
          <div className="h3" style={{ marginTop: 4 }}>{t("ag.title")}</div>
        </div>
        <div className="row">
          {demo && <span className="chip">{t("ag.sample")}</span>}
          {f && <span className="chip">{modelLabel(f.model)}</span>}
        </div>
      </div>

      {feed.isLoading && <div className="skeleton" style={{ marginTop: 14, height: 90 }} />}
      {feed.isError && <p className="hint" style={{ marginTop: 12 }}>{t("ag.unreachable")}</p>}

      {f && (
        <>
          <div className="agentmeta">
            <span className="label">{t("ag.address")}</span>
            <a className="mono" href={explorerAddress(f.agent)} target="_blank" rel="noreferrer">{short(f.agent)} ↗</a>
            {connected ? (
              <span className="chip paid">{t("ag.connected")}</span>
            ) : (
              <span className="hint">{t("ag.notConnected")}</span>
            )}
          </div>
          {!connected && canEdit && (
            <OnArc><button className="btn small" disabled={busy} onClick={connectVote}>{t("ag.connectVote")}</button></OnArc>
          )}

          {note && <NoteCard d={note} chest={chest} isMember={canEdit} onChange={onChange} />}

          <div className="label" style={{ marginTop: 18 }}>{t("ag.decisions")}</div>
          {rest.length === 0 ? (
            <p className="note muted" style={{ marginTop: 8 }}>{t("ag.empty")}</p>
          ) : (
            <div className="declist">
              {rest.map((d) => <DecisionCard key={d.id + d.at} d={d} />)}
            </div>
          )}

          {canEdit && <Settings chest={chest} onRan={() => feed.refetch()} />}
        </>
      )}
    </div>
  );
}

function DecisionCard({ d }: { d: Decision }) {
  const { t, lang } = useLang();
  const reading = modelText(d);
  const when = new Date(d.at).toLocaleString(lang === "tr" ? "tr-TR" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <article className={`decision o-${d.outcome}`}>
      <header className="between" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="mono muted" style={{ fontSize: 11 }}>{when}</div>
          <div className="dtitle">{d.title}</div>
        </div>
        <span className={`obadge o-${d.outcome}`}>{t(`ag.o.${d.outcome}`)}</span>
      </header>
      {d.outcome === "rejected" && <span className="stamp refused">{t("ag.stamp.refused")}</span>}

      {Object.keys(d.facts).length > 0 && (
        <div className="dsection">
          <div className="label">{t("ag.facts")}</div>
          <table className="simple facts">
            <tbody>
              {Object.entries(d.facts).map(([k, v]) => (
                <tr key={k}><th>{k}</th><td>{v}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {d.checks.length > 0 && (
        <div className="dsection">
          <div className="label">{t("ag.checks")}</div>
          <ul className="checks">
            {d.checks.map((c) => (
              <li key={c.name} className={c.ok ? "ok" : "bad"}>
                <span aria-hidden>{c.ok ? "✓" : "✗"}</span>
                <span><b>{c.name}</b> — {c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {reading && d.kind !== "reminder" && (
        <div className="reading">
          <div className="label">{t("ag.reasoning")}</div>
          <p className="note">{reading}</p>
        </div>
      )}
      {d.kind === "reminder" && reading && (
        <div className="reading">
          <div className="label">{t("ag.draft")}</div>
          <p className="note" style={{ whiteSpace: "pre-line" }}>{reading}</p>
          <SendRow subject={String((d.model?.output as { subject?: string } | undefined)?.subject ?? "")} text={reading} />
        </div>
      )}

      <footer className="mono dfoot">
        <span>{t("ag.ref")} {d.ref.slice(0, 10)}…{d.ref.slice(-4)}</span>
        {d.tx && <a href={explorerTx(d.tx)} target="_blank" rel="noreferrer">{t("ag.tx")}</a>}
      </footer>
    </article>
  );
}

function NoteCard({ d, chest, isMember, onChange }: { d: Decision; chest: Chest; isMember: boolean; onChange: () => void }) {
  const { t } = useLang();
  const { send, busy } = useTx();
  const o = (d.model?.output ?? {}) as { body?: string; suggestion?: string; suggestedReservePercent?: number };
  const pctNext = o.suggestedReservePercent ?? 0;
  const suggests = (o.suggestion === "raise_reserve" || o.suggestion === "lower_reserve") && pctNext >= 0 && pctNext <= 50 && Math.round(pctNext * 100) !== chest.rules.reserveBps;

  const vote = () => {
    const target = chest.rules.reserveTarget > 0n ? chest.rules.reserveTarget : 300_000_000n; // 300 USDC ceiling when turning it on
    const next: Rules = { ...chest.rules, reserveBps: Math.round(pctNext * 100), reserveTarget: target };
    return send(t("tx.agentVote"), {
      address: chest.address, abi: collectiveAbi, functionName: "propose",
      args: [kindIndex("SetRules"), encodeAbiParameters(RULES_T, [next]), d.ref],
    }).then((r) => r && onChange());
  };

  return (
    <div className="notecard">
      <div className="label">{t("ag.note")}</div>
      <div className="h3" style={{ marginTop: 6 }}>{d.title}</div>
      {o.body && <p className="note" style={{ marginTop: 8 }}>{o.body}</p>}
      {!o.body && (
        <table className="simple facts" style={{ marginTop: 8 }}>
          <tbody>{Object.entries(d.facts).map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody>
        </table>
      )}
      {suggests && (
        <div className="row" style={{ marginTop: 12 }}>
          <span className="mono">{t("ag.suggest", { pct: pctNext })}</span>
          {isMember && <OnArc><button className="btn small" disabled={busy} onClick={vote}>{t("ag.suggestVote")}</button></OnArc>}
        </div>
      )}
    </div>
  );
}

type Row = { name: string; emailDomain: string; payTo: string; typicalUsdc: string; maxUsdc: string };
const blank: Row = { name: "", emailDomain: "", payTo: "", typicalUsdc: "", maxUsdc: "" };
const amountOk = (s: string) => /^\d+(\.\d{1,6})?$/.test(s.trim());

function Settings({ chest, onRan }: { chest: Chest; onRan: () => void }) {
  const { t } = useLang();
  const { send, busy } = useTx();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const vendors = useQuery({ queryKey: ["agent-vendors", chest.address], queryFn: () => getVendors(chest.address), retry: 1 });
  const [rows, setRows] = useState<Row[]>([]);
  const [mailbox, setMailbox] = useState("bills@keyarc.app");
  const [msg, setMsg] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (vendors.data) setRows(vendors.data.map((v) => ({ ...v })));
  }, [vendors.data]);

  const payees = useQuery({
    queryKey: ["agent-payees", chest.address, rows.map((r) => r.payTo).join(",")],
    enabled: rows.some((r) => isAddress(r.payTo)),
    queryFn: async () => {
      const addrs = rows.map((r) => r.payTo).filter((a): a is Address => isAddress(a));
      const res = await publicClient.multicall({
        allowFailure: false,
        contracts: addrs.map((a) => ({ address: chest.address, abi: collectiveAbi, functionName: "isPayee", args: [a] }) as const),
      });
      return Object.fromEntries(addrs.map((a, i) => [a.toLowerCase(), res[i] as boolean]));
    },
  });

  const valid = rows.every((r) => r.name.trim() && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(r.emailDomain.trim()) && isAddress(r.payTo.trim()) && amountOk(r.typicalUsdc) && amountOk(r.maxUsdc));
  const sign = (m: string) => signMessageAsync({ message: m }) as Promise<Hex>;

  async function run(label: string, fn: () => Promise<void>) {
    setWorking(true);
    setMsg(null);
    try {
      await fn();
      setMsg(label);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  const save = () => run(t("ag.v.saved"), async () => {
    const list: Vendor[] = rows.map((r) => ({ name: r.name.trim(), emailDomain: r.emailDomain.trim().toLowerCase(), payTo: r.payTo.trim() as Address, typicalUsdc: r.typicalUsdc.trim(), maxUsdc: r.maxUsdc.trim() }));
    await signedPost("/vendors", chest.address, { vendors: list }, sign);
    await qc.invalidateQueries({ queryKey: ["agent-vendors", chest.address] });
  });

  const allowVote = (addr: Address) =>
    send(t("tx.agentVote"), {
      address: chest.address, abi: collectiveAbi, functionName: "propose",
      args: [kindIndex("SetPayee"), encodeAbiParameters([{ type: "address" }, { type: "bool" }], [addr, true]), ZERO_REF],
    });

  const set = (i: number, k: keyof Row, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  return (
    <details className="agentsettings">
      <summary className="label">{t("ag.settings")}</summary>

      <div className="dsection">
        <div className="label">{t("ag.vendors")}</div>
        <p className="hint" style={{ marginTop: 4 }}>{t("ag.vendorsHint")}</p>
        <div className="vendorrows">
          {rows.map((r, i) => {
            const allowed = isAddress(r.payTo) ? payees.data?.[r.payTo.toLowerCase()] : undefined;
            return (
              <div className="vendorrow" key={i}>
                <input className="input" aria-label={t("ag.v.name")} placeholder={t("ag.v.name")} value={r.name} onChange={(e) => set(i, "name", e.target.value)} />
                <input className="input" aria-label={t("ag.v.domain")} placeholder="figma.com" value={r.emailDomain} onChange={(e) => set(i, "emailDomain", e.target.value)} />
                <input className="input wide" aria-label={t("ag.v.payTo")} placeholder="0x…" value={r.payTo} onChange={(e) => set(i, "payTo", e.target.value)} />
                <label className="field"><span className="label">{t("ag.v.typical")}</span><input className="input" placeholder="0" inputMode="decimal" value={r.typicalUsdc} onChange={(e) => set(i, "typicalUsdc", e.target.value)} /></label>
                <label className="field"><span className="label">{t("ag.v.max")}</span><input className="input" placeholder="0" inputMode="decimal" value={r.maxUsdc} onChange={(e) => set(i, "maxUsdc", e.target.value)} /></label>
                <div className="row">
                  {allowed !== undefined && <span className={`chip ${allowed ? "paid" : "open"}`}>{t(allowed ? "ag.v.allowed" : "ag.v.notAllowed")}</span>}
                  {allowed === false && <OnArc><button className="btn small" disabled={busy} onClick={() => allowVote(r.payTo as Address)}>{t("ag.v.allowVote")}</button></OnArc>}
                  <button className="btn ghost small" onClick={() => setRows(rows.filter((_, j) => j !== i))}>{t("ag.v.remove")}</button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn ghost small" onClick={() => setRows([...rows, { ...blank }])}>{t("ag.v.add")}</button>
          <button className="btn small" disabled={!valid || working} onClick={save}>{t("ag.v.save")}</button>
        </div>
        {!valid && rows.length > 0 && <div className="error" style={{ marginTop: 6 }}>{t("ag.v.invalid")}</div>}
      </div>

      <div className="dsection">
        <div className="label">{t("ag.inbox")}</div>
        <p className="hint" style={{ marginTop: 4 }}>{t("ag.inboxHint")}</p>
        <div className="row" style={{ marginTop: 8 }}>
          <input className="input" style={{ flex: 1, minWidth: 200 }} value={mailbox} onChange={(e) => setMailbox(e.target.value)} />
          <button className="btn small" disabled={working || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mailbox)} onClick={() => run(t("ag.done"), () => signedPost("/inbox", chest.address, { mailbox: mailbox.trim().toLowerCase() }, sign))}>{t("ag.inboxSave")}</button>
        </div>
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn red small" disabled={working} onClick={() => run(t("ag.done"), async () => { await signedPost("/run", chest.address, { note: true }, sign); onRan(); })}>
          {working ? t("ag.running") : t("ag.run")}
        </button>
        {msg && <span className="mono">{msg}</span>}
      </div>
    </details>
  );
}
