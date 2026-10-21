// Song analysis shared by the web worker, the main-thread fallback, the CLI and
// the tests: onset envelopes -> local tempo curve -> beats, plus drum
// activations for tab checking and drum detection.
//
// Times returned here are in the song audio's own timeline (seconds from the
// start of the unpadded file). When a drum stem is given, stem events are
// moved onto the song timeline by `stemShift`.
import { onsetStrength } from './dsp/onset.js';
import { estimateTempoCurve } from './dsp/tempo.js';
import { trackBeats } from './dsp/beats.js';
import { pickOnsets, repairMetricalLevel, gridCheck } from './dsp/meter.js';
import { fitBeatsToOnsets } from './tempomap.js';
import { melSpectrogram, separateDrums } from './drums/transcribe.js';
import { ComplexFFT } from './dsp/fft.js';

export const ANALYSIS_SR = 22050;
export const DEFAULT_TRACKING = { minBpm: 60, maxBpm: 200, tempoScale: 1, meterFix: true };

// How well the stem must correlate with the song before it is trusted for
// beats and drum checks. A stem split from the song scores ~0.4-0.6; a stem
// from a different release or another song scores under 0.05.
const STEM_MATCH_MIN = 0.15;

export class SongAnalyzer {
  // mix: Float32Array mono at sr. stem: optional drum stem, same rate.
  load({ mix, stem = null, sr = ANALYSIS_SR }) {
    this.sr = sr;
    this.mix = mix;
    this.stem = stem;
    this.duration = mix.length / sr;
    this.mixOnset = onsetStrength(mix, sr);
    this.stemOnset = null;
    this.stemInfo = null;
    if (stem) {
      this.stemOnset = onsetStrength(stem, sr);
      this.stemInfo = matchStem(mix, stem, sr);
    }
    this.acts = null;
    return this.summary();
  }

  get useStem() {
    return Boolean(this.stemInfo && this.stemInfo.match >= STEM_MATCH_MIN);
  }

  summary() {
    return { duration: this.duration, stem: this.stemInfo, beatSource: this.useStem ? 'stem' : 'mix' };
  }

  // The onset envelope the beat tracker and aligner use, with the shift that
  // moves its frames onto the song timeline.
  get onset() {
    if (this.useStem) return { ...this.stemOnset, shift: this.stemInfo.shift };
    return { ...this.mixOnset, shift: 0 };
  }

  // Beats of the recording. With `meterFix` (the default), stretches the
  // tracker locked onto 2/3, 3/2, 1/2 or 2x of the song's dominant tempo are
  // re-tracked at the dominant level, and every beat is then fitted to the
  // drum onsets around it (see dsp/meter.js and fitBeatsToOnsets).
  //
  // Returns { beats, curve, meter }. meter: { dominantBpm, fixed: spans
  // re-tracked, kept: suspicious spans the onsets didn't confirm, offGrid:
  // stretches where hits still don't fit a 16th grid (gridCheck) }, or null
  // with meterFix off. Times are on the song timeline.
  track({ minBpm = DEFAULT_TRACKING.minBpm, maxBpm = DEFAULT_TRACKING.maxBpm, tempoScale = 1, priorBpm = 120, meterFix = true } = {}) {
    if (!this.mixOnset) throw new Error('No audio loaded');
    const { env, fps, shift } = this.onset;
    const curve = estimateTempoCurve(env, fps, { minBpm, maxBpm, priorBpm });
    let period = curve.period;
    if (tempoScale !== 1) for (let i = 0; i < period.length; i++) period[i] /= tempoScale;
    const run = (p) => trackBeats(env, fps, p);
    let beats = Array.from(run(period));
    let meter = null;
    if (meterFix) {
      const onsets = pickOnsets(env, fps);
      const repair = repairMetricalLevel(beats, onsets, fps, period, run);
      period = repair.period;
      beats = fitBeatsToOnsets(repair.beats, onsets);
      const span = (s) => ({ from: s.from + shift, to: s.to + shift, ratio: s.ratio, trackedBpm: s.trackedBpm, bpm: s.bpm });
      meter = {
        dominantBpm: repair.dominant,
        fixed: repair.spans.filter((s) => s.confirmed).map(span),
        kept: repair.spans.filter((s) => !s.confirmed).map(span),
        offGrid: gridCheck(beats, onsets).map((w) => ({ ...w, from: w.from + shift, to: w.to + shift })),
      };
    }
    // The tempo curve as tracked, after any repair.
    const curveBpm = Array.from(curve.times, (t, w) => (period.length ? (60 * fps) / period[Math.min(period.length - 1, Math.round(t * fps))] : curve.bpm[w] * tempoScale));
    return {
      beats: beats.map((t) => t + shift),
      curve: { times: Array.from(curve.times, (t) => t + shift), bpm: curveBpm },
      meter,
    };
  }

  // Drum activations (kick, snare, cymbal, high) of the best drum audio we
  // have: the stem when it matches the song, otherwise the full mix.
  transcribe() {
    if (this.acts) return this.acts;
    const fromStem = this.useStem;
    const samples = fromStem ? this.stem : this.mix;
    const spec = melSpectrogram(samples, this.sr);
    const acts = separateDrums(spec, { fullMix: !fromStem });
    this.acts = { acts, fps: spec.fps, shift: fromStem ? this.stemInfo.shift : 0, source: fromStem ? 'stem' : 'mix' };
    return this.acts;
  }
}

// Finds how far the stem is shifted against the song (stem time + shift = song
// time) and how well it matches. A stem split from the song is part of the
// song's waveform, so plain waveform cross-correlation finds it to the sample.
// (Onset envelopes don't work here: in a dense mix every lag a whole beat away
// scores almost the same.) It runs on several of the stem's loudest passages;
// `match` is the median correlation, scaled by how many passages agree.
export function matchStem(mix, stem, sr, { maxLag = 1.0, windowSec = 4, windows = 7 } = {}) {
  const W = Math.round(windowSec * sr);
  const L = Math.round(maxLag * sr);
  const n = Math.min(mix.length, stem.length);
  if (n < W + 2 * L) return { shift: 0, match: 0, agree: 0 };
  // Loudest blocks of the stem, at least one window apart.
  const blocks = [];
  for (let s = L; s + W + L <= n; s += W) {
    let e = 0;
    for (let i = s; i < s + W; i += 4) e += stem[i] * stem[i];
    blocks.push({ s, e });
  }
  blocks.sort((a, b) => b.e - a.e);
  const picked = blocks.filter((b) => b.e > 0).slice(0, windows);
  if (!picked.length) return { shift: 0, match: 0, agree: 0 };

  let size = 1;
  while (size < W + 2 * L) size <<= 1;
  const fft = new ComplexFFT(size);
  const results = [];
  for (const { s } of picked) {
    const ar = new Float64Array(size), ai = new Float64Array(size);
    const br = new Float64Array(size), bi = new Float64Array(size);
    let ea = 0, eb = 0;
    for (let i = 0; i < W + 2 * L; i++) { const v = mix[s - L + i]; ar[i] = v; ea += v * v; }
    for (let i = 0; i < W; i++) { const v = stem[s + i]; br[i] = v; eb += v * v; }
    fft.transform(ar, ai);
    fft.transform(br, bi);
    // corr = IFFT(A * conj(B)); inverse via conj -> forward -> conj.
    for (let k = 0; k < size; k++) {
      const re = ar[k] * br[k] + ai[k] * bi[k];
      const im = ai[k] * br[k] - ar[k] * bi[k];
      ar[k] = re; ai[k] = -im;
    }
    fft.transform(ar, ai);
    // ar[j] / size = sum_i mix[s - L + i + j] * stem[s + i]  ->  lag j - L
    let best = -Infinity, j0 = L;
    for (let j = 0; j <= 2 * L; j++) if (ar[j] > best) { best = ar[j]; j0 = j; }
    let d = 0;
    if (j0 > 0 && j0 < 2 * L) {
      const y0 = ar[j0 - 1], y1 = ar[j0], y2 = ar[j0 + 1];
      const den = y0 - 2 * y1 + y2;
      if (den < 0) d = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
    }
    // Mix energy over the matched stretch only.
    let em = 0;
    for (let i = 0; i < W; i++) { const v = mix[s + j0 - L + i] ?? 0; em += v * v; }
    results.push({ lag: (j0 - L + d) / sr, corr: em > 0 && eb > 0 ? best / size / Math.sqrt(em * eb) : 0 });
  }
  const lags = results.map((r) => r.lag).sort((a, b) => a - b);
  const lag = lags[lags.length >> 1];
  const agreeing = results.filter((r) => Math.abs(r.lag - lag) < 0.003);
  const corr = agreeing.map((r) => r.corr).sort((a, b) => a - b);
  const agree = agreeing.length / results.length;
  return { shift: lag, match: (corr[corr.length >> 1] ?? 0) * agree, agree };
}
