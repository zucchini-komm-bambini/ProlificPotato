# ProlificPotato: Trautonium für das Handy

Ein spielbares **Mixtur-Trautonium** im Browser, gebaut für Touchscreens.
Die Klangerzeugung ist in C geschrieben und läuft als **WebAssembly** in einem
AudioWorklet. Es gibt keine Abhängigkeiten, kein npm-Paket, kein Framework
und keinen Bundler.

Das Trautonium stellte Friedrich Trautwein 1930 in Berlin vor. Gespielt wird
es auf einem Draht, der über eine Metallschiene gespannt ist: Die Stelle, an
der der Finger den Draht auf die Schiene drückt, ergibt die Tonhöhe
(stufenlos), der Fingerdruck die Lautstärke. Oskar Sala erweiterte es zum
Mixtur-Trautonium mit zwei Manualen und Untertönen und erzeugte damit unter
anderem die Vogelschreie für Hitchcocks „Die Vögel“ (1963).

## Spielen

| Geste | Wirkung |
| --- | --- |
| Waagrecht über den Draht gleiten | Tonhöhe, stufenlos (Glissando, Vibrato mit dem Finger) |
| Weiter unten berühren bzw. Finger nach unten schieben | „tiefer drücken“: lauter und heller |
| Zweiter Finger auf demselben Draht | neuer Anschlag; beim Loslassen übernimmt der erste Finger wieder |
| Je ein Finger auf Manual I und II | zwei Stimmen gleichzeitig |
| Tasten 1–4 neben dem Draht | Mixtur umschalten, auch während des Spielens |
| Stift mit Andruck (z. B. Apple Pencil) | echter Druck statt Position |

Querformat und Kopfhörer sind empfohlen. Auf dem Startbildschirm muss einmal
„Einschalten“ getippt werden, weil Browser Ton erst nach einer Berührung
erlauben. Auf iOS spielt der Ton auch bei stummgeschaltetem Klingelschalter
(ab Safari 17 über `navigator.audioSession`).

## Klangerzeugung (`dsp/trautonium.c`)

Nachgebildet ist das Mixtur-Trautonium, nicht ein bestimmtes Exemplar:

- **Kippschwingung:** Wie bei der Glimmlampe lädt sich ein Kondensator
  exponentiell auf und entlädt sich schlagartig. Die Krümmung ist einstellbar,
  von geradem Sägezahn bis stark gekrümmt. Bandbegrenzt über PolyBLEP.
- **Mixturen aus Untertönen:** Pro Manual vier Generatoren, die als
  Frequenzteiler (÷1 bis ÷24) phasenstarr am Hauptoszillator hängen. ÷2 klingt
  eine Oktave tiefer; ÷4, ÷5 und ÷6 zusammen ergeben einen Mollakkord.
- **Formantfilter:** Pro Manual vier parallele Resonanzfilter (Tiefpass oder
  Bandpass, 50 Hz bis 5 kHz) plus Direktsignal, mit Vokal-Voreinstellungen.
- **Schlagwerk:** Einschwingen, Ausklingen bei gehaltenem Draht, Ausschwingen.
- **Geräuschgenerator**, Druckkennlinie, druckabhängige Helligkeit, Vibrato,
  Gleiten, gemeinsamer Hall.

Die Engine nutzt weder libc noch Heap. Alle Zustände liegen in statischem
Speicher, die Mathematik (2^x, sin, tan) ist selbst approximiert. Das Modul
hat keine Imports und ist etwa 12 KB groß.

## Aufbau

```
dsp/trautonium.c        Klangerzeugung (C -> WebAssembly)
docs/                   die fertige Web-App, direkt auslieferbar
  index.html, style.css
  app.js                Zustand, Audio-Start, Bedienfeld
  manual.js             Draht-Manual: Touch, Zeichnen
  presets.js            Klangfarben, Mixturen, Notennamen
  ui.js                 kleine DOM-Helfer
  worklet.js            AudioWorklet und Rückfallebene
  trautonium.wasm       übersetzte Engine (eingecheckt)
tests/engine.test.mjs   Tests der Engine (Tonhöhe, Untertöne, Pegel, Stabilität)
tests/browser-smoke.cjs Rauchtest im echten Browser
```

Audiopfad: Der Hauptthread schickt gebündelte Aufrufe (`voice`, `set_mix`, …)
per `postMessage` an das AudioWorklet, das sie an die WebAssembly-Exporte
weitergibt. Fehlt AudioWorklet, läuft dieselbe Engine im Hauptthread über
`ScriptProcessorNode`.

## Bauen, testen, starten

Die übersetzte `docs/trautonium.wasm` ist eingecheckt. Zum Ausprobieren
genügt also ein beliebiger statischer Webserver. Neu übersetzen muss nur, wer
`dsp/trautonium.c` ändert.

```sh
make          # übersetzt dsp/trautonium.c mit clang nach docs/trautonium.wasm
make test     # führt die Engine-Tests mit dem in Node eingebauten Test-Runner aus
make smoke    # spielt die Seite in Chromium an (braucht Playwright)
make serve    # startet einen Webserver auf http://localhost:8000 für docs/
```

Voraussetzungen: `clang` und `wasm-ld` ab Version 15 (Pakete `clang` und
`lld`), Node.js ab 20 für die Tests, Python 3 für `make serve`.

Zum Testen auf dem Handy im selben WLAN: `make serve` und am Handy
`http://<IP-des-Rechners>:8000` öffnen. AudioWorklet braucht allerdings einen
sicheren Kontext (HTTPS oder `localhost`). Über eine einfache LAN-Adresse
greift deshalb die Rückfallebene, und der Ton reagiert etwas träger. Für den
echten Eindruck die Seite über HTTPS ausliefern, siehe unten.

## Veröffentlichen mit GitHub Pages

Der Ordner `docs/` ist so angelegt, dass GitHub Pages ihn ohne Build-Schritt
ausliefern kann: unter *Settings → Pages → Build and deployment* die Quelle
*Deploy from a branch*, den Branch und den Ordner `/docs` wählen. Danach ist
das Instrument unter `https://<nutzer>.github.io/<repo>/` erreichbar und lässt
sich auf dem Handy über „Zum Home-Bildschirm“ wie eine App im Vollbild starten.

## Browser

Getestet in Chromium (Desktop, mobile Ansicht im Hoch- und Querformat, mit und
ohne AudioWorklet). Ziel sind aktuelle Versionen von Safari auf iOS (ab 15),
Chrome und Firefox auf Android. Die Engine braucht WebAssembly mit
Bulk-Memory, das alle diese Browser seit 2021 unterstützen.

## Lizenzen

Die Schrift Jost liegt unter der SIL Open Font License bei
(`docs/fonts/OFL-Jost.txt`).
