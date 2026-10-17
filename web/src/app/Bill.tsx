import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { isAddress, keccak256, parseEventLogs, toHex, type Address, type Hex } from "viem";
import { useConnection } from "wagmi";
import { collectiveAbi, factoryAbi } from "../lib/abi";
import { AGENT, FACTORY } from "../lib/contracts";
import { toUsdc, usdc } from "../lib/format";
import { useLang } from "../lib/i18n";
import { saveNames, useMyChests, loadNames, namesFragment } from "../lib/team";
import { useTx } from "../lib/tx";
import { useChest } from "./useChest";
import { Brand, OnArc, Wallet } from "./Wallet";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const DAY = 86_400;
const DUE = [
  { label: "b.due7", days: 7 },
  { label: "b.due14", days: 14 },
  { label: "b.due30", days: 30 },
  { label: "b.dueNone", days: 0 },
];
/** The window the agent's limits apply to. Shares themselves never wait: they go out when the client pays. */
const LIMITS_WINDOW = 30 * DAY;

type Person = { name: string; address: string; share: string };

/** Even split in whole percents; the last person absorbs the remainder. */
const evenShares = (n: number) => Array.from({ length: n }, (_, i) => (i === n - 1 ? 100 - Math.floor(100 / n) * (n - 1) : Math.floor(100 / n)).toString());

export default function Bill() {
  const { address: me } = useConnection();
  const { t } = useLang();
  const [params] = useSearchParams();
  const mine = useMyChests(me);
  const [team, setTeam] = useState<Address | "new">("new");
  const [done, setDone] = useState<{ chest: Address; id: Hex; others: string[] } | null>(null);

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
        <Done {...done} onAnother={() => setDone(null)} />
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
  onDone: (d: { chest: Address; id: Hex; others: string[] }) => void;
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
  const [dueDays, setDueDays] = useState(14);
  const [sharedOn, setSharedOn] = useState(false);
  const [reservePct, setReservePct] = useState("5");
  const [reserveTarget, setReserveTarget] = useState("300");
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
  const reserveBps = isNew ? (sharedOn ? Math.round(Number(reservePct) * 100) : 0) : (chest?.rules.reserveBps ?? 0);
  const total = people.reduce((s, p) => s + (Number(p.share) || 0), 0);
  const noteBytes = new TextEncoder().encode(job.trim()).length;

  const errors = useMemo(() => {
    const e: string[] = [];
    const addrs = people.map((p) => p.address.trim());
    if (isNew && !teamName.trim()) e.push(t("b.err.team"));
    if (addrs.some((a) => !isAddress(a))) e.push(t("b.err.addr"));
    if (new Set(addrs.map((a) => a.toLowerCase())).size !== addrs.length) e.push(t("b.err.dup"));
    if (me && isNew && !addrs.some((a) => a.toLowerCase() === me.toLowerCase())) e.push(t("b.err.me"));
    if (!job.trim()) e.push(t("b.err.job"));
    if (noteBytes > 280) e.push(t("b.err.jobLong"));
    if (!(Number(amount) > 0)) e.push(t("b.err.amount"));
    if (Math.abs(total - 100) > 1e-9) e.push(t("b.err.total", { n: total }));
    if (payer.trim() && !isAddress(payer.trim())) e.push(t("b.err.payer"));
    if (isNew && sharedOn && !(Number(reservePct) > 0 && Number(reservePct) <= 50)) e.push(t("b.err.reserve"));
    return e;
  }, [people, isNew, teamName, me, job, noteBytes, amount, total, payer, sharedOn, reservePct, t]);

  // preview: exactly what the chest will do, unless the shared-costs reserve is already full (then nobody gives anything)
  const gross = Number(amount) > 0 ? toUsdc(amount) : 0n;
  const reserveFull = !isNew && !!chest && chest.reserve >= chest.rules.reserveTarget;
  const toReserve = reserveFull ? 0n : (gross * BigInt(reserveBps)) / 10_000n;
  const net = gross - toReserve;
  const workers = people.filter((p) => Number(p.share) > 0);
  const each = (p: Person) => {
    const bps = BigInt(Math.round((Number(p.share) || 0) * 100));
    if (p !== workers[workers.length - 1]) return (net * bps) / 10_000n;
    return net - workers.slice(0, -1).reduce((s, w) => s + (net * BigInt(Math.round(Number(w.share) * 100))) / 10_000n, 0n);
  };
  const others = workers.filter((p) => !me || p.address.trim().toLowerCase() !== me.toLowerCase());

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
            reserveTarget: sharedOn ? toUsdc(reserveTarget || "0") : 0n,
            autoAttributeCap: toUsdc("100"),
            expenseCapPerPeriod: toUsdc("100"),
            quorumBps: 5001, // more than half; the contract refuses anything lower
            timelock: DAY,
            periodLength: LIMITS_WINDOW,
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
    const shares = workers.map((p) => Math.round(Number(p.share) * 100));
    shares[shares.length - 1] += 10_000 - shares.reduce((a, b) => a + b, 0); // absorb rounding
    const salt = keccak256(toHex(`${Date.now()}-${Math.random()}`));
    const dueAt = dueDays ? BigInt(Math.floor(Date.now() / 1000) + dueDays * DAY) : 0n;
    const receipt = await send(t("tx.createInvoice"), {
      address: chestAddr,
      abi: collectiveAbi,
      functionName: "createInvoice",
      args: [salt, toUsdc(amount), (payer.trim() || ZERO) as Address, dueAt, workers.map((p) => p.address.trim() as Address), shares, job.trim()],
    });
    if (!receipt) return;
    const [inv] = parseEventLogs({ abi: collectiveAbi, logs: receipt.logs, eventName: "InvoiceCreated" });
    if (!inv) return;
    onDone({ chest: chestAddr, id: inv.args.id, others: others.map((p) => p.name.trim() || `${p.address.slice(0, 6)}…`) });
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
            <label className="field"><span className="hint">{t("b.amount")}</span><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="2400" /></label>
          </div>
          <div className="grid2" style={{ marginTop: 10 }}>
            <label className="field"><span className="hint">{t("b.due")}</span>
              <select className="input" value={dueDays} onChange={(e) => setDueDays(Number(e.target.value))}>{DUE.map((d) => <option key={d.days} value={d.days}>{t(d.label)}</option>)}</select>
            </label>
            <p className="hint" style={{ alignSelf: "end" }}>{t("b.public")}</p>
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
              return (
                <div className="billrow" key={i}>
                  <input className="input" aria-label={t("b.name")} placeholder={mineRow ? t("b.you") : t("b.name")} value={p.name} onChange={(e) => set(i, "name", e.target.value)} />
                  <input className="input wide" aria-label={t("b.addr")} placeholder="0x…" value={p.address} disabled={!isNew} onChange={(e) => set(i, "address", e.target.value)} />
                  <label className="pct"><input className="input" inputMode="decimal" aria-label="%" value={p.share} onChange={(e) => set(i, "share", e.target.value)} /><span className="mono">%</span></label>
                  <span className="hint gets">{gross > 0n && Number(p.share) > 0 ? t("b.gets", { amt: usdc(each(p)) }) : ""}</span>
                  {isNew && people.length > 1 && i > 0 && <button className="btn ghost small" onClick={() => setPeople(people.filter((_, j) => j !== i))}>{t("b.remove")}</button>}
                </div>
              );
            })}
          </div>
          {isNew && <button className="btn ghost small" style={{ marginTop: 10 }} onClick={() => setPeople([...people, { name: "", address: "", share: "0" }])}>{t("b.addPerson")}</button>}
          {isNew && people.length > 1 && <p className="hint" style={{ marginTop: 10 }}>{t("b.walletHint")}</p>}
          {!isNew && <p className="hint" style={{ marginTop: 10 }}>{t("b.membersHint")}</p>}
          {gross > 0n && toReserve > 0n && <p className="mono" style={{ marginTop: 12 }}>{t("b.reserveCut", { amt: usdc(toReserve) })}</p>}
        </div>

        {isNew && (
          <div className="card kraft">
            <label className="row" style={{ alignItems: "flex-start" }}>
              <input type="checkbox" checked={sharedOn} onChange={(e) => setSharedOn(e.target.checked)} style={{ marginTop: 4 }} />
              <span><b className="mono">{t("b.sharedOn")}</b><br /><span className="hint">{t("b.sharedHint")}</span></span>
            </label>
            {sharedOn && (
              <div className="grid2" style={{ marginTop: 12 }}>
                <label className="field"><span className="hint">{t("b.reservePct")}</span><input className="input" inputMode="decimal" value={reservePct} onChange={(e) => setReservePct(e.target.value)} /></label>
                <label className="field"><span className="hint">{t("b.reserveTarget")}</span><input className="input" inputMode="decimal" value={reserveTarget} onChange={(e) => setReserveTarget(e.target.value)} /></label>
              </div>
            )}
          </div>
        )}

        <details className="card kraft">
          <summary className="label" style={{ cursor: "pointer" }}>{t("b.advanced")}</summary>
          <div className="stack" style={{ marginTop: 12 }}>
            {isNew && (
              <label className="row" style={{ alignItems: "flex-start" }}>
                <input type="checkbox" checked={useAgent} onChange={(e) => setUseAgent(e.target.checked)} style={{ marginTop: 4 }} />
                <span><b className="mono">{t("b.agentOn")}</b><br /><span className="hint">{t("b.agentHint")}</span></span>
              </label>
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
          {others.length > 0 && <p className="mono" style={{ marginTop: 8, opacity: 0.85 }}>{t("b.thenAgree", { n: others.length })}</p>}
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

function Done({ chest, id, others, onAnother }: { chest: Address; id: Hex; others: string[]; onAnother: () => void }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  // the names ride along so teammates see who is who; the client sees them too, which is fine for nicknames
  const link = `${window.location.origin}/pay/${chest}/${id}${namesFragment(chest)}`;
  return (
    <>
      <main className="main">
        <div className="card tape no-pin">
          <div className="label">{t("d.label")}</div>
          <h1 className="title" style={{ marginTop: 6 }}>{others.length ? t("d.titleTeam") : t("d.title")}</h1>
          <p className="note" style={{ marginTop: 12 }}>{others.length ? t("d.bodyTeam", { who: others.join(", ") }) : t("d.body")}</p>
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
