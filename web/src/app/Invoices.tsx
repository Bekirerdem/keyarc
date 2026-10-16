import { Fragment, useState } from "react";
import { Link } from "react-router";
import type { Hex } from "viem";
import { useConnection, useSignMessage } from "wagmi";
import { agentMock, modelLabel, requestReminder, type ReminderDraft } from "../lib/agent";
import { explorerTx } from "../lib/arc";
import { pct, usdc } from "../lib/format";
import { useLang } from "../lib/i18n";
import { useNames } from "../lib/team";
import { AgreeButton } from "./Agree";
import { waitingOn, type Chest, type Invoice } from "./useChest";

const DAY = 86_400;

/** "due in 3 days" / "5 days late" for an open invoice with a due date. */
export function useDue() {
  const { t, lang } = useLang();
  return (inv: Pick<Invoice, "dueAt" | "status">) => {
    if (!inv.dueAt || inv.status !== 1) return null;
    const now = Math.floor(Date.now() / 1000);
    const date = new Date(inv.dueAt * 1000).toLocaleDateString(lang === "tr" ? "tr-TR" : "en-GB", { day: "numeric", month: "short" });
    if (now > inv.dueAt) {
      const n = Math.floor((now - inv.dueAt) / DAY);
      return { late: true, text: n < 1 ? t("inv.lateToday", { date }) : t("inv.late", { n, date }) };
    }
    return { late: false, text: t("inv.due", { date }) };
  };
}

export function Invoices({ chest, invoices, loading, isMember, onChange }: { chest: Chest; invoices: Invoice[]; loading: boolean; isMember: boolean; onChange: () => void }) {
  const [reminding, setReminding] = useState<Hex | null>(null);
  const { t } = useLang();
  const { address: me } = useConnection();
  const who = useNames(chest.address);
  const due = useDue();
  return (
    <div className="card tilt-r">
      <div className="between">
        <div>
          <div className="label">{t("inv.label")}</div>
          <div className="h3" style={{ marginTop: 4 }}>{t("inv.title")}</div>
        </div>
        {isMember && <Link className="btn small" to={`/app/bill?team=${chest.address}`}>{t("inv.new")}</Link>}
      </div>
      {loading ? (
        <div className="skeleton" style={{ marginTop: 14, height: 60 }} />
      ) : invoices.length === 0 ? (
        <p className="note muted" style={{ marginTop: 14 }}>{t("inv.none")}</p>
      ) : (
        <table className="simple invtable" style={{ marginTop: 14 }}>
          <tbody>
            {invoices.map((inv) => {
              const waiting = inv.status === 1 ? waitingOn(inv) : [];
              const mine = !!me && waiting.some((m) => m.toLowerCase() === me.toLowerCase());
              const d = due(inv);
              return (
                <Fragment key={inv.id}>
                  <tr>
                    <td>
                      <b>{usdc(inv.amount)} USDC</b>
                      {inv.note && <div className="hint">{inv.note}</div>}
                    </td>
                    <td>
                      {inv.contributors.map((m, i) => (
                        <div key={m} className="mono">
                          {inv.status === 1 && <span aria-hidden>{inv.agreed.has(m.toLowerCase()) ? "✓ " : "· "}</span>}
                          {who(m)} {pct(inv.sharesBps[i])}
                        </div>
                      ))}
                    </td>
                    <td>
                      {inv.status === 1 && waiting.length > 0
                        ? <span className="chip">{t("inv.waiting", { n: waiting.length })}</span>
                        : <span className={`chip ${inv.status === 2 ? "paid" : inv.status === 1 ? "open" : ""}`}>{t(`inv.status.${inv.status}`)}</span>}
                      {d && <div className={`hint ${d.late ? "late" : ""}`} style={{ marginTop: 4 }}>{d.text}</div>}
                    </td>
                    <td className="invacts">
                      {mine && <AgreeButton chest={chest.address} id={inv.id} onDone={onChange} />}
                      {inv.status === 1 && <Link to={`/pay/${chest.address}/${inv.id}`}>{t("inv.payLink")}</Link>}
                      {inv.status === 1 && waiting.length === 0 && (isMember || agentMock()) && (
                        <button className="linkbtn" aria-expanded={reminding === inv.id} onClick={() => setReminding(reminding === inv.id ? null : inv.id)}>{t("inv.remind")}</button>
                      )}
                      {inv.paidTx && <a href={explorerTx(inv.paidTx)} target="_blank" rel="noreferrer">tx ↗</a>}
                    </td>
                  </tr>
                  {reminding === inv.id && (
                    <tr className="remindrow"><td colSpan={4}><Reminder chest={chest} invoice={inv} /></td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** The agent words a reminder from on-chain facts; the team reads it, edits it and sends it from their own app. */
function Reminder({ chest, invoice }: { chest: Chest; invoice: Invoice }) {
  const { t, lang } = useLang();
  const { signMessageAsync } = useSignMessage();
  const [draft, setDraft] = useState<ReminderDraft | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function ask() {
    setBusy(true);
    setError("");
    try {
      const d = await requestReminder(chest.address, { id: invoice.id, createdTx: invoice.createdTx, amount: invoice.amount, note: invoice.note }, lang, (m) => signMessageAsync({ message: m }));
      setDraft(d);
      setText(d.message);
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!draft) {
    return (
      <div className="remind">
        <p className="hint">{t("inv.remind.why")}</p>
        <div className="row">
          <button className="btn small" disabled={busy} onClick={ask}>{busy ? t("inv.remind.drafting") : t("inv.remind.ask")}</button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="remind">
      <div className="between">
        <span className="hint">{t("inv.remind.by", { model: modelLabel(draft.model), days: draft.daysOpen })}</span>
        <span className="chip">{draft.subject}</span>
      </div>
      <textarea className="input" rows={8} value={text} onChange={(e) => setText(e.target.value)} aria-label={t("inv.remind.text")} />
      <SendRow subject={draft.subject} text={text} />
      <p className="hint">{t("inv.remind.note")}</p>
    </div>
  );
}

/** WhatsApp, email or copy: the team sends a reminder through the channel it already uses. */
export function SendRow({ subject, text }: { subject: string; text: string }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const mail = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  return (
    <div className="row">
      <a className="btn small" href={wa} target="_blank" rel="noreferrer">WhatsApp</a>
      <a className="btn small ghost" href={mail}>{t("inv.remind.mail")}</a>
      <button className="btn small ghost" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)); }}>{copied ? t("inv.remind.copied") : t("inv.remind.copy")}</button>
    </div>
  );
}
