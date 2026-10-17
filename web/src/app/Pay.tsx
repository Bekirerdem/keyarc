import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { encodeFunctionData, isAddress, isHex, type Address, type Hex } from "viem";
import { useConnection } from "wagmi";
import { collectiveAbi, erc20Abi, memoAbi } from "../lib/abi";
import { explorerTx, publicClient } from "../lib/arc";
import { MEMO, USDC, versionOf } from "../lib/contracts";
import { pct, short, usdc } from "../lib/format";
import { useLang } from "../lib/i18n";
import { collectiveLogs } from "../lib/logs";
import { useNames } from "../lib/team";
import { useTx } from "../lib/tx";
import { AgreeButton } from "./Agree";
import { useDue } from "./Invoices";
import { PayFromBase } from "./PayFromBase";
import { invoicesFrom } from "./useChest";
import { Brand, OnArc, useUsdcBalance, Wallet } from "./Wallet";

function useInvoice(chest?: Address, id?: Hex, me?: Address) {
  return useQuery({
    queryKey: ["invoice", chest, id, me],
    enabled: !!chest && !!id,
    refetchInterval: 10_000,
    queryFn: async () => {
      if (versionOf(await publicClient.getCode({ address: chest! })) !== "current") return null;
      const [inv, name, allowance, agreedByMe] = await Promise.all([
        publicClient.readContract({ address: chest!, abi: collectiveAbi, functionName: "invoice", args: [id!] }),
        publicClient.readContract({ address: chest!, abi: collectiveAbi, functionName: "name" }),
        me ? publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [me, chest!] }) : Promise.resolve(0n),
        me ? publicClient.readContract({ address: chest!, abi: collectiveAbi, functionName: "approved", args: [id!, me] }) : Promise.resolve(false),
      ]);
      const [amount, creator, payer, status, dueAt, reserveBps, pending, contributors, sharesBps] = inv;
      return { amount, creator, payer, status, dueAt: Number(dueAt), reserveBps, pending, contributors, sharesBps, name, allowance, agreedByMe };
    },
  });
}

/** What the invoice was for and, once paid, where each share went: read from the chest's own events. */
function useStory(chest?: Address, id?: Hex) {
  return useQuery({
    queryKey: ["invoice-story", chest, id],
    enabled: !!chest && !!id,
    refetchInterval: 15_000,
    retry: 1,
    queryFn: async () => {
      const events = await collectiveLogs(chest!);
      const inv = invoicesFrom(events).find((x) => x.id.toLowerCase() === id!.toLowerCase());
      const paidAt = inv?.paidTx ? events.find((e) => e.transactionHash === inv.paidTx)?.blockNumber : undefined;
      const when = paidAt ? Number((await publicClient.getBlock({ blockNumber: paidAt })).timestamp) : undefined;
      return inv ? { ...inv, paidAtS: when } : null;
    },
  });
}

export default function Pay() {
  const { chest: c, id: i } = useParams();
  const chest = c && isAddress(c) ? (c as Address) : undefined;
  const id = i && isHex(i) && i.length === 66 ? (i as Hex) : undefined;
  const { address: me } = useConnection();
  const inv = useInvoice(chest, id, me);
  const story = useStory(chest, id);
  const bal = useUsdcBalance(me);
  const { send, busy } = useTx();
  const qc = useQueryClient();
  const [paidTx, setPaidTx] = useState<Hex | null>(null);
  const [via, setVia] = useState<"arc" | "base">("arc");
  const { t, lang } = useLang();
  const due = useDue();

  const d = inv.data;
  const exists = d && d.status !== 0;
  const wrongPayer = d && me && !/^0x0+$/.test(d.payer) && d.payer.toLowerCase() !== me.toLowerCase();
  const short_ = d && bal.data !== undefined && bal.data < d.amount;
  const allowed = d && d.allowance >= d.amount;
  const waiting = !!d && d.status === 1 && d.pending > 0;
  const iMustAgree = !!d && !!me && waiting && !d.agreedByMe && d.contributors.some((m) => m.toLowerCase() === me.toLowerCase());
  // the same link goes to the team and to the client: someone on the team gets "send it to the client", not a pay button
  const onTeam = !!d && !!me && [d.creator, ...d.contributors].some((m) => m.toLowerCase() === me.toLowerCase());
  const [payAnyway, setPayAnyway] = useState(false);
  const [copied, setCopied] = useState(false);
  const payHere = !onTeam || payAnyway;
  const who = useNames(chest);
  const label = (m: Address) => `${who(m)}${me && m.toLowerCase() === me.toLowerCase() ? ` · ${t("b.you")}` : ""}`;
  const refresh = () => qc.invalidateQueries();
  const dueLine = d ? due({ dueAt: d.dueAt, status: d.status }) : null;

  async function approve() {
    if (!d || !chest) return;
    // approve exactly this invoice, never an open-ended allowance
    const r = await send(t("tx.allow"), { address: USDC, abi: erc20Abi, functionName: "approve", args: [chest, d.amount] });
    if (r) qc.invalidateQueries({ queryKey: ["invoice", chest, id, me] });
  }

  async function pay() {
    if (!d || !chest || !id) return;
    // Pay through Arc's Memo contract: the invoice id is written to Arc's memo log, the payer stays msg.sender.
    const data = encodeFunctionData({ abi: collectiveAbi, functionName: "payInvoice", args: [id, d.amount] });
    const r = await send(t("tx.payInvoice"), { address: MEMO, abi: memoAbi, functionName: "memo", args: [chest, data, id, "0x"] });
    if (r) {
      setPaidTx(r.transactionHash);
      refresh();
    }
  }

  const s = story.data;
  const paidDate = s?.paidAtS ? new Date(s.paidAtS * 1000).toLocaleString(lang === "tr" ? "tr-TR" : "en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <div className="board" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,560px) minmax(0,1fr)" }}>
      <aside className="rail noprint"><Brand /></aside>
      <main className="main">
        {!chest || !id ? (
          <div className="card"><p className="note">{t("pay.broken")}</p></div>
        ) : inv.isLoading ? (
          <div className="card"><div className="skeleton" style={{ height: 220 }} /></div>
        ) : !exists ? (
          <div className="card"><p className="note">{t("pay.missing")}</p></div>
        ) : (
          <>
            <div className="card tape no-pin receipt-card">
              <div className="label">{t("pay.from")}</div>
              <h1 className="title" style={{ marginTop: 6 }}>{d!.name}</h1>
              {s?.note && <p className="note" style={{ marginTop: 8 }}>{s.note}</p>}
              <div className="amount" style={{ marginTop: 18, fontSize: 44 }}>{usdc(d!.amount)}<small>{t("pay.onArc")}</small></div>
              <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
                <span className={`chip ${d!.status === 2 ? "paid" : "open"}`}>{waiting ? t("inv.waiting", { n: d!.pending }) : t(`inv.status.${d!.status}`)}</span>
                {dueLine && <span className={`hint ${dueLine.late ? "late" : ""}`}>{dueLine.text}</span>}
              </div>
              <p className="mono hint" style={{ marginTop: 10 }}>{t("pay.ref", { id: `${id.slice(0, 10)}…${id.slice(-6)}` })}</p>
            </div>

            <div className="card tilt-l">
              <div className="label">{t("pay.who")}</div>
              <ul className="mono" style={{ listStyle: "none", marginTop: 10, display: "grid", gap: 6 }}>
                {d!.contributors.map((m, k) => (
                  <li key={m} className="between"><span>{label(m)}</span><span>{pct(d!.sharesBps[k])}</span></li>
                ))}
              </ul>
              <p className="hint" style={{ marginTop: 12 }}>{d!.reserveBps > 0 ? t("pay.explainReserve", { pct: pct(d!.reserveBps) }) : t("pay.explain")}</p>
            </div>

            {waiting && (
              <div className="card kraft">
                <div className="label">{t("pay.waitLabel")}</div>
                <p className="note" style={{ marginTop: 8 }}>{iMustAgree ? t("pay.youAgree") : onTeam ? t("pay.waitTeam", { n: d!.pending }) : t("pay.waitBody")}</p>
                {iMustAgree && <div style={{ marginTop: 12 }}><AgreeButton chest={chest} id={id} onDone={refresh} /></div>}
              </div>
            )}

            {d!.status === 1 && !waiting && !paidTx && !payHere && (
              <div className="card kraft noprint">
                <div className="label">{t("pay.teamLabel")}</div>
                <p className="note" style={{ marginTop: 8 }}>{t("pay.teamReady")}</p>
                <div className="row" style={{ marginTop: 14, flexWrap: "wrap" }}>
                  <button className="btn red" onClick={() => { void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true)); }}>{copied ? t("d.copied") : t("pay.copyForClient")}</button>
                  <button className="linkbtn" onClick={() => setPayAnyway(true)}>{t("pay.iPay")}</button>
                </div>
              </div>
            )}

            {d!.status === 1 && !waiting && !paidTx && payHere && (
              <div className="row noprint" role="tablist" aria-label={t("pay.via")}>
                <button role="tab" aria-selected={via === "arc"} className={`btn small ${via === "arc" ? "" : "ghost"}`} onClick={() => setVia("arc")}>{t("pay.viaArc")}</button>
                <button role="tab" aria-selected={via === "base"} className={`btn small ${via === "base" ? "" : "ghost"}`} onClick={() => setVia("base")}>{t("pay.viaBase")}</button>
              </div>
            )}
            {d!.status === 1 && !waiting && !paidTx && payHere && via === "base" && <PayFromBase chest={chest} invoiceId={id} amount={d!.amount} />}
            {d!.status === 1 && !waiting && !paidTx && payHere && via === "arc" && (
              <div className="card ink noprint">
                <div className="label">{t("pay.label")}</div>
                <ol className="mono" style={{ marginTop: 10, paddingLeft: 18, display: "grid", gap: 6 }}>
                  <li style={{ opacity: allowed ? 0.5 : 1 }}>{t("pay.step1", { amt: usdc(d!.amount) })}</li>
                  <li>{t("pay.step2")}</li>
                </ol>
                {me && bal.data !== undefined && <p className="mono" style={{ marginTop: 10, opacity: 0.8 }}>{t("pay.have", { amt: usdc(bal.data) })}</p>}
                {wrongPayer && <p className="error" style={{ marginTop: 10 }}>{t("pay.wrongPayer", { who: short(d!.payer) })}</p>}
                {short_ && <p className="error" style={{ marginTop: 10 }}>{t("pay.short")}</p>}
                <div className="row" style={{ marginTop: 16 }}>
                  <OnArc>
                    {!allowed ? (
                      <button className="btn" disabled={busy || !!wrongPayer || !!short_} onClick={approve}>{t("pay.allow", { amt: usdc(d!.amount) })}</button>
                    ) : (
                      <button className="btn red" disabled={busy || !!wrongPayer || !!short_} onClick={pay}>{t("pay.pay", { amt: usdc(d!.amount) })}</button>
                    )}
                  </OnArc>
                </div>
              </div>
            )}

            {(d!.status === 2 || paidTx) && (
              <div className="card kraft tilt-r receipt-card">
                <span className="stamp">{t("pay.stamp")}</span>
                <div className="label" style={{ marginTop: 14 }}>{t("pay.receipt")}</div>
                <table className="simple facts" style={{ marginTop: 8 }}>
                  <tbody>
                    <tr><th>{t("pay.r.team")}</th><td>{d!.name}</td></tr>
                    {s?.note && <tr><th>{t("pay.r.for")}</th><td>{s.note}</td></tr>}
                    <tr><th>{t("pay.r.amount")}</th><td>{usdc(d!.amount)} USDC</td></tr>
                    {paidDate && <tr><th>{t("pay.r.when")}</th><td>{paidDate}</td></tr>}
                    {(s?.toReserve ?? 0n) > 0n && <tr><th>{t("pay.r.reserve")}</th><td>{usdc(s!.toReserve!)} USDC</td></tr>}
                    {s?.payouts.map((p) => <tr key={p.member}><th>{label(p.member)}</th><td>{usdc(p.amount)} USDC</td></tr>)}
                    <tr><th>{t("pay.r.ref")}</th><td className="mono">{id}</td></tr>
                    {(paidTx ?? s?.paidTx) && <tr><th>{t("pay.r.tx")}</th><td><a className="mono" href={explorerTx((paidTx ?? s!.paidTx)!)} target="_blank" rel="noreferrer">{short(paidTx ?? s!.paidTx!)} ↗</a></td></tr>}
                  </tbody>
                </table>
                <p className="note" style={{ marginTop: 12 }}>{t("pay.thanks")}</p>
                <button className="btn ghost small noprint" style={{ marginTop: 12 }} onClick={() => window.print()}>{t("pay.print")}</button>
              </div>
            )}
            {d!.status === 3 && <div className="card"><p className="note">{t("pay.cancelled")}</p></div>}
          </>
        )}
      </main>
      <aside className="side noprint">
        <Wallet />
        {chest && <Link className="btn ghost small" style={{ alignSelf: "flex-start" }} to={`/c/${chest}`}>{t("pay.lookInside")}</Link>}
      </aside>
    </div>
  );
}
