// Tests der WebAssembly-Klangerzeugung mit dem in Node eingebauten Test-Runner.
// Aufruf: make test  (oder: node --test tests/*.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bytes = readFileSync(new URL('../docs/trautonium.wasm', import.meta.url));

async function engine(sampleRate = 48000) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const e = instance.exports;
  e.init(sampleRate);
  const n = e.max_frames();
  const left = new Float32Array(e.memory.buffer, e.out_left(), n);
  const right = new Float32Array(e.memory.buffer, e.out_right(), n);
  return {
    e,
    // Rendert `seconds` Sekunden, gibt den linken Kanal zurück.
    run(seconds, block = 128) {
      const total = Math.round(seconds * sampleRate);
      const out = new Float32Array(total);
      for (let i = 0; i < total; i += block) {
        const len = Math.min(block, total - i);
        e.render(len);
        out.set(left.subarray(0, len), i);
        for (let j = 0; j < len; j++) {
          if (!Number.isFinite(left[j]) || !Number.isFinite(right[j])) {
            throw new Error(`Ungültiger Wert bei Sample ${i + j}`);
          }
        }
      }
      return out;
    },
  };
}

// Reiner Kippton ohne Hall, Formanten, Druckfilter: für Frequenzmessungen.
function dry(e, m = 0) {
  e.set_reverb(0, 0.5, 0.5);
  e.set_pressure(m, 1, 0);
  e.set_direct(m, 1);
  e.set_vibrato(m, 0, 0);
  for (let k = 0; k < 4; k++) e.set_mix(m, k, k + 1, k === 0 ? 1 : 0);
}

const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

// Grundfrequenz über Autokorrelation (mit parabolischer Interpolation).
function pitch(signal, sampleRate, minHz = 20, maxHz = 2000) {
  const n = signal.length;
  const mean = signal.reduce((s, x) => s + x, 0) / n;
  const x = signal.map((v) => v - mean);
  const lagMin = Math.floor(sampleRate / maxHz);
  const lagMax = Math.ceil(sampleRate / minHz);
  const ac = new Float64Array(lagMax + 2);
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    ac[lag] = s / (n - lag);
  }
  // erstes deutliches Maximum (>= 90 % des globalen), damit keine Oktavfehler entstehen
  let globalMax = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) globalMax = Math.max(globalMax, ac[lag]);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (ac[lag] >= 0.9 * globalMax && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) {
      const a = ac[lag - 1], b = ac[lag], c = ac[lag + 1];
      const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
      return sampleRate / (lag + shift);
    }
  }
  return NaN;
}

const cents = (f, ref) => 1200 * Math.log2(f / ref);

test('Modul braucht keine Imports', () => {
  const mod = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(mod), []);
});

test('Stille, solange der Draht nicht berührt wird', async () => {
  const { run } = await engine();
  assert.equal(rms(run(0.5)), 0);
});

for (const [note, hz] of [[69, 440], [57, 220], [81, 880], [45, 110]]) {
  test(`Note ${note} klingt mit ${hz} Hz (±3 Cent)`, async () => {
    const { e, run } = await engine();
    dry(e);
    e.voice(0, 1, note, 1);
    run(0.2); // Einschwingen
    const f = pitch(run(0.5), 48000);
    assert.ok(Math.abs(cents(f, hz)) < 3, `gemessen ${f.toFixed(2)} Hz`);
  });
}

test('Stimmung A4 lässt sich verschieben', async () => {
  const { e, run } = await engine();
  dry(e);
  e.set_tuning(432);
  e.voice(0, 1, 69, 1);
  run(0.2);
  const f = pitch(run(0.5), 48000);
  assert.ok(Math.abs(cents(f, 432)) < 3, `gemessen ${f.toFixed(2)} Hz`);
});

for (const div of [2, 3, 5]) {
  test(`Teiler ${div} erzeugt den Unterton f/${div}`, async () => {
    const { e, run } = await engine();
    dry(e);
    e.set_mix(0, 0, div, 1);
    e.voice(0, 1, 81, 1); // 880 Hz
    run(0.2);
    const f = pitch(run(0.6), 48000, 20, 1000);
    assert.ok(Math.abs(cents(f, 880 / div)) < 3, `gemessen ${f.toFixed(2)} Hz`);
  });
}

test('Mischung aus Grundton und Untertönen bleibt phasenstarr (Periode = kgV)', async () => {
  const { e, run } = await engine();
  dry(e);
  e.set_mix(0, 0, 1, 1);
  e.set_mix(0, 1, 2, 0.8);
  e.set_mix(0, 2, 3, 0.6);
  e.voice(0, 1, 81, 1);
  run(0.2);
  // Grundperiode der Mischung ist 880/6 Hz
  const f = pitch(run(0.6), 48000, 50, 1000);
  assert.ok(Math.abs(cents(f, 880 / 6)) < 3, `gemessen ${f.toFixed(2)} Hz`);
});

test('Fingerdruck steuert die Lautstärke', async () => {
  const { e, run } = await engine();
  dry(e);
  e.voice(0, 1, 60, 1);
  const loud = rms(run(0.3).subarray(4800));
  e.voice(0, 1, 60, 0.3);
  run(0.1);
  const soft = rms(run(0.3));
  assert.ok(soft < loud * 0.5, `leise ${soft} / laut ${loud}`);
  assert.ok(soft > 0.001);
});

test('Pegel pro Manual', async () => {
  const { e, run } = await engine();
  dry(e);
  e.voice(0, 1, 60, 1);
  const full = rms(run(0.3).subarray(4800));
  e.set_level(0, 0.5);
  run(0.1);
  const half = rms(run(0.3));
  assert.ok(Math.abs(half / full - 0.5) < 0.05, `Verhältnis ${(half / full).toFixed(3)}`);
});

test('Loslassen klingt aus', async () => {
  const { e, run } = await engine();
  dry(e);
  e.set_env(0, 0.005, 0, 0.1);
  e.voice(0, 1, 60, 1);
  run(0.3);
  e.voice(0, 0, 60, 0);
  run(1.5);
  assert.ok(rms(run(0.2)) < 1e-4);
});

test('Schlagwerk: Ausklingen bei gehaltenem Draht', async () => {
  const { e, run } = await engine();
  dry(e);
  e.set_env(0, 0.002, 0.2, 0.2);
  e.voice(0, 1, 60, 1);
  const start = rms(run(0.1));
  run(1.0);
  const later = rms(run(0.1));
  assert.ok(later < start * 0.05, `Anfang ${start} / später ${later}`);
});

test('Zwei Manuale klingen gleichzeitig', async () => {
  const { e, run } = await engine();
  dry(e, 0);
  dry(e, 1);
  e.voice(0, 1, 69, 1);
  e.voice(1, 1, 57, 1);
  run(0.2);
  const sig = run(0.5);
  // Gemeinsame Periode 220 Hz (A3 und A4)
  const f = pitch(sig, 48000, 50, 1000);
  assert.ok(Math.abs(cents(f, 220)) < 3, `gemessen ${f.toFixed(2)} Hz`);
});

test('Extreme Einstellungen bleiben endlich und begrenzt', async () => {
  for (const sr of [22050, 44100, 48000, 96000]) {
    const { e, run } = await engine(sr);
    for (let m = 0; m < 2; m++) {
      for (let k = 0; k < 4; k++) e.set_mix(m, k, 24 - k, 1);
      e.set_kipp(m, 1);
      e.set_noise(m, 1);
      e.set_direct(m, 2);
      e.set_vibrato(m, 15, 200);
      for (let i = 0; i < 4; i++) e.set_formant(m, i, 1 + (i % 2), 5000 - i * 1500, 40, 4);
      e.voice(m, 1, 127 - m * 127, 1);
    }
    e.set_reverb(1, 1, 0);
    e.set_master(2);
    const sig = run(1.0);
    const peak = sig.reduce((p, x) => Math.max(p, Math.abs(x)), 0);
    assert.ok(peak <= 1.0001, `Spitze ${peak} bei ${sr} Hz`);
  }
});

test('Echtzeitfaktor: zwei volle Stimmen mit Hall', async () => {
  const { e, run } = await engine();
  for (let m = 0; m < 2; m++) {
    for (let k = 0; k < 4; k++) e.set_mix(m, k, k + 1, 0.7);
    for (let i = 0; i < 4; i++) e.set_formant(m, i, 2, 300 * (i + 1), 8, 1);
    e.set_noise(m, 0.1);
    e.set_vibrato(m, 5, 20);
    e.voice(m, 1, 50 + m * 12, 0.8);
  }
  e.set_reverb(0.4, 0.7, 0.4);
  const t0 = performance.now();
  run(10);
  const ms = performance.now() - t0;
  const factor = 10000 / ms;
  console.log(`  Echtzeitfaktor: ${factor.toFixed(0)}x`);
  assert.ok(factor > 20, `nur ${factor.toFixed(1)}x Echtzeit`);
});
