// Kleine DOM-Helfer für das Bedienfeld. Jedes Bedienelement liest seinen Wert
// über get() und schreibt über set(); das Bedienfeld wird bei größeren
// Änderungen (Klangfarbe, Mixtur) einfach neu aufgebaut.

export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}

const fmtNum = (v, digits) =>
  v.toLocaleString('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const fmt = {
  pct: (v) => `${Math.round(v * 100)} %`,
  hz: (v) => (v >= 1000 ? `${fmtNum(v / 1000, 2)} kHz` : `${Math.round(v)} Hz`),
  sec: (v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${fmtNum(v, 1)} s`),
  num: (d) => (v) => fmtNum(v, d),
  unit: (d, u) => (v) => `${fmtNum(v, d)} ${u}`,
};

// Schieberegler; log=true für Frequenzen und Zeiten.
export function slider({ id, label, min, max, step, log = false, get, set, format = fmt.num(2), special }) {
  const out = el('output', { for: id });
  const input = el('input', { type: 'range', id });
  const show = (v) => {
    out.textContent = special && special.when(v) ? special.text : format(v);
  };
  if (log) {
    const k = Math.log(max / min);
    input.min = 0;
    input.max = 1000;
    input.step = 1;
    input.value = Math.round((Math.log(get() / min) / k) * 1000);
    input.addEventListener('input', () => {
      const v = min * Math.exp((input.value / 1000) * k);
      set(v);
      show(v);
    });
  } else {
    input.min = min;
    input.max = max;
    input.step = step ?? (max - min) / 100;
    input.value = get();
    input.addEventListener('input', () => {
      const v = Number(input.value);
      set(v);
      show(v);
    });
  }
  show(get());
  return el('div', { class: 'ctl' }, el('label', { for: id, text: label }), out, input);
}

// Umschalter mit wenigen Optionen: [[wert, text], ...]
export function segmented({ id, label, options, get, set, compact = false }) {
  const group = el('div', { class: 'seg', role: 'group', 'aria-label': label, id });
  const buttons = options.map(([value, text]) => {
    const b = el('button', { type: 'button', text, 'aria-pressed': String(get() === value) });
    b.addEventListener('click', () => {
      set(value);
      for (const o of buttons) o.setAttribute('aria-pressed', String(o === b));
    });
    return b;
  });
  group.append(...buttons);
  return el('div', { class: compact ? 'ctl ctl-seg compact' : 'ctl ctl-seg' },
    el('span', { class: 'ctl-label', text: label }), group);
}

// Plus/Minus für ganze Zahlen (Frequenzteiler).
export function stepper({ id, label, min, max, get, set, format = String, info }) {
  const value = el('output', { id, class: 'step-val' });
  const note = info ? el('span', { class: 'step-info' }) : null;
  const show = () => {
    value.textContent = format(get());
    if (note) note.textContent = info(get());
  };
  const change = (d) => {
    const v = Math.min(max, Math.max(min, get() + d));
    set(v);
    show();
  };
  show();
  return el('div', { class: 'stepper' },
    el('span', { class: 'ctl-label', text: label }),
    el('div', { class: 'step-row' },
      el('button', { type: 'button', class: 'step-btn', 'aria-label': `${label} verringern`, onclick: () => change(-1), text: '−' }),
      value,
      el('button', { type: 'button', class: 'step-btn', 'aria-label': `${label} erhöhen`, onclick: () => change(1), text: '+' }),
      note));
}

export function section(title, ...kids) {
  return el('section', { class: 'psec' }, el('h3', { text: title }), ...kids);
}
