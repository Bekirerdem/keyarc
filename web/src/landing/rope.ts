import { clamp, type Point } from "./motion";

/** One pinned scene: its stage, the canvas the threads are drawn on, and what lives on it. */
export type Scene = {
  sec: HTMLElement;
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  ropes: Rope[];
  beads: Bead[];
  active: boolean;
  rect: DOMRect;
};

/** Centre of an element's pin (or of the element itself) in stage coordinates. */
export function stagePoint(el: Element, sc: Scene): Point {
  const target = el.classList.contains("pin") ? el : el.querySelector(":scope > .pin") ?? el;
  const p = target.getBoundingClientRect();
  return { x: p.left + p.width / 2 - sc.rect.left, y: p.top + p.height / 2 - sc.rect.top };
}

type RopePoint = { x: number; y: number; px: number; py: number };
type RopeOptions = { n?: number; slack?: number; extra?: number; reveal?: number };

/** Verlet thread between two pins. Sags, swings, reacts to the pointer and scroll speed, can be
 *  pulled taut and can snap free. `reveal` (0..1) draws it progressively. */
export class Rope {
  sc: Scene;
  a: Element;
  b: Element;
  n: number;
  slack: number;
  extra: number;
  reveal: number;
  taut = 0;
  tautTarget = 0;
  holdTaut = 0;
  jitter = 0;
  free = false;
  freeLen = 0;
  pts: RopePoint[] | null = null;
  cum: number[] = [];

  constructor(sc: Scene, a: Element, b: Element, o: RopeOptions = {}) {
    this.sc = sc;
    this.a = a;
    this.b = b;
    this.n = o.n ?? 22;
    this.slack = o.slack ?? 1.1;
    this.extra = o.extra ?? 26;
    this.reveal = o.reveal ?? 0;
    sc.ropes.push(this);
  }

  ends(): [Point, Point] {
    return [stagePoint(this.a, this.sc), stagePoint(this.b, this.sc)];
  }

  init(A: Point, B: Point) {
    this.pts = [];
    for (let i = 0; i < this.n; i++) {
      const t = i / (this.n - 1);
      const sag = Math.sin(Math.PI * t) * 30;
      const x = A.x + (B.x - A.x) * t;
      const y = A.y + (B.y - A.y) * t + sag;
      this.pts.push({ x, y, px: x, py: y });
    }
  }

  restLen(A: Point, B: Point) {
    if (this.free) return this.freeLen;
    const d = Math.hypot(B.x - A.x, B.y - A.y);
    const s = this.slack + (1.0 - this.slack) * this.taut;
    return d * s + this.extra * (1 - this.taut);
  }

  length() {
    const P = this.pts;
    if (!P) return 0;
    let L = 0;
    for (let i = 1; i < this.n; i++) L += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
    return L;
  }

  setFree(f: boolean) {
    if (f && !this.free && this.pts) this.freeLen = Math.min(this.length() * 0.6, 260);
    this.free = f;
  }

  pluck(k = 5) {
    const P = this.pts;
    if (!P) return;
    for (let i = 1; i < this.n - 1; i++) {
      const w = Math.sin((Math.PI * i) / (this.n - 1));
      P[i].px += (Math.random() - 0.5) * k * w;
      P[i].py += Math.random() * -1 * k * w;
    }
  }

  step(mouse: Point | null, scrollV: number) {
    const [A, B] = this.ends();
    if (!this.pts || Math.hypot(this.pts[0].x - A.x, this.pts[0].y - A.y) > 420) this.init(A, B);
    const P = this.pts as RopePoint[];
    const n = this.n;
    this.taut += (this.tautTarget - this.taut) * 0.12;
    const sv = clamp(scrollV, -2500, 2500) * 0.00007;
    for (let i = 1; i < n; i++) {
      if (i === n - 1 && !this.free) continue;
      const p = P[i];
      const vx = clamp((p.x - p.px) * 0.965, -22, 22);
      const vy = clamp((p.y - p.py) * 0.965, -22, 22);
      p.px = p.x;
      p.py = p.y;
      const w = Math.sin((Math.PI * i) / (n - 1)) || 0.6;
      p.x += vx;
      p.y += vy + 0.42 - sv * w;
      if (this.jitter) {
        p.x += (Math.random() - 0.5) * this.jitter * w;
        p.y += (Math.random() - 0.5) * this.jitter * w;
      }
      if (mouse) {
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const d = Math.hypot(dx, dy);
        if (d < 90 && d > 0.01) {
          const f = ((90 - d) / 90) * 2.4;
          p.x += (dx / d) * f;
          p.y += (dy / d) * f;
        }
      }
    }
    const seg = this.restLen(A, B) / (n - 1);
    for (let k = 0; k < 10; k++) {
      P[0].x = A.x;
      P[0].y = A.y;
      if (!this.free) {
        P[n - 1].x = B.x;
        P[n - 1].y = B.y;
      }
      for (let i = 0; i < n - 1; i++) {
        const p = P[i];
        const q = P[i + 1];
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const d = Math.hypot(dx, dy) || 0.0001;
        const diff = ((d - seg) / d) * 0.5;
        const pin0 = i === 0;
        const pin1 = i + 1 === n - 1 && !this.free;
        if (pin0 && !pin1) {
          q.x -= dx * diff * 2;
          q.y -= dy * diff * 2;
        } else if (pin1 && !pin0) {
          p.x += dx * diff * 2;
          p.y += dy * diff * 2;
        } else if (!pin0 && !pin1) {
          p.x += dx * diff;
          p.y += dy * diff;
          q.x -= dx * diff;
          q.y -= dy * diff;
        }
      }
    }
    P[0].x = A.x;
    P[0].y = A.y;
    if (!this.free) {
      P[n - 1].x = B.x;
      P[n - 1].y = B.y;
    }
    // cumulative lengths for beads and partial reveal
    this.cum = [0];
    for (let i = 1; i < n; i++) this.cum.push(this.cum[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y));
  }

  pointAt(t: number): Point {
    const P = this.pts as RopePoint[];
    const L = this.cum[this.n - 1] * clamp(t, 0, 1);
    let i = 1;
    while (i < this.n - 1 && this.cum[i] < L) i++;
    const a = P[i - 1];
    const b = P[i];
    const seg = this.cum[i] - this.cum[i - 1] || 1;
    const u = (L - this.cum[i - 1]) / seg;
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  }

  draw(ctx: CanvasRenderingContext2D) {
    const P = this.pts;
    if (this.reveal <= 0 || !P) return;
    const Lmax = this.cum[this.n - 1] * this.reveal;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(P[0].x, P[0].y);
      for (let i = 1; i < this.n; i++) {
        if (this.cum[i] > Lmax) {
          const e = this.pointAt(this.reveal);
          ctx.lineTo(e.x, e.y);
          break;
        }
        ctx.lineTo(P[i].x, P[i].y);
      }
    };
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(40,10,0,.38)";
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 4;
    ctx.shadowBlur = 3;
    ctx.strokeStyle = "#c8241c";
    ctx.lineWidth = 2.3;
    path();
    ctx.stroke();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "rgba(255,170,160,.45)";
    ctx.lineWidth = 0.8;
    ctx.translate(-0.5, -0.6);
    path();
    ctx.stroke();
    ctx.restore();
  }
}

/** A glowing payment that travels a rope and leaves a trail; its label is a DOM chip. */
export class Bead {
  sc: Scene;
  rope: Rope;
  r: number;
  t = 0;
  on = false;
  trail: Point[] = [];
  label: HTMLDivElement;

  constructor(sc: Scene, rope: Rope, r: number, label: string) {
    this.sc = sc;
    this.rope = rope;
    this.r = r;
    this.label = document.createElement("div");
    this.label.className = "coin";
    this.label.textContent = label;
    sc.stage.appendChild(this.label);
    sc.beads.push(this);
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (!this.on || !this.rope.pts) {
      this.trail.length = 0;
      this.label.style.visibility = "hidden";
      return;
    }
    const p = this.rope.pointAt(this.t);
    this.trail.unshift(p);
    if (this.trail.length > 16) this.trail.pop();
    ctx.save();
    this.trail.forEach((q, i) => {
      const a = (1 - i / this.trail.length) * 0.5;
      ctx.fillStyle = `rgba(255,214,110,${a})`;
      ctx.beginPath();
      ctx.arc(q.x, q.y, this.r * (1 - i / 22), 0, 7);
      ctx.fill();
    });
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, this.r * 3.4);
    g.addColorStop(0, "rgba(255,246,210,1)");
    g.addColorStop(0.32, "rgba(255,214,110,.9)");
    g.addColorStop(1, "rgba(255,214,110,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, this.r * 3.4, 0, 7);
    ctx.fill();
    ctx.fillStyle = "#fff7da";
    ctx.beginPath();
    ctx.arc(p.x, p.y, this.r * 0.62, 0, 7);
    ctx.fill();
    ctx.restore();
    this.label.style.visibility = "visible";
    this.label.style.transform = `translate(${p.x + this.r + 8}px,${p.y - this.r - 24}px)`;
  }

  remove() {
    this.label.remove();
  }
}
