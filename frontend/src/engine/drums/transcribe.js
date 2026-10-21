// Drum transcription: semi-adaptive NMF on a mel spectrogram. Three drum
// templates (kick, snare, cymbals) start from generic spectral shapes and may
// adapt part-way to the recording; on a full mix, extra free templates soak
// up the rest of the music. Peaks in each drum's activation become hits.
//
// Ported from drumcharts2026 (src/drums/transcribe.js). Change: pickHits drops
// weak "snare" hits that sit on a kick. Kick clicks leak into the snare
// template; on a Harmonix-charted drum stem those leaks were about half of all
// detected snares, and all of them were far weaker than real snares.
import { RealFFT } from '../dsp/fft.js';
import { melBank } from '../dsp/onset.js';

export const DRUMS = ['kick', 'snare', 'cymbal'];
const N_BANDS = 48;
const F_MIN = 30;

export function melSpectrogram(samples, sr, { nFft = 1024, hop = 256 } = {}) {
  const fft = new RealFFT(nFft);
  const bank = melBank(N_BANDS, nFft, sr, F_MIN, sr / 2);
  const nFrames = Math.floor(samples.length / hop) + 1;
  const window = new Float64Array(nFft);
  for (let i = 0; i < nFft; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft);
  const frame = new Float64Array(nFft);
  const mag = new Float64Array(nFft / 2 + 1);
  const V = new Float32Array(N_BANDS * nFrames); // band-major: V[b * nFrames + t]
  for (let t = 0; t < nFrames; t++) {
    const start = t * hop - nFft / 2;
    for (let j = 0; j < nFft; j++) {
      const s = start + j;
      frame[j] = s >= 0 && s < samples.length ? samples[s] * window[j] : 0;
    }
    fft.magnitude(frame, mag);
    for (let b = 0; b < N_BANDS; b++) {
      const { first, weights } = bank[b];
      let e = 0;
      for (let k = 0; k < weights.length; k++) e += weights[k] * mag[first + k];
      V[b * nFrames + t] = e;
    }
  }
  const centres = bank.map((_, b) => melToHz(hzToMel(F_MIN) + ((hzToMel(sr / 2) - hzToMel(F_MIN)) * (b + 1)) / (N_BANDS + 1)));
  return { V, bands: N_BANDS, frames: nFrames, fps: sr / hop, centres };
}

const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m) => 700 * (10 ** (m / 2595) - 1);

// Generic starting spectra for each drum, over the band centre frequencies.
function drumTemplates(centres) {
  const g = (f, mu, sigmaOct) => Math.exp(-0.5 * (Math.log2(f / mu) / sigmaOct) ** 2);
  const shapes = {
    kick: (f) => g(f, 65, 0.6) + 0.05 * g(f, 3000, 1),
    snare: (f) => 0.8 * g(f, 200, 0.5) + 0.5 * g(f, 2500, 1.4),
    cymbal: (f) => g(f, 8000, 0.8) + 0.2 * g(f, 4000, 0.8),
  };
  return DRUMS.map((d) => normalise(Float64Array.from(centres, shapes[d])));
}

function normalise(w) {
  let s = 0;
  for (const v of w) s += v;
  for (let i = 0; i < w.length; i++) w[i] /= s || 1;
  return w;
}

// Returns the activation curve of each drum.
export function separateDrums(spec, { fullMix = true, iterations = 40, freeComponents = 8, seed = 11 } = {}) {
  const { bands: B, frames: N, centres } = spec;
  // Work on the percussive part of the spectrogram only.
  const V = percussive(spec.V, B, N);
  let peak = 0;
  for (const v of V) if (v > peak) peak = v;
  const scale = peak > 0 ? 1 / peak : 1;
  const Vn = Float32Array.from(V, (v) => v * scale);

  const init = drumTemplates(centres);
  const F = fullMix ? freeComponents : 0;
  const K = DRUMS.length + F;
  let state = seed;
  const rand = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const W = [];
  for (let k = 0; k < K; k++) W.push(k < DRUMS.length ? Float64Array.from(init[k]) : normalise(Float64Array.from({ length: B }, () => 0.5 + rand())));
  const H = [];
  for (let k = 0; k < K; k++) H.push(Float32Array.from({ length: N }, () => 0.1 + 0.1 * rand()));

  const L = new Float32Array(B * N);
  const R = new Float32Array(B * N);
  const eps = 1e-9;
  for (let it = 0; it < iterations; it++) {
    computeRatio(Vn, W, H, L, R, B, N, K, eps);
    // H update (KL divergence): H *= W^T R / W^T 1; templates sum to 1.
    for (let k = 0; k < K; k++) {
      const w = W[k];
      const h = H[k];
      for (let t = 0; t < N; t++) {
        let num = 0;
        for (let b = 0; b < B; b++) num += w[b] * R[b * N + t];
        h[t] *= num;
      }
    }
    computeRatio(Vn, W, H, L, R, B, N, K, eps);
    // W update. Drum templates stay fixed for the first half, then blend in
    // up to 30% of what the recording suggests.
    const adapt = it < iterations / 2 ? 0 : 0.3;
    for (let k = 0; k < K; k++) {
      const drum = k < DRUMS.length;
      if (drum && adapt === 0) continue;
      const h = H[k];
      let hSum = 0;
      for (let t = 0; t < N; t++) hSum += h[t];
      if (hSum <= eps) continue;
      const w = W[k];
      const updated = new Float64Array(B);
      for (let b = 0; b < B; b++) {
        let num = 0;
        const row = b * N;
        for (let t = 0; t < N; t++) num += h[t] * R[row + t];
        updated[b] = (w[b] * num) / hSum;
      }
      normalise(updated);
      for (let b = 0; b < B; b++) w[b] = drum ? (1 - adapt) * init[k][b] + adapt * updated[b] : updated[b];
      normalise(w);
    }
  }
  const out = {};
  DRUMS.forEach((d, k) => { out[d] = H[k]; });
  // Raw energy above 4 kHz, before separation: tells a ringing crash from a
  // closed hi-hat.
  const high = new Float32Array(N);
  for (let b = 0; b < B; b++) {
    if (centres[b] < 4000) continue;
    for (let t = 0; t < N; t++) high[t] += spec.V[b * N + t];
  }
  out.high = high;
  return out;
}

// Harmonic/percussive separation by median filtering (Fitzgerald 2010):
// sustained partials are smooth across time, drum hits across frequency.
function percussive(V, B, N, timeLen = 17, freqLen = 7) {
  const out = new Float32Array(V.length);
  const ht = timeLen >> 1;
  const hf = freqLen >> 1;
  const harm = new Float32Array(V.length);
  const buf = [];
  for (let b = 0; b < B; b++) {
    const row = b * N;
    for (let t = 0; t < N; t++) {
      buf.length = 0;
      for (let j = Math.max(0, t - ht); j <= Math.min(N - 1, t + ht); j++) buf.push(V[row + j]);
      harm[row + t] = medianOf(buf);
    }
  }
  for (let t = 0; t < N; t++) {
    for (let b = 0; b < B; b++) {
      buf.length = 0;
      for (let j = Math.max(0, b - hf); j <= Math.min(B - 1, b + hf); j++) buf.push(V[j * N + t]);
      const p = medianOf(buf);
      const h = harm[b * N + t];
      const mask = p * p / (p * p + h * h + 1e-12);
      out[b * N + t] = V[b * N + t] * mask;
    }
  }
  return out;
}

function medianOf(a) {
  a.sort((x, y) => x - y);
  return a[a.length >> 1];
}

function computeRatio(V, W, H, L, R, B, N, K, eps) {
  L.fill(0);
  for (let k = 0; k < K; k++) {
    const w = W[k];
    const h = H[k];
    for (let b = 0; b < B; b++) {
      const wb = w[b];
      if (wb === 0) continue;
      const row = b * N;
      for (let t = 0; t < N; t++) L[row + t] += wb * h[t];
    }
  }
  for (let i = 0; i < L.length; i++) R[i] = V[i] / (L[i] + eps);
}

// Peak-picks each activation. sensitivity 0..1 (higher finds quieter hits).
// Returns [{ time, drum, strength }] where drum is kick | snare | hat | crash.
// snareBleed: snare hits weaker than this that land within 35 ms of a kick are
// dropped as kick leakage (0 turns the filter off).
export function pickHits(acts, fps, { sensitivity = 0.5, snareBleed = 0.4 } = {}) {
  const hits = pickRawHits(acts, fps, sensitivity);
  if (!(snareBleed > 0)) return hits;
  const kicks = hits.filter((h) => h.drum === 'kick').map((h) => h.time);
  let k = 0;
  return hits.filter((h) => {
    if (h.drum !== 'snare' || h.strength >= snareBleed) return true;
    while (k < kicks.length && kicks[k] < h.time - 0.035) k++;
    return !(k < kicks.length && Math.abs(kicks[k] - h.time) <= 0.035);
  });
}

function pickRawHits(acts, fps, sensitivity) {
  const hits = [];
  const relative = 0.45 - 0.35 * sensitivity; // fraction of a typical strong hit
  const minGap = Math.round(0.05 * fps);
  for (const drum of DRUMS) {
    const h = acts[drum];
    const n = h.length;
    // Onset novelty: rise over the last few frames.
    const d = new Float32Array(n);
    for (let t = 1; t < n; t++) {
      let lo = h[t - 1];
      for (let j = 2; j <= 3 && t - j >= 0; j++) lo = Math.min(lo, h[t - j]);
      d[t] = Math.max(0, h[t] - lo);
    }
    // Threshold relative to the drum's real hits (the upper peaks), so the
    // small bumps other drums leak into this activation stay below it.
    const peaks = [];
    for (let t = 1; t < n - 1; t++) if (d[t] > 0 && d[t] >= d[t - 1] && d[t] >= d[t + 1]) peaks.push(d[t]);
    if (!peaks.length) continue;
    peaks.sort((a, b) => a - b);
    const top = peaks[peaks.length - 1];
    const strong = peaks.filter((v) => v >= 0.3 * top);
    const ref = strong[Math.floor(strong.length / 2)];
    const threshold = ref * relative;
    let last = -Infinity;
    const found = [];
    for (let t = 1; t < n - 1; t++) {
      if (d[t] < threshold || d[t] < d[t - 1] || d[t] < d[t + 1]) continue;
      if (t - last < minGap) continue;
      // Time the hit at the steepest single-frame rise.
      let p = t;
      for (let j = t - 2; j < t; j++) if (j > 0 && h[j] - h[j - 1] > h[p] - h[p - 1]) p = j;
      found.push({ frame: p, strength: d[t] / top });
      last = t;
    }
    for (let i = 0; i < found.length; i++) {
      const f = found[i];
      let name = drum;
      if (drum === 'cymbal') name = isSustained(acts.high ?? h, f.frame, found[i + 1]?.frame, fps) ? 'crash' : 'hat';
      hits.push({ time: f.frame / fps, drum: name, strength: f.strength });
    }
  }
  return hits.sort((a, b) => a.time - b.time);
}

// A crash keeps ringing after it's hit; a closed hi-hat dies away at once.
// Measured against the level just before the hit, so a hi-hat played over a
// still-ringing crash isn't mistaken for another crash.
function isSustained(h, frame, nextFrame, fps) {
  let base = Infinity;
  for (let t = Math.max(0, frame - 3); t < frame; t++) base = Math.min(base, h[t]);
  if (!Number.isFinite(base)) base = 0;
  let peak = 0;
  for (let t = frame; t <= Math.min(h.length - 1, frame + 2); t++) peak = Math.max(peak, h[t]);
  const hit = peak - base;
  if (hit <= 0) return false;
  const from = frame + Math.round(0.08 * fps);
  const to = Math.min(frame + Math.round(0.35 * fps), (nextFrame ?? Infinity) - Math.round(0.02 * fps), h.length - 1);
  if (to - from < Math.round(0.04 * fps)) return false;
  let min = Infinity;
  for (let t = from; t <= to; t++) min = Math.min(min, h[t]);
  return min - base > 0.3 * hit;
}
