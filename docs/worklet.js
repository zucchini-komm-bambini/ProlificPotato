// Brücke zwischen Web Audio und der WebAssembly-Klangerzeugung.
//
// Dieselbe Datei dient zwei Zwecken:
//  - als AudioWorklet-Modul (registriert den Prozessor "trautonium"),
//  - als normales ES-Modul im Hauptthread, falls AudioWorklet fehlt
//    (Rückfall auf ScriptProcessorNode, siehe app.js).

// Nur diese Exporte dürfen per Nachricht aufgerufen werden.
const CALLABLE = new Set([
  'voice', 'retrigger', 'set_env', 'set_mix', 'set_kipp', 'set_formant',
  'set_direct', 'set_level', 'set_noise', 'set_pressure', 'set_vibrato', 'set_glide',
  'set_reverb', 'set_master', 'set_tuning',
]);

export class Engine {
  static async create(bytes, sampleRate) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Engine(instance.exports, sampleRate);
  }

  constructor(exports, sampleRate) {
    this.x = exports;
    this.x.init(sampleRate);
    this.maxFrames = this.x.max_frames();
    const buf = this.x.memory.buffer; // Speicher wächst nie, die Sichten bleiben gültig
    this.left = new Float32Array(buf, this.x.out_left(), this.maxFrames);
    this.right = new Float32Array(buf, this.x.out_right(), this.maxFrames);
  }

  call(name, args) {
    if (CALLABLE.has(name)) this.x[name](...args);
  }

  // Füllt zwei Float32Arrays beliebiger Länge.
  process(outL, outR) {
    for (let pos = 0; pos < outL.length; pos += this.maxFrames) {
      const n = Math.min(this.maxFrames, outL.length - pos);
      this.x.render(n);
      outL.set(this.left.subarray(0, n), pos);
      if (outR) outR.set(this.right.subarray(0, n), pos);
    }
  }
}

if (typeof registerProcessor === 'function') {
  class TrautoniumProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.engine = null;
      this.queue = [];
      // Jede Nachricht ist eine Liste von Aufrufen: [[name, args], ...]
      this.port.onmessage = (ev) => {
        if (this.engine) for (const [name, args] of ev.data) this.engine.call(name, args);
        else this.queue.push(...ev.data);
      };
      Engine.create(options.processorOptions.wasm, sampleRate).then(
        (engine) => {
          for (const [name, args] of this.queue) engine.call(name, args);
          this.queue = null;
          this.engine = engine;
          this.port.postMessage({ ready: true });
        },
        (err) => this.port.postMessage({ error: String(err && err.message || err) }),
      );
    }

    process(_inputs, outputs) {
      const out = outputs[0];
      if (this.engine && out && out[0]) this.engine.process(out[0], out[1]);
      return true;
    }
  }
  registerProcessor('trautonium', TrautoniumProcessor);
}
