// Local tempo curve: windowed autocorrelation of the onset envelope, with a
// Viterbi pass across windows so octave errors can't flicker in and out while
// real jumps and gradual drift still come through.

const BIN_RATIO = 1.01;

export function estimateTempoCurve(env, fps, {
  minBpm = 60,
  maxBpm = 200,
  winSec = 8,
  hopSec = 0.5,
  priorBpm = 120,
  harmonic = 0.5,
  jumpCost = 2, // cost per octave of tempo change between windows, in units of normalised evidence
  octaveCost = 6, // extra cost for jumping by (almost exactly) an octave
} = {}) {
  if (!(minBpm > 0 && maxBpm > minBpm)) throw new Error('BPM range must satisfy 0 < min < max');
  const nFrames = env.length;
  const nBins = Math.floor(Math.log(maxBpm / minBpm) / Math.log(BIN_RATIO)) + 1;
  const bpmBins = new Float64Array(nBins);
  const prior = new Float64Array(nBins);
  for (let b = 0; b < nBins; b++) {
    bpmBins[b] = minBpm * BIN_RATIO ** b;
    prior[b] = Math.exp(-0.5 * Math.log2(bpmBins[b] / priorBpm) ** 2);
  }

  const win = 2 * Math.round((winSec * fps) / 2);
  const hop = Math.max(1, Math.round(hopSec * fps));
  const maxLag = Math.min(win - 1, Math.ceil((2 * 60 * fps) / minBpm) + 2);
  const hann = new Float64Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);

  const nWin = Math.max(1, Math.floor((nFrames - 1) / hop) + 1);
  const seg = new Float64Array(win);
  const acf = new Float64Array(maxLag + 1);
  const evidence = new Float64Array(nBins);
  const lagAt = (lag) => {
    if (lag >= maxLag) return 0;
    const i = Math.floor(lag);
    const f = lag - i;
    return acf[i] * (1 - f) + acf[i + 1] * f;
  };

  // Transition cost depends only on the distance between bins. Half- and
  // double-time jumps get an extra penalty: they are almost always the
  // estimator switching metrical level, not the music changing tempo.
  const step = Math.log2(BIN_RATIO);
  const moveCost = new Float64Array(nBins);
  for (let d = 0; d < nBins; d++) {
    const octaves = d * step;
    const nearOctave = Math.min(Math.abs(octaves - 1), Math.abs(octaves - 2));
    moveCost[d] = jumpCost * octaves + octaveCost * Math.exp(-0.5 * (nearOctave / 0.06) ** 2);
  }
  let score = new Float64Array(nBins);
  let next = new Float64Array(nBins);
  const back = [];

  for (let w = 0; w < nWin; w++) {
    const centre = w * hop;
    for (let i = 0; i < win; i++) {
      const f = centre - win / 2 + i;
      seg[i] = f >= 0 && f < nFrames ? env[f] * hann[i] : 0;
    }
    for (let lag = 0; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < win; i++) s += seg[i] * seg[i + lag];
      acf[lag] = s;
    }
    if (acf[0] > 0) for (let lag = maxLag; lag >= 0; lag--) acf[lag] /= acf[0];

    let top = 0;
    for (let b = 0; b < nBins; b++) {
      const lag = (60 * fps) / bpmBins[b];
      const v = Math.max(0, lagAt(lag) + harmonic * lagAt(2 * lag)) * prior[b];
      evidence[b] = v;
      if (v > top) top = v;
    }
    if (top > 0) for (let b = 0; b < nBins; b++) evidence[b] /= top;

    if (w === 0) {
      score.set(evidence);
      back.push(null);
      continue;
    }
    const ptr = new Int32Array(nBins);
    for (let b = 0; b < nBins; b++) {
      // Ties keep the same bin.
      let best = score[b];
      let from = b;
      for (let p = 0; p < nBins; p++) {
        const v = score[p] - moveCost[Math.abs(b - p)];
        if (v > best) { best = v; from = p; }
      }
      next[b] = evidence[b] + best;
      ptr[b] = from;
    }
    back.push(ptr);
    const t = score; score = next; next = t;
  }

  const path = new Int32Array(nWin);
  let bin = 0;
  for (let b = 1; b < nBins; b++) if (score[b] > score[bin]) bin = b;
  for (let w = nWin - 1; w >= 0; w--) {
    path[w] = bin;
    if (w > 0) bin = back[w][bin];
  }

  const times = new Float64Array(nWin);
  const bpm = new Float64Array(nWin);
  for (let w = 0; w < nWin; w++) {
    times[w] = (w * hop) / fps;
    bpm[w] = bpmBins[path[w]];
  }

  // Per-frame beat period (in frames), interpolated in the log domain.
  const period = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const x = f / hop;
    const w0 = Math.min(nWin - 1, Math.floor(x));
    const w1 = Math.min(nWin - 1, w0 + 1);
    const a = x - w0;
    const lp = (1 - a) * Math.log(bpm[w0]) + a * Math.log(bpm[w1]);
    period[f] = (60 * fps) / Math.exp(lp);
  }
  return { times, bpm, period };
}
