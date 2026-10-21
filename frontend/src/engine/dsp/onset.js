// Onset strength envelope: log-compressed spectral flux over mel bands.
// Mel bands keep broadband hi-hats from swamping the kick and bass, which
// otherwise pushes tempo estimates to double time.
import { RealFFT } from './fft.js';

export const ANALYSIS_SR = 22050;

export function onsetStrength(samples, sr, { nFft = 1024, hop = 256, nBands = 40, gamma = 100, meanSec = 0.4 } = {}) {
  const fft = new RealFFT(nFft);
  const bins = nFft / 2 + 1;
  const nFrames = Math.floor(samples.length / hop) + 1;
  const window = new Float64Array(nFft);
  let winSum = 0;
  for (let i = 0; i < nFft; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft);
    winSum += window[i];
  }
  const scale = gamma / (winSum / 2);
  const bank = melBank(nBands, nFft, sr, 30, sr / 2);
  const frame = new Float64Array(nFft);
  const mag = new Float64Array(bins);
  let prev = new Float64Array(nBands);
  let cur = new Float64Array(nBands);
  const flux = new Float32Array(nFrames);
  const lowFlux = new Float32Array(nFrames); // bands below ~150 Hz: kick drum
  const lowBands = bank.filter((_, b) => melCentre(b, nBands, 30, sr / 2) < 150).length;

  // Frames are centred on t = i * hop, zero-padded at the edges.
  for (let i = 0; i < nFrames; i++) {
    const start = i * hop - nFft / 2;
    for (let j = 0; j < nFft; j++) {
      const s = start + j;
      frame[j] = s >= 0 && s < samples.length ? samples[s] * window[j] : 0;
    }
    fft.magnitude(frame, mag);
    let sum = 0;
    let low = 0;
    for (let b = 0; b < nBands; b++) {
      const { first, weights } = bank[b];
      let e = 0;
      for (let k = 0; k < weights.length; k++) e += weights[k] * mag[first + k];
      cur[b] = Math.log1p(scale * e);
      if (i > 0) {
        const d = cur[b] - prev[b];
        if (d > 0) { sum += d; if (b < lowBands) low += d; }
      }
    }
    flux[i] = sum / nBands;
    lowFlux[i] = low / Math.max(1, lowBands);
    const t = prev; prev = cur; cur = t;
  }

  const fps = sr / hop;
  return { env: novelty(flux, fps, meanSec), envLow: novelty(lowFlux, fps, meanSec), fps };
}

// Removes the slowly varying part so only attacks stand out, then normalises.
function novelty(flux, fps, meanSec) {
  const nFrames = flux.length;
  const radius = Math.max(1, Math.round((meanSec * fps) / 2));
  const env = new Float32Array(nFrames);
  let acc = 0;
  let count = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < nFrames; i++) {
    while (hi < Math.min(nFrames - 1, i + radius)) { hi++; acc += flux[hi]; count++; }
    while (lo < i - radius) { acc -= flux[lo]; lo++; count--; }
    env[i] = Math.max(0, flux[i] - acc / count);
  }
  let sq = 0;
  for (let i = 0; i < nFrames; i++) sq += env[i] * env[i];
  const rms = Math.sqrt(sq / Math.max(1, nFrames));
  if (rms > 0) for (let i = 0; i < nFrames; i++) env[i] /= rms;
  return env;
}

function melCentre(b, nBands, fMin, fMax) {
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const m = mel(fMin) + ((mel(fMax) - mel(fMin)) * (b + 1)) / (nBands + 1);
  return 700 * (10 ** (m / 2595) - 1);
}

// Triangular mel filters, each normalised to unit sum. A band too narrow to
// contain a bin centre falls back to its nearest bin.
export function melBank(nBands, nFft, sr, fMin, fMax) {
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const hz = (m) => 700 * (10 ** (m / 2595) - 1);
  const binHz = sr / nFft;
  const edges = [];
  for (let i = 0; i < nBands + 2; i++) edges.push(hz(mel(fMin) + ((mel(fMax) - mel(fMin)) * i) / (nBands + 1)));
  const bank = [];
  for (let b = 0; b < nBands; b++) {
    const [lo, mid, hi] = [edges[b], edges[b + 1], edges[b + 2]];
    const first = Math.max(0, Math.ceil(lo / binHz));
    const last = Math.min(nFft / 2, Math.floor(hi / binHz));
    const weights = [];
    for (let k = first; k <= last; k++) {
      const f = k * binHz;
      weights.push(f <= mid ? (f - lo) / (mid - lo) : (hi - f) / (hi - mid));
    }
    const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
    if (sum > 0) {
      bank.push({ first, weights: Float64Array.from(weights, (w) => Math.max(0, w) / sum) });
    } else {
      bank.push({ first: Math.min(nFft / 2, Math.round(mid / binHz)), weights: Float64Array.of(1) });
    }
  }
  return bank;
}
