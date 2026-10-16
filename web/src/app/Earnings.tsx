import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { formatUnits, isAddress, type Address, type Hex } from "viem";
import { useConnection } from "wagmi";
import { collectiveAbi, erc20Abi } from "../lib/abi";
import { explorerTx, publicClient } from "../lib/arc";
import { USDC } from "../lib/contracts";
import { short, toUsdc, usdc } from "../lib/format";
import { EURC, POOL_FEE, quoteEurc, routerAbi, SWAP_ROUTER } from "../lib/fx";
import { useLang } from "../lib/i18n";
import { collectiveLogs } from "../lib/logs";
import { useMyChests, type MyChest } from "../lib/team";
import { useTx } from "../lib/tx";
import { invoicesFrom } from "./useChest";
import { Brand, OnArc, Wallet } from "./Wallet";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

type Row = { at: number; team: string; chest: Address; kind: "paid" | "deferred" | "claimed"; amount: bigint; tx: Hex; job: string };
type TeamState = { chest: MyChest; payoutTo: Address; owed: bigint; pending: bigint };

/** Everything the connected member earned, from each chest's own events, with the job each payment was for. */
function useEarnings(me: Address | undefined, chests: MyChest[] | undefined) {
  return useQuery({
    queryKey: ["earnings", me, chests?.map((c) => c.address).join()],
    enabled: !!me && !!chests,
    queryFn: async () => {
      const lower = me!.toLowerCase();
      const rows: Row[] = [];
      const teams: TeamState[] = [];
      for (const c of chests!) {
        const [payoutTo, owed] = await publicClient.multicall({
          allowFailure: false,
          contracts: [
            { address: c.address, abi: collectiveAbi, functionName: "payoutTo", args: [me!] },
            { address: c.address, abi: collectiveAbi, functionName: "owed", args: [me!] },
          ],
        });
        const events = await collectiveLogs(c.address);
        const invoices = invoicesFrom(events);
        const jobOf = new Map(invoices.map((i) => [i.id.toLowerCase(), i.note]));
        // my share of invoices the client hasn't paid yet, before any shared-costs cut
        const pending = invoices.filter((i) => i.status === 1).reduce((s, i) => {
          const k = i.contributors.findIndex((m) => m.toLowerCase() === lower);
          return k < 0 ? s : s + (i.amount * BigInt(i.sharesBps[k])) / 10_000n;
        }, 0n);
        teams.push({ chest: c, payoutTo, owed, pending });

        for (const e of events) {
          const a = e.args as { member?: string; amount?: bigint; source?: Hex };
          if (!a.member || a.member.toLowerCase() !== lower || a.amount === undefined) continue;
          const kind = e.eventName === "Paid" ? "paid" : e.eventName === "PayoutDeferred" ? "deferred" : e.eventName === "Claimed" ? "claimed" : null;
          if (!kind) continue;
          rows.push({ at: Number(e.blockNumber), team: c.name, chest: c.address, kind, amount: a.amount, tx: e.transactionHash, job: (a.source && jobOf.get(a.source.toLowerCase())) || "" });
        }
      }
      // block number → time, one lookup per distinct block
      const blocks = [...new Set(rows.map((r) => r.at))];
      const times = new Map<number, number>();
      await Promise.all(blocks.map(async (b) => times.set(b, Number((await publicClient.getBlock({ blockNumber: BigInt(b) })).timestamp))));
      for (const r of rows) r.at = times.get(r.at) ?? 0;
      rows.sort((x, y) => y.at - x.at);
      return { rows, teams };
    },
  });
}

function csv(rows: Row[], t: (k: string) => string) {
  const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
  const head = ["date", "team", "for", "type", "amount_usdc", "tx"].join(",");
  const lines = rows.map((r) => [new Date(r.at * 1000).toISOString(), q(r.team), q(r.job), t(`e.${r.kind}`), formatUnits(r.amount, 6), r.tx].join(","));
  const blob = new Blob([[head, ...lines].join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `keyarc-earnings-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function Earnings() {
  const { address: me } = useConnection();
  const { t, lang } = useLang();
  const mine = useMyChests(me);
  const data = useEarnings(me, mine.data);

  const received = data.data?.rows.filter((r) => r.kind !== "deferred").reduce((s, r) => s + r.amount, 0n) ?? 0n;
  const pending = data.data?.teams.reduce((s, x) => s + x.pending, 0n) ?? 0n;
  const owed = data.data?.teams.reduce((s, x) => s + x.owed, 0n) ?? 0n;
  const when = (s: number) => new Date(s * 1000).toLocaleDateString(lang === "tr" ? "tr-TR" : "en-GB", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <div className="board">
      <aside className="rail noprint">
        <Brand />
        <Wallet />
      </aside>

      <main className="main">
        <div className="card tape no-pin">
          <div className="label">{t("e.label")}</div>
          <h1 className="title" style={{ marginTop: 6 }}>{t("e.title")}</h1>
          {me && <p className="mono" style={{ marginTop: 8 }}>{me}</p>}
        </div>

        {!me && <div className="card tilt-l"><p className="note">{t("e.connect")}</p></div>}
        {me && mine.data && mine.data.length === 0 && (
          <div className="card tilt-r"><p className="note">{t("e.noTeams")}</p><Link className="btn small" style={{ marginTop: 12 }} to="/app/bill">{t("h.bill")}</Link></div>
        )}
        {me && (mine.isLoading || data.isLoading) && <div className="card"><div className="skeleton" style={{ height: 120 }} /></div>}
        {me && data.isError && (
          <div className="card tilt-l"><p className="note">{t("net.down")}</p><button className="btn small" style={{ marginTop: 12 }} onClick={() => data.refetch()}>{t("net.retry")}</button></div>
        )}

        {data.data && (
          <>
            <div className="grid3">
              <div className="card ink"><div className="label">{t("e.received")}</div><div className="amount" style={{ marginTop: 8 }}>{usdc(received)}<small>USDC</small></div></div>
              <div className="card tilt-r"><div className="label">{t("e.pending")}</div><div className="amount" style={{ marginTop: 8 }}>{usdc(pending)}<small>USDC</small></div></div>
              <div className="card tilt-l"><div className="label">{t("e.owed")}</div><div className="amount" style={{ marginTop: 8 }}>{usdc(owed)}<small>USDC</small></div></div>
            </div>

            <div className="card">
              <div className="between">
                <div className="label">{t("e.history")}</div>
                <div className="row noprint">
                  <button className="btn ghost small" disabled={!data.data.rows.length} onClick={() => csv(data.data!.rows, t)}>{t("e.csv")}</button>
                  <button className="btn ghost small" onClick={() => window.print()}>{t("e.print")}</button>
                </div>
              </div>
              {data.data.rows.length === 0 ? (
                <p className="note muted" style={{ marginTop: 12 }}>{t("e.none")}</p>
              ) : (
                <table className="simple" style={{ marginTop: 12 }}>
                  <thead><tr><th>{t("e.when")}</th><th>{t("e.team")}</th><th>{t("e.for")}</th><th>{t("e.what")}</th><th>{t("e.amount")}</th><th /></tr></thead>
                  <tbody>
                    {data.data.rows.map((r) => (
                      <tr key={`${r.tx}-${r.kind}`}>
                        <td>{when(r.at)}</td>
                        <td>{r.team}</td>
                        <td>{r.job}</td>
                        <td><span className={`chip ${r.kind === "paid" ? "paid" : r.kind === "deferred" ? "open" : ""}`}>{t(`e.${r.kind}`)}</span></td>
                        <td>{usdc(r.amount)} USDC</td>
                        <td><a href={explorerTx(r.tx)} target="_blank" rel="noreferrer">{short(r.tx)} ↗</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </main>

      <aside className="side noprint">
        {me && <ToEurc me={me} />}
        {data.data?.teams.map((x) => <Destination key={x.chest.address} state={x} me={me!} />)}
      </aside>
    </div>
  );
}

/** Swap USDC already in the member's wallet to EURC, signed by the member; nothing passes through the chest or the agent. */
function ToEurc({ me }: { me: Address }) {
  const { t } = useLang();
  const { send, busy } = useTx();
  const [amount, setAmount] = useState("");
  const bal = useQuery({
    queryKey: ["fx-bal", me],
    refetchInterval: 15_000,
    queryFn: async () => {
      const [usdcBal, eurcBal, allowance] = await publicClient.multicall({
        allowFailure: false,
        contracts: [
          { address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [me] },
          { address: EURC, abi: erc20Abi, functionName: "balanceOf", args: [me] },
          { address: USDC, abi: erc20Abi, functionName: "allowance", args: [me, SWAP_ROUTER] },
        ],
      });
      return { usdcBal, eurcBal, allowance };
    },
  });
  const amt = Number(amount) > 0 ? toUsdc(amount) : 0n;
  const quote = useQuery({ queryKey: ["fx-quote", amt.toString()], enabled: amt > 0n, queryFn: () => quoteEurc(amt), staleTime: 10_000 });
  const enough = !!bal.data && amt > 0n && bal.data.usdcBal >= amt;
  const approved = !!bal.data && bal.data.allowance >= amt;

  async function go() {
    if (!quote.data) return;
    if (!approved) {
      // exact amount only, never an open allowance
      const ok = await send(t("fx.allow"), { address: USDC, abi: erc20Abi, functionName: "approve", args: [SWAP_ROUTER, amt] });
      if (!ok) return;
    }
    const fresh = await quoteEurc(amt);
    const ok = await send(t("fx.swap"), {
      address: SWAP_ROUTER,
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [{ tokenIn: USDC, tokenOut: EURC, fee: POOL_FEE, recipient: me, amountIn: amt, amountOutMinimum: fresh.min, sqrtPriceLimitX96: 0n }],
    });
    if (ok) {
      setAmount("");
      void bal.refetch();
    }
  }

  return (
    <div className="card ink">
      <div className="label">{t("fx.label")}</div>
      {bal.data && <p className="mono" style={{ marginTop: 8, opacity: 0.85 }}>{t("fx.have", { usdc: usdc(bal.data.usdcBal), eurc: usdc(bal.data.eurcBal) })}</p>}
      <input className="input" style={{ marginTop: 10, width: "100%" }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t("fx.ph")} />
      {quote.data && <p className="mono" style={{ marginTop: 8 }}>{t("fx.quote", { out: usdc(quote.data.out), min: usdc(quote.data.min) })}</p>}
      {amt > 0n && bal.data && !enough && <p className="error" style={{ marginTop: 8 }}>{t("fx.short")}</p>}
      <p className="hint" style={{ marginTop: 8, opacity: 0.8 }}>{t("fx.hint")}</p>
      <div style={{ marginTop: 12 }}>
        <OnArc>
          <button className="btn small" disabled={!enough || !quote.data || busy} onClick={go}>{approved ? t("fx.swap") : t("fx.allowSwap")}</button>
        </OnArc>
      </div>
    </div>
  );
}

/** Per team: where this member's share is sent, and a claim button for anything that couldn't be delivered. */
function Destination({ state, me }: { state: TeamState; me: Address }) {
  const { t } = useLang();
  const { send, busy } = useTx();
  const qc = useQueryClient();
  const [to, setTo] = useState("");
  const own = state.payoutTo === ZERO;
  const valid = isAddress(to.trim()) && to.trim().toLowerCase() !== me.toLowerCase();
  const refresh = () => qc.invalidateQueries({ queryKey: ["earnings"] });

  async function save(addr: Address) {
    const r = await send(t("tx.setDest"), { address: state.chest.address, abi: collectiveAbi, functionName: "setPayoutAddress", args: [addr] });
    if (r) {
      setTo("");
      refresh();
    }
  }

  return (
    <div className="card kraft">
      <div className="label">{state.chest.name} · {t("e.dest")}</div>
      <p className="note" style={{ marginTop: 8 }}>{own ? t("e.destOwn") : t("e.destOther", { addr: short(state.payoutTo) })}</p>
      <input className="input" style={{ marginTop: 10, width: "100%" }} value={to} onChange={(e) => setTo(e.target.value)} placeholder={t("e.destPh")} />
      <p className="hint" style={{ marginTop: 8 }}>{t("e.destHint")}</p>
      <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
        <OnArc>
          <button className="btn small" disabled={!valid || busy} onClick={() => save(to.trim() as Address)}>{t("e.save")}</button>
          {!own && <button className="btn ghost small" disabled={busy} onClick={() => save(ZERO)}>{t("e.reset")}</button>}
          {state.owed > 0n && (
            <button className="btn red small" disabled={busy} onClick={async () => { if (await send(t("tx.claim"), { address: state.chest.address, abi: collectiveAbi, functionName: "claim", args: [me] })) refresh(); }}>
              {t("e.claim", { amt: usdc(state.owed) })}
            </button>
          )}
        </OnArc>
      </div>
    </div>
  );
}
