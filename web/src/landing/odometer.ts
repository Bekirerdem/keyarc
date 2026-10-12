import { fmt } from "./motion";

type Slot = { el: HTMLSpanElement; p: number; sep?: boolean; strip?: HTMLSpanElement };
type OdoState = { slots: Slot[]; v: number };

// Rolling digits. The shown value is a pure function of timeline progress, so a mid-scroll frame
// is always consistent and the end state is exact.
const state = new WeakMap<HTMLElement, OdoState>();

export function makeOdo(el: HTMLElement) {
  const str = fmt(Number(el.dataset.max));
  let p = str.replace(/\D/g, "").length - 1;
  const slots: Slot[] = [];
  el.innerHTML = "";
  for (const ch of str) {
    if (/\d/.test(ch)) {
      const s = document.createElement("span");
      s.className = "od";
      const strip = document.createElement("span");
      strip.className = "ods";
      strip.innerHTML = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => `<i>${d}</i>`).join("");
      s.appendChild(strip);
      el.appendChild(s);
      slots.push({ el: s, strip, p });
      p--;
    } else {
      const s = document.createElement("span");
      s.className = "osep";
      s.textContent = ch;
      el.appendChild(s);
      slots.push({ el: s, sep: true, p: p + 1 });
    }
  }
  state.set(el, { slots, v: -1 });
  setOdo(el, 0);
}

export function setOdo(el: HTMLElement, value: number) {
  const st = state.get(el);
  if (!st) return;
  const v = Math.max(0, value);
  if (Math.abs(v - st.v) < 0.001) return;
  st.v = v;
  for (const s of st.slots) {
    const pow = 10 ** s.p;
    if (s.sep || !s.strip) {
      s.el.classList.toggle("lead", v < pow - 1);
      continue;
    }
    let pos: number;
    if (s.p === 0) pos = v % 10;
    else {
      const whole = Math.floor(v / pow);
      pos = whole % 10;
      const rem = v - whole * pow;
      if (rem > pow - 1) pos += rem - (pow - 1);
    }
    s.strip.style.transform = `translateY(${-pos}em)`;
    s.el.classList.toggle("lead", s.p > 0 && v < pow - 1);
  }
}

export function clearOdo(el: HTMLElement) {
  state.delete(el);
  el.innerHTML = "";
}
