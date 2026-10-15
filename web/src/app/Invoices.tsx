import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router";
import { isAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { useSignMessage } from "wagmi";
import { collectiveAbi } from "../lib/abi";
import { agentMock, modelLabel, requestReminder, type ReminderDraft } from "../lib/agent";
import { explorerTx } from "../lib/arc";
import { pct, short, toUsdc, usdc } from "../lib/format";
import { useLang } from "../lib/i18n";
import { useTx } from "../lib/tx";
import type { Chest, Invoice } from "./useChest";
import { OnArc } from "./Wallet";

export function Invoices({ chest, invoices, loading, isMember, onChange }: { chest: Chest; invoices: Invoice[]; loading: boolean; isMember: boolean; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [reminding, setReminding] = useState<Hex | null>(null);
  const { t } = useLang();
  return (
    <div className="card tilt-r">
      <div className="between">
        <div>
          <div className="label">{t("inv.label")}</div>
          <div className="h3" style={{ marginTop: 4 }}>{t("inv.title")}</div>
        </div>
        {isMember && <button className="btn small" onClick={() => setOpen(!open)}>{open ? t("inv.close") : t("inv.new")}</button>}
      </div>
      {open && <NewInvoice chest={chest} onDone={() => { setOpen(false); onChange(); }} />}
      {loading ? (
        <div className="skeleton" style={{ marginTop: 14, height: 60 }} />
      ) : invoices.length === 0 ? (
        <p className="note muted" style={{ marginTop: 14 }}>{t("inv.none")}</p>
      ) : (
        <table className="simple" style={{ marginTop: 14 }}>
          <tbody>
            {invoices.map((inv) => (
              <Fragment key={inv.id}>
                <tr>
                  <td>{usdc(inv.amount)} USDC</td>
                  <td>{inv.contributors.map((m, i) => `${short(m)} ${pct(inv.sharesBps[i])}`).join(" · ")}</td>
                  <td><span className={`chip ${inv.status === 2 ? "paid" : inv.status === 1 ? "open" : ""}`}>{t(`inv.status.${inv.status}`)}</span></td>
                  <td className="invacts">
                    {inv.status === 1 && <Link to={`/pay/${chest.address}/${inv.id}`}>{t("inv.payLink")}</Link>}
                    {inv.status === 1 && (isMember || agentMock()) && (
                      <button className="linkbtn" aria-expanded={reminding === inv.id} onClick={() => setReminding(reminding === inv.id ? null : inv.id)}>{t("inv.remind")}</button>
                    )}
                    {inv.paidTx && <a href={explorerTx(inv.paidTx)} target="_blank" rel="noreferrer">tx ↗</a>}
                  </td>
                </tr>
                {reminding === inv.id && (
                  <tr className="remindrow"><td colSpan={4}><Reminder chest={chest} invoice={inv} /></td></tr>
                )}
              </Fragment>
            ))}
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
  const [copied, setCopied] = useState(false);

  async function ask() {
    setBusy(true);
    setError("");
    try {
      const d = await requestReminder(chest.address, { id: invoice.id, createdTx: invoice.createdTx, amount: invoice.amount }, lang, (m) => signMessageAsync({ message: m }));
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

  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const mail = `mailto:?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(text)}`;
  return (
    <div className="remind">
      <div className="between">
        <span className="hint">{t("inv.remind.by", { model: modelLabel(draft.model), days: draft.daysOpen })}</span>
        <span className="chip">{draft.subject}</span>
      </div>
      <textarea className="input" rows={8} value={text} onChange={(e) => setText(e.target.value)} aria-label={t("inv.remind.text")} />
      <div className="row">
        <a className="btn small" href={wa} target="_blank" rel="noreferrer">WhatsApp</a>
        <a className="btn small ghost" href={mail}>{t("inv.remind.mail")}</a>
        <button className="btn small ghost" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)); }}>{copied ? t("inv.remind.copied") : t("inv.remind.copy")}</button>
      </div>
      <p className="hint">{t("inv.remind.note")}</p>
    </div>
  );
}

function NewInvoice({ chest, onDone }: { chest: Chest; onDone: () => void }) {
  const { send, busy } = useTx();
  const { t } = useLang();
  const [amount, setAmount] = useState("");
  const [payer, setPayer] = useState("");
  const [rows, setRows] = useState<{ member: Address; share: string }[]>([{ member: chest.members[0], share: "100" }]);

  const total = rows.reduce((s, r) => s + (Number(r.share) || 0), 0);
  const errors = useMemo(() => {
    const e: string[] = [];
    if (!(Number(amount) > 0)) e.push(t("inv.err.amount"));
    if (payer.trim() && !isAddress(payer.trim())) e.push(t("inv.err.payer"));
    if (Math.abs(total - 100) > 1e-9) e.push(t("inv.err.total", { n: total }));
    if (new Set(rows.map((r) => r.member)).size !== rows.length) e.push(t("inv.err.dup"));
    return e;
  }, [amount, payer, total, rows, t]);

  async function create() {
    const shares = rows.map((r) => Math.round(Number(r.share) * 100));
    shares[shares.length - 1] += 10_000 - shares.reduce((a, b) => a + b, 0); // absorb rounding
    const salt = keccak256(toHex(`${Date.now()}-${Math.random()}`));
    const ok = await send(t("tx.createInvoice"), {
      address: chest.address,
      abi: collectiveAbi,
      functionName: "createInvoice",
      args: [salt, toUsdc(amount), (payer.trim() || "0x0000000000000000000000000000000000000000") as Address, rows.map((r) => r.member), shares],
    });
    if (ok) onDone();
  }

  return (
    <div className="stack" style={{ marginTop: 16, paddingTop: 16, borderTop: "1px dashed rgba(29,26,22,.3)" }}>
      <div className="grid2">
        <label className="field"><span className="hint">{t("inv.amount")}</span><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="2000" /></label>
        <label className="field"><span className="hint">{t("inv.payer")}</span><input className="input" value={payer} onChange={(e) => setPayer(e.target.value)} placeholder={t("inv.anyone")} /></label>
      </div>
      <span className="hint">{t("inv.who")}</span>
      {rows.map((r, i) => (
        <div className="row" key={i}>
          <select className="input" style={{ flex: 2 }} value={r.member} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, member: e.target.value as Address } : x)))}>
            {chest.members.map((m) => <option key={m} value={m}>{short(m)}</option>)}
          </select>
          <input className="input" style={{ flex: 1 }} inputMode="decimal" value={r.share} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, share: e.target.value } : x)))} />
          <span className="mono">%</span>
          {rows.length > 1 && <button className="btn ghost small" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>}
        </div>
      ))}
      {rows.length < chest.members.length && (
        <button className="btn ghost small" style={{ alignSelf: "flex-start" }} onClick={() => setRows([...rows, { member: chest.members.find((m) => !rows.some((r) => r.member === m)) ?? chest.members[0], share: "0" }])}>{t("inv.addPerson")}</button>
      )}
      {errors.length > 0 && <div className="error">{errors[0]}</div>}
      <OnArc><button className="btn" disabled={errors.length > 0 || busy} onClick={create}>{busy ? t("inv.pinning") : t("inv.pin")}</button></OnArc>
    </div>
  );
}
