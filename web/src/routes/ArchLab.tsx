import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { createArch, type Inscription } from "../arch/scene";
import "../arch/strings";
import { LangSwitch, useLang } from "../lib/i18n";
import "../styles/arch.css";

gsap.registerPlugin(ScrollTrigger);

/** Which copy step is showing for a given assembly progress. */
const stepOf = (p: number) => (p < 0.16 ? -1 : p < 0.4 ? 0 : p < 0.72 ? 1 : 2);

export default function ArchLab() {
  const { t, lang } = useLang();
  const canvas = useRef<HTMLCanvasElement>(null);
  const build = useRef<HTMLElement>(null);
  const [step, setStep] = useState(-1);

  useEffect(() => {
    const compact = window.matchMedia("(max-width: 760px)").matches;
    const sans = (text: string, size = 30) => ({ text, size });
    const serif = (text: string, size = 92) => ({ text, size, serif: true });
    const inscriptions: (Inscription | null)[] = [
      { lines: [sans(t("a.st.job1"), 34)] },
      { lines: [serif("Bekir"), sans(t("a.st.frontend"))], hero: true },
      { lines: [serif(lang === "tr" ? "Ömer" : "Omer"), sans(t("a.st.design"))], hero: true },
      { lines: [serif(t("a.st.key"), 70), sans(t("a.st.keySub"), 26)], red: true },
      { lines: [sans(t("a.st.job2"), 34)] },
      { lines: [serif("Naim"), sans(t("a.st.contracts"))], hero: true },
      { lines: [sans(t("a.st.job3"), 34)] },
    ];
    let arch: ReturnType<typeof createArch> | null = null;
    let lenis: Lenis | null = null;
    let st: ScrollTrigger | null = null;
    let raf = 0;
    let disposed = false;

    // the engravings are drawn with the page fonts, so wait for them
    Promise.all([document.fonts.load("92px 'Instrument Serif'"), document.fonts.load("30px 'JetBrains Mono'")]).finally(() => {
      if (disposed || !canvas.current || !build.current) return;
      arch = createArch(canvas.current, { inscriptions, reserve: { lines: [serif(t("a.st.reserve"), 74), sans(t("a.st.reserveSub"), 26)] }, compact });

      lenis = new Lenis({ lerp: 0.085, smoothWheel: true });
      lenis.on("scroll", ScrollTrigger.update);
      const loop = (time: number) => {
        lenis!.raf(time);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);

      st = ScrollTrigger.create({
        trigger: build.current,
        start: "top top",
        end: "bottom bottom",
        onUpdate: (self) => {
          arch!.setProgress(self.progress);
          setStep(stepOf(self.progress));
        },
      });

      // hero lines rise out of their masks once, on load
      gsap.from(".ah-line > span", { yPercent: 110, duration: 1.3, ease: "expo.out", stagger: 0.12, delay: 0.15 });
      gsap.from(".ah-eyebrow, .ah-cue", { opacity: 0, y: 12, duration: 1, ease: "power3.out", delay: 0.7, stagger: 0.1 });
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      st?.kill();
      lenis?.destroy();
      arch?.dispose();
    };
  }, [t, lang]);

  return (
    <div className="arch">
      <canvas ref={canvas} className="arch-canvas" aria-hidden="true" />
      <div className="arch-grain" aria-hidden="true" />

      <header className="arch-top">
        <Link to="/" className="arch-brand">
          Keyarc <span>{t("a.tag")}</span>
        </Link>
        <div className="arch-actions">
          <LangSwitch className="arch-lang" />
          <Link className="arch-cta" to="/app">{t("a.open")}</Link>
        </div>
      </header>

      <section className="arch-hero">
        <p className="ah-eyebrow">{t("a.hero.eyebrow")}</p>
        <h1 className="ah-title">
          <span className="ah-line"><span>{t("a.hero.l1")}</span></span>
          <span className="ah-line"><span>{t("a.hero.l2")}</span></span>
          <span className="ah-line accent"><span>{t("a.hero.l3")}</span></span>
        </h1>
        <p className="ah-cue">{t("a.scroll")} <i /></p>
      </section>

      <section className="arch-build" ref={build}>
        <div className="ab-sticky">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`ab-step ${step === i ? "on" : step > i ? "past" : ""}`} aria-hidden={step !== i}>
              <p className="ab-k">{t(`a.s${i + 1}.k`)}</p>
              {i === 2 ? (
                <h2 className="ab-t">{t("a.s3.t.a")} <em>{t("a.s3.t.b")}</em></h2>
              ) : (
                <h2 className="ab-t">{t(`a.s${i + 1}.t`)}</h2>
              )}
              <p className="ab-b">{t(`a.s${i + 1}.b`)}</p>
            </div>
          ))}
          <ol className="ab-rail" aria-hidden="true">
            {[0, 1, 2].map((i) => <li key={i} className={step >= i ? "on" : ""} />)}
          </ol>
        </div>
      </section>
      <section className="arch-after" />
    </div>
  );
}
