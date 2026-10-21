// Detect mode, second pass: which snare and kick hits are really toms, which
// tom each one is, and which cymbal hits have no cymbal in the audio.
//
// The NMF in transcribe.js has no tom template. A tom whose body sits around
// 100-250 Hz lands in the snare activation, a floor tom (~75 Hz) in the kick.
// Each hit is described at its attack by:
//   pitch  the strongest partial 55-420 Hz it adds, 25 to 185 ms after the attack
//   buzz   snare wires: 3-9 kHz energy added at the attack against 80-400 Hz
//          (about -9 dB on a snare, -20 to -28 dB on a tom)
//   ring   how fast 80-400 Hz dies away, in dB per 100 ms (about -18 on a
//          snare, -3 to -10 on a tom)
//   click  beater click: 2-6 kHz added at the attack against 30-200 Hz
// A snare with its wires off rings like a tom but keeps the snare's pitch, so
// a tom-like hit at the pitch of the song's wired snares stays a snare.
//
// The snare template also peaks late (or early) on a ringing tom, so toms are
// re-timed to the nearest attack in the 55-420 Hz band.
//
// Cymbal hits with no attack above 6 kHz are dropped: the cymbal template also
// fires on crash wash and snare tails.
import { RealFFT } from '../dsp/fft.js';

// buzzMax: a hit with more wire buzz than this (dB) is a snare.
// ringMin: a tom loses less than this (dB) per 100 ms.
// buzzNoRing: when the next hit comes too soon to measure the ring, a tom
//   needs less buzz than this.
// snareWiresMin: snares with at least this much buzz set the song's snare pitch.
// samePitchOct: a tom-like hit this close to it (about a semitone) is the snare
//   with its wires off.
export const TOM_RULES = { buzzMax: -15, ringMin: -13, buzzNoRing: -22, snareWiresMin: -12, samePitchOct: 0.085 };

// Per-frame band energies from the mel spectrogram, a low-rate copy of the
// audio for pitch, and a fine envelope above 6 kHz for cymbal attacks. Plain
// typed arrays, so it can leave a Web Worker.
export function drumFeatures(samples, sr, spec) {
  const { V, bands: B, frames: N, fps, centres } = spec;
  const inRange = (lo, hi) => [...centres.keys()].filter((b) => centres[b] >= lo && centres[b] < hi);
  const band = (bands) => {
    const e = new Float32Array(N);
    for (const b of bands) {
      const row = b * N;
      for (let t = 0; t < N; t++) e[t] += V[row + t] * V[row + t];
    }
    return e;
  };
  const range = (lo, hi) => band(inRange(lo, hi));
  const bodyBands = inRange(55, 420).map((b) => band([b]));
  const { data, rate } = decimate(samples, sr);
  const fine = highEnvelope(samples, sr);
  return {
    fps,
    bodyBands, // each mel band 55-420 Hz: drum bodies (kick top, snare, toms)
    low: range(80, 400), // snare and tom body
    kick: range(30, 200), // kick and floor tom
    click: range(2000, 6000), // beater click
    buzz: range(3000, 9000), // snare wires
    lowAudio: data,
    lowRate: rate,
    highFine: fine.data, // energy above 6 kHz in 5.8 ms blocks: cymbal attacks
    highRate: fine.rate,
  };
}

// Energy above 6 kHz in short blocks. A closed hi-hat is over in ~20 ms, so a
// 46 ms mel frame smears it into any crash still ringing; short blocks don't.
function highEnvelope(x, sr, { cutoff = 6000, block = 128 } = {}) {
  const fc = Math.min(cutoff, 0.45 * sr);
  // 4th-order Butterworth high-pass: two biquads.
  const sections = [0.5412, 1.3066].map((q) => {
    const w = (2 * Math.PI * fc) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const cw = Math.cos(w);
    const a0 = 1 + alpha;
    return { b0: (1 + cw) / 2 / a0, b1: -(1 + cw) / a0, b2: (1 + cw) / 2 / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
  });
  const n = Math.floor(x.length / block);
  const out = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    let e = 0;
    for (let i = j * block; i < (j + 1) * block; i++) {
      let v = x[i];
      for (const s of sections) {
        const y = s.b0 * v + s.b1 * s.x1 + s.b2 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2;
        s.x2 = s.x1; s.x1 = v; s.y2 = s.y1; s.y1 = y;
        v = y;
      }
      e += v * v;
    }
    out[j] = e;
  }
  return { data: out, rate: sr / block };
}

// Low-pass (Blackman-windowed sinc) and keep every Nth sample, down to about
// 1.4 kHz: plenty for drum body pitch, and cheap to search.
function decimate(x, sr, targetRate = 1400) {
  const factor = Math.max(1, Math.floor(sr / targetRate));
  const rate = sr / factor;
  if (factor === 1) return { data: Float32Array.from(x), rate };
  const m = Math.round(7.5 * factor); // half length; taps is odd
  const taps = 2 * m + 1;
  const fc = 0.5 / factor;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - m;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  const n = Math.floor(x.length / factor);
  const out = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const c = j * factor - m;
    const i0 = Math.max(0, -c);
    const i1 = Math.min(taps - 1, x.length - 1 - c);
    let acc = 0;
    for (let i = i0; i <= i1; i++) acc += h[i] * x[c + i];
    out[j] = acc / sum;
  }
  return { data: out, rate };
}

const PITCH_FFT = 2048;
let pitchFft = null;

// Strongest partial between lo and hi Hz that the hit at `time` (seconds)
// adds: the spectrum of a 160 ms window from 25 ms after the hit (leaving out
// the stick attack), less half the spectrum of a window just before it. A tom
// still ringing from the last hit has lost about that much by then, so it
// doesn't count, while a second hit on the same tom still does. The window
// stops 10 ms before `end` (the next hit), but is never shorter than 50 ms.
export function bodyPitch(features, time, { lo = 55, hi = 420, end = Infinity } = {}) {
  const { lowAudio: x, lowRate: rate } = features;
  const len = Math.max(0.05, Math.min(0.16, end - 0.01 - (time + 0.025)));
  const n = Math.round(len * rate);
  const after = spectrum(x, Math.round((time + 0.025) * rate), n);
  const before = spectrum(x, Math.round((time - 0.005) * rate) - n, n);
  const k0 = Math.ceil((lo * PITCH_FFT) / rate);
  const k1 = Math.min(PITCH_FFT / 2, Math.floor((hi * PITCH_FFT) / rate));
  const added = new Float64Array(after.length);
  for (let k = k0 - 1; k <= k1 + 1; k++) added[k] = Math.max(0, after[k] - 0.5 * before[k]);
  let best = k0;
  for (let k = k0; k <= k1; k++) if (added[k] > added[best]) best = k;
  if (!(added[best] > 0)) return NaN;
  let d = 0;
  if (best > k0 && best < k1 && added[best - 1] > 0 && added[best + 1] > 0) {
    const a = Math.log(added[best - 1]);
    const b = Math.log(added[best]);
    const c = Math.log(added[best + 1]);
    const den = a - 2 * b + c;
    if (den < 0) d = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
  }
  return ((best + d) * rate) / PITCH_FFT;
}

// Magnitude spectrum of n samples from `start`, Hann-windowed, zero-padded.
function spectrum(x, start, n) {
  if (!pitchFft) pitchFft = new RealFFT(PITCH_FFT);
  const buf = new Float64Array(PITCH_FFT);
  for (let i = 0; i < n; i++) {
    const s = start + i;
    if (s >= 0 && s < x.length) buf[i] = x[s] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n));
  }
  return pitchFft.magnitude(buf, new Float64Array(PITCH_FFT / 2 + 1));
}

const ratioDb = (a, b) => {
  if (!(b > 0)) return a > 0 ? 60 : 0;
  if (!(a > 0)) return -60;
  return Math.max(-60, Math.min(60, 10 * Math.log10(a / b)));
};

// The energy a band gains at an attack: its peak over the next ~25 ms against
// its level 35-50 ms before (mel frames are 46 ms long, centred).
function rising(e, frame) {
  let peak = 0;
  let at = frame;
  for (let t = Math.max(0, frame); t <= frame + 2 && t < e.length; t++) if (e[t] > peak) { peak = e[t]; at = t; }
  let pre = Infinity;
  for (let t = frame - 4; t <= frame - 3; t++) pre = Math.min(pre, t >= 0 && t < e.length ? e[t] : 0);
  return { peak, at, pre, added: Math.max(0, peak - pre) };
}

// dB lost over 100 ms from the peak. Stops short of the next hit and scales
// up; NaN when the next hit is under 40 ms away. `base` is taken off both
// ends first (what was already sounding before the hit).
function ringDb(e, at, nextFrame, fps, base = 0) {
  const full = Math.round(0.1 * fps);
  const span = Math.min(full, nextFrame - 2 - at, e.length - 1 - at);
  if (span < Math.round(0.04 * fps)) return NaN;
  return (ratioDb(e[at + span] - base, e[at] - base) * full) / span;
}

// Everything the classifier looks at for one attack (a mel frame index).
// nextFrame: the next kick, snare or body attack, which ends the ring window.
export function describeAttack(features, frame, nextFrame = Infinity) {
  const f = features;
  const low = rising(f.low, frame);
  const kick = rising(f.kick, frame);
  return {
    frame,
    time: frame / f.fps,
    pitch: bodyPitch(f, frame / f.fps, { end: nextFrame / f.fps }),
    buzz: ratioDb(rising(f.buzz, frame).added, low.added),
    ring: ringDb(f.low, low.at, nextFrame, f.fps),
    // Over what was already ringing, so a kick under a floor tom's tail
    // doesn't pass for a floor tom.
    kickRing: ringDb(f.kick, kick.at, nextFrame, f.fps, kick.pre),
    click: ratioDb(rising(f.click, frame).added, kick.added),
  };
}

// No snare wires, and either a long ring or (when the next hit comes too soon
// to measure the ring) no wires at all.
export function isTomLike(d, rules = TOM_RULES) {
  if (!(d.buzz < rules.buzzMax)) return false;
  if (Number.isNaN(d.ring)) return d.buzz < rules.buzzNoRing;
  return d.ring > rules.ringMin;
}

const octaves = (a, b) => Math.abs(Math.log2(a / b));
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};

// Attacks in the 55-420 Hz mel bands: some band that carries the sound (within
// 10 dB of the loudest) gains at least 6 dB over ~35 ms, and the whole range
// at least 2 dB. Per band, so a new tom shows up over the ring of the one
// before at another pitch. Kept when no more than 14-26 dB (by sensitivity)
// below a typical strong hit, and at least 60 ms after the last one. Returns
// { time, frame, strength }: frame is the nearest mel frame.
export function bodyOnsets(features, sensitivity = 0.5) {
  const bands = features.bodyBands;
  const n = bands[0]?.length ?? 0;
  let top = 0;
  for (const e of bands) for (const v of e) if (v > top) top = v;
  if (!(top > 0)) return [];
  const Lb = bands.map((e) => Float32Array.from(e, (v) => 10 * Math.log10(v / top + 1e-9)));
  const total = new Float32Array(n);
  for (const e of bands) for (let t = 0; t < n; t++) total[t] += e[t];
  const L = Float32Array.from(total, (v) => 10 * Math.log10(v / top + 1e-9));
  const rise = new Float32Array(n);
  const by = new Int8Array(n); // the band that rose most
  for (let t = 3; t < n; t++) {
    let loudest = -Infinity;
    for (const l of Lb) loudest = Math.max(loudest, l[t]);
    Lb.forEach((l, b) => {
      if (l[t] < loudest - 10) return;
      const r = l[t] - Math.min(l[t - 1], l[t - 2], l[t - 3]);
      if (r > rise[t]) { rise[t] = r; by[t] = b; }
    });
  }
  const cands = [];
  for (let t = 4; t < n - 3; t++) {
    const d = rise[t];
    if (d < 6 || d < rise[t - 1] || d < rise[t + 1]) continue;
    // The whole band must gain too: a tom's pitch drop just moves energy
    // from one band to the next.
    if (Math.max(L[t], L[t + 1]) - Math.min(L[t - 1], L[t - 2], L[t - 3]) < 2) continue;
    // Time it where that band has gained half its new energy: a 46 ms frame
    // centred on the hit holds half of it. (The biggest jump in dB comes a
    // frame or two early; the steepest jump in energy wobbles when two toms
    // beat against each other.)
    const e = bands[by[t]];
    const pre = Math.min(e[t - 1], e[t - 2], e[t - 3]);
    let peak = 0;
    for (let j = t; j <= t + 3 && j < n; j++) peak = Math.max(peak, e[j]);
    const half = pre + 0.5 * (peak - pre);
    let at = t;
    for (let j = t - 2; j <= t + 3 && j < n; j++) {
      if (e[j] < half) continue;
      at = e[j - 1] < half ? j - 1 + (half - e[j - 1]) / (e[j] - e[j - 1]) : j;
      break;
    }
    cands.push({ at, level: Math.max(L[t], L[t + 1], L[t + 2]) });
  }
  if (!cands.length) return [];
  const levels = cands.map((c) => c.level).sort((a, b) => a - b);
  const loud = levels.filter((v) => v >= levels[levels.length - 1] - 12);
  const ref = loud[loud.length >> 1];
  const gate = ref - (14 + 12 * sensitivity);
  const minGap = 0.06 * features.fps;
  const out = [];
  for (const c of cands) {
    if (c.level < gate) continue;
    if (out.length && c.at - out[out.length - 1].at < minGap) continue;
    out.push({ at: c.at, frame: Math.round(c.at), time: c.at / features.fps, strength: Math.min(1, 10 ** ((c.level - ref) / 20)) });
  }
  return out;
}

// How much the energy above 6 kHz rises at `time`: its peak up to 30 ms after
// against its level 30-60 ms before.
export function highRiseDb(features, time) {
  const { highFine: e, highRate: rate } = features;
  const at = (s) => Math.round((time + s) * rate);
  let pre = 0;
  let count = 0;
  for (let j = at(-0.06); j <= at(-0.03); j++) { pre += j >= 0 && j < e.length ? e[j] : 0; count++; }
  let post = 0;
  for (let j = Math.max(0, at(-0.012)); j <= at(0.03) && j < e.length; j++) post = Math.max(post, e[j]);
  return ratioDb(post, pre / count);
}

// Cymbal hits with no attack above 6 kHz (a rise under `minRiseDb`) are the
// cymbal template firing on cymbal wash or a snare tail, not a new hit.
export function dropGhostCymbals(hits, features, { minRiseDb = 3 } = {}) {
  return hits.filter((h) => (h.drum !== 'hat' && h.drum !== 'crash') || highRiseDb(features, h.time) >= minRiseDb);
}

export const TOM_PADS = ['highTom', 'midTom', 'floorTom'];

// Below this a lone tom (or the lower of two) is taken for a floor tom.
const FLOOR_TOM_HZ = 100;

// Groups tom pitches into drums: the clear peaks of their (log-pitch) density,
// at least `minGapOct` apart, at most three. Returns a pad index per pitch:
// 0 high (yellow), 1 mid (blue), 2 floor (green). Three toms are high, mid and
// floor; with two, the lower is the floor tom when it's under 100 Hz.
export function tomPadsFor(pitches, { minGapOct = 0.2, bandwidthOct = 0.05 } = {}) {
  const xs = pitches.map((p) => (p > 0 ? Math.log2(p) : NaN));
  const ok = xs.filter(Number.isFinite);
  if (!ok.length) return pitches.map(() => 0);
  const lo = Math.min(...ok) - 0.2;
  const hi = Math.max(...ok) + 0.2;
  const step = 0.01;
  const grid = [];
  for (let g = lo; g <= hi; g += step) {
    let d = 0;
    for (const x of ok) d += Math.exp(-0.5 * ((g - x) / bandwidthOct) ** 2);
    grid.push({ g, d });
  }
  const peaks = grid.filter((p, i) => (i === 0 || p.d > grid[i - 1].d) && (i === grid.length - 1 || p.d >= grid[i + 1].d));
  const minMass = Math.max(2, 0.05 * ok.length);
  const mass = (g) => ok.filter((x) => Math.abs(x - g) <= 0.1).length;
  peaks.sort((a, b) => b.d - a.d);
  const modes = [];
  for (const p of peaks) {
    if (modes.length === 3) break;
    if (mass(p.g) < minMass && modes.length) continue;
    if (modes.some((m) => Math.abs(m - p.g) < minGapOct)) continue;
    modes.push(p.g);
  }
  modes.sort((a, b) => b - a); // highest pitch first
  const floor = (g) => 2 ** g < FLOOR_TOM_HZ;
  const pads = modes.length === 3 ? [0, 1, 2] : modes.length === 2 ? [0, floor(modes[1]) ? 2 : 1] : [floor(modes[0]) ? 2 : 0];
  return xs.map((x) => {
    if (!Number.isFinite(x)) return pads[0];
    let best = 0;
    for (let i = 1; i < modes.length; i++) if (Math.abs(x - modes[i]) < Math.abs(x - modes[best])) best = i;
    return pads[best];
  });
}

// hits: pickHits output ({ time, drum, strength }, drum kick|snare|hat|crash).
// Returns a new list with ghost cymbals dropped and toms split out as
// highTom / midTom / floorTom (with their body `pitch`). stem: the audio is a
// drum stem, which also turns on floor toms in the kick and toms the NMF
// missed (on a full mix, bass notes look just like them).
export function classifyHits(hits, features, { stem = false, sensitivity = 0.5, rules = TOM_RULES } = {}) {
  if (!features) return hits;
  const { fps } = features;
  const out = dropGhostCymbals(hits, features);
  const onsets = bodyOnsets(features, sensitivity);
  const onsetFrames = onsets.map((o) => o.frame);
  const drums = out
    .filter((h) => h.drum === 'kick' || h.drum === 'snare')
    .map((h) => ({ hit: h, drum: h.drum, frame: Math.round(h.time * fps) }))
    .sort((a, b) => a.frame - b.frame);
  // Where each snare hit's sound starts: the nearest body attack up to 80 ms
  // away, never past half way to the neighbouring kick or snare. Kicks keep
  // their own timing.
  const reach = Math.round(0.08 * fps);
  drums.forEach((d, i) => {
    d.attack = d.frame;
    d.time = d.hit.time;
    if (d.drum !== 'snare') return;
    const o = onsets[nearest(onsetFrames, d.frame)];
    if (!o || Math.abs(o.frame - d.frame) > reach) return;
    const prev = drums[i - 1]?.frame ?? -Infinity;
    const next = drums[i + 1]?.frame ?? Infinity;
    if (o.frame - prev > (d.frame - prev) / 2 && next - o.frame > (next - d.frame) / 2) { d.attack = o.frame; d.time = o.time; }
  });
  const starts = [...new Set([...drums.map((d) => d.attack), ...onsetFrames])].sort((a, b) => a - b);
  const describe = (frame) => describeAttack(features, frame, starts[firstAbove(starts, frame + 2)] ?? Infinity);
  for (const d of drums) d.info = describe(d.attack);

  // The song's wired snare pitch, for snares played with the wires off.
  const wired = drums.filter((d) => d.drum === 'snare' && d.info.buzz >= rules.snareWiresMin);
  const snarePitch = wired.length >= 4 ? median(wired.map((d) => d.info.pitch)) : NaN;
  const atSnarePitch = (info) => Number.isFinite(snarePitch) && info.pitch > 0 && octaves(info.pitch, snarePitch) < rules.samePitchOct;
  const tomLike = (info) => isTomLike(info, rules) && !atSnarePitch(info);

  const toms = drums.filter((d) => d.drum === 'snare' && tomLike(d.info));
  if (stem) {
    // Floor toms: a kick hit that rings much longer than the song's kicks and
    // has no more beater click than they do.
    const kicks = drums.filter((d) => d.drum === 'kick');
    const ring = median(kicks.map((d) => d.info.kickRing));
    const click = median(kicks.map((d) => d.info.click));
    for (const d of kicks) if (d.info.kickRing >= Math.max(-10, ring + 6) && d.info.click <= click + 3) toms.push(d);
    // Toms the NMF missed: a body attack well above the kick, with no kick or
    // snare within 35 ms.
    const taken = drums.map((d) => d.attack).sort((a, b) => a - b);
    const apart = Math.round(0.035 * fps);
    for (const o of onsets) {
      const t = taken[nearest(taken, o.frame)];
      if (t !== undefined && Math.abs(t - o.frame) <= apart) continue;
      const info = describe(o.frame);
      if (info.pitch >= 90 && tomLike(info)) toms.push({ hit: null, time: o.time, info, strength: o.strength });
    }
  }
  const tomHits = new Set(toms.map((d) => d.hit));
  const pads = tomPadsFor(toms.map((d) => d.info.pitch));
  const result = out.filter((h) => !tomHits.has(h)).map(({ time, drum, strength }) => ({ time, drum, strength }));
  toms.forEach((d, i) => result.push({ time: d.time, drum: TOM_PADS[pads[i]], strength: d.hit ? d.hit.strength : d.strength, pitch: d.info.pitch }));
  return result.sort((a, b) => a.time - b.time);
}

// Index of the first value in sorted `a` above x.
function firstAbove(a, x) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] <= x) lo = m + 1; else hi = m;
  }
  return lo;
}

// Index of the value in sorted `a` closest to x (-1 when empty).
function nearest(a, x) {
  const i = firstAbove(a, x);
  if (i === 0) return a.length ? 0 : -1;
  if (i === a.length) return i - 1;
  return x - a[i - 1] <= a[i] - x ? i - 1 : i;
}
