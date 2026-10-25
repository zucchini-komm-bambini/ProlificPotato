// Klangfarben (Patches) und Mixturen.
//
// Eine Mixtur besteht aus vier Generatoren [Teiler, Pegel]. Teiler 1 ist der
// Grundton unter dem Finger, Teiler n erklingt als n-ter Unterton (f/n).
// Formant-Modus: 0 = aus, 1 = Tiefpass, 2 = Bandpass.
// level gleicht die Lautheit der Klangfarben untereinander an.

export const MIX_STANDARD = [
  { name: 'Grundton', gens: [[1, 1], [2, 0], [3, 0], [4, 0]] },
  { name: 'Oktaven', gens: [[1, 0.8], [2, 0.7], [4, 0.45], [3, 0]] },
  { name: 'Untertonreihe', gens: [[1, 0.65], [2, 0.55], [3, 0.5], [4, 0.4]] },
  { name: 'Mollakkord', gens: [[4, 0.7], [5, 0.65], [6, 0.7], [1, 0.25]] },
];

const bp = (f, q, g) => ({ mode: 2, f, q, g });
const lp = (f, q, g) => ({ mode: 1, f, q, g });
const off = (f = 1000) => ({ mode: 0, f, q: 4, g: 0.5 });

export const PATCHES = [
  {
    id: 'glimm',
    name: 'Glimmlampe',
    kipp: 0.5, direct: 0.55, noise: 0, level: 1,
    formants: [bp(650, 3, 0.9), bp(1500, 4, 0.5), lp(3500, 0.7, 0.3), off(2800)],
    env: { a: 0.008, d: 0, r: 0.2 },
    press: { curve: 1.4, bright: 0.6 },
    vib: { rate: 5.5, depth: 0 },
    glide: 0.006,
    mixtures: MIX_STANDARD,
  },
  {
    id: 'vokal',
    name: 'Vokal A',
    kipp: 0.3, direct: 0.06, noise: 0, level: 3.2,
    formants: [bp(730, 8, 1.3), bp(1090, 10, 1), bp(2440, 14, 0.6), off(3500)],
    env: { a: 0.03, d: 0, r: 0.25 },
    press: { curve: 1.2, bright: 0.3 },
    vib: { rate: 5.3, depth: 14 },
    glide: 0.02,
    mixtures: MIX_STANDARD,
  },
  {
    id: 'orgel',
    name: 'Untertonorgel',
    kipp: 0.35, direct: 0.5, noise: 0, level: 0.7,
    formants: [lp(2200, 0.8, 0.6), bp(400, 2, 0.5), off(1200), off(3000)],
    env: { a: 0.04, d: 0, r: 0.35 },
    press: { curve: 1, bright: 0.25 },
    vib: { rate: 5, depth: 0 },
    glide: 0.006,
    mixtures: [
      MIX_STANDARD[2],
      MIX_STANDARD[1],
      { name: 'Quinten', gens: [[1, 0.6], [3, 0.6], [2, 0.5], [6, 0.4]] },
      MIX_STANDARD[3],
    ],
  },
  {
    id: 'vogel',
    name: 'Vogelschrei',
    kipp: 0.9, direct: 0.15, noise: 0.12, level: 4,
    formants: [bp(2600, 9, 1.6), bp(3900, 12, 1.1), bp(1300, 6, 0.4), off(5000)],
    env: { a: 0.002, d: 0.7, r: 0.1 },
    press: { curve: 1.8, bright: 0.85 },
    vib: { rate: 11, depth: 35 },
    glide: 0.03,
    mixtures: [
      { name: 'Schrei', gens: [[1, 1], [2, 0], [3, 0], [4, 0]] },
      { name: 'Krächzen', gens: [[1, 0.9], [2, 0.35], [3, 0], [4, 0]] },
      { name: 'Rauh', gens: [[1, 0.8], [3, 0.4], [5, 0.3], [2, 0]] },
      { name: 'Schwarm', gens: [[1, 0.7], [7, 0.5], [11, 0.4], [13, 0.3]] },
    ],
  },
  {
    id: 'glocke',
    name: 'Glocke',
    kipp: 0.6, direct: 0.35, noise: 0, level: 1.6,
    formants: [bp(1100, 4, 0.8), bp(2300, 6, 0.5), lp(5000, 0.7, 0.2), off(800)],
    env: { a: 0.001, d: 1.6, r: 1.4 },
    press: { curve: 1, bright: 0.4 },
    vib: { rate: 5, depth: 0 },
    glide: 0.004,
    mixtures: [
      { name: 'Glockenmixtur', gens: [[1, 0.8], [3, 0.55], [5, 0.45], [7, 0.35]] },
      { name: 'Gong', gens: [[1, 0.8], [2, 0.6], [5, 0.4], [9, 0.3]] },
      MIX_STANDARD[0],
      MIX_STANDARD[3],
    ],
  },
  {
    id: 'bass',
    name: 'Tiefbass',
    kipp: 0.3, direct: 0.2, noise: 0, level: 0.7,
    formants: [lp(380, 2.2, 1.4), bp(900, 3, 0.35), off(2000), off(3000)],
    env: { a: 0.006, d: 0, r: 0.14 },
    press: { curve: 1.3, bright: 0.7 },
    vib: { rate: 5, depth: 0 },
    glide: 0.006,
    mixtures: [
      { name: 'Grund + Unteroktave', gens: [[1, 0.8], [2, 0.8], [3, 0], [4, 0]] },
      MIX_STANDARD[0],
      { name: 'Fundament', gens: [[1, 0.7], [2, 0.6], [3, 0.5], [4, 0]] },
      { name: 'Doppeloktave', gens: [[1, 0.6], [2, 0.7], [4, 0.6], [3, 0]] },
    ],
  },
  {
    id: 'wind',
    name: 'Wind',
    kipp: 0.5, direct: 0, noise: 0.85, level: 3.5,
    formants: [bp(700, 18, 2.2), bp(1400, 18, 1.6), bp(2900, 20, 1), off(500)],
    env: { a: 0.35, d: 0, r: 1.5 },
    press: { curve: 1.6, bright: 0.8 },
    vib: { rate: 5, depth: 0 },
    glide: 0.05,
    mixtures: [
      { name: 'Rauschen', gens: [[1, 0.12], [2, 0.08], [3, 0], [4, 0]] },
      { name: 'Pfeifen', gens: [[1, 0.45], [2, 0], [3, 0], [4, 0]] },
      { name: 'Brausen', gens: [[2, 0.2], [3, 0.2], [5, 0.15], [1, 0]] },
      { name: 'Stille Luft', gens: [[1, 0], [2, 0], [3, 0], [4, 0]] },
    ],
  },
  {
    id: 'streicher',
    name: 'Streicher',
    kipp: 0.15, direct: 0.35, noise: 0, level: 1.6,
    formants: [bp(280, 2.5, 0.8), bp(1100, 3, 0.7), bp(2600, 4, 0.5), bp(4200, 5, 0.2)],
    env: { a: 0.07, d: 0, r: 0.3 },
    press: { curve: 1.6, bright: 0.65 },
    vib: { rate: 5.8, depth: 16 },
    glide: 0.012,
    mixtures: MIX_STANDARD,
  },
];

// Formanten 1–3 für Vokale (Bandpass), grob nach Peterson & Barney.
export const VOWELS = {
  A: [[730, 8, 1.3], [1090, 10, 1], [2440, 14, 0.6]],
  E: [[450, 7, 1.3], [1900, 12, 0.9], [2550, 14, 0.6]],
  I: [[280, 6, 1.4], [2250, 14, 0.8], [3000, 16, 0.6]],
  O: [[450, 7, 1.3], [800, 9, 1], [2450, 14, 0.5]],
  U: [[310, 6, 1.4], [870, 9, 0.8], [2250, 14, 0.4]],
};

export function patchById(id) {
  return PATCHES.find((p) => p.id === id) || PATCHES[0];
}

// Tiefe Kopie, damit Änderungen im Bedienfeld die Vorlage nicht verändern.
export function soundFromPatch(patch) {
  return JSON.parse(JSON.stringify({ ...patch, id: undefined, name: undefined }));
}

const NOTE_NAMES = ['C', 'Cis', 'D', 'Dis', 'E', 'F', 'Fis', 'G', 'Gis', 'A', 'B', 'H'];

export function noteName(n) {
  const r = Math.round(n);
  return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
}

export function isNatural(n) {
  return [0, 2, 4, 5, 7, 9, 11].includes(((n % 12) + 12) % 12);
}

// "÷3" -> "19,0 HT tiefer"
export function divisorInfo(d) {
  if (d === 1) return 'Grundton';
  const st = 12 * Math.log2(d);
  return `${st.toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} Halbtöne tiefer`;
}
