import * as THREE from "three";

/** Deterministic PRNG so the stone looks the same on every load. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value-noise fbm on a grid, returned as 0..1 floats. */
function fbm(size: number, seed: number, octaves: number, base: number): Float32Array {
  const out = new Float32Array(size * size);
  const rand = rng(seed);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = base << o;
    const grid = new Float32Array(cells * cells).map(() => rand());
    const at = (x: number, y: number) => grid[((y + cells) % cells) * cells + ((x + cells) % cells)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const fy = (y / size) * cells;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
        const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
        out[y * size + x] += (a + (b - a) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

export type StoneMaps = { map: THREE.Texture; bump: THREE.Texture; rough: THREE.Texture };

/**
 * Limestone: warm bone base, soft clouding, fine speckle, a few pits and hairline veins.
 * `tint` shifts the base so the keystone can be a different bed of the same quarry.
 */
export function limestone(seed: number, tint: [number, number, number], size = 512): StoneMaps {
  const cloud = fbm(size, seed, 6, 3);
  const grain = fbm(size, seed + 7, 3, 64);
  const vein = fbm(size, seed + 13, 5, 2);
  const rand = rng(seed + 29);

  const color = document.createElement("canvas");
  const height = document.createElement("canvas");
  const rough = document.createElement("canvas");
  for (const c of [color, height, rough]) c.width = c.height = size;
  const ci = color.getContext("2d")!.createImageData(size, size);
  const hi = height.getContext("2d")!.createImageData(size, size);
  const ri = rough.getContext("2d")!.createImageData(size, size);

  for (let i = 0; i < size * size; i++) {
    const c = cloud[i];
    const g = grain[i];
    // hairline veins where the low-frequency field crosses a band
    const v = Math.max(0, 1 - Math.abs(vein[i] - 0.5) * 220) * 0.35;
    let shade = 0.84 + (c - 0.5) * 0.2 + (g - 0.5) * 0.16 - v * 0.08;
    if (rand() < 0.0025) shade -= 0.35; // fossil pits
    const k = i * 4;
    ci.data[k] = Math.min(255, tint[0] * shade);
    ci.data[k + 1] = Math.min(255, tint[1] * shade);
    ci.data[k + 2] = Math.min(255, tint[2] * shade);
    ci.data[k + 3] = 255;
    const h = 255 * (0.5 + (c - 0.5) * 0.6 + (g - 0.5) * 0.5 - v * 0.4);
    hi.data[k] = hi.data[k + 1] = hi.data[k + 2] = h;
    hi.data[k + 3] = 255;
    const r = 255 * (0.82 + (g - 0.5) * 0.25);
    ri.data[k] = ri.data[k + 1] = ri.data[k + 2] = r;
    ri.data[k + 3] = 255;
  }
  color.getContext("2d")!.putImageData(ci, 0, 0);
  height.getContext("2d")!.putImageData(hi, 0, 0);
  rough.getContext("2d")!.putImageData(ri, 0, 0);

  const wrap = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1, 1);
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { map: wrap(color, true), bump: wrap(height, false), rough: wrap(rough, false) };
}

/**
 * An engraving: letters cut into the face. Dark cut, a light lip under each stroke,
 * drawn on a transparent canvas that sits a hair in front of the stone.
 */
export function engraving(lines: { text: string; size: number; font: string; color?: string }[], w = 512, h = 256) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const gap = 10;
  const total = lines.reduce((s, l) => s + l.size, 0) + gap * (lines.length - 1);
  let y = h / 2 - total / 2;
  for (const l of lines) {
    y += l.size / 2;
    g.font = `${l.size}px ${l.font}`;
    // lip catching the light
    g.fillStyle = "rgba(255, 246, 230, 0.35)";
    g.fillText(l.text, w / 2, y + 2);
    // the cut
    g.fillStyle = l.color ?? "rgba(52, 40, 30, 0.86)";
    g.fillText(l.text, w / 2, y);
    y += l.size / 2 + gap;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * Box-projected UVs: every face takes the texture from the two axes it faces along,
 * so extruded sides don't smear the grain into stripes. `scale` = texture tiles per unit.
 */
export function boxUV(geo: THREE.BufferGeometry, scale: number, offset = 0) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    let u: number;
    let v: number;
    if (az >= ax && az >= ay) [u, v] = [x, y];
    else if (ax >= ay) [u, v] = [z, y];
    else [u, v] = [x, z];
    uv[i * 2] = u * scale + offset;
    uv[i * 2 + 1] = v * scale + offset * 0.7;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/** Soft round sprite for dust. */
export function dustSprite() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,240,220,0.9)");
  grad.addColorStop(0.4, "rgba(230,210,185,0.35)");
  grad.addColorStop(1, "rgba(230,210,185,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
