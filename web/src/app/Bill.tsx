import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { isAddress, keccak256, parseEventLogs, toHex, type Address, type Hex } from "viem";
import { useConnection } from "wagmi";
import { collectiveAbi, factoryAbi } from "../lib/abi";
import { AGENT, FACTORY } from "../lib/contracts";
import { AGENT_URL } from "../lib/agent";
import { toUsdc, usdc } from "../lib/format";
import { useLang } from "../lib/i18n";
import { saveNames, useMyChests, loadNames } from "../lib/team";
import { useTx } from "../lib/tx";
import { useChest } from "./useChest";
import { Brand, OnArc, Wallet } from "./Wallet";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const PERIODS = [
  { label: "new.p1w", s: 7 * 86400 },
  { label: "new.p2w", s: 14 * 86400 },
  { label: "new.p1m", s: 30 * 86400 },
];

type Person = { name: string; address: string; share: string };

/** Even split in whole basis points; the last person absorbs the remainder. */
const evenShares = (n: number) => Array.from({ length: n }, (_, i) => (i === n - 1 ? 100 - Math.floor(100 / n) * (n - 1) : Math.floor(100 / n)).toString());

export default function Bill() {
  const { address: me } = useConnection();
  const { t } = useLang();
  const [params] = useSearchParams();
  const mine = useMyChests(me);
  const [team, setTeam] = useState<Address | "new">("new");
  const [done, setDone] = useState<{ chest: Address; id: Hex } | null>(null);

  // land on the team named in ?team=, else the newest one, else a new team
  useEffect(() => {
    const wanted = params.get("team");
    const list = mine.data ?? [];
    if (wanted && list.some((c) => c.address.toLowerCase() === wanted.toLowerCase())) setTeam(wanted as Address);
    else if (list.length) setTeam(list[0].address);
  }, [mine.data, params]);

  return (
    <div className="board">
      <aside className="rail">
        <Brand />
        <Wallet />
        <div className="card no-pin kraft tilt-l">
          <div className="label">{t("home.how")}</div>
          <ol className="mono" style={{ marginTop: 10, paddingLeft: 18, display: "grid", gap: 8 }}>
            <li>{t("h.how1")}</li>
            <li>{t("h.how2")}</li>
            <li>{t("h.how3")}</li>
            <li>{t("h.how4")}</li>
          </ol>
        </div>
      </aside>
      {done ? (
        <Done chest={done.chest} id={done.id} onAnother={() => setDone(null)} />
      ) : (
        <BillForm key={team} team={team} setTeam={setTeam} teams={mine.data ?? []} me={me} onDone={setDone} />
      )}
    </div>
  );
}

function BillForm({ team, setTeam, teams, me, onDone }: {
  team: Address | "new";
  setTeam: (t: Address | "new") => void;
  teams: { address: Address; name: string }[];
  me?: Address;
  onDone: (d: { chest: Address; id: Hex }) => void;
}) {
  const { t } = useLang();
  const { send, busy } = useTx();
  const existing = useChest(team === "new" ? undefined : team, me);
  const chest = existing.data;

  const [teamName, setTeamName] = useState("");
  const [people, setPeople] = useState<Person[]>([{ name: "", address: me ?? "", share: "100" }]);
  const [job, setJob] = useState("");
  const [amount, setAmount] = useState("");
  const [payer, setPayer] = useState("");
  const [reservePct, setReservePct] = useState("10");
  const [reserveTarget, setReserveTarget] = useState("500");
  const [period, setPeriod] = useState(30 * 86400);
  const [useAgent, setUseAgent] = useState(true);

  // an existing team brings its members (with any names saved in this browser)
  useEffect(() => {
    if (!chest) return;
    const names = loadNames(chest.address);
    const shares = evenShares(chest.members.length);
    setPeople(chest.members.map((a, i) => ({ name: names[a.toLowerCase()] ?? "", address: a, share: shares[i] })));
  }, [chest]);
  useEffect(() => {
    if (team === "new" && me) setPeople((p) => (p[0] && p[0].address === "" ? [{ ...p[0], address: me }, ...p.slice(1)] : p));
  }, [me, team]);

  const isNew = team === "new";
  const reserveBps = isNew ? Math.round(Number(reservePct) * 100) : (chest?.rules.reserveBps ?? 0);
  const total = people.reduce((s, p) => s + (Number(p.share) || 0), 0);

  const errors = useMemo(() => {
    const e: string[] = [];
    const addrs = people.map((p) => p.address.trim());
    if (isNew && !teamName.trim()) e.push(t("b.err.team"));
    if (addrs.some((a) => !isAddress(a))) e.push(t("b.err.addr"));
    if (new Set(addrs.map((a) => a.toLowerCase())).size !== addrs.length) e.push(t("b.err.dup"));
    if (me && isNew && !addrs.some((a) => a.toLowerCase() === me.toLowerCase())) e.push(t("b.err.me"));
    if (!(Number(amount) > 0)) e.push(t("b.err.amount"));
    if (Math.abs(total - 100) > 1e-9) e.push(t("b.err.total", { n: total }));
    if (payer.trim() && !isAddress(payer.trim())) e.push(t("b.err.payer"));
    return e;
  }, [people, isNew, teamName, me, amount, total, payer, t]);

  // preview: at most this much goes to the reserve (less once the reserve is full)
  const gross = Number(amount) > 0 ? toUsdc(amount) : 0n;
  const toReserve = (gross * BigInt(reserveBps)) / 10_000n;
  const net = gross - toReserve;

  async function submit() {
    const contributors = people.map((p) => p.address.trim() as Address);
    let chestAddr = isNew ? undefined : (team as Address);
    if (isNew) {
      const receipt = await send(t("tx.openTeam"), {
        address: FACTORY,
        abi: factoryAbi,
        functionName: "create",
        args: [
          teamName.trim(),
          contributors,
          {
            reserveBps,
            reserveTarget: toUsdc(reserveTarget),
            autoAttributeCap: toUsdc("100"),
            expenseCapPerPeriod: toUsdc("100"),
            quorumBps: 5001, // more than half; the contract refuses anything lower
            timelock: 86400,
            periodLength: period,
          },
          useAgent ? AGENT : ZERO,
        ],
      });
      if (!receipt) return;
      const [created] = parseEventLogs({ abi: factoryAbi, logs: receipt.logs, eventName: "CollectiveCreated" });
      if (!created) return;
      chestAddr = created.args.collective;
    }
    if (!chestAddr) return;
    saveNames(chestAddr, Object.fromEntries(people.map((p) => [p.address.trim(), p.name])));

    // only the people with a share are on the invoice
    const workers = people.filter((p) => Number(p.share) > 0);
    const shares = workers.map((p) => Math.round(Number(p.share) * 100));
    shares[shares.length - 1] += 10_000 - shares.reduce((a, b) => a + b, 0); // absorb rounding
    const salt = keccak256(toHex(`${Date.now()}-${Math.random()}`));
    const receipt = await send(t("tx.createInvoice"), {
      address: chestAddr,
      abi: collectiveAbi,
      functionName: "createInvoice",
      args: [salt, toUsdc(amount), (payer.trim() || ZERO) as Address, workers.map((p) => p.address.trim() as Address), shares],
    });
    if (!receipt) return;
    const [inv] = parseEventLogs({ abi: collectiveAbi, logs: receipt.logs, eventName: "InvoiceCreated" });
    if (!inv) return;
    // what the job was for helps the agent match a payment later; best effort
    if (job.trim()) {
      void fetch(`${AGENT_URL}/invoice-note?chest=${chestAddr}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: inv.args.id, note: job.trim() }),
      }).catch(() => {});
    }
    onDone({ chest: chestAddr, id: inv.args.id });
  }

  const set = (i: number, k: keyof Person, v: string) => setPeople(people.map((p, j) => (j === i ? { ...p, [k]: v } : p)));

  return (
    <>
      <main className="main">
        <div className="card tape no-pin">
          <div className="label">{t("b.label")}</div>
          <h1 className="title" style={{ marginTop: 6 }}>{t("b.title")}</h1>
        </div>

        <div className="card tilt-l">
          <div className="label">{t("b.team")}</div>
          <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
            {teams.map((c) => (
              <button key={c.address} className={`btn small ${team === c.address ? "" : "ghost"}`} onClick={() => setTeam(c.address)}>{c.name}</button>
            ))}
            <button className={`btn small ${isNew ? "" : "ghost"}`} onClick={() => setTeam("new")}>{t("b.newTeam")}</button>
          </div>
          {isNew && (
            <label className="field" style={{ marginTop: 14 }}>
              <span className="hint">{t("b.teamName")}</span>
              <input className="input" value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder={t("b.teamNamePh")} />
            </label>
          )}
        </div>

        <div className="card tilt-r">
          <div className="label">{t("b.job")}</div>
          <div className="grid2" style={{ marginTop: 10 }}>
            <label className="field"><span className="hint">{t("b.jobName")}</span><input className="input" value={job} onChange={(e) => setJob(e.target.value)} placeholder={t("b.jobNamePh")} /></label>
            <label className="field"><span className="hint">{t("b.amount")}</span><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="2000" /></label>
          </div>
        </div>

        <div className="card">
          <div className="between">
            <div>
              <div className="label">{t("b.shares")}</div>
              <p className="hint" style={{ marginTop: 4 }}>{t("b.sharesHint")}</p>
            </div>
            <button className="btn ghost small" onClick={() => { const s = evenShares(people.length); setPeople(people.map((p, i) => ({ ...p, share: s[i] }))); }}>{t("b.even")}</button>
          </div>
          <div className="billrows">
            {people.map((p, i) => {
              const mineRow = me && p.address.toLowerCase() === me.toLowerCase();
              const each = (net * BigInt(Math.round((Number(p.share) || 0) * 100))) / 10_000n;
              return (
                <div className="billrow" key={i}>
                  <input className="input" aria-label={t("b.name")} placeholder={mineRow ? t("b.you") : t("b.name")} value={p.name} onChange={(e) => set(i, "name", e.target.value)} />
                  <input className="input wide" aria-label={t("b.addr")} placeholder="0x…" value={p.address} disabled={!isNew} onChange={(e) => set(i, "address", e.target.value)} />
                  <label className="pct"><input className="input" inputMode="decimal" aria-label="%" value={p.share} onChange={(e) => set(i, "share", e.target.value)} /><span className="mono">%</span></label>
                  <span className="hint gets">{gross > 0n ? t("b.gets", { amt: usdc(each) }) : ""}</span>
                  {isNew && people.length > 1 && i > 0 && <button className="btn ghost small" onClick={() => setPeople(people.filter((_, j) => j !== i))}>{t("b.remove")}</button>}
                </div>
              );
            })}
          </div>
          {isNew && <button className="btn ghost small" style={{ marginTop: 10 }} onClick={() => setPeople([...people, { name: "", address: "", share: "0" }])}>{t("b.addPerson")}</button>}
          {gross > 0n && reserveBps > 0 && <p className="mono" style={{ marginTop: 12 }}>{t("b.reserveCut", { amt: usdc(toReserve) })}</p>}
        </div>

        <details className="card kraft">
          <summary className="label" style={{ cursor: "pointer" }}>{t("b.advanced")}</summary>
          <div className="stack" style={{ marginTop: 12 }}>
            {isNew && (
              <>
                <div className="grid2">
                  <label className="field"><span className="hint">{t("b.reservePct")}</span><input className="input" inputMode="decimal" value={reservePct} onChange={(e) => setReservePct(e.target.value)} /></label>
                  <label className="field"><span className="hint">{t("b.reserveTarget")}</span><input className="input" inputMode="decimal" value={reserveTarget} onChange={(e) => setReserveTarget(e.target.value)} /></label>
                </div>
                <label className="field"><span className="hint">{t("b.period")}</span>
                  <select className="input" value={period} onChange={(e) => setPeriod(Number(e.target.value))}>{PERIODS.map((p) => <option key={p.s} value={p.s}>{t(p.label)}</option>)}</select>
                </label>
                <label className="row" style={{ alignItems: "flex-start" }}>
                  <input type="checkbox" checked={useAgent} onChange={(e) => setUseAgent(e.target.checked)} style={{ marginTop: 4 }} />
                  <span><b className="mono">{t("b.agentOn")}</b><br /><span className="hint">{t("b.agentHint")}</span></span>
                </label>
              </>
            )}
            <label className="field"><span className="hint">{t("b.payer")}</span><input className="input" value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="0x…" /></label>
          </div>
        </details>
      </main>

      <aside className="side">
        <div className="card ink">
          <div className="label">{t("b.summary")}</div>
          {gross > 0n && <div className="amount" style={{ marginTop: 10 }}>{usdc(gross)}<small>USDC</small></div>}
          <p className="mono" style={{ marginTop: 10, opacity: 0.85 }}>{isNew ? t("b.signs2") : t("b.signs1")}</p>
          {errors.length > 0 && <ul className="mono" style={{ marginTop: 10, paddingLeft: 16, display: "grid", gap: 6 }}>{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          <div style={{ marginTop: 16 }}>
            <OnArc>
              <button className="btn" disabled={errors.length > 0 || busy} onClick={submit}>{busy ? t("b.submitting") : t("b.submit")}</button>
            </OnArc>
          </div>
        </div>
      </aside>
    </>
  );
}

function Done({ chest, id, onAnother }: { chest: Address; id: Hex; onAnother: () => void }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/pay/${chest}/${id}`;
  return (
    <>
      <main className="main">
        <div className="card tape no-pin">
          <div className="label">{t("d.label")}</div>
          <h1 className="title" style={{ marginTop: 6 }}>{t("d.title")}</h1>
          <p className="note" style={{ marginTop: 12 }}>{t("d.body")}</p>
        </div>
        <div className="card tilt-l">
          <div className="paylink mono">{link}</div>
          <div className="row" style={{ marginTop: 14, flexWrap: "wrap" }}>
            <button className="btn red" onClick={() => { void navigator.clipboard?.writeText(link).then(() => setCopied(true)); }}>{copied ? t("d.copied") : t("d.copy")}</button>
            <a className="btn ghost" href={link} target="_blank" rel="noreferrer">{t("d.open")}</a>
          </div>
        </div>
      </main>
      <aside className="side">
        <Link className="btn" to={`/c/${chest}`}>{t("d.chest")}</Link>
        <button className="btn ghost" onClick={onAnother}>{t("d.another")}</button>
      </aside>
    </>
  );
}
