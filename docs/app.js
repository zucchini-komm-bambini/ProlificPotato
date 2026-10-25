// Trautonium für Touchscreens – Hauptprogramm.

import { PATCHES, VOWELS, patchById, soundFromPatch, divisorInfo } from './presets.js';
import { Manual } from './manual.js';
import { el, fmt, slider, segmented, stepper, section } from './ui.js';
import {
  isAppleTouch, requestPlaybackSession, startSilentElement, pauseSilentElement,
  silentElementPaused, audioSessionStatus,
} from './ios-audio.js';

const STORE_KEY = 'trautonium.v1';
const BASE_NOTE = 48; // C3: tiefster Ton von Manual I in Lage 0
const ROMAN = ['I', 'II'];

/* ------------------------------------------------------------------ Zustand */

function defaultState() {
  return {
    v: 1,
    global: { volume: 0.65, reverb: 0.22, room: 0.65, damping: 0.4, a4: 440, range: 0, snap: 0, markers: true },
    manuals: [
      { patch: 'glimm', octave: 0, mix: 0, sound: soundFromPatch(patchById('glimm')) },
      { patch: 'bass', octave: -1, mix: 0, sound: soundFromPatch(patchById('bass')) },
    ],
  };
}

function validState(s) {
  return s && s.v === 1 && s.global && Array.isArray(s.manuals) && s.manuals.length === 2 &&
    s.manuals.every((m) => m.sound && m.sound.mixtures?.length === 4 && m.sound.formants?.length === 4 &&
      m.sound.env && m.sound.press && m.sound.vib);
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (validState(s)) return { ...s, global: { ...defaultState().global, ...s.global } };
  } catch { /* kein Speicher verfügbar */ }
  return defaultState();
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* egal */ }
  }, 300);
}

let state = loadState();

/* --------------------------------------------------------------- Klangmotor */

const audio = { ctx: null, port: null, engine: null, analyser: null, pending: [], mode: '' };

// Aufrufe sammeln und einmal pro Ereignis gebündelt an den Audio-Thread schicken.
function E(name, ...args) {
  audio.pending.push([name, args]);
  if (audio.pending.length === 1) queueMicrotask(flush);
}

function flush() {
  const calls = audio.pending;
  audio.pending = [];
  if (audio.port) audio.port.postMessage(calls);
  else if (audio.engine) for (const [n, a] of calls) audio.engine.call(n, a);
}

function pushMix(m) {
  const man = state.manuals[m];
  man.sound.mixtures[man.mix].gens.forEach(([d, l], k) => E('set_mix', m, k, d, l));
}

function pushManual(m) {
  const s = state.manuals[m].sound;
  pushMix(m);
  E('set_kipp', m, s.kipp);
  s.formants.forEach((f, i) => E('set_formant', m, i, f.mode, f.f, f.q, f.g));
  E('set_direct', m, s.direct);
  E('set_level', m, s.level ?? 1);
  E('set_noise', m, s.noise);
  E('set_env', m, s.env.a, s.env.d, s.env.r);
  E('set_pressure', m, s.press.curve, s.press.bright);
  E('set_vibrato', m, s.vib.rate, s.vib.depth);
  E('set_glide', m, s.glide);
}

function pushGlobal() {
  const g = state.global;
  E('set_reverb', g.reverb, g.room, g.damping);
  E('set_master', g.volume);
  E('set_tuning', g.a4);
}

function pushAll() {
  pushGlobal();
  pushManual(0);
  pushManual(1);
}

const wasmBytes = fetch('trautonium.wasm').then((r) => {
  if (!r.ok) throw new Error(`trautonium.wasm nicht gefunden (${r.status})`);
  return r.arrayBuffer();
});

async function workletOutput(ctx, wasm) {
  await ctx.audioWorklet.addModule('worklet.js');
  const node = new AudioWorkletNode(ctx, 'trautonium', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { wasm },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Audio-Thread antwortet nicht')), 4000);
    node.port.onmessage = (ev) => {
      clearTimeout(timer);
      if (ev.data.ready) resolve();
      else reject(new Error(ev.data.error || 'unbekannter Fehler'));
    };
  });
  audio.port = node.port;
  audio.mode = 'AudioWorklet';
  return node;
}

// Rückfallebene für Browser ohne AudioWorklet: gleiche Engine im Hauptthread.
async function scriptOutput(ctx, wasm) {
  const { Engine } = await import('./worklet.js');
  const engine = await Engine.create(wasm, ctx.sampleRate);
  const node = ctx.createScriptProcessor(1024, 1, 2);
  node.onaudioprocess = (ev) =>
    engine.process(ev.outputBuffer.getChannelData(0), ev.outputBuffer.getChannelData(1));
  audio.engine = engine;
  audio.mode = 'ScriptProcessor';
  return node;
}

async function startAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('Dieser Browser unterstützt kein Web Audio.');
  if (typeof WebAssembly !== 'object') throw new Error('Dieser Browser unterstützt kein WebAssembly.');
  // iOS: auch im Stummmodus hörbar (siehe ios-audio.js)
  requestPlaybackSession();
  const ctx = new Ctx({ latencyHint: 'interactive' });
  startSilentElement(ctx.sampleRate); // beides muss innerhalb der Nutzergeste passieren
  const resumed = ctx.resume();
  audio.ctx = ctx;
  ctx.addEventListener('statechange', () => {
    if (!panel.hidden && panelTab === 'g') renderPanel();
  });
  const wasm = await wasmBytes;

  let out = null;
  if (ctx.audioWorklet && window.AudioWorkletNode) {
    try {
      out = await workletOutput(ctx, wasm.slice(0));
    } catch (err) {
      console.warn('AudioWorklet nicht nutzbar, nutze ScriptProcessor:', err);
    }
  }
  if (!out) out = await scriptOutput(ctx, wasm);

  audio.analyser = ctx.createAnalyser();
  audio.analyser.fftSize = 2048;
  out.connect(ctx.destination);
  out.connect(audio.analyser);
  await resumed;
  pushAll();
  flush();
  requestWakeLock();
  drawScope();
}

// Bei jeder Berührung: nach Anruf, App-Wechsel oder Sperrbildschirm wieder anwerfen.
function resumeIfNeeded() {
  if (!audio.ctx) return;
  if (silentElementPaused()) startSilentElement(audio.ctx.sampleRate);
  if (audio.ctx.state !== 'running') audio.ctx.resume();
}

function testTone() {
  resumeIfNeeded();
  E('voice', 0, 1, 69, 0.85);
  setTimeout(() => {
    E('voice', 0, 0, 0, 0);
    if (!panel.hidden && panelTab === 'g') renderPanel();
  }, 700);
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* nicht erlaubt – egal */ }
}

/* --------------------------------------------------------------- Manuale */

function autoSemis(width) {
  // ca. 20 px pro Halbton, in halben Oktaven
  return Math.min(48, Math.max(12, Math.round(width / 20 / 6) * 6));
}

function layout(m, width) {
  const g = state.global;
  return {
    low: BASE_NOTE + 12 * state.manuals[m].octave,
    semis: g.range > 0 ? g.range : autoSemis(width),
    snap: g.snap,
    markers: g.markers,
    a4: g.a4,
  };
}

const manuals = [0, 1].map((m) => new Manual(document.getElementById(`wire-${m}`), m, {
  layout,
  onVoice: (i, gate, note, press) => E('voice', i, gate, note, press),
  onRetrigger: (i) => E('retrigger', i),
  onFirstTouch: resumeIfNeeded,
}));

function redrawManuals() {
  for (const m of manuals) m.invalidate();
}
document.fonts?.ready.then(redrawManuals); // Skala in der Hausschrift neu zeichnen

function updateSide(m) {
  const man = state.manuals[m];
  document.getElementById(`pname-${m}`).textContent = patchById(man.patch).name;
  document.getElementById(`mix-name-${m}`).textContent = man.sound.mixtures[man.mix].name;
  document.querySelectorAll(`#mix-${m} button`).forEach((b, k) => {
    b.setAttribute('aria-pressed', String(k === man.mix));
  });
}

function selectMix(m, k) {
  state.manuals[m].mix = k;
  pushMix(m);
  updateSide(m);
  if (!panel.hidden && panelTab === m) renderPanel();
  save();
}

for (const m of [0, 1]) {
  document.querySelectorAll(`#mix-${m} button`).forEach((b, k) => {
    // pointerdown statt click: schaltet sofort, auch während ein anderer Finger spielt
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      resumeIfNeeded();
      selectMix(m, k);
    });
    b.addEventListener('click', (e) => { if (e.detail === 0) selectMix(m, k); }); // Tastatur
  });
  document.getElementById(`patch-${m}`).addEventListener('click', () => openPanel(m));
  updateSide(m);
}

/* ----------------------------------------------------------- Oszilloskop */

const scope = document.getElementById('scope');
const scopeCtx = scope.getContext('2d');
const lamp = document.getElementById('lamp');
let scopeBuf = null;
let scopeColor = '';

function drawScope() {
  requestAnimationFrame(drawScope);
  if (!audio.analyser || document.hidden) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = scope.clientWidth, h = scope.clientHeight;
  if (scope.width !== Math.round(w * dpr)) {
    scope.width = Math.round(w * dpr);
    scope.height = Math.round(h * dpr);
  }
  if (!scopeBuf) scopeBuf = new Float32Array(audio.analyser.fftSize);
  audio.analyser.getFloatTimeDomainData(scopeBuf);

  // Auf steigenden Nulldurchgang triggern, damit das Bild steht
  let start = 0;
  for (let i = 1; i < scopeBuf.length / 2; i++) {
    if (scopeBuf[i - 1] < 0 && scopeBuf[i] >= 0) { start = i; break; }
  }
  let peak = 0;
  for (let i = 0; i < scopeBuf.length; i++) peak = Math.max(peak, Math.abs(scopeBuf[i]));
  lamp.style.opacity = String(0.25 + Math.min(1, peak * 1.6) * 0.75);

  const c = scopeCtx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  c.strokeStyle = scopeColor || (scopeColor = getComputedStyle(scope).color);
  c.lineWidth = 1.5;
  c.beginPath();
  const n = 1024;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const y = h / 2 - scopeBuf[start + i] * (h / 2 - 2);
    if (i) c.lineTo(x, y); else c.moveTo(x, y);
  }
  c.stroke();
}

/* ------------------------------------------------------------ Bedienfeld */

const panel = document.getElementById('panel');
const panelBody = document.getElementById('panel-body');
const tabs = [...document.querySelectorAll('#panel [role=tab]')];
let panelTab = 0;

function openPanel(tab = panelTab) {
  panelTab = tab;
  panel.hidden = false;
  renderPanel();
  document.getElementById('btn-close').focus({ preventScroll: true });
}

function closePanel() {
  panel.hidden = true;
  document.getElementById('btn-panel').focus({ preventScroll: true });
}

document.getElementById('btn-panel').addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
document.getElementById('btn-close').addEventListener('click', closePanel);
tabs.forEach((t, i) => t.addEventListener('click', () => { panelTab = i === 2 ? 'g' : i; renderPanel(); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) closePanel(); });

function renderPanel() {
  tabs.forEach((t, i) => t.setAttribute('aria-selected', String((i === 2 ? 'g' : i) === panelTab)));
  const scroll = panelBody.scrollTop;
  panelBody.replaceChildren(...(panelTab === 'g' ? globalControls() : manualControls(panelTab)));
  panelBody.scrollTop = scroll;
}

function manualControls(m) {
  const man = state.manuals[m];
  const s = man.sound;
  const id = (k) => `m${m}-${k}`;
  const changed = () => { pushManual(m); save(); };

  // Klangfarbe
  const select = el('select', { id: id('patch') },
    PATCHES.map((p) => el('option', { value: p.id, text: p.name, selected: p.id === man.patch })));
  select.addEventListener('change', () => loadPatch(m, select.value));
  const patchRow = el('div', { class: 'ctl ctl-select' },
    el('label', { for: id('patch'), text: 'Klangfarbe' }),
    el('div', { class: 'select-row' }, select,
      el('button', { type: 'button', class: 'btn btn-quiet', text: 'Zurücksetzen', onclick: () => loadPatch(m, man.patch) })));

  const lage = segmented({
    id: id('octave'), label: 'Lage (Oktave)',
    options: [[-2, '−2'], [-1, '−1'], [0, '0'], [1, '+1'], [2, '+2']],
    get: () => man.octave,
    set: (v) => { man.octave = v; redrawManuals(); save(); },
  });

  // Mixturen
  const mix = s.mixtures[man.mix];
  const mixSel = segmented({
    id: id('mixsel'), label: 'Mixtur bearbeiten',
    options: [0, 1, 2, 3].map((k) => [k, String(k + 1)]),
    get: () => man.mix,
    set: (k) => selectMix(m, k),
  });
  const mixName = el('input', { type: 'text', id: id('mixname'), value: mix.name, maxlength: 24, autocomplete: 'off' });
  mixName.addEventListener('input', () => { mix.name = mixName.value; updateSide(m); save(); });
  const gens = mix.gens.map((g, k) => el('div', { class: 'gen' },
    stepper({
      id: id(`div${k}`), label: `Generator ${k + 1}`, min: 1, max: 24,
      get: () => g[0], set: (v) => { g[0] = v; pushMix(m); save(); },
      format: (v) => `÷${v}`, info: divisorInfo,
    }),
    slider({
      id: id(`lvl${k}`), label: 'Pegel', min: 0, max: 1, step: 0.01,
      get: () => g[1], set: (v) => { g[1] = v; pushMix(m); save(); }, format: fmt.pct,
    })));

  // Formantfilter
  const formants = s.formants.map((f, i) => el('div', { class: 'formant' },
    segmented({
      id: id(`fm${i}`), label: `Formant ${i + 1}`, compact: true,
      options: [[0, 'Aus'], [1, 'Tiefpass'], [2, 'Bandpass']],
      get: () => f.mode, set: (v) => { f.mode = v; changed(); },
    }),
    slider({ id: id(`ff${i}`), label: 'Frequenz', min: 50, max: 5000, log: true, get: () => f.f, set: (v) => { f.f = v; changed(); }, format: fmt.hz }),
    slider({ id: id(`fq${i}`), label: 'Güte', min: 0.5, max: 30, log: true, get: () => f.q, set: (v) => { f.q = v; changed(); }, format: fmt.num(1) }),
    slider({ id: id(`fg${i}`), label: 'Pegel', min: 0, max: 2.5, step: 0.01, get: () => f.g, set: (v) => { f.g = v; changed(); }, format: fmt.pct })));

  const vowels = el('div', { class: 'ctl ctl-seg' },
    el('span', { class: 'ctl-label', text: 'Vokal einstellen' }),
    el('div', { class: 'seg' }, Object.keys(VOWELS).map((v) =>
      el('button', { type: 'button', text: v, onclick: () => setVowel(m, v) }))));

  const level = slider({
    id: id('level'), label: 'Pegel dieses Manuals', min: 0.1, max: 4, log: true,
    get: () => s.level ?? 1, set: (v) => { s.level = v; changed(); },
    format: (v) => `${v >= 1 ? '+' : '−'}${Math.abs(20 * Math.log10(v)).toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} dB`,
  });

  return [
    section('Klang', patchRow, lage, level),
    section('Mixtur aus Untertönen',
      el('p', { class: 'note', text: 'Jeder Generator teilt die Frequenz des Grundtons durch eine ganze Zahl. ÷2 klingt eine Oktave tiefer, ÷4, ÷5, ÷6 zusammen ergeben einen Mollakkord.' }),
      mixSel,
      el('div', { class: 'ctl ctl-select' }, el('label', { for: id('mixname'), text: 'Name der Mixtur' }), mixName),
      ...gens),
    section('Kippschwingung',
      slider({ id: id('kipp'), label: 'Form: gerade bis gekrümmt', min: 0, max: 1, step: 0.01, get: () => s.kipp, set: (v) => { s.kipp = v; changed(); }, format: fmt.pct }),
      slider({ id: id('noise'), label: 'Geräusch', min: 0, max: 1, step: 0.01, get: () => s.noise, set: (v) => { s.noise = v; changed(); }, format: fmt.pct })),
    section('Formantfilter',
      el('p', { class: 'note', text: 'Vier parallele Resonanzfilter mit fester Lage. Sie färben jeden Ton gleich, wie die Resonanzen einer Stimme.' }),
      vowels,
      slider({ id: id('direct'), label: 'Direktsignal (ungefiltert)', min: 0, max: 1.5, step: 0.01, get: () => s.direct, set: (v) => { s.direct = v; changed(); }, format: fmt.pct }),
      ...formants),
    section('Schlagwerk',
      slider({ id: id('att'), label: 'Einschwingen', min: 0.001, max: 1, log: true, get: () => s.env.a, set: (v) => { s.env.a = v; changed(); }, format: fmt.sec }),
      slider({
        id: id('dec'), label: 'Ausklingen bei gehaltenem Draht', min: 0.05, max: 10, log: true,
        get: () => s.env.d > 0 ? s.env.d : 10,
        set: (v) => { s.env.d = v >= 9.9 ? 0 : v; changed(); },
        format: fmt.sec, special: { when: (v) => v >= 9.9, text: 'hält' },
      }),
      slider({ id: id('rel'), label: 'Ausschwingen nach Loslassen', min: 0.01, max: 4, log: true, get: () => s.env.r, set: (v) => { s.env.r = v; changed(); }, format: fmt.sec })),
    section('Druck und Vibrato',
      slider({ id: id('curve'), label: 'Druckkennlinie', min: 0.5, max: 3, step: 0.05, get: () => s.press.curve, set: (v) => { s.press.curve = v; changed(); }, format: fmt.num(2) }),
      slider({ id: id('bright'), label: 'Druck macht heller', min: 0, max: 1, step: 0.01, get: () => s.press.bright, set: (v) => { s.press.bright = v; changed(); }, format: fmt.pct }),
      slider({ id: id('vdepth'), label: 'Vibrato-Tiefe', min: 0, max: 100, step: 1, get: () => s.vib.depth, set: (v) => { s.vib.depth = v; changed(); }, format: fmt.unit(0, 'ct') }),
      slider({ id: id('vrate'), label: 'Vibrato-Tempo', min: 2, max: 12, step: 0.1, get: () => s.vib.rate, set: (v) => { s.vib.rate = v; changed(); }, format: fmt.unit(1, 'Hz') }),
      slider({ id: id('glide'), label: 'Gleiten zwischen Fingern', min: 0.002, max: 1, log: true, get: () => s.glide, set: (v) => { s.glide = v; changed(); }, format: fmt.sec })),
  ];
}

function globalControls() {
  const g = state.global;
  const id = (k) => `g-${k}`;
  const changed = () => { pushGlobal(); save(); };
  return [
    section('Ausgang',
      slider({ id: id('vol'), label: 'Lautstärke', min: 0, max: 1.2, step: 0.01, get: () => g.volume, set: (v) => { g.volume = v; changed(); }, format: fmt.pct }),
      slider({ id: id('rev'), label: 'Hall', min: 0, max: 1, step: 0.01, get: () => g.reverb, set: (v) => { g.reverb = v; changed(); }, format: fmt.pct }),
      slider({ id: id('room'), label: 'Raumgröße', min: 0, max: 1, step: 0.01, get: () => g.room, set: (v) => { g.room = v; changed(); }, format: fmt.pct }),
      slider({ id: id('damp'), label: 'Dämpfung', min: 0, max: 1, step: 0.01, get: () => g.damping, set: (v) => { g.damping = v; changed(); }, format: fmt.pct })),
    section('Spielhilfen',
      segmented({
        id: id('range'), label: 'Umfang je Draht in Oktaven',
        options: [[0, 'Auto'], [12, '1'], [18, '1½'], [24, '2'], [36, '3'], [48, '4']],
        get: () => g.range, set: (v) => { g.range = v; redrawManuals(); save(); },
      }),
      slider({
        id: id('snap'), label: 'Einrasten auf Halbtöne', min: 0, max: 1, step: 0.05,
        get: () => g.snap, set: (v) => { g.snap = v; save(); }, format: fmt.pct,
        special: { when: (v) => v === 0, text: 'stufenlos' },
      }),
      segmented({
        id: id('markers'), label: 'Tonmarken',
        options: [[true, 'Alle Halbtöne'], [false, 'Nur C']],
        get: () => g.markers, set: (v) => { g.markers = v; redrawManuals(); save(); },
      }),
      slider({ id: id('a4'), label: 'Stimmton a¹', min: 415, max: 466, step: 1, get: () => g.a4, set: (v) => { g.a4 = v; changed(); redrawManuals(); }, format: fmt.unit(0, 'Hz') })),
    section('Ton-Diagnose', ...diagnostics()),
    section('Über dieses Instrument',
      el('p', { class: 'note', text: 'Friedrich Trautwein stellte das Trautonium 1930 in Berlin vor. Gespielt wird es auf einem Draht, der über eine Metallschiene gespannt ist: Wo der Finger den Draht auf die Schiene drückt, entsteht die Tonhöhe, und der Fingerdruck bestimmt die Lautstärke. Oskar Sala baute daraus das Mixtur-Trautonium mit zwei Manualen und Untertönen, mit dem er unter anderem die Vogelschreie für Hitchcocks „Die Vögel“ (1963) erzeugte.' }),
      el('p', { class: 'note', text: 'Diese Nachbildung rechnet in WebAssembly, übersetzt aus C.' }),
      el('button', { type: 'button', class: 'btn btn-quiet', text: 'Alle Einstellungen zurücksetzen', onclick: resetAll })),
  ];
}

function diagnostics() {
  const ctx = audio.ctx;
  const ms = (s) => (s > 0 ? `${Math.round(s * 1000)} ms` : 'unbekannt');
  const rows = [
    ['Audioausgabe', audio.mode || 'noch nicht eingeschaltet'],
    ['Zustand', ctx ? { running: 'läuft', suspended: 'angehalten', interrupted: 'unterbrochen', closed: 'beendet' }[ctx.state] || ctx.state : '–'],
    ['Abtastrate', ctx ? `${ctx.sampleRate} Hz` : '–'],
    ['Latenz', ctx ? `${ms(ctx.baseLatency)} + Ausgabe ${ms(ctx.outputLatency)}` : '–'],
  ];
  if (isAppleTouch) {
    const st = audioSessionStatus();
    rows.push(['Audio-Sitzung', st.session], ['Stummmodus-Umgehung', st.element]);
  }
  return [
    el('ul', { class: 'diag' }, rows.map(([k, v]) => el('li', {}, el('span', { text: `${k}: ` }), el('b', { text: v })))),
    el('div', { class: 'select-row' },
      el('button', { type: 'button', class: 'btn btn-quiet', text: 'Testton a¹ spielen', onclick: testTone })),
    el('p', { class: 'note', text: 'Bewegt sich beim Testton die Linie oben im Oszilloskop, aber es ist nichts zu hören, dann kommt der Ton beim Gerät nicht an. Auf dem iPhone: Stummmodus ausschalten (Schalter an der Seite oder Glocke im Kontrollzentrum), Lautstärketasten drücken, während ein Ton klingt, und prüfen, ob Kopfhörer per Bluetooth verbunden sind.' }),
  ];
}

function loadPatch(m, patchId) {
  const man = state.manuals[m];
  man.patch = patchId;
  man.sound = soundFromPatch(patchById(patchId));
  man.mix = 0;
  pushManual(m);
  updateSide(m);
  renderPanel();
  save();
}

function setVowel(m, v) {
  const s = state.manuals[m].sound;
  VOWELS[v].forEach(([f, q, g], i) => Object.assign(s.formants[i], { mode: 2, f, q, g }));
  s.formants[3].mode = 0;
  s.direct = 0.06;
  pushManual(m);
  renderPanel();
  save();
}

function resetAll() {
  state = defaultState();
  pushAll();
  updateSide(0);
  updateSide(1);
  redrawManuals();
  renderPanel();
  save();
}

/* --------------------------------------------------------- Start und Rest */

const overlay = document.getElementById('start');
const startBtn = document.getElementById('btn-start');
const startError = document.getElementById('start-error');
if (isAppleTouch) document.getElementById('ios-hint').hidden = false;

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startBtn.textContent = 'Wird eingeschaltet …';
  startError.hidden = true;
  try {
    await startAudio();
    overlay.hidden = true;
    document.getElementById('app').classList.add('on');
  } catch (err) {
    console.error(err);
    startError.textContent = `Der Klang ließ sich nicht starten: ${err.message}`;
    startError.hidden = false;
    startBtn.disabled = false;
    startBtn.textContent = 'Erneut versuchen';
  }
});

const fullBtn = document.getElementById('btn-full');
if (document.fullscreenEnabled && document.documentElement.requestFullscreen) {
  fullBtn.hidden = false;
  fullBtn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        await screen.orientation?.lock?.('landscape').catch(() => {});
      }
    } catch { /* nicht erlaubt */ }
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    for (const m of manuals) m.releaseAll();
    pauseSilentElement();
  } else {
    requestWakeLock();
  }
});
window.addEventListener('pagehide', () => { for (const m of manuals) m.releaseAll(); });
