// Automatic tempo-map fitting: aligns a drum MIDI's hits against the uploaded
// audio's percussive onsets, producing a global tempo + per-section BPM anchors
// ("multi-BPM") so recordings that aren't perfectly metronomic still sync.
//
// Pure math, no React/DOM imports — keep it that way so it can be unit-tested
// in Node against real audio.
//
// Key design points, learned the hard way on real material:
// - Onsets are scored per frequency band (kick vs. low band, snare/toms vs.
//   mids, hats/cymbals vs. highs). A full-band score is ambiguous: shifting
//   the whole chart by 1.5 beats still lands every hit on SOME onset when the
//   song has eighth-note hi-hats. A kick aligned to a hi-hat scores ~zero in
//   the low band, so phase-flipped alignments collapse.
// - The score landscape is extremely spiky (a 0.0001 tempo error moves
//   late-song notes by whole envelope frames), so the coarse search keeps the
//   top-K separated candidates and refines each; refined raw scores decide.

// How strongly each GM drum pitch registers in a full mix (kick/snare dominate).
export const GM_FIT_WEIGHTS = {
  35: 1.0, 36: 1.0, 38: 1.0, 40: 1.0,
  49: 0.8, 52: 0.8, 55: 0.8, 57: 0.8,
  41: 0.5, 43: 0.5, 45: 0.5, 47: 0.5, 48: 0.5, 50: 0.5,
  42: 0.3, 44: 0.3, 46: 0.3,
  51: 0.4, 53: 0.4, 59: 0.4
};

export const fitWeightForPitch = (pitch) => (
  GM_FIT_WEIGHTS[pitch] !== undefined ? GM_FIT_WEIGHTS[pitch] : 0.3
);

// Which onset band a GM drum voice's transient lives in: 0=low, 1=mid, 2=high.
export const fitBandForPitch = (pitch) => {
  if (pitch === 35 || pitch === 36) return 0;                    // kick
  if (pitch === 42 || pitch === 44 || pitch === 46) return 2;    // hi-hats
  if (pitch >= 49 && pitch <= 59 && pitch !== 50) return 2;      // cymbals/rides
  return 1;                                                      // snare, toms, misc
};

const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 0));

// In-place iterative radix-2 complex FFT (length must be a power of 2).
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k + half], aIm = im[i + k + half];
        const vRe = aRe * curRe - aIm * curIm;
        const vIm = aRe * curIm + aIm * curRe;
        re[i + k + half] = re[i + k] - vRe;
        im[i + k + half] = im[i + k] - vIm;
        re[i + k] += vRe;
        im[i + k] += vIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

// Detrend (remove ~1.2s local mean), clamp at 0, normalize to max 1. In place.
function detrendNormalize(arr, fps) {
  const nFrames = arr.length;
  const w = Math.max(3, Math.round(1.2 * fps) | 1);
  const half = w >> 1;
  const prefix = new Float64Array(nFrames + 1);
  for (let i = 0; i < nFrames; i++) prefix[i + 1] = prefix[i] + arr[i];
  let maxV = 0;
  for (let i = 0; i < nFrames; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(nFrames, i + half + 1);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    const v = arr[i] - mean;
    arr[i] = v > 0 ? v : 0;
    if (arr[i] > maxV) maxV = arr[i];
  }
  if (maxV > 0) for (let i = 0; i < nFrames; i++) arr[i] /= maxV;
}

// Spectral-flux onset envelopes: full-band plus three percussion bands.
// Returns { flux, bands: [low, mid, high], fps }.
export async function computeOnsetEnvelope(monoSamples, sampleRate, onProgress) {
  const win = 1024;
  const hop = Math.max(128, Math.round(sampleRate / 86)); // ~86 frames/sec
  const nFrames = Math.max(0, Math.floor((monoSamples.length - win) / hop));
  const fps = sampleRate / hop;
  const flux = new Float32Array(nFrames);
  const low = new Float32Array(nFrames);
  const mid = new Float32Array(nFrames);
  const high = new Float32Array(nFrames);
  if (nFrames === 0) return { flux, bands: [low, mid, high], fps };

  // Band edges in bins (bin width = sampleRate/win): low < ~170 Hz (kick),
  // mid < ~2 kHz (snare/tom body+crack), high = the rest (hats/cymbals).
  const binHz = sampleRate / win;
  const lowEnd = Math.max(2, Math.round(170 / binHz));
  const midEnd = Math.max(lowEnd + 1, Math.round(2000 / binHz));

  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));

  const re = new Float32Array(win);
  const im = new Float32Array(win);
  const bins = (win >> 1) + 1;
  const prevMag = new Float32Array(bins);

  for (let f = 0; f < nFrames; f++) {
    const start = f * hop;
    for (let i = 0; i < win; i++) {
      re[i] = monoSamples[start + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    let sAll = 0, sLow = 0, sMid = 0, sHigh = 0;
    for (let k = 0; k < bins; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const d = m - prevMag[k];
      if (d > 0) {
        sAll += d;
        if (k <= lowEnd) sLow += d;
        else if (k <= midEnd) sMid += d;
        else sHigh += d;
      }
      prevMag[k] = m;
    }
    flux[f] = sAll; low[f] = sLow; mid[f] = sMid; high[f] = sHigh;
    if ((f & 2047) === 2047) {
      if (onProgress) onProgress(f / nFrames);
      await yieldToUI();
    }
  }

  detrendNormalize(flux, fps);
  detrendNormalize(low, fps);
  detrendNormalize(mid, fps);
  detrendNormalize(high, fps);
  return { flux, bands: [low, mid, high], fps };
}

// Alignment score of a linear time map audioTime = alpha*beat + beta.
// Each hit is scored against its own band's envelope.
// bands: [low, mid, high]; hits: [{ beat, w, band }].
function scoreMap(bands, fps, hits, alpha, beta) {
  let s = 0;
  const n = bands[0].length - 1;
  for (let h = 0; h < hits.length; h++) {
    const i = Math.floor((alpha * hits[h].beat + beta) * fps);
    if (i >= 0 && i < n) {
      const env = bands[hits[h].band];
      const a = env[i], b = env[i + 1];
      s += hits[h].w * (a > b ? a : b);
    }
  }
  return s;
}

// Max-dilate an envelope by ±radius frames: widens onset peaks so coarse grid
// steps can't fall between peaks and miss the true alignment basin.
function dilate(arr, radius) {
  if (radius <= 0) return arr;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let m = 0;
    const a = Math.max(0, i - radius), b = Math.min(arr.length - 1, i + radius);
    for (let j = a; j <= b; j++) if (arr[j] > m) m = arr[j];
    out[i] = m;
  }
  return out;
}

// Fit audioTime(beat) = alpha*beat + beta against the banded onset envelopes,
// then refine per-anchor offsets (every 16 beats) into a piecewise map.
// bands: [low, mid, high] from computeOnsetEnvelope.
// hits: [{ beat, w, band }] with beat = midiTicks / PPQ (quarter-note position).
// Returns { alpha, beta, score, anchors: [{ beat, time }] }.
export async function fitTempoMap(bands, fps, hits, nominalBPM, onProgress) {
  if (!hits.length || !bands[0].length) throw new Error('Not enough data to fit a tempo map.');
  const alpha0 = 60 / nominalBPM;

  const range = (from, to, step) => {
    const arr = [];
    for (let v = from; v <= to + step / 2; v += step) arr.push(v);
    return arr;
  };

  const bands1 = bands.map(b => dilate(b, 1));

  // Coarse scan keeping the top-K separated candidates (see file header).
  // Two grid points belong to the same basin iff they predict nearly the same
  // audio time at BOTH reference beats (25th/75th percentile) — a scale-only
  // box would let one basin occupy many slots at adjacent scales.
  const beatsSorted = hits.map(h => h.beat).sort((a, b) => a - b);
  const bRef1 = beatsSorted[Math.floor(beatsSorted.length * 0.25)];
  const bRef2 = beatsSorted[Math.floor(beatsSorted.length * 0.75)];
  const sameBasin = (a, b) => (
    Math.abs((a.sc - b.sc) * alpha0 * bRef1 + (a.beta - b.beta)) <= 0.12 &&
    Math.abs((a.sc - b.sc) * alpha0 * bRef2 + (a.beta - b.beta)) <= 0.12
  );
  const K = 16;
  const candidates = []; // { score, sc, beta } sorted by score desc
  const consider = (score, sc, beta) => {
    const cand = { score, sc, beta };
    for (let i = 0; i < candidates.length; i++) {
      if (sameBasin(candidates[i], cand)) {
        if (score > candidates[i].score) {
          candidates[i] = cand;
          candidates.sort((a, b) => b.score - a.score);
        }
        return;
      }
    }
    if (candidates.length < K) {
      candidates.push(cand);
      candidates.sort((a, b) => b.score - a.score);
    } else if (score > candidates[K - 1].score) {
      candidates[K - 1] = cand;
      candidates.sort((a, b) => b.score - a.score);
    }
  };

  const coarseScales = range(0.92, 1.08, 0.001);
  const coarseBetas = range(-1.0, 6.0, 0.02);
  for (let i = 0; i < coarseScales.length; i++) {
    const alpha = alpha0 * coarseScales[i];
    for (const beta of coarseBetas) {
      consider(scoreMap(bands1, fps, hits, alpha, beta), coarseScales[i], beta);
    }
    if ((i & 7) === 7) {
      if (onProgress) onProgress(0.75 * (i / coarseScales.length));
      await yieldToUI();
    }
  }

  // Refine every candidate basin; the RAW-envelope score is what competes
  // across candidates (dilated scores are inflated and not comparable).
  const refined = [];
  for (const cand of candidates) {
    let local = { score: -1, sc: cand.sc, beta: cand.beta };
    const sweepLocal = (envs, scales, betas) => {
      for (const sc of scales) {
        const alpha = alpha0 * sc;
        for (const beta of betas) {
          const s = scoreMap(envs, fps, hits, alpha, beta);
          if (s > local.score) local = { score: s, sc, beta };
        }
      }
    };
    // Position pass at ±1-frame tolerance...
    sweepLocal(bands1,
      range(cand.sc - 0.0012, cand.sc + 0.0012, 0.0002),
      range(cand.beta - 0.06, cand.beta + 0.06, 0.004));
    // ...then re-score from scratch on the raw envelopes around that position.
    local.score = -1;
    sweepLocal(bands,
      range(local.sc - 0.0003, local.sc + 0.0003, 0.00005),
      range(local.beta - 0.02, local.beta + 0.02, 0.0015));
    refined.push({ score: local.score, alpha: alpha0 * local.sc, beta: local.beta });
  }
  refined.sort((a, b) => b.score - a.score);

  // Basin selection. Groove music is loop-periodic: a line shifted by a whole
  // measure still threads the dense middle of the song and can even win the
  // raw score. Parity only shows at aperiodic EDGES — where the drums enter
  // and where they stop. So among candidates near the best raw score, prefer
  // the one whose first/last strong hits (kick/snare/crash) actually land on
  // onsets, with a generous ±140ms window (well under a half-beat at any
  // plausible tempo, so measure/beat ghosts get no edge credit).
  let best = refined[0];
  const strong = hits.filter(h => h.w >= 0.75).sort((a, b) => a.beat - b.beat);
  if (refined.length > 1 && strong.length >= 12) {
    const edgeHits = strong.slice(0, 12).concat(strong.slice(-12));
    const bands12 = bands.map(b => dilate(b, 12));
    const maxRaw = refined[0].score;
    const eligible = refined.filter(r => r.score >= 0.8 * maxRaw);
    let bestEdge = -1;
    for (const r of eligible) {
      const e = scoreMap(bands12, fps, edgeHits, r.alpha, r.beta);
      if (e > bestEdge + 1e-9 || (Math.abs(e - bestEdge) <= 1e-9 && r.score > best.score)) {
        bestEdge = e;
        best = r;
      }
    }
  }
  if (onProgress) onProgress(0.85);
  await yieldToUI();

  const { alpha, beta } = best;

  // Per-anchor drift refinement ("multi-BPM"): recordings drift/rubato, so
  // each anchor may deviate from the global line. A Viterbi pass over a delta
  // grid finds the globally best drift path — greedy chaining wanders off in
  // weak-evidence sections (sparse outros) and poisons everything after.
  // The ±0.25s per-step limit stays under a half-beat at any sane tempo, so
  // the path cannot hop beat parity between anchors.
  const ANCHOR_STEP = 4;   // anchors every 4 beats
  const WINDOW = 5;        // ±5 beats of evidence per anchor — small enough that
                           // local tempo deviations don't smear the emission peak
  const lastBeat = hits.reduce((m, h) => (h.beat > m ? h.beat : m), 0);
  const anchorBeats = [];
  for (let A = 0; A <= lastBeat + ANCHOR_STEP; A += ANCHOR_STEP) anchorBeats.push(A);

  const D_MIN = -2.0, D_STEP = 0.01, ND = 401;   // delta grid -2.00 .. +2.00 s
  const MAX_STEP = 15;                            // ±0.15s between anchors (~6% tempo)
  const TRANS_PEN = 2.0;                          // score cost per second of delta change
  const emissions = anchorBeats.map(A => {
    const local = hits.filter(h => Math.abs(h.beat - A) <= WINDOW);
    const weightSum = local.reduce((s, h) => s + h.w, 0);
    const row = new Float32Array(ND);
    if (weightSum >= 3) {
      for (let k = 0; k < ND; k++) {
        row[k] = scoreMap(bands, fps, local, alpha, beta + D_MIN + k * D_STEP);
      }
    }
    return row; // silent window: all zeros — transitions alone decide
  });
  await yieldToUI();

  const nA = anchorBeats.length;
  let prevCol = new Float64Array(ND);
  const back = [];
  // Start near the global line: its start position was edge-validated above.
  for (let k = 0; k < ND; k++) prevCol[k] = emissions[0][k] - 2.0 * Math.abs(D_MIN + k * D_STEP);
  for (let j = 1; j < nA; j++) {
    const cur = new Float64Array(ND);
    const bk = new Int16Array(ND);
    for (let k = 0; k < ND; k++) {
      let bv = -Infinity, bi = k;
      const a = Math.max(0, k - MAX_STEP), b = Math.min(ND - 1, k + MAX_STEP);
      for (let p = a; p <= b; p++) {
        const v = prevCol[p] - TRANS_PEN * Math.abs(k - p) * D_STEP;
        if (v > bv) { bv = v; bi = p; }
      }
      cur[k] = bv + emissions[j][k];
      bk[k] = bi;
    }
    prevCol = cur;
    back.push(bk);
  }
  let kBest = 0;
  for (let k = 1; k < ND; k++) if (prevCol[k] > prevCol[kBest]) kBest = k;
  const path = new Array(nA);
  path[nA - 1] = kBest;
  for (let j = nA - 2; j >= 0; j--) path[j] = back[j][path[j + 1]];
  const anchors = anchorBeats.map((A, j) => ({
    beat: A,
    time: alpha * A + beta + D_MIN + path[j] * D_STEP
  }));

  // Keep segment tempi sane: clamp each segment to ±10% of the global tempo so
  // weak-evidence windows can't produce wild BPM swings.
  for (let j = 0; j + 1 < anchors.length; j++) {
    const db = anchors[j + 1].beat - anchors[j].beat;
    let spb = (anchors[j + 1].time - anchors[j].time) / db; // seconds per beat
    const lo = alpha * 0.9, hi = alpha * 1.1;
    if (!(spb >= lo && spb <= hi)) {
      spb = Math.min(hi, Math.max(lo, isFinite(spb) ? spb : alpha));
      anchors[j + 1].time = anchors[j].time + spb * db;
    }
  }

  if (onProgress) onProgress(1);
  return { alpha, beta, score: best.score, anchors };
}

// Convert fitted anchors into chart-domain BPM events. Notes are shifted by
// leadInTicks, so anchor beat b lives at tick leadInTicks + resolution*b.
// The opening segment [tick 0 .. first usable anchor] gets whatever BPM makes
// the chart reach that anchor at exactly its fitted audio time — this also
// absorbs fitted maps whose beat 0 lands before the audio starts (negative
// time): those anchors are unplayable and are simply skipped.
export function anchorsToBpmEvents(anchors, globalBPM, leadInTicks, resolution = 480) {
  const usable = anchors.filter(a => a.time > 0.05);
  if (!usable.length) return [{ tick: 0, bpm: globalBPM }];

  const events = [];
  let lastBpm = null;
  const push = (tick, bpm) => {
    if (!isFinite(bpm) || !(bpm > 0)) return;
    if (lastBpm !== null && Math.abs(bpm - lastBpm) <= 0.02) return;
    events.push({ tick, bpm });
    lastBpm = bpm;
  };

  const first = usable[0];
  const beatsToFirst = leadInTicks / resolution + first.beat;
  let openingBpm = beatsToFirst > 0 ? (60 * beatsToFirst) / first.time : globalBPM;
  // A degenerate opening (first anchor almost at t=0) can produce a wild BPM;
  // there is no audible content there, so fall back to the global tempo.
  if (!isFinite(openingBpm) || openingBpm < globalBPM * 0.5 || openingBpm > globalBPM * 3) {
    openingBpm = globalBPM;
  }
  events.push({ tick: 0, bpm: openingBpm });
  lastBpm = openingBpm;

  for (let j = 0; j + 1 < usable.length; j++) {
    const db = usable[j + 1].beat - usable[j].beat;
    const dt = usable[j + 1].time - usable[j].time;
    if (!(dt > 0) || !(db > 0)) continue;
    const tick = leadInTicks + Math.round(resolution * usable[j].beat);
    if (tick > 0) push(tick, (60 * db) / dt);
  }
  return events;
}
