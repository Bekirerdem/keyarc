import { Link } from "react-router";
import { useConnection } from "wagmi";
import { DEMO_CHEST } from "../lib/contracts";
import { short } from "../lib/format";
import { useLang } from "../lib/i18n";
import { useMyChests } from "../lib/team";
import { Brand, Wallet } from "./Wallet";

export default function Home() {
  const { address } = useConnection();
  const mine = useMyChests(address);
  const { t } = useLang();

  return (
    <div className="board">
      <aside className="rail">
        <Brand />
        <Wallet />
        <div className="card tilt-l no-pin kraft">
          <div className="label">{t("home.how")}</div>
          <ol className="mono" style={{ marginTop: 10, paddingLeft: 18, display: "grid", gap: 8 }}>
            <li>{t("h.how1")}</li>
            <li>{t("h.how2")}</li>
            <li>{t("h.how3")}</li>
            <li>{t("h.how4")}</li>
          </ol>
        </div>
      </aside>

      <main className="main">
        <div className="card tape no-pin">
          <div className="label">{t("h.label")}</div>
          <h1 className="title" style={{ marginTop: 6 }}>{t("h.title")}</h1>
          <div className="row" style={{ marginTop: 18, flexWrap: "wrap" }}>
            <Link className="btn red" to="/app/bill">{t("h.bill")}</Link>
            <Link className="btn ghost" to="/app/earnings">{t("h.earnings")}</Link>
          </div>
        </div>

        <div className="label" style={{ marginTop: 6 }}>{t("h.teams")}</div>
        {!address && (
          <div className="card tilt-l">
            <p className="note">{t("home.connectFirst")}</p>
          </div>
        )}
        {address && mine.isLoading && <div className="card"><div className="skeleton" style={{ height: 60 }} /></div>}
        {address && mine.isError && (
          <div className="card tilt-l">
            <p className="note">{t("net.down")}</p>
            <p className="hint" style={{ marginTop: 8 }}>{t("net.downBody")}</p>
            <button className="btn small" style={{ marginTop: 12 }} onClick={() => mine.refetch()}>{t("net.retry")}</button>
          </div>
        )}
        {address && mine.data && mine.data.length === 0 && (
          <div className="card tilt-r empty">
            <p className="note">{t("home.empty")}</p>
            <Link className="btn small" style={{ marginTop: 12 }} to="/app/bill">{t("h.bill")}</Link>
          </div>
        )}
        <div className="grid2">
          {mine.data?.map((c, i) => (
            <div key={c.address} className={`card ${i % 2 ? "tilt-r" : "tilt-l"}`} style={{ animationDelay: `${i * 60}ms` }}>
              <Link to={`/c/${c.address}`} style={{ textDecoration: "none", color: "inherit" }}>
                <div className="label">{short(c.address)}</div>
                <div className="h3" style={{ marginTop: 6 }}>{c.name}</div>
              </Link>
              <Link className="btn ghost small" style={{ marginTop: 12 }} to={`/app/bill?team=${c.address}`}>{t("h.bill")}</Link>
            </div>
          ))}
        </div>
      </main>

      <aside className="side">
        <Link to={`/c/${DEMO_CHEST}`} className="card ink" style={{ textDecoration: "none" }}>
          <div className="label">{t("home.live")}</div>
          <div className="h3" style={{ marginTop: 6 }}>{t("h.demo")}</div>
          <p className="mono" style={{ marginTop: 8, opacity: 0.8 }}>{t("h.demoBody")}</p>
          <span className="btn small" style={{ marginTop: 14 }}>{t("home.lookInside")}</span>
        </Link>
      </aside>
    </div>
  );
}
