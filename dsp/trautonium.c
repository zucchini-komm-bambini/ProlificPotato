/*
 * Trautonium – Klangerzeugung als freistehendes C für wasm32.
 *
 * Modell nach dem Mixtur-Trautonium von Oskar Sala:
 *   - zwei Manuale (Stimmen), jede mit einem Kippschwingungs-Oszillator
 *     (Glimmlampe/Kondensator: exponentiell gekrümmter Sägezahn),
 *   - je vier Generatoren, die als Frequenzteiler 1..24 am Hauptoszillator
 *     hängen (Untertöne, "Mixturen"),
 *   - Geräuschgenerator, "Schlagwerk" (Hüllkurve), Druck auf den Draht
 *     steuert Lautstärke und Helligkeit,
 *   - vier parallele Formantfilter (Tiefpass/Bandpass) pro Manual,
 *   - gemeinsamer Hall (Freeverb-Struktur) und Ausgangsstufe.
 *
 * Keine libc, kein Heap: alle Zustände liegen in statischem Speicher.
 * Übersetzen: siehe Makefile.
 */

#define EXPORT(name) __attribute__((export_name(#name)))

#define MAX_FRAMES 1024
#define MANUALS 2
#define GENS 4
#define FORMANTS 4
#define MAX_DIV 24
#define CTL_EVERY 16   /* Filterkoeffizienten werden alle 16 Samples nachgeführt */

typedef unsigned int u32;

/* ---------------------------------------------------------------- Mathe */

static inline float clampf(float x, float lo, float hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

/* 2^x, Taylor 6. Ordnung auf dem Nachkommaanteil: Fehler < 2e-5 (0,03 Cent). */
static float exp2f_(float x) {
  x = clampf(x, -126.f, 126.f);
  float fi = __builtin_floorf(x);
  float f = x - fi;
  float p = 1.0f + f * (0.693147181f + f * (0.240226507f + f * (0.0555041087f +
            f * (0.00961812911f + f * (0.00133335581f + f * 0.000154035304f)))));
  union { float f; int i; } u;
  u.i = ((int)fi + 127) << 23;
  return p * u.f;
}

/* log2(x) für x > 0, Fehler < 1e-4 – nur für Parameter, nicht pro Sample. */
static float log2f_(float x) {
  if (x <= 0.f) return -126.f;
  union { float f; u32 i; } u = { x };
  float e = (float)((int)((u.i >> 23) & 255) - 127);
  u.i = (u.i & 0x007FFFFFu) | 0x3F800000u; /* Mantisse in [1,2) */
  float m = u.f;
  /* log2(m) über atanh-Reihe: t=(m-1)/(m+1), log2(m)=2/ln2*(t+t^3/3+t^5/5+t^7/7) */
  float t = (m - 1.f) / (m + 1.f), t2 = t * t;
  float s = t * (1.f + t2 * (0.333333333f + t2 * (0.2f + t2 * (0.142857143f + t2 * 0.111111111f))));
  return e + 2.885390082f * s;
}

static inline float powf_(float x, float y) { return x <= 0.f ? 0.f : exp2f_(y * log2f_(x)); }

/* e^(-1/(t*sr)) als Ein-Pol-Koeffizient für Zeitkonstante t Sekunden. */
static float tau_coef(float t, float sr) {
  if (t <= 0.f) return 0.f;
  return exp2f_(-1.442695041f / (t * sr));
}

/* sin(x) für x in [-pi/2, pi/2], Taylor bis x^11. */
static inline float sin_poly(float x) {
  float x2 = x * x;
  return x * (1.f + x2 * (-0.166666667f + x2 * (0.00833333333f + x2 * (-0.000198412698f +
         x2 * (2.75573192e-6f + x2 * -2.50521084e-8f)))));
}

static inline float cos_poly(float x) {
  float x2 = x * x;
  return 1.f + x2 * (-0.5f + x2 * (0.0416666667f + x2 * (-0.00138888889f +
         x2 * (2.48015873e-5f + x2 * (-2.75573192e-7f + x2 * 2.08767570e-9f)))));
}

/* sin(2*pi*ph) für beliebiges ph. */
static float sin_turns(float ph) {
  ph -= __builtin_floorf(ph);         /* [0,1) */
  float x = ph - 0.5f;                /* sin(2pi ph) = -sin(2pi x) */
  if (x > 0.25f) x = 0.5f - x;
  else if (x < -0.25f) x = -0.5f - x;
  return -sin_poly(6.283185307f * x);
}

/* tan(x) für x in [0, ~1.45]: Vorverzerrung der Filter. */
static inline float tan_(float x) { return sin_poly(x) / cos_poly(x); }

/* Weiche Sättigung, rationale tanh-Näherung. */
static inline float softclip(float x) {
  x = clampf(x, -3.f, 3.f);
  float x2 = x * x;
  return x * (27.f + x2) / (27.f + 9.f * x2);
}

/* Spült Kleinstwerte weg, damit Rückkopplungen nicht in Denormals laufen. */
static inline float undenormal(float x) {
  x += 1e-18f;
  return x - 1e-18f;
}

/* ----------------------------------------------------- Zustandsvariablen-Filter */

/* Topologie-erhaltendes SVF (Zavalishin/Simper): stabil unter Modulation. */
typedef struct {
  float ic1, ic2;
} Svf;

typedef struct {
  float g, k, a1, a2, a3;
} SvfCoef;

static inline void svf_coef(SvfCoef *c, float g, float k) {
  c->g = g;
  c->k = k;
  c->a1 = 1.f / (1.f + g * (g + k));
  c->a2 = g * c->a1;
  c->a3 = g * c->a2;
}

/* Liefert Tiefpass in *lp, Bandpass (Spitzenpegel 1) in *bp. */
static inline void svf_tick(Svf *s, const SvfCoef *c, float v0, float *lp, float *bp) {
  float v3 = v0 - s->ic2;
  float v1 = c->a1 * s->ic1 + c->a2 * v3;
  float v2 = s->ic2 + c->a2 * s->ic1 + c->a3 * v3;
  s->ic1 = undenormal(2.f * v1 - s->ic1);
  s->ic2 = undenormal(2.f * v2 - s->ic2);
  *lp = v2;
  *bp = c->k * v1;
}

/* ------------------------------------------------------------- Zustand */

enum { ENV_IDLE, ENV_ATTACK, ENV_DECAY, ENV_RELEASE };
enum { F_OFF = 0, F_LOWPASS = 1, F_BANDPASS = 2 };

typedef struct {
  /* Ziele (vom UI gesetzt) */
  float f_tgt, q_tgt, gain_tgt;
  int mode;
  /* geglättete Werte */
  float f, q, lp_gain, bp_gain;
  SvfCoef c;
  Svf s;
} Formant;

typedef struct {
  /* Spielzustand */
  int gate;
  float note_tgt, note;
  float amp_tgt, amp;         /* Druck nach Kennlinie */
  float bright_tgt, bright;   /* Druck -> Helligkeit, 0..1 */
  float press_raw;

  /* Oszillator */
  float phase;
  int div[GENS];
  int count[GENS];
  float lvl_tgt[GENS], lvl[GENS];
  float kipp_k, kipp_norm;    /* Krümmung der Kippschwingung */

  /* Hüllkurve ("Schlagwerk") */
  int env_stage;
  float env;
  float att_inc, dec_mul, rel_mul;

  /* Klangparameter */
  float noise_tgt, noise;
  float press_curve, press_bright;
  float vib_rate, vib_depth, vib_phase;
  float glide_coef;
  float direct_tgt, direct;
  float level_tgt, level;     /* Ausgangspegel des Manuals */

  Svf tone;                   /* druckabhängiger Tiefpass */
  SvfCoef tone_c;
  Formant fmt[FORMANTS];
} Voice;

/* Hall: 8 Kammfilter + 4 Allpässe je Kanal (Freeverb-Abstimmung). */
#define COMBS 8
#define ALLPASSES 4
#define REV_MAX_SR 96000.f
static const int comb_tune[COMBS] = { 1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617 };
static const int ap_tune[ALLPASSES] = { 556, 441, 341, 225 };
#define STEREO_SPREAD 23
#define COMB_CAP 3600   /* (1617+23) * 96000/44100 ≈ 3570 */
#define AP_CAP 1300     /* (556+23)  * 96000/44100 ≈ 1260 */

typedef struct {
  float buf[COMB_CAP];
  int len, idx;
  float store;
} Comb;

typedef struct {
  float buf[AP_CAP];
  int len, idx;
} Allpass;

static struct {
  Comb comb[2][COMBS];
  Allpass ap[2][ALLPASSES];
  float feedback, damp;
  float mix_tgt, mix;
} rev;

static float sr = 48000.f;
static float smooth_coef;      /* ~10 ms Parameterglättung pro Sample */
static float ctl_coef;         /* dieselbe Zeitkonstante bei Steuerrate */
static int ctl_count;
static float a4 = 440.f;
static float master_tgt = 0.8f, master = 0.8f;
static float dc_x1, dc_y1;
static u32 rng = 0x9E3779B9u;

static Voice voices[MANUALS];
static float out_l[MAX_FRAMES], out_r[MAX_FRAMES];

static inline float white(void) {
  rng ^= rng << 13;
  rng ^= rng >> 17;
  rng ^= rng << 5;
  return (float)(int)rng * (1.f / 2147483648.f);
}

/* --------------------------------------------------------- Hilfsfunktionen */

static void kipp_set(Voice *v, float shape) {
  /* shape 0..1 -> Krümmung k 0..5; k=0 ist der gerade Sägezahn. */
  float k = clampf(shape, 0.f, 1.f) * 5.f;
  v->kipp_k = k;
  v->kipp_norm = k < 1e-3f ? 1.f : 1.f / (1.f - exp2f_(-1.442695041f * k));
}

/* Kippschwingung für Phase p in [0,1): Kondensator lädt exponentiell,
 * Glimmlampe zündet und entlädt schlagartig. Ergebnis in [-1,1]. */
static inline float kipp_wave(const Voice *v, float p) {
  float s = v->kipp_k < 1e-3f ? p : (1.f - exp2f_(-1.442695041f * v->kipp_k * p)) * v->kipp_norm;
  return 2.f * s - 1.f;
}

/* PolyBLEP-Korrektur für den Rücksprung um -2 bei p = 0. */
static inline float polyblep(float p, float dt) {
  if (p < dt) {
    p /= dt;
    return p + p - p * p - 1.f;
  }
  if (p > 1.f - dt) {
    p = (p - 1.f) / dt;
    return p * p + p + p + 1.f;
  }
  return 0.f;
}

static void formant_update(Formant *f, float c) {
  f->f += (f->f_tgt - f->f) * c;
  f->q += (f->q_tgt - f->q) * c;
  float lp = f->mode == F_LOWPASS ? f->gain_tgt : 0.f;
  float bp = f->mode == F_BANDPASS ? f->gain_tgt : 0.f;
  f->lp_gain += (lp - f->lp_gain) * c;
  f->bp_gain += (bp - f->bp_gain) * c;
  float w = 3.141592654f * clampf(f->f, 20.f, 0.45f * sr) / sr;
  svf_coef(&f->c, tan_(w), 1.f / clampf(f->q, 0.3f, 40.f));
}

static void reverb_init(void) {
  float scale = sr / 44100.f;
  for (int ch = 0; ch < 2; ch++) {
    int spread = ch ? STEREO_SPREAD : 0;
    for (int i = 0; i < COMBS; i++) {
      Comb *c = &rev.comb[ch][i];
      c->len = (int)((comb_tune[i] + spread) * scale);
      if (c->len > COMB_CAP) c->len = COMB_CAP;
      if (c->len < 1) c->len = 1;
      c->idx = 0;
      c->store = 0.f;
      for (int j = 0; j < COMB_CAP; j++) c->buf[j] = 0.f;
    }
    for (int i = 0; i < ALLPASSES; i++) {
      Allpass *a = &rev.ap[ch][i];
      a->len = (int)((ap_tune[i] + spread) * scale);
      if (a->len > AP_CAP) a->len = AP_CAP;
      if (a->len < 1) a->len = 1;
      a->idx = 0;
      for (int j = 0; j < AP_CAP; j++) a->buf[j] = 0.f;
    }
  }
}

static inline float reverb_channel(int ch, float in) {
  float acc = 0.f;
  float damp1 = rev.damp, damp2 = 1.f - rev.damp;
  for (int i = 0; i < COMBS; i++) {
    Comb *c = &rev.comb[ch][i];
    float y = c->buf[c->idx];
    c->store = undenormal(y * damp2 + c->store * damp1);
    c->buf[c->idx] = in + c->store * rev.feedback;
    if (++c->idx >= c->len) c->idx = 0;
    acc += y;
  }
  for (int i = 0; i < ALLPASSES; i++) {
    Allpass *a = &rev.ap[ch][i];
    float b = a->buf[a->idx];
    a->buf[a->idx] = undenormal(acc + b * 0.5f);
    if (++a->idx >= a->len) a->idx = 0;
    acc = b - acc;
  }
  return acc;
}

/* --------------------------------------------------------------- Export */

EXPORT(out_left) float *out_left(void) { return out_l; }
EXPORT(out_right) float *out_right(void) { return out_r; }
EXPORT(max_frames) int max_frames(void) { return MAX_FRAMES; }

EXPORT(set_env)
void set_env(int m, float attack, float decay, float release) {
  if (m < 0 || m >= MANUALS) return;
  Voice *v = &voices[m];
  v->att_inc = 1.f / (clampf(attack, 0.0005f, 5.f) * sr);
  v->dec_mul = decay <= 0.f ? 1.f : tau_coef(clampf(decay, 0.01f, 30.f), sr); /* <=0: Halten */
  v->rel_mul = tau_coef(clampf(release, 0.003f, 10.f), sr);
}

EXPORT(set_mix)
void set_mix(int m, int k, int divisor, float level) {
  if (m < 0 || m >= MANUALS || k < 0 || k >= GENS) return;
  Voice *v = &voices[m];
  if (divisor < 1) divisor = 1;
  if (divisor > MAX_DIV) divisor = MAX_DIV;
  if (v->div[k] != divisor) {
    v->div[k] = divisor;
    v->count[k] %= divisor;
  }
  v->lvl_tgt[k] = clampf(level, 0.f, 1.f);
}

EXPORT(set_kipp)
void set_kipp(int m, float shape) {
  if (m < 0 || m >= MANUALS) return;
  kipp_set(&voices[m], shape);
}

EXPORT(set_formant)
void set_formant(int m, int i, int mode, float freq, float q, float gain) {
  if (m < 0 || m >= MANUALS || i < 0 || i >= FORMANTS) return;
  Formant *f = &voices[m].fmt[i];
  f->mode = (mode == F_LOWPASS || mode == F_BANDPASS) ? mode : F_OFF;
  f->f_tgt = clampf(freq, 30.f, 8000.f);
  f->q_tgt = clampf(q, 0.3f, 40.f);
  f->gain_tgt = clampf(gain, 0.f, 4.f);
}

EXPORT(set_direct)
void set_direct(int m, float level) {
  if (m < 0 || m >= MANUALS) return;
  voices[m].direct_tgt = clampf(level, 0.f, 2.f);
}

EXPORT(set_level)
void set_level(int m, float gain) {
  if (m < 0 || m >= MANUALS) return;
  voices[m].level_tgt = clampf(gain, 0.f, 4.f);
}

EXPORT(set_noise)
void set_noise(int m, float level) {
  if (m < 0 || m >= MANUALS) return;
  voices[m].noise_tgt = clampf(level, 0.f, 1.f);
}

EXPORT(set_pressure)
void set_pressure(int m, float curve, float bright) {
  if (m < 0 || m >= MANUALS) return;
  voices[m].press_curve = clampf(curve, 0.25f, 4.f);
  voices[m].press_bright = clampf(bright, 0.f, 1.f);
}

EXPORT(set_vibrato)
void set_vibrato(int m, float rate, float depth_cents) {
  if (m < 0 || m >= MANUALS) return;
  voices[m].vib_rate = clampf(rate, 0.f, 15.f);
  voices[m].vib_depth = clampf(depth_cents, 0.f, 200.f) * 0.01f; /* in Halbtönen */
}

EXPORT(set_glide)
void set_glide(int m, float seconds) {
  if (m < 0 || m >= MANUALS) return;
  voices[m].glide_coef = 1.f - tau_coef(clampf(seconds, 0.002f, 3.f), sr);
}

EXPORT(set_reverb)
void set_reverb(float mix, float size, float damping) {
  rev.mix_tgt = clampf(mix, 0.f, 1.f);
  rev.feedback = 0.70f + 0.28f * clampf(size, 0.f, 1.f);
  rev.damp = 0.05f + 0.6f * clampf(damping, 0.f, 1.f);
}

EXPORT(set_master)
void set_master(float gain) { master_tgt = clampf(gain, 0.f, 2.f); }

EXPORT(set_tuning)
void set_tuning(float hz) { a4 = clampf(hz, 400.f, 480.f); }

/* Draht berührt (gate=1) oder losgelassen (gate=0).
 * note: MIDI-Notennummer als Gleitkommazahl, pressure: 0..1. */
EXPORT(voice)
void voice(int m, int gate, float note, float pressure) {
  if (m < 0 || m >= MANUALS) return;
  Voice *v = &voices[m];
  note = clampf(note, 0.f, 127.f);
  pressure = clampf(pressure, 0.f, 1.f);
  if (gate) {
    if (!v->gate) {
      /* Neuer Anschlag: Tonhöhe springt, Hüllkurve startet vom aktuellen Pegel. */
      if (v->env < 0.001f) {
        v->note = note;
        v->vib_phase = 0.f;
        v->amp = 0.f;
      }
      v->env_stage = ENV_ATTACK;
    }
    v->gate = 1;
    v->note_tgt = note;
    v->press_raw = pressure;
    v->amp_tgt = powf_(pressure, v->press_curve);
    v->bright_tgt = 1.f - v->press_bright * (1.f - pressure);
  } else {
    v->gate = 0;
    if (v->env_stage != ENV_IDLE) v->env_stage = ENV_RELEASE;
  }
}

/* Neuer Anschlag, obwohl der Draht schon gedrückt ist (zweiter Finger). */
EXPORT(retrigger)
void retrigger(int m) {
  if (m < 0 || m >= MANUALS) return;
  if (voices[m].gate) voices[m].env_stage = ENV_ATTACK;
}

EXPORT(init)
void init(float sample_rate) {
  sr = clampf(sample_rate, 8000.f, 192000.f);
  smooth_coef = 1.f - tau_coef(0.010f, sr);
  ctl_coef = 1.f - tau_coef(0.010f, sr / CTL_EVERY);
  ctl_count = 0;
  for (int m = 0; m < MANUALS; m++) {
    Voice *v = &voices[m];
    Voice zero = {0};
    *v = zero;
    v->note = v->note_tgt = 60.f;
    for (int k = 0; k < GENS; k++) {
      v->div[k] = k + 1;
      v->lvl_tgt[k] = v->lvl[k] = k == 0 ? 1.f : 0.f;
    }
    kipp_set(v, 0.5f);
    v->press_curve = 1.5f;
    v->press_bright = 0.5f;
    v->direct_tgt = v->direct = 1.f;
    v->level_tgt = v->level = 1.f;
    v->bright = v->bright_tgt = 1.f;
    svf_coef(&v->tone_c, tan_(3.141592654f * 0.45f), 1.41421356f);
    for (int i = 0; i < FORMANTS; i++) {
      Formant *f = &v->fmt[i];
      f->f = f->f_tgt = 500.f * (i + 1);
      f->q = f->q_tgt = 2.f;
      f->mode = F_OFF;
      formant_update(f, 1.f);
    }
    set_env(m, 0.01f, 0.f, 0.15f);
    set_glide(m, 0.004f);
  }
  rev.mix = rev.mix_tgt = 0.2f;
  set_reverb(0.2f, 0.6f, 0.4f);
  reverb_init();
  master = master_tgt;
  dc_x1 = dc_y1 = 0.f;
}

/* Berechnet n Stereo-Samples in out_left()/out_right(). */
EXPORT(render)
void render(int n) {
  if (n > MAX_FRAMES) n = MAX_FRAMES;
  const float c = smooth_coef;
  const float inv_sr = 1.f / sr;

  for (int i = 0; i < n; i++) {
    float mono = 0.f;
    int ctl = ctl_count == 0;
    if (++ctl_count >= CTL_EVERY) ctl_count = 0;

    for (int m = 0; m < MANUALS; m++) {
      Voice *v = &voices[m];
      if (v->env_stage == ENV_IDLE) continue;

      /* Hüllkurve */
      switch (v->env_stage) {
        case ENV_ATTACK:
          v->env += v->att_inc;
          if (v->env >= 1.f) { v->env = 1.f; v->env_stage = ENV_DECAY; }
          break;
        case ENV_DECAY:
          v->env *= v->dec_mul;
          break;
        case ENV_RELEASE:
          v->env *= v->rel_mul;
          if (v->env < 1e-5f) { v->env = 0.f; v->env_stage = ENV_IDLE; }
          break;
      }

      /* Glättung der Spielgrößen */
      v->note += (v->note_tgt - v->note) * v->glide_coef;
      v->amp += (v->amp_tgt - v->amp) * c;
      v->bright += (v->bright_tgt - v->bright) * c;
      v->noise += (v->noise_tgt - v->noise) * c;
      v->direct += (v->direct_tgt - v->direct) * c;
      v->level += (v->level_tgt - v->level) * c;

      float note = v->note;
      if (v->vib_depth > 0.f) {
        v->vib_phase += v->vib_rate * inv_sr;
        if (v->vib_phase >= 1.f) v->vib_phase -= 1.f;
        note += v->vib_depth * sin_turns(v->vib_phase);
      }
      float freq = a4 * exp2f_((note - 69.f) * (1.f / 12.f));
      float dt = clampf(freq * inv_sr, 0.f, 0.45f);

      /* Hauptoszillator: Phase und Teilerzähler */
      v->phase += dt;
      if (v->phase >= 1.f) {
        v->phase -= 1.f;
        for (int k = 0; k < GENS; k++)
          if (++v->count[k] >= v->div[k]) v->count[k] = 0;
      }

      float osc = 0.f;
      for (int k = 0; k < GENS; k++) {
        v->lvl[k] += (v->lvl_tgt[k] - v->lvl[k]) * c;
        if (v->lvl[k] < 1e-4f) continue;
        float inv = 1.f / (float)v->div[k];
        float p = ((float)v->count[k] + v->phase) * inv;
        float s = kipp_wave(v, p) - polyblep(p, dt * inv);
        osc += v->lvl[k] * s;
      }
      osc *= 0.5f;
      osc += v->noise * white();

      /* Druckabhängige Helligkeit: 150 Hz .. 19 kHz */
      if (ctl) {
        float cutoff = clampf(150.f * exp2f_(7.f * v->bright), 20.f, 0.45f * sr);
        svf_coef(&v->tone_c, tan_(3.141592654f * cutoff * inv_sr), 1.41421356f);
      }
      float toned, unused;
      svf_tick(&v->tone, &v->tone_c, osc, &toned, &unused);

      float x = toned * v->env * v->amp;

      /* Formantfilter parallel + Direktsignal */
      float y = v->direct * x;
      for (int f = 0; f < FORMANTS; f++) {
        Formant *fm = &v->fmt[f];
        if (ctl) formant_update(fm, ctl_coef);
        if (fm->lp_gain < 1e-4f && fm->bp_gain < 1e-4f) continue;
        float lp, bp;
        svf_tick(&fm->s, &fm->c, x, &lp, &bp);
        y += fm->lp_gain * lp + fm->bp_gain * bp;
      }
      mono += y * v->level;
    }

    /* Gleichspannung entfernen */
    float dc = mono - dc_x1 + 0.995f * dc_y1;
    dc_x1 = mono;
    dc_y1 = undenormal(dc);
    mono = dc;

    rev.mix += (rev.mix_tgt - rev.mix) * c;
    master += (master_tgt - master) * c;

    float wet_in = mono * 0.015f;
    float wl = reverb_channel(0, wet_in);
    float wr = reverb_channel(1, wet_in);
    float dry = 1.f - 0.5f * rev.mix;
    float wet = rev.mix * 3.f;

    out_l[i] = softclip((mono * dry + wl * wet) * master);
    out_r[i] = softclip((mono * dry + wr * wet) * master);
  }
}
