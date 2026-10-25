// Rauchtest im echten Browser (Chromium über Playwright):
// Seite laden, einschalten, Draht per Touch spielen, Klang am Oszilloskop prüfen.
// Aufruf: node tests/browser-smoke.cjs [Ordner für Bildschirmfotos]
// Mit TRAUTONIUM_URL=http://server:port/ wird eine laufende Installation geprüft
// statt docs/ über einen eigenen kleinen Server.
// Voraussetzung: Playwright mit Chromium ist installiert.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', 'docs');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, url.endsWith('/') ? url + 'index.html' : url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function touch(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 1 })),
  });
}

const lampOpacity = (page) => page.$eval('#lamp', (n) => Number(n.style.opacity || 0));

(async () => {
  const shots = process.argv[2];
  const server = process.env.TRAUTONIUM_URL ? null : await serve();
  const base = process.env.TRAUTONIUM_URL || `http://127.0.0.1:${server.address().port}/`;
  // AudioWorklet gibt es nur in sicheren Kontexten (HTTPS oder localhost)
  const secure = /^https:|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(base);
  console.log(`Prüfe ${base}${secure ? '' : ' (ohne HTTPS: Rückfallebene erwartet)'}`);
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  let failed = false;
  const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FEHLER'} ${msg}`); if (!ok) failed = true; };

  try {
    const runs = [
      ['quer', { width: 844, height: 390 }, 'AudioWorklet'],
      ['hoch', { width: 390, height: 844 }, 'AudioWorklet'],
      ['ohne-worklet', { width: 844, height: 390 }, 'ScriptProcessor'],
      ['ios-nachbau', { width: 844, height: 390 }, 'AudioWorklet'],
    ];
    for (const [name, viewport, wanted] of runs) {
      const mode = secure ? wanted : 'ScriptProcessor';
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      // Älteren Browser ohne AudioWorklet nachstellen
      if (mode === 'ScriptProcessor') await page.addInitScript(() => { delete window.AudioWorkletNode; });
      // Safari-Kennzeichen nachstellen: webkitAudioContext auf einem Touchgerät
      const ios = name === 'ios-nachbau';
      if (ios) await page.addInitScript(() => { window.webkitAudioContext = window.AudioContext; });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(base);
      await page.waitForLoadState('networkidle');
      if (shots) await page.screenshot({ path: path.join(shots, `${name}-start.png`) });

      await page.click('#btn-start');
      await page.waitForSelector('#start', { state: 'hidden', timeout: 8000 });
      check(true, `${name}: eingeschaltet`);

      const cdp = await ctx.newCDPSession(page);
      const box = await page.$eval('#wire-0', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      const box2 = await page.$eval('#wire-1', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      check((await lampOpacity(page)) < 0.3, `${name}: still, solange niemand spielt`);

      // Zwei Finger: einer auf jedem Manual, dann gleiten
      const p1 = [box.x + box.w * 0.3, box.y + box.h * 0.7];
      const p2 = [box2.x + box2.w * 0.6, box2.y + box2.h * 0.5];
      await touch(cdp, 'touchStart', [p1, p2]);
      for (let i = 1; i <= 10; i++) {
        await touch(cdp, 'touchMove', [[p1[0] + i * 8, p1[1]], p2]);
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(250);
      const playing = await lampOpacity(page);
      check(playing > 0.4, `${name}: Klang beim Spielen (Glimmlampe ${playing.toFixed(2)})`);
      if (shots) await page.screenshot({ path: path.join(shots, `${name}-spielen.png`) });

      await touch(cdp, 'touchEnd', []);
      await page.waitForTimeout(1500);
      const after = await lampOpacity(page);
      check(after < playing, `${name}: klingt nach dem Loslassen aus (${after.toFixed(2)})`);

      // Mixtur umschalten und Bedienfeld öffnen
      await page.tap('#mix-0 button:nth-child(3)');
      const pressed = await page.$eval('#mix-0 button:nth-child(3)', (b) => b.getAttribute('aria-pressed'));
      check(pressed === 'true', `${name}: Mixtur 3 gewählt`);
      await page.tap('#btn-panel');
      await page.waitForSelector('#panel', { state: 'visible' });
      if (shots) await page.screenshot({ path: path.join(shots, `${name}-klang.png`) });
      await page.tap('#tab-g');
      if (shots) await page.screenshot({ path: path.join(shots, `${name}-allgemein.png`) });
      const about = await page.textContent('#panel-body');
      check(about.includes(`Audioausgabe: ${mode}`), `${name}: Audioausgabe über ${mode}`);
      check(about.includes('Zustand: läuft'), `${name}: AudioContext läuft`);
      if (ios) check(about.includes('Stummmodus-Umgehung: spielt'), `${name}: stilles <audio> läuft (${about.match(/Stummmodus-Umgehung: [^A-ZÄÖÜ]*/)})`);
      else check(!about.includes('Stummmodus-Umgehung'), `${name}: keine iOS-Umgehung nötig`);
      // Testton muss am Oszilloskop ankommen
      await page.click('text=Testton a¹ spielen');
      await page.waitForTimeout(350);
      const tone = await lampOpacity(page);
      check(tone > 0.4, `${name}: Testton erklingt (Glimmlampe ${tone.toFixed(2)})`);
      await page.tap('#btn-close');

      const scrollW = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(scrollW <= 0, `${name}: kein seitliches Scrollen`);
      check(errors.length === 0, `${name}: keine Fehler in der Konsole ${errors.join(' | ')}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    if (server) server.close();
  }
  process.exit(failed ? 1 : 0);
})();
