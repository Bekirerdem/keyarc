import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { setupCursor } from "./cursor";
import { LAND, LEAVE, POP, SHIFT, baseRot, clamp, type Point } from "./motion";
import { clearOdo, makeOdo, setOdo } from "./odometer";
import { Bead, Rope, stagePoint, type Scene } from "./rope";

gsap.registerPlugin(ScrollTrigger);

type SlamOptions = { x?: number; y?: number; rot?: number; dur?: number };

/** Wires every scene of the workshop-board landing inside `root` and returns a full cleanup
 *  (timelines, ScrollTriggers, rAF, listeners, observers and every DOM node it created). */
export function initLanding(root: HTMLElement): () => void {
  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`landing: missing ${sel}`);
    return el;
  };
  const qa = <T extends HTMLElement = HTMLElement>(sel: string): T[] => [...root.querySelectorAll<T>(sel)];

  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cleanups: Array<() => void> = [];
  const createdNodes: Element[] = [];
  let alive = true;
  let raf = 0;

  // DOM the engine rewrites; restored on cleanup so a remount (StrictMode) starts clean.
  const headlineSpans = qa("h1 .line>span");
  const headlineHtml = headlineSpans.map((s) => s.innerHTML);
  const odos = qa(".odo");
  const lines = qa("#receipt .ln");
  const ptapeTicks = q("#ptape .ticks");
  const ptapeDays = q("#ptape .days");

  // ── scenes ──────────────────────────────────────────────────────────────
  const scenes: Record<string, Scene> = {};
  qa("[data-scene]").forEach((sec) => {
    const stage = sec.querySelector<HTMLElement>(".stage");
    const canvas = stage?.querySelector<HTMLCanvasElement>("canvas.threads");
    const ctx = canvas?.getContext("2d");
    if (!stage || !canvas || !ctx || !sec.dataset.scene) return;
    scenes[sec.dataset.scene] = { sec, stage, canvas, ctx, ropes: [], beads: [], active: true, rect: stage.getBoundingClientRect() };
  });
  const S = scenes;

  // pointer + scroll velocity feed the ropes
  let mouseClient: Point | null = null;
  let scrollV = 0;
  const onMove = (e: PointerEvent) => {
    mouseClient = { x: e.clientX, y: e.clientY };
  };
  const onLeave = () => {
    mouseClient = null;
  };
  window.addEventListener("pointermove", onMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onLeave);
  cleanups.push(() => {
    window.removeEventListener("pointermove", onMove);
    document.documentElement.removeEventListener("pointerleave", onLeave);
  });

  // only simulate scenes that are on screen
  const io = new IntersectionObserver(
    (es) =>
      es.forEach((e) => {
        const s = Object.values(scenes).find((x) => x.sec === e.target);
        if (s) s.active = e.isIntersecting;
      }),
    { rootMargin: "120px" },
  );
  Object.values(scenes).forEach((s) => io.observe(s.sec));
  cleanups.push(() => io.disconnect());

  const sizeCanvas = (sc: Scene) => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = sc.stage.clientWidth;
    const h = sc.stage.clientHeight;
    if (sc.canvas.width !== Math.round(w * dpr) || sc.canvas.height !== Math.round(h * dpr)) {
      sc.canvas.width = Math.round(w * dpr);
      sc.canvas.height = Math.round(h * dpr);
    }
    sc.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  // ── ropes, beads, held tag ──────────────────────────────────────────────
  const ropesOf = new Map<Element, Rope[]>();
  const attach = (card: Element, rope: Rope) => {
    const list = ropesOf.get(card) ?? [];
    list.push(rope);
    ropesOf.set(card, list);
  };

  const hr = [
    new Rope(S.hero, q("#jWeb"), q("#mAli"), { slack: 1.12 }),
    new Rope(S.hero, q("#jWeb"), q("#mAyse"), { slack: 1.14 }),
    new Rope(S.hero, q("#jApi"), q("#mMeh"), { slack: 1.1 }),
    new Rope(S.hero, q("#jApi"), q("#mAyse"), { slack: 1.08 }),
    new Rope(S.hero, q("#jApi"), q("#mAli"), { slack: 1.06 }),
  ];
  attach(q("#jWeb"), hr[0]); attach(q("#mAli"), hr[0]);
  attach(q("#jWeb"), hr[1]); attach(q("#mAyse"), hr[1]);
  attach(q("#jApi"), hr[2]); attach(q("#mMeh"), hr[2]);
  attach(q("#jApi"), hr[3]); attach(q("#mAyse"), hr[3]);
  attach(q("#jApi"), hr[4]); attach(q("#mAli"), hr[4]);

  const br = [
    new Rope(S.but, q("#stA"), q("#sheetPin"), { slack: 1.06 }),
    new Rope(S.but, q("#stB"), q("#sheetPin"), { slack: 1.08 }),
    new Rope(S.but, q("#stC"), q("#sheetPin"), { slack: 1.07 }),
  ];
  br.forEach((r, i) => attach([q("#stA"), q("#stB"), q("#stC")][i], r));

  const tInv = new Rope(S.so, q("#inv"), q("#soJob"), { slack: 1.08 });
  const tRes = new Rope(S.so, q("#soJob"), q("#res"), { slack: 1.1 });
  const tAli = new Rope(S.so, q("#soJob"), q("#pAli"), { slack: 1.12 });
  const tAyse = new Rope(S.so, q("#soJob"), q("#pAyse"), { slack: 1.06 });
  ([
    ["#inv", tInv], ["#soJob", tInv], ["#soJob", tRes], ["#res", tRes],
    ["#soJob", tAli], ["#pAli", tAli], ["#soJob", tAyse], ["#pAyse", tAyse],
  ] as const).forEach(([sel, r]) => attach(q(sel), r));
  const bInv = new Bead(S.so, tInv, 9, q("#inv").dataset.bead ?? "");
  const bRes = new Bead(S.so, tRes, 4.2, q("#res").dataset.bead ?? "");
  const bAli = new Bead(S.so, tAli, 7.6, q("#pAli").dataset.bead ?? "");
  const bAyse = new Bead(S.so, tAyse, 6.2, q("#pAyse").dataset.bead ?? "");
  const beads = [bInv, bRes, bAli, bAyse];

  const tHold = new Rope(S.rules, q("#sender"), q("#agent"), { slack: 1.16 });
  attach(q("#sender"), tHold);
  attach(q("#agent"), tHold);

  // HELD tag hangs from the middle of the held thread and swings like a pendulum
  const heldEl = q("#held");
  const heldTag = {
    a: 0,
    va: 0,
    lx: null as number | null,
    vis: 0,
    update() {
      if (!tHold.pts || this.vis <= 0) {
        heldEl.style.visibility = "hidden";
        this.lx = null;
        this.a = this.va = 0;
        return;
      }
      const p = tHold.pointAt(0.5);
      const ax = this.lx == null ? 0 : clamp(p.x - this.lx, -5, 5);
      this.lx = p.x;
      this.va += -this.a * 0.07 - this.va * 0.08 - ax * 0.8;
      this.va = clamp(this.va, -6, 6);
      this.a = clamp(this.a + this.va, -32, 32);
      heldEl.style.visibility = "visible";
      heldEl.style.transform = `translate(${p.x - heldEl.offsetWidth / 2}px,${p.y + 18}px) rotate(${this.a}deg) scale(${this.vis})`;
    },
  };

  const frame = () => {
    if (!alive) return;
    scrollV *= 0.9;
    for (const sc of Object.values(scenes)) {
      if (!sc.active) continue;
      sc.rect = sc.stage.getBoundingClientRect();
      sizeCanvas(sc);
      const m = mouseClient && !REDUCED ? { x: mouseClient.x - sc.rect.left, y: mouseClient.y - sc.rect.top } : null;
      sc.ctx.clearRect(0, 0, sc.canvas.width, sc.canvas.height);
      for (const r of sc.ropes) {
        r.step(m, REDUCED ? 0 : scrollV);
        r.draw(sc.ctx);
      }
      for (const b of sc.beads) b.draw(sc.ctx);
    }
    heldTag.update();
    raf = requestAnimationFrame(frame);
  };

  // ── static DOM preparation ──────────────────────────────────────────────
  odos.forEach(makeOdo);
  for (let i = 1; i <= 31; i++) ptapeTicks.appendChild(document.createElement("i"));
  [1, 5, 10, 15, 20, 25, 31].forEach((n) => {
    const s = document.createElement("span");
    s.textContent = String(n).padStart(2, "0");
    ptapeDays.appendChild(s);
  });
  // split the hero headline into letters for a 1f glyph stagger; letters are grouped per word
  // so a line can only wrap between words, never inside one
  const walk = (n: Node) => {
    [...n.childNodes].forEach((c) => {
      if (c.nodeType === Node.TEXT_NODE) {
        const f = document.createDocumentFragment();
        (c.textContent ?? "").split(/( )/).forEach((part) => {
          if (!part) return;
          if (part === " ") {
            f.appendChild(document.createTextNode(" "));
            return;
          }
          const w = document.createElement("span");
          w.className = "w";
          [...part].forEach((ch) => {
            const s = document.createElement("span");
            s.className = "ch";
            s.textContent = ch;
            w.appendChild(s);
          });
          f.appendChild(w);
        });
        c.replaceWith(f);
      } else walk(c);
    });
  };
  headlineSpans.forEach(walk);

  // scene titles: every word (or highlighted phrase) sits in its own mask and rises out of it
  const splitEls = qa("[data-split]");
  const splitHtml = splitEls.map((el) => el.innerHTML);
  const mask = (inner: Node) => {
    const m = document.createElement("span");
    m.className = "wm";
    const i = document.createElement("span");
    i.className = "wi";
    m.appendChild(i);
    i.appendChild(inner);
    return m;
  };
  splitEls.forEach((el) => {
    [...el.childNodes].forEach((c) => {
      if (c.nodeType === Node.TEXT_NODE) {
        const f = document.createDocumentFragment();
        (c.textContent ?? "").split(/(\s+)/).forEach((part) => {
          if (!part) return;
          f.appendChild(/^\s+$/.test(part) ? document.createTextNode(" ") : mask(document.createTextNode(part)));
        });
        c.replaceWith(f);
      } else {
        const hole = document.createComment("");
        c.replaceWith(hole);
        hole.replaceWith(mask(c));
      }
    });
  });
  const words = (sel: string) => qa(`${sel} .wi`);
  /** Words rise out of their masks with a slight tilt that settles. */
  const rise = (sel: string, duration = 0.6) =>
    gsap.fromTo(words(sel), { yPercent: 115, rotation: 5 }, { yPercent: 0, rotation: 0, duration, ease: LAND, stagger: 0.05, immediateRender: true });

  const totalChars = lines.reduce((a, l) => a + (l.dataset.text ?? "").length, 0);
  const typeTo = (n: number) => {
    let left = Math.round(n);
    lines.forEach((l) => {
      const t = l.dataset.text ?? "";
      const k = clamp(left, 0, t.length);
      left -= t.length;
      const shown = t.slice(0, k).replace(/(matched|paid|held|eşleşti|ödendi|bekletildi)/g, "<b>$1</b>");
      l.innerHTML = shown + (k > 0 && k < t.length ? '<span class="caret"></span>' : "");
    });
  };

  // ── building blocks ─────────────────────────────────────────────────────
  /** A card flies in, hits the cork, squashes, overshoots, settles; the pin is punched in last
   *  and the attached threads twang. */
  const slam = (el: HTMLElement, o: SlamOptions = {}) => {
    const r = baseRot(el);
    const pin = el.querySelector(":scope > .pin");
    const tl = gsap.timeline();
    const dur = o.dur ?? 0.42;
    tl.fromTo(
      el,
      { x: o.x ?? 0, y: o.y ?? -340, rotation: r + (o.rot ?? gsap.utils.random(-18, 18)), scale: 1.18, autoAlpha: 0 },
      { x: 0, y: 0, rotation: r, scale: 1, autoAlpha: 1, duration: dur, ease: LAND, immediateRender: true },
    )
      // its shadow is wide and soft while it is in the air and snaps tight when it hits the cork
      .fromTo(el, { "--air": 1 }, { "--air": 0, duration: dur * 0.9, ease: LEAVE, immediateRender: true }, "<")
      .to(el, { scaleX: 1.045, scaleY: 0.95, duration: 0.06, ease: SHIFT })
      .to(el, { scaleX: 1, scaleY: 1, duration: 0.34, ease: POP });
    if (pin)
      tl.fromTo(pin, { y: -30, scale: 2.3, autoAlpha: 0 }, { y: 0, scale: 1, autoAlpha: 1, duration: 0.26, ease: POP, immediateRender: true }, "<-.06")
        .to(pin, { y: -7, duration: 0.07, ease: LAND }, ">-.08")
        .to(pin, { y: 0, duration: 0.18, ease: POP });
    tl.add(() => (ropesOf.get(el) ?? []).forEach((rp) => rp.pluck(9)), "<-.2");
    return tl;
  };

  /** Value tween whose onUpdate gets the current value (keeps `this` out of callbacks). */
  const value = (from: number, to: number, duration: number, ease: string, onUpdate: (v: number) => void) => {
    const o = { v: from };
    return gsap.to(o, { v: to, duration, ease, onUpdate: () => onUpdate(o.v) });
  };
  /** Instant toggle placed on a timeline: fires with `true` past the midpoint, `false` before it. */
  const toggle = (onChange: (on: boolean) => void) => value(0, 1, 0.01, "none", (v) => onChange(v > 0.5));

  const loosePinFor = (card: HTMLElement, stage: HTMLElement) => {
    const real = card.querySelector<HTMLElement>(":scope > .pin");
    const c = document.createElement("i");
    c.className = `${real?.className ?? "pin"} loose`;
    stage.appendChild(c);
    createdNodes.push(c);
    return { real, c };
  };

  const finalStates = () => {
    // reduced motion: show where every story ends, nothing moves
    [...hr, ...br, tInv, tRes, tAli, tAyse, tHold].forEach((r) => (r.reveal = 1));
    tHold.taut = tHold.tautTarget = tHold.holdTaut = 1;
    heldTag.vis = 1;
    setOdo(q("#resAmt"), 200);
    setOdo(q("#aliAmt"), 1080);
    setOdo(q("#ayseAmt"), 720);
    setOdo(q("#voteOdo"), 2);
    gsap.set(qa(".stamp"), { scale: 1 });
    gsap.set(q("#needle"), { left: "80%" });
    q("#ruler").classList.add("at-limit");
    typeTo(totalChars);
    gsap.set(qa(".step"), { opacity: 1, x: 0 });
  };

  // ── timelines ───────────────────────────────────────────────────────────
  const buildHero = () => {
    const tl = gsap.timeline({ delay: 0.15 });
    tl.from(qa("h1 .ch"), { yPercent: 120, rotation: 8, duration: 0.55, ease: LAND, stagger: 0.016 })
      .from(q(".eyebrow"), { y: -40, rotation: -12, autoAlpha: 0, duration: 0.45, ease: POP }, "<.1")
      .from(q(".lede"), { y: 30, rotation: 1.5, autoAlpha: 0, duration: 0.55, ease: LAND }, "<.2")
      .from(qa(".hero-copy .btn"), { y: 24, autoAlpha: 0, duration: 0.45, ease: POP, stagger: 0.08 }, "<.1");
    ["#mAli", "#mAyse", "#mMeh", "#jWeb", "#jApi"].forEach((s, i) => tl.add(slam(q(s), { y: -380 - i * 30 }), 0.35 + i * 0.11));
    tl.to(hr, { reveal: 1, duration: 0.7, ease: LAND, stagger: 0.12 }, ">-.2");
    if (matchMedia("(min-width:761px)").matches) {
      // depth parallax: nearer cards (higher data-depth) leave faster and drift apart a little
      const st = { trigger: q("#hero"), start: "top top", end: "bottom top", scrub: 0.6 };
      qa(".hc").forEach((c) => {
        const d = parseFloat(c.dataset.depth ?? "1");
        gsap.to(c, { yPercent: -90 * d, xPercent: (d - 1) * 40, ease: "none", scrollTrigger: { ...st } });
      });
      qa("#hero h1 .line").forEach((l, i) => gsap.to(l, { yPercent: -40 - i * 22, ease: "none", scrollTrigger: { ...st } }));
      gsap.to(qa(".hero-copy .lede, .hero-copy .btnrow"), { yPercent: -60, autoAlpha: 0.2, ease: "none", scrollTrigger: { ...st } });
    }
  };

  const buildBut = (pinned: boolean) => {
    const trigger = q("#but");
    const st = pinned
      ? { trigger, start: "top top", end: "+=210%", pin: true, scrub: 0.9, invalidateOnRefresh: true }
      : { trigger, start: "top 75%", end: "bottom 30%", scrub: 0.9, invalidateOnRefresh: true };
    const tl = gsap.timeline({ scrollTrigger: st });
    const sheet = q("#sheet");
    const halves = [q("#sheet .half.l"), q("#sheet .half.r")];
    tl.add(slam(sheet, { y: -520, rot: -20, dur: 0.6 }))
      .add(rise(".but-title", 0.7), "-=.3")
      .add(slam(q("#stA"), { y: -260, x: -120, rot: -24 }), "+=.05")
      .to(br[0], { reveal: 1, duration: 0.4, ease: LAND }, "<.3")
      .add(slam(q("#stB"), { y: -260, x: 140, rot: 20 }), "<.1")
      .to(br[1], { reveal: 1, duration: 0.4, ease: LAND }, "<.3")
      .add(slam(q("#stC"), { y: 200, x: 160, rot: -16 }), "<.1")
      .to(br[2], { reveal: 1, duration: 0.4, ease: LAND }, "<.3")
      // pressure builds: the complaints pull their threads tight, the sheet trembles
      .to(br, { taut: 1, tautTarget: 1, duration: 0.6, ease: SHIFT }, "+=.25")
      .to(sheet, { keyframes: { rotation: [-1.5, -3, 0, -2.5, 0.5, -2], x: [0, -4, 5, -3, 4, 0] }, duration: 0.6, ease: "none" }, "<")
      // the tear
      .addLabel("tear")
      .to(q("#sheetPin"), {
        keyframes: [
          { y: -200, x: 150, rotation: 320, duration: 0.3, ease: LAND },
          { y: 900, x: 330, rotation: 900, duration: 0.6, ease: LEAVE },
        ],
      }, "tear")
      .add(toggle((on) => {
        br.forEach((r) => r.setFree(on));
        sheet.classList.toggle("torn", on);
      }), "tear")
      .to(halves[0], { x: -60, y: 20, rotation: -11, transformOrigin: "0% 0%", duration: 0.35, ease: LAND }, "tear")
      .to(halves[1], { x: 70, y: 10, rotation: 13, transformOrigin: "100% 0%", duration: 0.35, ease: LAND }, "tear")
      .to(halves[0], { y: 900, rotation: -32, duration: 0.7, ease: LEAVE }, "tear+=.35")
      .to(halves[1], { y: 900, rotation: 41, duration: 0.75, ease: LEAVE }, "tear+=.4")
      // paper flutters off the board
      .to(q("#stA"), { keyframes: [
        { x: -40, y: -50, rotation: -22, duration: 0.22, ease: LAND },
        { x: -90, y: 150, rotation: 8, duration: 0.3, ease: SHIFT },
        { x: -130, y: 820, rotation: -36, duration: 0.5, ease: LEAVE },
      ] }, "tear+=.12")
      .to(q("#stB"), { keyframes: [
        { x: 50, y: -60, rotation: 22, duration: 0.22, ease: LAND },
        { x: 110, y: 140, rotation: -6, duration: 0.3, ease: SHIFT },
        { x: 170, y: 900, rotation: 44, duration: 0.5, ease: LEAVE },
      ] }, "tear+=.2")
      .to(q("#stC"), { keyframes: [
        { x: 40, y: -40, rotation: -18, duration: 0.22, ease: LAND },
        { x: 80, y: 120, rotation: 12, duration: 0.3, ease: SHIFT },
        { x: 110, y: 700, rotation: -30, duration: 0.5, ease: LEAVE },
      ] }, "tear+=.28")
      .to({}, { duration: 0.5 });
  };

  const buildSo = (pinned: boolean) => {
    const trigger = q("#so");
    const st = pinned
      ? { trigger, start: "top top", end: "+=300%", pin: true, scrub: 0.9, invalidateOnRefresh: true }
      : { trigger, start: "top 70%", end: "bottom 40%", scrub: 0.9, invalidateOnRefresh: true };
    const tl = gsap.timeline({ scrollTrigger: st });
    const step = (i: number) => gsap.to(q(`.step:nth-child(${i})`), { opacity: 1, x: 0, duration: 0.35, ease: LAND });
    const flag = (s: string) => gsap.fromTo(q(s), { y: -70, rotation: -14, autoAlpha: 0 }, { y: 0, rotation: 0, autoAlpha: 1, duration: 0.4, ease: POP });
    const recv = (el: HTMLElement, rope: Rope) =>
      gsap.timeline().to(el, { scale: 1.06, duration: 0.08, ease: SHIFT }).to(el, { scale: 1, duration: 0.4, ease: POP }).add(() => rope.pluck(8), 0);
    const flow = (bead: Bead, dur: number) =>
      value(0, 1, dur, SHIFT, (t) => {
        bead.t = t;
        bead.on = t > 0 && t < 1;
      });
    const burst = q("#burst");
    tl.add(rise(".so-title"))
      .add(slam(q("#inv"), { y: -320, rot: -18 }), "<.15")
      .add(step(1), "<.25")
      .add(flag("#fl1"), "<")
      .add(slam(q("#soJob"), { x: -280, y: -40, rot: 12 }))
      .to(tInv, { reveal: 1, duration: 0.45, ease: LAND }, "<.25")
      .add(flow(bInv, 1.1))
      .add(step(2), "<.6")
      .add(recv(q("#soJob"), tInv), ">-.02")
      // the node flashes and the payment splits by its shares
      .fromTo(burst, { autoAlpha: 1, scale: 0.2 }, {
        scale: 1.6, autoAlpha: 0, duration: 0.5, ease: LAND,
        onStart: () => {
          S.so.rect = S.so.stage.getBoundingClientRect();
          const p = stagePoint(q("#soJob"), S.so);
          gsap.set(burst, { x: p.x, y: p.y });
        },
      }, "<")
      .add(slam(q("#res"), { y: -280, rot: 14 }), "<.05")
      .to(tRes, { reveal: 1, duration: 0.4, ease: LAND }, "<.2")
      .add(flow(bRes, 0.8))
      .add(recv(q("#res"), tRes))
      .add(value(0, 200, 0.5, LAND, (v) => setOdo(q("#resAmt"), v)), "<")
      .add(step(3), "<")
      .add(flag("#fl2"), "<")
      .add(slam(q("#pAli"), { y: 300, rot: -16 }), ">-.1")
      .add(slam(q("#pAyse"), { y: 320, rot: 16 }), "<.1")
      .to([tAli, tAyse], { reveal: 1, duration: 0.45, ease: LAND, stagger: 0.08 }, "<.2")
      .addLabel("split")
      .add(flow(bAli, 1), "split")
      .add(flow(bAyse, 1.15), "split")
      .add(step(4), "split+=.4")
      .add(recv(q("#pAli"), tAli), "split+=1")
      .add(recv(q("#pAyse"), tAyse), "split+=1.15")
      .add(value(0, 1080, 0.7, LAND, (v) => setOdo(q("#aliAmt"), v)), "split+=1")
      .add(value(0, 720, 0.7, LAND, (v) => setOdo(q("#ayseAmt"), v)), "split+=1.15")
      .add(flag("#fl3"), "split+=1.2")
      .to([q("#pAli"), q("#pAyse")], {
        boxShadow: "0 0 0 3px #ffe08a, 0 0 40px 8px rgba(255,214,110,.7), 0 14px 28px -8px rgba(40,20,5,.45)",
        duration: 0.3, ease: LAND, stagger: 0.1,
      }, "split+=1.2")
      .to(q(".ptape .now"), { left: "30%", duration: 0.6, ease: SHIFT }, "split+=1.2")
      // hold so the counters sit on their final values well before the pin releases
      .to({}, { duration: 0.9 });
  };

  const buildRules = (pinned: boolean) => {
    const trigger = q("#rules");
    const st = pinned
      ? { trigger, start: "top top", end: "+=320%", pin: true, scrub: 0.9, invalidateOnRefresh: true }
      : { trigger, start: "top 70%", end: "bottom 35%", scrub: 0.9, invalidateOnRefresh: true };
    const tl = gsap.timeline({ scrollTrigger: st });
    const ballot = q("#ballot");
    tl.add(rise(".rules-title"))
      .add(slam(ballot, { x: -420, y: -60, rot: -16 }), "<.2");
    // YES stamps: ink splashes, stamp lands with overshoot, the tally rolls
    qa(".vote").slice(0, 2).forEach((v, i) => {
      const splat = v.querySelector(".splat");
      const stamp = v.querySelector(".stamp");
      if (!splat || !stamp) return;
      tl.fromTo(splat, { scale: 0.2, autoAlpha: 0 }, { scale: 1.25, autoAlpha: 1, duration: 0.18, ease: LAND }, `stamp${i}`)
        .to(splat, { scale: 1.05, autoAlpha: 0.55, duration: 0.3, ease: LAND }, `stamp${i}+=.18`)
        .fromTo(stamp, { scale: 2.2, rotation: -30 }, { scale: 1, rotation: -14, duration: 0.28, ease: POP }, `stamp${i}+=.04`)
        .to(ballot, { y: 3, duration: 0.05, ease: SHIFT }, `stamp${i}+=.08`)
        .to(ballot, { y: 0, duration: 0.2, ease: POP })
        .add(value(i, i + 1, 0.25, LAND, (n) => setOdo(q("#voteOdo"), n)), `stamp${i}+=.1`);
      if (i < 1) tl.addLabel(`stamp${i + 1}`, `stamp${i}+=.32`);
    });
    const ruler = q("#ruler");
    tl.add(slam(q("#agent"), { y: -400, rot: 18 }), ">+.1")
      .add(slam(q("#sender"), { x: 300, y: -80, rot: 24 }), "<.15")
      .to(tHold, { reveal: 1, duration: 0.5, ease: LAND }, "<.25")
      // the agent holds: the thread snaps taut and trembles, a tag swings from it
      .addLabel("hold")
      .to(tHold, { taut: 1, tautTarget: 1, holdTaut: 1, duration: 0.35, ease: SHIFT }, "hold")
      .add(value(0, 1, 0.35, "none", (j) => (tHold.jitter = j * 1.6)), "hold")
      .to(heldTag, { vis: 1, duration: 0.3, ease: POP }, "hold+=.15")
      .add(() => {
        heldTag.va += 4;
      }, "hold+=.2")
      .add(slam(ruler, { y: 300, rot: -8 }), "hold+=.3")
      .to(q("#needle"), { left: "86%", duration: 0.9, ease: SHIFT })
      .to(q("#needle"), { left: "80%", duration: 0.3, ease: POP })
      .add(toggle((on) => ruler.classList.toggle("at-limit", on)), ">")
      .add(slam(q("#receipt"), { y: 260, rot: 6 }), "<")
      .add(value(0, totalChars, 1.6, "none", typeTo), ">-.1");
    if (pinned) {
      // month end: pins pop and roll, the board empties
      const cards = ["#ballot", "#agent", "#sender", "#ruler", "#receipt"].map((s) => q(s));
      const stage = S.rules.stage;
      tl.addLabel("clear", "+=1.4")
        .to(tHold, { taut: 0, tautTarget: 0, holdTaut: 0, duration: 0.2, ease: LAND }, "clear")
        .add(value(1, 0, 0.2, "none", (j) => (tHold.jitter = j * 1.6)), "clear")
        .to(heldTag, { vis: 0, duration: 0.2, ease: LEAVE }, "clear")
        .add(toggle((on) => tHold.setFree(on)), "clear+=.15");
      cards.forEach((card, i) => {
        const { real, c } = loosePinFor(card, stage);
        const dx = (i % 2 ? 1 : -1) * gsap.utils.random(80, 180);
        let p0: Point = { x: 0, y: 0 };
        const at = `clear+=${0.08 * i}`;
        tl.set(c, {
          x: () => {
            S.rules.rect = stage.getBoundingClientRect();
            p0 = stagePoint(card, S.rules);
            return p0.x - 9;
          },
          y: () => p0.y - 9,
          autoAlpha: 1,
          rotation: 0,
        }, at);
        if (real) tl.set(real, { autoAlpha: 0 }, at);
        tl.to(c, { y: "-=70", x: `+=${dx * 0.25}`, rotation: 140, duration: 0.18, ease: LAND }, at)
          .to(c, { y: () => stage.clientHeight - 26, x: `+=${dx * 0.45}`, rotation: "+=320", duration: 0.42, ease: LEAVE })
          .to(c, { y: "-=38", x: `+=${dx * 0.15}`, rotation: "+=120", duration: 0.14, ease: LAND })
          .to(c, { y: "+=38", x: `+=${dx * 0.15}`, rotation: "+=120", duration: 0.14, ease: LEAVE })
          .to(c, { x: `+=${dx * 0.6}`, rotation: "+=300", duration: 0.4, ease: LAND })
          .to(card, {
            y: () => stage.clientHeight + 260,
            rotation: `+=${(i % 2 ? 1 : -1) * gsap.utils.random(18, 40)}`,
            duration: 0.6,
            ease: LEAVE,
          }, `${at}+=.12`);
      });
      tl.to(q(".rules-title"), { y: -500, autoAlpha: 0, duration: 0.5, ease: LEAVE }, "clear+=.3").to({}, { duration: 0.3 });
    }
  };

  const buildClose = () => {
    const tl = gsap.timeline({ paused: true });
    tl.add(slam(q("#closeCard"), { y: 260, rot: -10, dur: 0.6 }))
      .add(rise("#closeCard h2", 0.7), "-=.3")
      .from(qa("#closeCard > p, #closeCard .btnrow > *"), { y: 22, autoAlpha: 0, duration: 0.45, ease: LAND, stagger: 0.08 }, "-=.45")
      .add(slam(q("#periodCard"), { y: -260, x: 160, rot: 32 }), "-=.3");
    ScrollTrigger.create({ trigger: q("#start"), start: "top 70%", once: true, onEnter: () => void tl.play() });
  };

  // ── wire it all inside one context so a single revert undoes every tween ──
  const mm = gsap.matchMedia();
  const ctx = gsap.context(() => {
    qa(".card").forEach((c) => gsap.set(c, { rotation: baseRot(c) }));
    ScrollTrigger.create({ start: 0, end: "max", onUpdate: (s) => (scrollV = s.getVelocity()) });

    // card hover pulls its threads taut (desktop pointer)
    qa(".card.lift").forEach((c) => {
      const enter = () => (ropesOf.get(c) ?? []).forEach((r) => (r.tautTarget = Math.max(r.tautTarget, 0.65)));
      const leave = () => (ropesOf.get(c) ?? []).forEach((r) => (r.tautTarget = r.holdTaut || 0));
      c.addEventListener("pointerenter", enter);
      c.addEventListener("pointerleave", leave);
      cleanups.push(() => {
        c.removeEventListener("pointerenter", enter);
        c.removeEventListener("pointerleave", leave);
      });
    });

    if (matchMedia("(hover:hover) and (pointer:fine)").matches && !REDUCED) cleanups.push(setupCursor(q(".cursor")));

    if (REDUCED) {
      qa(".card").forEach((c) => gsap.set(c, { autoAlpha: 1 }));
      finalStates();
    } else {
      buildHero();
      mm.add("(min-width:761px)", () => {
        buildBut(true);
        buildSo(true);
        buildRules(true);
      });
      mm.add("(max-width:760px)", () => {
        buildBut(false);
        buildSo(false);
        buildRules(false);
      });
      buildClose();
    }
  }, root);

  raf = requestAnimationFrame(frame);
  const refresh = () => {
    if (alive) ScrollTrigger.refresh();
  };
  window.addEventListener("load", refresh);
  cleanups.push(() => window.removeEventListener("load", refresh));
  void document.fonts?.ready.then(refresh);
  requestAnimationFrame(refresh);

  if (import.meta.env.DEV) {
    (window as unknown as { __orta?: unknown }).__orta = {
      scenes,
      ropes: { hero: hr, but: br, so: [tInv, tRes, tAli, tAyse], rules: [tHold] },
      beads: { bInv, bRes, bAli, bAyse },
      heldTag,
      setOdo,
    };
  }

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    mm.revert();
    ctx.revert();
    cleanups.forEach((fn) => fn());
    beads.forEach((b) => b.remove());
    createdNodes.forEach((n) => n.remove());
    odos.forEach(clearOdo);
    lines.forEach((l) => (l.innerHTML = ""));
    ptapeTicks.innerHTML = "";
    ptapeDays.innerHTML = "";
    headlineSpans.forEach((s, i) => (s.innerHTML = headlineHtml[i]));
    splitEls.forEach((el, i) => (el.innerHTML = splitHtml[i]));
    if (import.meta.env.DEV) delete (window as unknown as { __orta?: unknown }).__orta;
  };
}
