import { useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { isAddress, type Address } from "viem";
import { useConnection } from "wagmi";
import { collectiveAbi } from "../lib/abi";
import { explorerAddress, explorerTx } from "../lib/arc";
import { pct, short, usdc } from "../lib/format";
import { useDuration, useLang } from "../lib/i18n";
import type { CollectiveEvent } from "../lib/logs";
import { useNames } from "../lib/team";
import { useTx } from "../lib/tx";
import { AgentPanel } from "./Agent";
import { Invoices } from "./Invoices";
import { invoicesFrom, OlderChest, paidByMember, useChest, useChestEvents, type Chest as ChestT } from "./useChest";
import { Votes } from "./Votes";
import { Brand, OnArc, Wallet } from "./Wallet";

export default function Chest() {
  const { address: param } = useParams();
  const address = param && isAddress(param) ? (param as Address) : undefined;
  const { address: me } = useConnection();
  const chest = useChest(address, me);
  const events = useChestEvents(address);
  const qc = useQueryClient();
  const { t } = useLang();
  const dur = useDuration();
  const who = useNames(address);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["chest", address] });
    qc.invalidateQueries({ queryKey: ["chest-events", address] });
    qc.invalidateQueries({ queryKey: ["usdc"] });
  };

  if (!address) return <Missing text={t("chest.notAddress")} />;
  if (chest.error instanceof OlderChest) return <Older address={address} version={chest.error.version} />;
  if (chest.isError) return <Missing text={t("chest.readFail")} />;

  const c = chest.data;
  const isMember = !!(me && c?.members.some((m) => m.toLowerCase() === me.toLowerCase()));
  const invoices = events.data ? invoicesFrom(events.data) : [];

  return (
    <div className="board">
      <aside className="rail">
        <Brand />
        <Wallet />
        <div className="card tilt-l">
          <div className="label">{t("chest.members")}</div>
          {!c ? <div className="skeleton" style={{ marginTop: 10, height: 80 }} /> : (
            <ul className="mono" style={{ listStyle: "none", marginTop: 10, display: "grid", gap: 8 }}>
              {c.members.map((m) => (
                <li key={m} className="between">
                  <a href={explorerAddress(m)} target="_blank" rel="noreferrer">{who(m)}</a>
                  {me && m.toLowerCase() === me.toLowerCase() && <span className="chip">{t("chest.you")}</span>}
                </li>
              ))}
            </ul>
          )}
          {c && !/^0x0+$/.test(c.agent) && <p className="hint" style={{ marginTop: 12 }}>{t("chest.agent")}: {short(c.agent)}</p>}
        </div>
        <div className="card no-pin kraft tilt-r">
          <div className="label">{t("chest.rules")}</div>
          {c && (
            <ul className="mono" style={{ marginTop: 10, paddingLeft: 16, display: "grid", gap: 6 }}>
              <li>{t("chest.rule0")}</li>
              <li>{c.rules.reserveBps > 0 ? t("chest.rule1", { pct: pct(c.rules.reserveBps), target: usdc(c.rules.reserveTarget) }) : t("chest.rule1none")}</li>
              <li>{t("chest.rule3", { d: dur(c.rules.timelock) })}</li>
              <li>{t("chest.rule4", { cap: usdc(c.rules.autoAttributeCap), d: dur(c.rules.periodLength) })}</li>
            </ul>
          )}
        </div>
      </aside>

      <main className="main">
        <div className="card tape no-pin">
          <div className="label">{t("chest.label")} · <a href={explorerAddress(address)} target="_blank" rel="noreferrer">{short(address)} ↗</a></div>
          <h1 className="title" style={{ marginTop: 6 }}>{c?.name ?? "…"}</h1>
          {!isMember && c && <p className="hint" style={{ marginTop: 8 }}>{t("chest.lookingIn")}</p>}
        </div>
        {c ? <Money chest={c} events={events.data} who={who} onChange={refresh} /> : <div className="card"><div className="skeleton" style={{ height: 160 }} /></div>}
        {c && <Invoices chest={c} invoices={invoices} loading={events.isLoading} isMember={isMember} onChange={refresh} />}
        {c && <AgentPanel chest={c} isMember={isMember} onChange={refresh} />}
      </main>

      <aside className="side">
        {c && <Votes chest={c} isMember={isMember} me={me} onChange={refresh} />}
        <Activity events={events.data} loading={events.isLoading} who={who} />
      </aside>
    </div>
  );
}

/** What the team was paid, and what it keeps aside for shared costs. Nothing else waits in the chest. */
function Money({ chest, events, who, onChange }: { chest: ChestT; events?: CollectiveEvent[]; who: (a: string) => string; onChange: () => void }) {
  const { t } = useLang();
  const paid = events ? paidByMember(events) : new Map<string, bigint>();
  const total = [...paid.values()].reduce((s, v) => s + v, 0n);
  const max = [...paid.values()].reduce((m, v) => (v > m ? v : m), 0n);
  const reserveOn = chest.rules.reserveBps > 0;
  const fill = chest.rules.reserveTarget > 0n ? Number((chest.reserve * 10_000n) / chest.rules.reserveTarget) / 100 : 0;

  return (
    <div className="grid2">
      <div className="card ink tilt-l">
        <div className="label">{t("chest.paidOut")}</div>
        <div className="amount" style={{ marginTop: 8, color: "var(--glow)" }}>{usdc(total)}<small style={{ color: "inherit", opacity: 0.7 }}>USDC</small></div>
        <p className="mono" style={{ marginTop: 10, opacity: 0.8 }}>{t("chest.paidNow")}</p>
        {total > 0n && (
          <div className="stack" style={{ marginTop: 14 }}>
            {[...paid.entries()].map(([m, v]) => (
              <div key={m} className="bar">
                <span>{who(m)}</span>
                <span className="track"><i style={{ width: `${max > 0n ? Number((v * 1000n) / max) / 10 : 0}%` }} /></span>
                <span>{usdc(v)}</span>
              </div>
            ))}
          </div>
        )}
        {chest.owedToMe > 0n && (
          <div style={{ marginTop: 14 }}>
            <OnArc><ClaimButton chest={chest} onDone={onChange} /></OnArc>
          </div>
        )}
      </div>
      <div className="card tilt-r">
        <div className="label">{t("chest.reserve")}</div>
        {reserveOn ? (
          <>
            <div className="amount" style={{ marginTop: 8 }}>{usdc(chest.reserve)}<small>{t("chest.of", { target: usdc(chest.rules.reserveTarget) })}</small></div>
            <div className="gauge" style={{ marginTop: 14 }}><i style={{ width: `${Math.min(fill, 100)}%` }} /></div>
            <p className="hint" style={{ marginTop: 10 }}>{t("chest.reserveUse")}</p>
          </>
        ) : (
          <p className="note" style={{ marginTop: 10 }}>{t("chest.reserveOff")}</p>
        )}
        {chest.unattributed > 0n && <p className="mono" style={{ marginTop: 10, color: "var(--thread)" }}>{t("chest.unlabelled", { amt: usdc(chest.unattributed) })}</p>}
      </div>
    </div>
  );
}

function ClaimButton({ chest, onDone }: { chest: ChestT; onDone: () => void }) {
  const { send, busy } = useTx();
  const { address } = useConnection();
  const { t } = useLang();
  return (
    <button className="btn red small" disabled={busy || !address} onClick={() =>
      send(t("tx.collect"), { address: chest.address, abi: collectiveAbi, functionName: "claim", args: [address!] }).then((r) => r && onDone())
    }>{t("chest.collect", { amt: usdc(chest.owedToMe) })}</button>
  );
}

type T = (k: string, v?: Record<string, string | number>) => string;
const line = (e: CollectiveEvent, t: T, who: (a: string) => string): string | null => {
  const a = e.args as Record<string, unknown>;
  const amt = () => usdc(a.amount as bigint);
  switch (e.eventName) {
    case "CollectiveInitialized": return t("ev.opened");
    case "InvoiceCreated": return a.note ? t("ev.invoiceCreatedFor", { amt: amt(), note: String(a.note) }) : t("ev.invoiceCreated", { amt: amt() });
    case "InvoiceApproved": return t("ev.agreed", { who: who(a.member as string) });
    case "InvoicePaid": return (a.toReserve as bigint) > 0n ? t("ev.invoicePaid", { amt: amt(), res: usdc(a.toReserve as bigint) }) : t("ev.invoicePaidAll", { amt: amt() });
    case "InvoiceCancelled": return t("ev.invoiceCancelled");
    case "InvoiceSettled": return t("ev.settled", { amt: amt() });
    case "Paid": return t("ev.paid", { amt: amt(), who: who(a.member as string) });
    case "PayoutDeferred": return t("ev.deferred", { amt: amt(), who: who(a.member as string) });
    case "Attributed": return t("ev.attributed", { amt: amt(), who: who(a.member as string) });
    case "ExpensePaid": return t("ev.expense", { amt: amt(), who: short(a.to as string) });
    case "Proposed": return t("ev.proposed", { n: String(a.id) });
    case "Executed": return t("ev.executed", { n: String(a.id) });
    case "ReserveReleased": return t("ev.reserve", { amt: amt(), who: who(a.to as string) });
    case "Claimed": return t("ev.claimed", { amt: amt() });
    default: return null;
  }
};

function Activity({ events, loading, who }: { events?: CollectiveEvent[]; loading: boolean; who: (a: string) => string }) {
  const { t } = useLang();
  const items = (events ?? []).map((e) => ({ e, text: line(e, t, who) })).filter((x) => x.text).reverse().slice(0, 25);
  return (
    <div className="card tilt-r pin-gold">
      <div className="label">{t("chest.record")}</div>
      {loading && <div className="skeleton" style={{ marginTop: 12, height: 120 }} />}
      {!loading && items.length === 0 && <p className="note muted" style={{ marginTop: 10 }}>{t("chest.quiet")}</p>}
      <div className="timeline" style={{ marginTop: 8 }}>
        {items.map(({ e, text }) => (
          <div className="ev" key={`${e.transactionHash}-${e.logIndex}`}>
            <span>{text} · <a href={explorerTx(e.transactionHash)} target="_blank" rel="noreferrer">tx ↗</a></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Older({ address, version }: { address: Address; version: string }) {
  const { t } = useLang();
  return (
    <div className="board">
      <aside className="rail"><Brand /></aside>
      <main className="main">
        <div className="card tilt-l">
          <div className="label">{t("chest.label")} · {short(address)}</div>
          <p className="note" style={{ marginTop: 10 }}>{t("chest.older", { v: version })}</p>
          <div className="row" style={{ marginTop: 14, flexWrap: "wrap" }}>
            <a className="btn ghost small" href={explorerAddress(address)} target="_blank" rel="noreferrer">{t("chest.olderExplorer")}</a>
            <Link className="btn small" to="/app/bill">{t("h.bill")}</Link>
          </div>
        </div>
      </main>
    </div>
  );
}

function Missing({ text }: { text: string }) {
  const { t } = useLang();
  return (
    <div className="board">
      <aside className="rail"><Brand /></aside>
      <main className="main"><div className="card tilt-l"><p className="note">{text}</p><Link className="btn small" style={{ marginTop: 14 }} to="/app">{t("chest.back")}</Link></div></main>
    </div>
  );
}
