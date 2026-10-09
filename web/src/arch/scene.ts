import * as THREE from "three";
import { boxUV, dustSprite, engraving, limestone, rng } from "./stone";

const UV_SCALE = 0.3; // texture tiles per world unit

/**
 * The keystone arch. Every member is a voussoir, the piers are the reserve, the keystone is the rules.
 * Scroll progress `p` (0..1) moves the stones from where they drift in the hero to where they lock.
 * Nothing here knows about the DOM beyond the canvas; the page drives it with setProgress().
 */

export type Inscription = { lines: { text: string; size: number; serif?: boolean }[]; red?: boolean; hero?: boolean };
export type ArchOptions = {
  /** one per voussoir, left springer → right springer; the middle one is the keystone */
  inscriptions: (Inscription | null)[];
  reserve: Inscription;
  compact: boolean;
};

const R_IN = 2.05;
const R_OUT = 2.95;
const DEPTH = 1.15;
const N = 7; // voussoirs incl. keystone
const KEY = 3;
const GAP = 0.012; // radians of mortar joint
const PIER_H = 2.25;
const PIER_X = (R_IN + R_OUT) / 2;

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const window01 = (p: number, s: number, d: number) => clamp((p - s) / d);
const easeOutQuint = (t: number) => 1 - (1 - t) ** 5;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeInQuad = (t: number) => t * t;

/** A wedge between two angles. The keystone runs up to a flat top, so its sides flare. */
function wedge(a0: number, a1: number, key: boolean): THREE.Shape {
  const s = new THREE.Shape();
  const steps = 14;
  s.moveTo(R_IN * Math.cos(a0), R_IN * Math.sin(a0));
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    s.lineTo(R_IN * Math.cos(a), R_IN * Math.sin(a));
  }
  if (key) {
    const top = R_OUT + 0.42;
    s.lineTo((top / Math.sin(a1)) * Math.cos(a1), top);
    s.lineTo((top / Math.sin(a0)) * Math.cos(a0), top);
  } else {
    for (let i = 0; i <= steps; i++) {
      const a = a1 + ((a0 - a1) * i) / steps;
      s.lineTo(R_OUT * Math.cos(a), R_OUT * Math.sin(a));
    }
  }
  s.closePath();
  return s;
}

/** A dressed block: rectangle extruded with a chamfer so edges catch light. */
function block(w: number, h: number, d: number, seed: number) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -h / 2);
  s.lineTo(w / 2, -h / 2);
  s.lineTo(w / 2, h / 2);
  s.lineTo(-w / 2, h / 2);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: d - 0.06, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2 });
  g.translate(0, 0, -(d - 0.06) / 2);
  boxUV(g, UV_SCALE, seed * 0.41);
  return g;
}

type Piece = {
  mesh: THREE.Group;
  hero?: boolean;
  target: THREE.Vector3;
  from: THREE.Vector3;
  fromQ: THREE.Quaternion;
  phase: number;
  start: number;
  dur: number;
  kind: "pier" | "stone" | "key";
};

export function createArch(canvas: HTMLCanvasElement, opts: ArchOptions) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.compact ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = opts.compact ? new THREE.Fog(0x0e0b09, 22, 40) : new THREE.Fog(0x0e0b09, 14, 30);

  const camera = new THREE.PerspectiveCamera(opts.compact ? 42 : 32, 1, 0.1, 100);

  // ── light: one warm low sun, a cool-white rim, a faint fill, and the red flash for the keystone
  scene.add(new THREE.HemisphereLight(0xfff1dc, 0x1a120c, 0.35));
  const sun = new THREE.DirectionalLight(0xffd7a3, 3.2);
  sun.position.set(-6, 7, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(opts.compact ? 1024 : 2048, opts.compact ? 1024 : 2048);
  sun.shadow.camera.left = -8;
  sun.shadow.camera.right = 8;
  sun.shadow.camera.top = 8;
  sun.shadow.camera.bottom = -6;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0xf3ecff, 1.4);
  rim.position.set(5, 3, -7);
  scene.add(rim);
  const flash = new THREE.PointLight(0xff3b1f, 0, 7, 1.6);
  flash.position.set(0, R_OUT + 0.4, 1.4);
  scene.add(flash);

  // ── ground: dark, rough, only there to hold shadows
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0x15100c, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -PIER_H - 0.35;
  ground.receiveShadow = true;
  scene.add(ground);

  // ── materials
  const stoneMaps = limestone(11, [232, 224, 210]);
  const keyMaps = limestone(23, [222, 206, 188]);
  const stoneMat = new THREE.MeshStandardMaterial({ map: stoneMaps.map, bumpMap: stoneMaps.bump, bumpScale: 1.2, roughnessMap: stoneMaps.rough, roughness: 1 });
  const keyMat = new THREE.MeshStandardMaterial({ map: keyMaps.map, bumpMap: keyMaps.bump, bumpScale: 1.4, roughnessMap: keyMaps.rough, roughness: 1 });

  const inscribe = (ins: Inscription, w: number, h: number) => {
    const tex = engraving(
      ins.lines.map((l) => ({
        text: l.text,
        size: l.size,
        font: l.serif ? "'Instrument Serif', Georgia, serif" : "'JetBrains Mono', monospace",
        color: ins.red ? "rgba(196, 44, 24, 0.95)" : undefined,
      })),
    );
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    return m;
  };

  const pieces: Piece[] = [];
  const rand = rng(5);
  const root = new THREE.Group();
  scene.add(root);

  // scatter: where each piece drifts in the hero. Biased right so the headline owns the left.
  const scatter = (i: number, total: number) => {
    const a = (i / total) * Math.PI * 2 + rand() * 0.6;
    const r = 2.4 + rand() * 2.2;
    return new THREE.Vector3(Math.cos(a) * r * (opts.compact ? 0.7 : 1.25) + (opts.compact ? 0 : 2.8), (opts.compact ? -1.6 : 0.9) + Math.sin(a) * r * 0.75, -3.6 + rand() * 2.4);
  };
  const randomQ = () => new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 2.4, (rand() - 0.5) * 2.4, (rand() - 0.5) * 2.4));

  // ── piers: three courses a side, they rise first (the reserve is the foundation)
  const courses = [0.78, 0.72, 0.75];
  let k = 0;
  for (const side of [-1, 1]) {
    let y = -PIER_H;
    courses.forEach((h, c) => {
      const w = R_OUT - R_IN + (c === 0 ? 0.18 : 0.04 * ((c * 7 + (side > 0 ? 3 : 0)) % 3));
      const g = new THREE.Group();
      const m = new THREE.Mesh(block(w, h - 0.02, DEPTH + (c === 0 ? 0.16 : 0), k), stoneMat);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      if (side < 0 && c === 1) {
        const ins = inscribe(opts.reserve, w * 0.92, (w * 0.92) / 2);
        ins.position.z = (DEPTH + 0.0) / 2 + 0.006;
        g.add(ins);
      }
      const target = new THREE.Vector3(side * PIER_X, y + h / 2, 0);
      y += h;
      pieces.push({
        mesh: g,
        target,
        from: new THREE.Vector3(target.x + side * 0.6, target.y - 4.5 - c * 0.6, target.z + 0.8),
        fromQ: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25 * side, 0, 0.18 * side)),
        phase: k++,
        start: 0.02 + c * 0.05,
        dur: 0.2,
        kind: "pier",
      });
      root.add(g);
    });
  }

  // ── voussoirs: from both springers inward, keystone last
  const step = Math.PI / N;
  for (let i = 0; i < N; i++) {
    const a0 = Math.PI - i * step - (i === 0 ? 0 : GAP / 2);
    const a1 = Math.PI - (i + 1) * step + (i === N - 1 ? 0 : GAP / 2);
    const isKey = i === KEY;
    const shape = wedge(a0, a1, isKey);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: DEPTH - 0.06, bevelEnabled: true, bevelSize: 0.028, bevelThickness: 0.03, bevelSegments: 2, curveSegments: 14 });
    geo.computeBoundingBox();
    const center = new THREE.Vector3();
    geo.boundingBox!.getCenter(center);
    geo.translate(-center.x, -center.y, -center.z);
    boxUV(geo, UV_SCALE, 3 + i * 0.37);

    const g = new THREE.Group();
    const m = new THREE.Mesh(geo, isKey ? keyMat : stoneMat);
    m.castShadow = m.receiveShadow = true;
    g.add(m);

    const ins = opts.inscriptions[i];
    if (ins) {
      const mid = (a0 + a1) / 2;
      const w = isKey ? 0.95 : 0.98;
      const plate = inscribe(ins, w, w / 2);
      plate.position.z = DEPTH / 2 + 0.006;
      // the keystone reads upright; the others follow the curve of the arch
      plate.rotation.z = isKey ? 0 : mid - Math.PI / 2;
      if (isKey) plate.position.y = 0.06;
      g.add(plate);
    }

    const order = Math.min(i, N - 1 - i); // 0 = springers, 3 = keystone
    const target = new THREE.Vector3(center.x, center.y, 0);
    pieces.push({
      mesh: g,
      target,
      from: scatter(i, N),
      fromQ: randomQ(),
      phase: i * 1.7,
      start: isKey ? 0.7 : 0.18 + order * 0.11,
      dur: isKey ? 0.1 : 0.26,
      kind: isKey ? "key" : "stone",
      hero: !!ins?.hero,
    });
    root.add(g);
  }
  // hero: the three named stones come forward, closest to the viewer
  const named = pieces.filter((p) => p.hero);
  const heroSpots = opts.compact
    ? [new THREE.Vector3(-1.6, -0.4, 3.4), new THREE.Vector3(1.7, -1.8, 4.2), new THREE.Vector3(-0.4, -3.4, 4.6)]
    : [new THREE.Vector3(0.1, 2.1, 4.4), new THREE.Vector3(2.3, 0.5, 3.0), new THREE.Vector3(0.5, -1.4, 5.2)];
  named.slice(0, 3).forEach((p, j) => {
    p.from.copy(heroSpots[j]);
    // turned toward the viewer so the names read
    p.fromQ.setFromEuler(new THREE.Euler(0.08 - j * 0.06, -0.3 + j * 0.22, (j - 1) * 0.16));
  });

  // ── dust for the moment the keystone lands
  const DUST = opts.compact ? 140 : 320;
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(DUST * 3);
  const dustVel = new Float32Array(DUST * 3);
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({ map: dustSprite(), size: 0.16, transparent: true, depthWrite: false, opacity: 0, color: 0xf2e6d4 });
  const dust = new THREE.Points(dustGeo, dustMat);
  scene.add(dust);
  let dustT = -1;
  const burst = () => {
    const keyTop = R_OUT - 0.1;
    for (let i = 0; i < DUST; i++) {
      const side = i % 2 ? 1 : -1;
      dustPos[i * 3] = side * (0.45 + Math.random() * 0.12);
      dustPos[i * 3 + 1] = keyTop - Math.random() * 0.9;
      dustPos[i * 3 + 2] = (Math.random() - 0.5) * DEPTH;
      dustVel[i * 3] = side * (0.4 + Math.random() * 1.6);
      dustVel[i * 3 + 1] = -0.2 + Math.random() * 1.2;
      dustVel[i * 3 + 2] = (Math.random() - 0.2) * 1.4;
    }
    dustGeo.attributes.position.needsUpdate = true;
    dustT = 0;
  };

  // ── state
  let progress = 0;
  let landed = false;
  let shake = 0;
  const pointer = new THREE.Vector2();
  const pointerEased = new THREE.Vector2();
  const look = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const idleQ = new THREE.Quaternion();
  const idleE = new THREE.Euler();
  const ident = new THREE.Quaternion();
  const above = new THREE.Vector3(0, R_OUT + 4.2, 0);

  function place(time: number) {
    for (const piece of pieces) {
      const g = piece.mesh;
      const bob = Math.sin(time * 0.55 + piece.phase) * 0.12;
      idleE.set(Math.sin(time * 0.31 + piece.phase) * 0.12, Math.cos(time * 0.27 + piece.phase) * 0.16, 0);
      idleQ.setFromEuler(idleE);
      if (piece.kind === "key") {
        // drift → hang above the gap → fall
        const lift = easeInOutCubic(window01(progress, 0.5, 0.18));
        const fall = easeInQuad(window01(progress, piece.start, piece.dur));
        const drift = piece.from.clone().add(new THREE.Vector3(0, bob, 0));
        const hang = above.clone().add(new THREE.Vector3(0, Math.sin(time * 1.1) * 0.06 * (1 - fall), 0));
        g.position.lerpVectors(drift, hang, lift).lerp(piece.target, fall);
        tmpQ.copy(piece.fromQ).multiply(idleQ).slerp(ident, Math.max(lift, fall));
        g.quaternion.copy(tmpQ);
        continue;
      }
      const t = easeOutQuint(window01(progress, piece.start, piece.dur));
      const fromNow = piece.from.clone();
      if (piece.kind === "stone") fromNow.y += bob;
      g.position.lerpVectors(fromNow, piece.target, t);
      tmpQ.copy(piece.fromQ);
      if (piece.kind === "stone") tmpQ.multiply(idleQ);
      g.quaternion.copy(tmpQ.slerp(ident, t));
    }

    const nowLanded = progress >= 0.8;
    if (nowLanded && !landed) {
      shake = 1;
      burst();
    }
    landed = nowLanded;
  }

  let w = 1;
  let h = 1;
  function resize() {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function frameCamera(dt: number) {
    pointerEased.lerp(pointer, 1 - Math.exp(-dt * 3));
    const p = easeInOutCubic(clamp(progress / 0.85));
    const theta = -0.32 + p * 0.42 + pointerEased.x * 0.05;
    // framed so the whole arch, piers to keystone, sits inside the frame at the end
    const radius = opts.compact ? 24 - p * 2.2 : 16 - p * 1.8;
    const y = 1.2 + p * 0.7 - pointerEased.y * 0.25;
    // desktop: the arch sits right of centre so the copy owns the left third;
    // phone: the copy owns the top, the arch stands in the lower half
    const offset = opts.compact ? 0 : -2.7 + p * 0.2;
    look.set(offset, opts.compact ? 2.9 : 0.55, 0);
    camera.position.set(look.x + Math.sin(theta) * radius, y, Math.cos(theta) * radius);
    if (shake > 0) {
      camera.position.x += (Math.random() - 0.5) * 0.08 * shake;
      camera.position.y += (Math.random() - 0.5) * 0.08 * shake;
      shake = Math.max(0, shake - dt * 2.4);
    }
    camera.lookAt(look);
  }

  const clock = new THREE.Clock();
  let raf = 0;
  let running = true;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function tick() {
    raf = requestAnimationFrame(tick);
    if (!running) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = reduce ? 0 : clock.elapsedTime;
    place(time);
    frameCamera(dt);

    // red flash and dust after the keystone lands
    flash.intensity = landed ? 14 * shake + 1.2 : 0;
    if (dustT >= 0) {
      dustT += dt;
      for (let i = 0; i < DUST; i++) {
        dustVel[i * 3 + 1] -= dt * 1.4;
        dustVel[i * 3] *= 1 - dt * 1.2;
        dustVel[i * 3 + 2] *= 1 - dt * 1.2;
        dustPos[i * 3] += dustVel[i * 3] * dt;
        dustPos[i * 3 + 1] += dustVel[i * 3 + 1] * dt;
        dustPos[i * 3 + 2] += dustVel[i * 3 + 2] * dt;
      }
      dustGeo.attributes.position.needsUpdate = true;
      dustMat.opacity = Math.max(0, 0.75 * (1 - dustT / 2.2));
      if (dustT > 2.2) dustT = -1;
    }
    renderer.render(scene, camera);
  }

  const onPointer = (e: PointerEvent) => pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  window.addEventListener("pointermove", onPointer, { passive: true });
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  const io = new IntersectionObserver(([e]) => (running = e.isIntersecting));
  io.observe(canvas);
  resize();
  tick();

  return {
    setProgress(p: number) {
      progress = reduce ? 1 : clamp(p);
    },
    get progress() {
      return progress;
    },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointer);
      ro.disconnect();
      io.disconnect();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
          o.geometry.dispose();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
            m.dispose();
          }
        }
      });
      renderer.dispose();
    },
  };
}
