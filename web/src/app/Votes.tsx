import { useState } from "react";
import { decodeAbiParameters, encodeAbiParameters, isAddress, type Address, type Hex } from "viem";
import { collectiveAbi } from "../lib/abi";
import { kindIndex, ProposalKind, type ProposalKindName } from "../lib/contracts";
import { pct, short, toUsdc, usdc } from "../lib/format";
import { useDuration, useLang } from "../lib/i18n";
import { useTx } from "../lib/tx";
import type { Chest, Proposal, Rules } from "./useChest";
import { OnArc } from "./Wallet";

const RULES_T = [{
  type: "tuple",
  components: [
    { name: "reserveBps", type: "uint16" }, { name: "reserveTarget", type: "uint256" }, { name: "autoAttributeCap", type: "uint256" },
    { name: "expenseCapPerPeriod", type: "uint256" }, { name: "quorumBps", type: "uint16" }, { name: "timelock", type: "uint32" },
    { name: "periodLength", type: "uint32" },
  ],
}] as const;

function describe(p: Proposal, t: (k: string, v?: Record<string, string | number>) => string): string {
  const k = ProposalKind[p.kind];
  try {
    switch (k) {
      case "AddMember": return t("vote.d.add", { who: short(decodeAbiParameters([{ type: "address" }], p.payload)[0]) });
      case "RemoveMember": return t("vote.d.remove", { who: short(decodeAbiParameters([{ type: "address" }], p.payload)[0]) });
      case "SetAgent": {
        const a = decodeAbiParameters([{ type: "address" }], p.payload)[0];
        return /^0x0+$/.test(a) ? t("vote.d.noAgent") : t("vote.d.agent", { who: short(a) });
      }
      case "SetPayee": {
        const [a, ok] = decodeAbiParameters([{ type: "address" }, { type: "bool" }], p.payload);
        return t(ok ? "vote.d.payee" : "vote.d.noPayee", { who: short(a) });
      }
      case "ReleaseReserve": {
        const [to, amt] = decodeAbiParameters([{ type: "address[]" }, { type: "uint256[]" }], p.payload);
        return t("vote.d.release", { amt: usdc(amt.reduce((s, x) => s + x, 0n)), who: to.map(short).join(", ") });
      }
      case "Attribute": {
        const [m, a] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], p.payload);
        return t("vote.d.attribute", { amt: usdc(a), who: short(m) });
      }
      case "Expense": {
        const [to, a] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], p.payload);
        return t("vote.d.expense", { amt: usdc(a), who: short(to) });
      }
      case "SettleInvoice": {
        const id = decodeAbiParameters([{ type: "bytes32" }], p.payload)[0];
        return t("vote.d.settle", { id: `${id.slice(0, 10)}…` });
      }
      case "SetRules": {
        const r = decodeAbiParameters(RULES_T, p.payload)[0];
        return r.reserveBps > 0 ? t("vote.d.rules", { pct: pct(r.reserveBps), amt: usdc(r.reserveTarget) }) : t("vote.d.rulesOff");
      }
    }
  } catch { /* fall through */ }
  return k;
}

export function Votes({ chest, isMember, me, onChange }: { chest: Chest; isMember: boolean; me?: Address; onChange: () => void }) {
  const { send, busy } = useTx();
  const { t } = useLang();
  const dur = useDuration();
  const now = Math.floor(Date.now() / 1000);
  const open = chest.proposals.filter((p) => !p.executed && !p.cancelled && p.epoch === chest.governanceEpoch && now <= p.expiresAt);
  const past = chest.proposals.filter((p) => !open.includes(p)).slice(0, 6);

  const act = (label: string, fn: "vote" | "unvote" | "execute" | "cancel", id: number) =>
    send(label, { address: chest.address, abi: collectiveAbi, functionName: fn, args: [BigInt(id)] }).then((r) => r && onChange());

  return (
    <div className="card tilt-l">
      <div className="label">{t("vote.label")}</div>
      <div className="h3" style={{ marginTop: 4 }}>{t("vote.title")}</div>
      <p className="hint" style={{ marginTop: 6 }}>{t("vote.hint", { d: dur(chest.rules.timelock) })}</p>

      <div className="stack" style={{ marginTop: 14 }}>
        {open.length === 0 && <p className="note muted">{t("vote.none")}</p>}
        {open.map((p) => {
          const ready = p.votes >= p.votesNeeded && now >= p.executableAt;
          return (
            <div key={p.id} className="card no-pin" style={{ background: "var(--paper-2)", animation: "none" }}>
              <div className="between">
                <span className="mono">#{p.id} · {describe(p, t)}</span>
                <span className="stamp">{p.votes}/{p.votesNeeded}</span>
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                {now < p.executableAt ? t("vote.canRun", { d: dur(p.executableAt - now) }) : t("vote.openFor", { d: dur(p.expiresAt - now) })} · {t("vote.by", { who: short(p.proposer) })}
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <OnArc>
                  {isMember && !p.iVoted && <button className="btn small" disabled={busy} onClick={() => act(t("tx.vote"), "vote", p.id)}>{t("vote.yes")}</button>}
                  {isMember && p.iVoted && <button className="btn ghost small" disabled={busy} onClick={() => act(t("tx.unvote"), "unvote", p.id)}>{t("vote.takeBack")}</button>}
                  {ready && <button className="btn red small" disabled={busy} onClick={() => act(t("tx.execute"), "execute", p.id)}>{t("vote.carry")}</button>}
                  {me && p.proposer.toLowerCase() === me.toLowerCase() && <button className="btn ghost small" disabled={busy} onClick={() => act(t("tx.cancel"), "cancel", p.id)}>{t("vote.withdraw")}</button>}
                </OnArc>
              </div>
            </div>
          );
        })}
      </div>

      {isMember && <Propose chest={chest} onDone={onChange} />}

      {past.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary className="label" style={{ cursor: "pointer" }}>{t("vote.past")}</summary>
          <ul className="mono" style={{ marginTop: 8, paddingLeft: 16, display: "grid", gap: 4 }}>
            {past.map((p) => <li key={p.id}>#{p.id} {describe(p, t)} — {t(p.executed ? "vote.carried" : p.cancelled ? "vote.withdrawn" : "vote.lapsed")}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

function Propose({ chest, onDone }: { chest: Chest; onDone: () => void }) {
  const { send, busy } = useTx();
  const { t } = useLang();
  const [kind, setKind] = useState<ProposalKindName>("AddMember");
  const [addr, setAddr] = useState("");
  const [amount, setAmount] = useState("");
  const [reservePct, setReservePct] = useState(String(chest.rules.reserveBps / 100));

  let payload: Hex | null = null;
  let error = "";
  try {
    if (kind === "AddMember" || kind === "RemoveMember" || kind === "SetAgent") {
      if (!isAddress(addr.trim())) error = t("vote.err.addr");
      else payload = encodeAbiParameters([{ type: "address" }], [addr.trim() as Address]);
    } else if (kind === "SetPayee") {
      if (!isAddress(addr.trim())) error = t("vote.err.payee");
      else payload = encodeAbiParameters([{ type: "address" }, { type: "bool" }], [addr.trim() as Address, true]);
    } else if (kind === "ReleaseReserve") {
      const total = toUsdc(amount || "0");
      if (total <= 0n) error = t("vote.err.amount");
      else if (total > chest.reserve) error = t("vote.err.reserveMax", { amt: usdc(chest.reserve) });
      else {
        // split evenly between current members; remainder to the first
        const n = BigInt(chest.members.length);
        const each = total / n;
        const amts = chest.members.map((_, i) => (i === 0 ? each + (total - each * n) : each));
        payload = encodeAbiParameters([{ type: "address[]" }, { type: "uint256[]" }], [[...chest.members], amts]);
      }
    } else if (kind === "SetRules") {
      const r = Number(reservePct);
      if (!(r >= 0 && r <= 100)) error = t("vote.err.pct");
      else {
        const next: Rules = { ...chest.rules, reserveBps: Math.round(r * 100) };
        payload = encodeAbiParameters(RULES_T, [next]);
      }
    }
  } catch {
    error = t("vote.err.check");
  }

  async function propose() {
    if (!payload) return;
    const ok = await send(t("tx.propose"), {
      address: chest.address,
      abi: collectiveAbi,
      functionName: "propose",
      args: [kindIndex(kind), payload, "0x0000000000000000000000000000000000000000000000000000000000000000"],
    });
    if (ok) { setAddr(""); setAmount(""); onDone(); }
  }

  return (
    <div className="stack" style={{ marginTop: 16, paddingTop: 16, borderTop: "1px dashed rgba(29,26,22,.3)" }}>
      <span className="label">{t("vote.open")}</span>
      <select className="input" value={kind} onChange={(e) => setKind(e.target.value as ProposalKindName)}>
        {(["AddMember", "RemoveMember", "SetAgent", "SetPayee", "ReleaseReserve", "SetRules"] as const).map((k) => (
          <option key={k} value={k}>{t(`vote.k.${k}`)}</option>
        ))}
      </select>
      {(kind === "AddMember" || kind === "RemoveMember" || kind === "SetAgent" || kind === "SetPayee") && (
        <input className="input" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" />
      )}
      {kind === "ReleaseReserve" && <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t("vote.upTo", { amt: usdc(chest.reserve) })} />}
      {kind === "SetRules" && <input className="input" inputMode="decimal" value={reservePct} onChange={(e) => setReservePct(e.target.value)} placeholder={t("vote.pctPh")} />}
      {error && <div className="error">{error}</div>}
      <OnArc><button className="btn small" disabled={!payload || busy} onClick={propose}>{t("vote.submit")}</button></OnArc>
    </div>
  );
}
