// iOS behandelt Web Audio als „Ambient“-Ton: Er verstummt, sobald das iPhone
// im Stummmodus ist (Klingelschalter oder Aktionstaste). <audio>-Elemente
// gelten dagegen als Wiedergabe und spielen weiter. Zwei Gegenmittel:
//  1. navigator.audioSession.type = 'playback' (Audio Session API, neuere iOS),
//  2. ein stilles, endlos geloopte <audio>-Element, das die Sitzung in die
//     Kategorie „Wiedergabe“ hebt. Muss innerhalb einer Berührung starten.

// iPhone und iPad (auch iPadOS mit Desktop-Kennung) und jeder Browser darauf
export const isAppleTouch =
  navigator.maxTouchPoints > 0 && typeof window.webkitAudioContext === 'function';

const status = { session: 'nicht verfügbar', element: 'nicht benötigt' };
let element = null;

export function audioSessionStatus() {
  return { ...status };
}

export function requestPlaybackSession() {
  try {
    if (navigator.audioSession) {
      navigator.audioSession.type = 'playback';
      status.session = navigator.audioSession.type;
    }
  } catch (err) {
    status.session = `Fehler: ${err.message}`;
  }
}

// Stille WAV-Datei mit derselben Abtastrate wie der AudioContext; sonst
// schaltet iOS die Hardware um und der Web-Audio-Ton klingt verzerrt.
function silentWav(sampleRate) {
  const n = Math.round(sampleRate / 10); // 0,1 s, 8 Bit mono
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const ascii = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); v.setUint32(4, 36 + n, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  ascii(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128); // 128 = Nulllinie bei 8 Bit
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

// Synchron aus einem Klick- oder Touch-Handler aufrufen.
export function startSilentElement(sampleRate) {
  if (!isAppleTouch) return;
  if (!element) {
    element = document.createElement('audio');
    element.setAttribute('x-webkit-airplay', 'deny');
    element.disableRemotePlayback = true;
    element.preload = 'auto';
    element.loop = true;
    element.src = silentWav(sampleRate);
    element.load();
  }
  status.element = 'startet';
  const played = element.play();
  if (played && played.then) {
    played.then(
      () => { status.element = 'spielt'; },
      (err) => { status.element = `blockiert: ${err.name}`; },
    );
  }
  // Benennt die Medien-Anzeige im Sperrbildschirm, falls iOS sie einblendet
  try {
    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'Trautonium' });
    }
  } catch { /* egal */ }
}

export function pauseSilentElement() {
  if (element && !element.paused) {
    element.pause();
    status.element = 'pausiert';
  }
}

export function silentElementPaused() {
  return !!element && element.paused;
}
