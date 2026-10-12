import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { Link } from "react-router";
import { initLanding } from "../landing/engine";
import "../landing/strings";
import { LangSwitch, useLang } from "../lib/i18n";
import "../styles/landing.css";

const FACTORY_URL = "https://explorer.arc.io/address/0x295F88F793E38eB8be6684b13e02799aADAEd0d9";

type CardStyle = CSSProperties & { "--r": string };
/** Position + resting tilt for a pinned card. */
const at = (left: string | null, top: string | null, r: string, extra: CSSProperties = {}): CardStyle => ({
  ...(left ? { left } : {}),
  ...(top ? { top } : {}),
  "--r": r,
  ...extra,
});

type T = ReturnType<typeof useLang>["t"];

function SheetHalf({ side, t }: { side: "l" | "r"; t: T }) {
  return (
    <div className={`half ${side}`} aria-hidden={side === "r" ? true : undefined}>
      <div className="tear">
        <div className="bar">
          <span>{t("l.sheet.file")}</span>
          <span>{t("l.sheet.edited")}</span>
        </div>
        <table>
          <tbody>
            <tr><td>Lena</td><td>{t("l.sheet.owe")} {t("l.sheet.lenaOwed")}</td><td className="q">{t("l.sheet.partial")}</td></tr>
            <tr><td>Marco</td><td>{t("l.sheet.owe")} {t("l.sheet.marcoOwed")}</td><td className="q">{t("l.sheet.which")}</td></tr>
            <tr><td>{t("l.sheet.reserve")}</td><td>—</td><td className="x">{t("l.sheet.forgot")}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Vote({ who, yes, label }: { who: string; yes: boolean; label: string }) {
  return (
    <div className="vote">
      {who}
      {yes && (
        <>
          <i className="splat" />
          <i className="stamp">{label}</i>
        </>
      )}
    </div>
  );
}

/** Remounts the whole board when the language changes so every scene rebuilds from the new text. */
export default function Landing() {
  const { lang } = useLang();
  return <Board key={lang} />;
}

function Board() {
  const root = useRef<HTMLDivElement>(null);
  const { t, lang } = useLang();

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    // the odometers read the page language while building; set it before the scenes are wired
    document.documentElement.lang = lang;
    document.body.classList.add("landing-body");
    const dispose = initLanding(el);
    return () => {
      dispose();
      document.body.classList.remove("landing-body");
    };
  }, [lang]);

  const yes = t("l.rules.yes");

  return (
    <div className="landing" ref={root}>
      <div className="cursor" aria-hidden="true"><i className="c-needle" /><i className="c-head" /></div>

      <div className="strip">
        <div className="brand"><div className="tape" /><b>Keyarc</b><span>{t("l.tagline")}</span></div>
        <nav className="navcard" aria-label="Main">
          <a href="#but">{t("l.nav.why")}</a>
          <a href="#so">{t("l.nav.how")}</a>
          <a href="#rules">{t("l.nav.rules")}</a>
          <Link className="cta" to="/app">{t("l.nav.open")}</Link>
          <LangSwitch className="nav-lang" />
        </nav>
      </div>

      {/* 1 · HERO — the team earns together */}
      <section className="scene" id="hero" data-scene="hero">
        <div className="stage" id="heroStage">
          <canvas className="threads" />
          <div className="hero-copy">
            <span className="eyebrow">{t("l.hero.eyebrow")}</span>
            <h1>
              <span className="line"><span>{t("l.hero.l1")}</span></span>
              <span className="line"><span>{t("l.hero.l2")}</span></span>
              <span className="line"><span><em>{t("l.hero.l3")}</em></span></span>
            </h1>
            <p className="lede">{t("l.hero.lede")}</p>
            <div className="btnrow">
              <Link className="btn" to="/app">{t("l.hero.start")} <span className="arr">→</span></Link>
              <a className="btn ghost" href="#but">{t("l.hero.see")} <span className="arr">↓</span></a>
            </div>
          </div>

          {/* money enters at the top (clients pay a link), runs through the job, lands with the people */}
          <div className="card client kraft hc lift" id="cWeb" data-depth="1.25" data-bead={t("l.bead.client")} style={at("57vw", "11vh", "-2.5deg")}><i className="pin" /><span className="label">{t("l.client.monthly")}</span><div className="cname">{t("l.client.coffee")}</div><span className="paylink">{t("l.client.link")} #014 ↗</span></div>
          <div className="card client kraft hc lift" id="cApi" data-depth=".9" style={at("78vw", "11vh", "2deg")}><i className="pin" /><span className="label">{t("l.client.once")}</span><div className="cname">{t("l.client.fintech")}</div><span className="paylink">{t("l.client.link")} #015 ↗</span></div>
          <div className="card job hc lift" id="jWeb" data-depth=".95" style={at("56vw", "36vh", "2deg")}><i className="pin brass" /><span className="label">{t("l.job.retainer")}</span><h4>{t("l.job.web")}</h4><div className="jobamt">{t("l.job.retainerAmt")}</div><div className="who"><span className="chip">Deniz 60%</span><span className="chip">Lena 40%</span></div></div>
          <div className="card job hc lift" id="jApi" data-depth="1.2" style={at("76vw", "39vh", "-3deg")}><i className="pin brass" /><span className="label">{t("l.job.oneoff")}</span><h4>{t("l.job.launch")}</h4><div className="jobamt">{t("l.job.oneoffAmt")}</div><div className="who"><span className="chip">Lena 50%</span><span className="chip">Marco 30%</span><span className="chip">Deniz 20%</span></div></div>
          <div className="card member hc lift" id="mAli" data-depth="1.15" style={at("57vw", "66vh", "-4deg")}><i className="pin" /><div className="face">D</div><div className="name">Deniz</div><div className="role">{t("l.role.dev")}</div></div>
          <div className="card member hc lift" id="mAyse" data-depth=".8" style={at("71vw", "69vh", "3deg")}><i className="pin" /><div className="face" style={{ background: "#7a2a1d" }}>L</div><div className="name">Lena</div><div className="role">{t("l.role.design")}</div></div>
          <div className="card member hc lift" id="mMeh" data-depth="1.3" style={at("85vw", "65vh", "-2deg")}><i className="pin" /><div className="face" style={{ background: "#2f4a3a" }}>M</div><div className="name">Marco</div><div className="role">{t("l.role.copy")}</div></div>
        </div>
      </section>

      {/* 2 · BUT — the split lives in one spreadsheet */}
      <section className="scene" id="but" data-scene="but">
        <div className="stage" id="butStage">
          <canvas className="threads" />
          <div className="card sticky bc lift" id="stA" style={at("8vw", "16vh", "-6deg")}><i className="pin" /><p className="note">{t("l.but.note1")}</p><span className="sig">— {t("l.but.sig1")}</span></div>
          <div className="card sticky pink bc lift" id="stB" style={at("66vw", "10vh", "5deg")}><i className="pin" /><p className="note">{t("l.but.note2")}</p><span className="sig">— {t("l.but.sig2")}</span></div>
          <div className="card sticky blue bc lift" id="stC" style={at("72vw", "44vh", "-3deg")}><i className="pin" /><p className="note">{t("l.but.note3")}</p></div>
          <div className="card sheet" id="sheet" style={at("31vw", "22vh", "-1.5deg")}>
            <i className="pin" id="sheetPin" />
            <SheetHalf side="l" t={t} />
            <SheetHalf side="r" t={t} />
          </div>
          <div data-split className="big-say but-title">{t("l.but.title.a")}<i>{t("l.but.title.em")}</i>{t("l.but.title.b")}</div>
        </div>
      </section>

      {/* 3 · SO — the chest */}
      <section className="scene" id="so" data-scene="so">
        <div className="stage" id="soStage">
          <canvas className="threads" />
          <div data-split className="big-say so-title">{t("l.so.title")}</div>
          <div className="card invoice lift" id="inv" data-bead={t("l.bead.inv")} style={at("7vw", "12vh", "-2deg")}>
            <i className="pin" />
            <span className="label">{t("l.so.invoice")}</span>
            <div className="row"><span className="note" style={{ fontSize: 19 }}>{t("l.so.client")}</span><span className="amount">{t("l.so.amount")}</span></div>
          </div>
          <div className="card job lift" id="soJob" style={at("12vw", "42vh", "1.5deg")}><i className="pin brass" /><span className="label">{t("l.so.matched")}</span><h4>{t("l.job.web")}</h4><div className="who"><span className="chip">Deniz 60%</span><span className="chip">Lena 40%</span></div></div>
          <div className="card reserve lift" id="res" data-bead={t("l.bead.res")} style={at("38vw", "12vh", "-1deg")}><i className="pin" /><span className="label" style={{ position: "relative" }}>{t("l.so.reserve")}</span><span className="amount" style={{ position: "relative" }}><span className="odo" id="resAmt" data-max="200" /> USDC</span></div>
          <div className="card payee lift" id="pAli" data-bead={t("l.bead.a")} style={at("40vw", "50vh", "-3deg")}><i className="pin" /><span className="label">Deniz · 60%</span><div className="amount"><span className="odo" id="aliAmt" data-max="1080" /> USDC</div><span className="chip paycur">{t("l.so.payA")}</span></div>
          <div className="card payee lift" id="pAyse" data-bead={t("l.bead.b")} style={at("55vw", "55vh", "2.5deg")}><i className="pin" /><span className="label">Lena · 40%</span><div className="amount"><span className="odo" id="ayseAmt" data-max="720" /> USDC</div><span className="chip paycur">{t("l.so.payB")}</span></div>
          <div className="burst" id="burst" />
          <div className="steps">
            <div className="step"><b>01</b><span>{t("l.so.step1")}</span></div>
            <div className="step"><b>02</b><span>{t("l.so.step2")}</span></div>
            <div className="step"><b>03</b><span>{t("l.so.step3")}</span></div>
            <div className="step"><b>04</b><span>{t("l.so.step4")}</span></div>
          </div>
          <div className="ptape" id="ptape">
            <span className="label" style={{ position: "absolute", right: 18, top: -24, background: "var(--paper)", padding: "3px 8px", transform: "rotate(1deg)" }}>{t("l.so.period")}</span>
            <div className="ticks" />
            <div className="days" />
            <span className="now" />
            <span className="flag" id="fl1" style={{ left: "7%" }}>{t("l.so.day")}<b>{t("l.so.flag1.n")}</b>{t("l.so.flag1")}</span>
            <span className="flag" id="fl2" style={{ left: "34%" }}>{t("l.so.day")}<b>200</b>{t("l.so.flag2")}</span>
            <span className="flag" id="fl3" style={{ left: "58%" }}>{t("l.so.day")}<b>{t("l.so.flag3.n")}</b>{t("l.so.flag3")}</span>
          </div>
        </div>
      </section>

      {/* 4 · RULES — vote + agent inside limits */}
      <section className="scene" id="rules" data-scene="rules">
        <div className="stage" id="rulesStage">
          <canvas className="threads" />
          <div data-split className="big-say rules-title">{t("l.rules.title")}</div>
          <div className="card ballot lift" id="ballot" style={at("7vw", "44vh", "-1.5deg")}>
            <i className="pin" />
            <span className="label">{t("l.rules.proposal")}</span>
            <span className="tally"><span className="odo" id="voteOdo" data-max="3" />/3</span>
            <h4>{t("l.rules.reserve3")}</h4>
            <div className="votes">
              <Vote who="D" yes label={yes} /><Vote who="L" yes label={yes} /><Vote who="M" yes={false} label={yes} />
            </div>
            <span className="label needs">{t("l.rules.needs")}</span>
          </div>
          <div className="card sender kraft lift" id="sender" style={at("84vw", "40vh", "4deg")}><i className="pin" /><span className="label">{t("l.rules.unknown")}</span><div className="amount">{t("l.rules.senderAmt")}</div></div>
          <div className="card agent lift" id="agent" style={at("50vw", "15vh", "2deg")}>
            <i className="pin brass" />
            <span className="label">{t("l.rules.agent")}</span>
            <p className="note" style={{ marginTop: 8 }}>{t("l.rules.agentNote")}</p>
          </div>
          <span className="held" id="held">{t("l.rules.held")}</span>
          <div className="card ruler" id="ruler" style={at("44vw", "58vh", "-1deg")}><i className="pin" /><span className="limitline" /><span className="needle" id="needle" /><span className="label">{t("l.rules.ruler")}</span><span className="limit">{t("l.rules.limit")}</span></div>
          <div className="card receipt" id="receipt" style={at("7vw", "76vh", ".6deg")}>
            <i className="pin brass" />
            <div className="ln" data-text={t("l.rules.log1")} />
            <div className="ln" data-text={t("l.rules.log2")} />
            <div className="ln" data-text={t("l.rules.log3")} />
          </div>
        </div>
      </section>

      {/* 5 · CLOSE — month end, board clears, new period */}
      <section className="close" id="start">
        <div className="card close-card lift" id="closeCard" style={at(null, null, "-.8deg")}>
          <i className="pin" />
          <div className="card period" id="periodCard" style={at(null, null, "6deg")}><i className="pin brass" /><span className="label">{t("l.close.period")}</span><div className="amount" style={{ marginTop: 6 }}>{t("l.close.opens")}</div></div>
          <span className="label">{t("l.close.label")}</span>
          <h2 data-split style={{ marginTop: 18 }}>{t("l.close.title")}</h2>
          <p>{t("l.close.body")}</p>
          <div className="btnrow">
            <Link className="btn" to="/app">{t("l.hero.start")} <span className="arr">→</span></Link>
            <a className="btn ghost" href={FACTORY_URL} target="_blank" rel="noopener noreferrer">{t("l.close.contract")} <span className="arr">↗</span></a>
          </div>
        </div>
      </section>
      <footer className="foot"><span>{t("l.foot.a")}</span><span>{t("l.foot.b")}</span></footer>
    </div>
  );
}
