// Ein Bandmanual: Draht über einer Metallschiene.
// Waagrechte Position -> Tonhöhe (stufenlos), Tiefe des Drucks -> Lautstärke.

import { noteName, isNatural } from './presets.js';

const MIN_PRESS = 0.15; // auch ganz leichtes Berühren soll hörbar sein

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Einrasten: 0 = stufenlos wie das Original, 1 = feste Halbtöne.
// Dazwischen entstehen Plateaus um jeden Halbton, ohne Sprünge an den Rändern.
export function snapNote(n, amount) {
  if (amount <= 0) return n;
  const r = Math.round(n);
  if (amount >= 1) return r;
  const f = n - r;
  const dead = amount / 2;
  const a = Math.abs(f);
  return r + Math.sign(f) * (a <= dead ? 0 : (0.5 * (a - dead)) / (0.5 - dead));
}

export class Manual {
  constructor(canvas, index, { layout, onVoice, onRetrigger, onFirstTouch }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.index = index;
    this.layout = layout;           // (index, width) -> { low, semis, snap, markers, a4 }
    this.onVoice = onVoice;         // (index, gate, note, pressure)
    this.onRetrigger = onRetrigger; // (index)
    this.onFirstTouch = onFirstTouch;
    this.touches = new Map();       // pointerId -> { x, y, note, press, depth }
    this.active = null;
    this.glow = 0;
    this.glowX = 0;
    this.lastFrame = 0;
    this.frame = 0;
    this.w = 1;
    this.h = 1;
    this.colors = {
      enamel: cssVar('--enamel'),
      dim: cssVar('--enamel-dim'),
      brass: cssVar('--brass'),
      neon: cssVar('--neon'),
      steel: cssVar('--steel'),
      panel: cssVar('--panel'),
      band: cssVar('--panel-lo'),
      data: cssVar('--font-data'),
      display: cssVar('--font-display'),
    };

    const down = (e) => this.down(e);
    const move = (e) => this.move(e);
    const up = (e) => this.up(e);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('lostpointercapture', up);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  get geom() {
    return { wireY: Math.round(this.h * 0.24), railY: Math.round(this.h * 0.8) };
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.invalidate();
  }

  noteAt(x) {
    const L = this.layout(this.index, this.w);
    const raw = L.low - 0.5 + (x / this.w) * (L.semis + 1);
    return snapNote(raw, L.snap);
  }

  xOf(note) {
    const L = this.layout(this.index, this.w);
    return ((note - L.low + 0.5) / (L.semis + 1)) * this.w;
  }

  track(e, t = {}) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
    const y = e.clientY - r.top;
    const { wireY, railY } = this.geom;
    let depth = Math.min(Math.max((y - wireY) / (railY - wireY), 0), 1);
    // Stift mit echtem Andruck (z. B. Apple Pencil) ersetzt die Tiefe
    if (e.pointerType === 'pen' && e.pressure > 0) depth = e.pressure;
    t.x = x;
    t.y = y;
    t.depth = depth;
    t.press = MIN_PRESS + (1 - MIN_PRESS) * depth;
    t.note = this.noteAt(x);
    return t;
  }

  down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (this.onFirstTouch) this.onFirstTouch();
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* bereits beendet */ }
    const held = this.touches.size > 0;
    const t = this.track(e);
    this.touches.set(e.pointerId, t);
    this.active = e.pointerId;
    this.onVoice(this.index, 1, t.note, t.press);
    if (held) this.onRetrigger(this.index);
    this.invalidate();
  }

  move(e) {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    e.preventDefault();
    this.track(e, t);
    if (e.pointerId === this.active) this.onVoice(this.index, 1, t.note, t.press);
    this.invalidate();
  }

  up(e) {
    if (!this.touches.has(e.pointerId)) return;
    this.touches.delete(e.pointerId);
    if (e.pointerId === this.active) {
      // Der zuletzt aufgesetzte verbleibende Finger übernimmt (legato)
      const rest = [...this.touches.keys()];
      if (rest.length) {
        this.active = rest[rest.length - 1];
        const t = this.touches.get(this.active);
        this.onVoice(this.index, 1, t.note, t.press);
      } else {
        this.active = null;
        this.onVoice(this.index, 0, 0, 0);
      }
    }
    this.invalidate();
  }

  releaseAll() {
    if (!this.touches.size) return;
    this.touches.clear();
    this.active = null;
    this.onVoice(this.index, 0, 0, 0);
    this.invalidate();
  }

  invalidate() {
    if (!this.frame) this.frame = requestAnimationFrame((t) => this.draw(t));
  }

  draw(now) {
    this.frame = 0;
    const dt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.1) : 0.016;
    this.lastFrame = now;

    const { ctx, w, h, colors: c } = this;
    const { wireY, railY } = this.geom;
    const L = this.layout(this.index, w);
    const act = this.active != null ? this.touches.get(this.active) : null;

    if (act) {
      this.glow = act.press;
      this.glowX = act.x;
    } else {
      this.glow *= Math.exp(-dt * 6);
    }

    ctx.clearRect(0, 0, w, h);

    // Halbtonfelder: Vorzeichen-Töne dunkler, wie Bünde auf einem Griffbrett
    const span = w / (L.semis + 1);
    if (L.markers) {
      ctx.fillStyle = c.band;
      for (let n = L.low; n <= L.low + L.semis; n++) {
        if (!isNatural(n)) ctx.fillRect(this.xOf(n) - span / 2, wireY, span, railY - wireY);
      }
    }

    // Skala unter der Schiene
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelSize = Math.max(10, Math.min(13, h * 0.08));
    ctx.font = `500 ${labelSize}px ${c.display}`;
    for (let n = L.low; n <= L.low + L.semis; n++) {
      const x = Math.round(this.xOf(n)) + 0.5;
      const pc = ((n % 12) + 12) % 12;
      const isC = pc === 0;
      if (!L.markers && !isC) continue;
      const len = isC ? 12 : isNatural(n) ? 8 : 4;
      ctx.strokeStyle = isC ? c.enamel : c.dim;
      ctx.globalAlpha = isC ? 0.9 : 0.6;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, railY + 6);
      ctx.lineTo(x, railY + 6 + len);
      ctx.stroke();
      if (isC || (L.markers && span > 26 && pc === 9)) {
        const label = noteName(n);
        const half = ctx.measureText(label).width / 2 + 2;
        ctx.fillStyle = isC ? c.enamel : c.dim;
        ctx.fillText(label, Math.min(Math.max(x, half), w - half), railY + 8 + len);
      }
    }
    ctx.globalAlpha = 1;

    // Schiene
    const rail = ctx.createLinearGradient(0, railY, 0, railY + 6);
    rail.addColorStop(0, c.enamel);
    rail.addColorStop(0.35, c.steel);
    rail.addColorStop(1, c.panel);
    ctx.fillStyle = rail;
    ctx.fillRect(0, railY, w, 6);

    // Glimmen an der Kontaktstelle
    if (this.glow > 0.01) {
      const r = 18 + 50 * this.glow;
      const g = ctx.createRadialGradient(this.glowX, railY, 0, this.glowX, railY, r);
      g.addColorStop(0, c.neon);
      g.addColorStop(1, 'transparent');
      ctx.globalAlpha = Math.min(1, this.glow * 1.1);
      ctx.fillStyle = g;
      ctx.fillRect(this.glowX - r, railY - r, 2 * r, 2 * r);
      ctx.globalAlpha = 1;
    }

    // Draht: wird von jedem Finger bis zur gedrückten Tiefe heruntergezogen
    const pts = [...this.touches.values()]
      .map((t) => ({ x: t.x, y: wireY + (railY - wireY) * t.depth }))
      .sort((a, b) => a.x - b.x);
    ctx.strokeStyle = c.brass;
    ctx.lineWidth = 2;
    if (act) {
      ctx.shadowColor = c.neon;
      ctx.shadowBlur = 6 + 10 * act.press;
    }
    ctx.beginPath();
    ctx.moveTo(-2, wireY);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(w + 2, wireY);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Anzeige über dem aktiven Finger: Ton, Abweichung, Frequenz
    if (act) {
      const cents = Math.round((act.note - Math.round(act.note)) * 100);
      const hz = L.a4 * Math.pow(2, (act.note - 69) / 12);
      const sign = cents > 0 ? '+' : cents < 0 ? '−' : '±';
      const text = `${noteName(act.note)} ${sign}${Math.abs(cents)} ct · ${Math.round(hz)} Hz`;
      ctx.font = `500 ${Math.max(11, Math.min(14, h * 0.085))}px ${c.data}`;
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(text).width;
      const x = Math.min(Math.max(act.x, tw / 2 + 4), w - tw / 2 - 4);
      ctx.fillStyle = c.enamel;
      ctx.fillText(text, x, wireY / 2);
    }

    if (!act && this.glow > 0.01) this.invalidate(); // Nachglimmen
  }
}
