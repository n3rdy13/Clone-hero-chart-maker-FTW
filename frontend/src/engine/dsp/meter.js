// Metrical-level checks for tracked beats.
//
// A beat tracker can lock onto 2/3 or 3/2 of the real tempo for long
// stretches, not just double or half time. On Stavesacre's "Stars and Clouds"
// (a steady 128 BPM) it read a tom groove with dotted-quarter accents and a
// kick only every 2 bars as 85 BPM, and stayed there through much of the
// song. Straight 128 BPM eighths can't sit on an 85 BPM grid, so notes
// snapped to it were up to ~85 ms off.
//
// The tempo of the beats alone can't tell those apart, but where the drums
// land can: played at 128, almost every hit sits on a 128 BPM 16th, while the
// 85 BPM 16ths miss two in three of the 128 eighths. So stretches whose
// tracked tempo is 2/3, 3/2, 1/2 or 2x the song's dominant tempo are checked
// against the onsets with a 16th-note comb, and re-tracked at the dominant
// level when that fits the hits clearly better (2/3, 3/2) or at least as well
// (1/2, 2x); see metricalErrors.

// Onset peaks of an onset envelope, [{ time, strength }] in seconds, with
// sub-frame timing. Peaks below `threshold` (the envelope is normalised to
// RMS 1) or closer than `minGapSec` to a stronger one are dropped.
export function pickOnsets(env, fps, { threshold = 1, minGapSec = 0.04 } = {}) {
  const gap = Math.max(1, Math.round(minGapSec * fps));
  const peaks = [];
  for (let t = 1; t + 1 < env.length; t++) {
    const v = env[t];
    if (v < threshold || v <= env[t - 1] || v < env[t + 1]) continue;
    peaks.push(t);
  }
  // Strongest first, so a weak shoulder never wins over the main peak.
  const order = peaks.slice().sort((a, b) => env[b] - env[a]);
  const taken = new Uint8Array(env.length);
  const kept = [];
  for (const t of order) {
    let clash = false;
    for (let k = Math.max(0, t - gap); k <= Math.min(env.length - 1, t + gap); k++) if (taken[k]) { clash = true; break; }
    if (clash) continue;
    taken[t] = 1;
    kept.push(t);
  }
  kept.sort((a, b) => a - b);
  return kept.map((t) => {
    const y0 = env[t - 1];
    const y1 = env[t];
    const y2 = env[t + 1];
    const den = y0 - 2 * y1 + y2;
    const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    return { time: (t + d) / fps, strength: y1 };
  });
}

// How well onsets in [from, to) line up with a comb of `division` notes per
// beat at `bpm`: the length of the strength-weighted mean phase vector, 1 when
// every onset sits on the comb, near 0 when they are spread over it.
// Strengths are capped so one loud hit can't decide it alone.
export function combCoherence(onsets, from, to, bpm, { division = 4, cap = 4 } = {}) {
  const f = (bpm / 60) * division;
  let re = 0;
  let im = 0;
  let sum = 0;
  for (const o of onsets) {
    if (o.time < from || o.time >= to) continue;
    const w = Math.min(cap, o.strength);
    const a = 2 * Math.PI * f * (o.time - from);
    re += w * Math.cos(a);
    im += w * Math.sin(a);
    sum += w;
  }
  return sum > 0 ? Math.hypot(re, im) / sum : 0;
}

// The tempo within `spread` (a fraction) of `bpm` whose 16th comb fits the
// onsets in [from, to) best. Coherence over a window of a few seconds is
// sharp, so the search runs on a fine grid.
export function bestCombTempo(onsets, from, to, bpm, { spread = 0.04, division = 4 } = {}) {
  const steps = 160;
  const inWin = onsetsIn(onsets, from, to);
  let best = { bpm, coherence: -1 };
  for (let i = 0; i <= steps; i++) {
    const b = bpm * (1 - spread + (2 * spread * i) / steps);
    const c = combCoherence(inWin, from, to, b, { division });
    if (c > best.coherence) best = { bpm: b, coherence: c };
  }
  return best;
}

// The onsets (sorted by time) in [from, to).
function onsetsIn(onsets, from, to) {
  const first = (t) => {
    let lo = 0;
    let hi = onsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (onsets[mid].time < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  return onsets.slice(first(from), first(to));
}

// The song's dominant tempo: the most common beat-to-beat tempo, each beat
// weighted by its length, with tempos within a few percent pooled.
export function dominantTempo(beats, { sigma = 0.02 } = {}) {
  if (beats.length < 3) return null;
  const binsPerOctave = 200;
  const lo = Math.log2(20);
  const hist = new Float64Array(binsPerOctave * 5);
  for (let i = 0; i + 1 < beats.length; i++) {
    const d = beats[i + 1] - beats[i];
    if (!(d > 0)) continue;
    const b = Math.round((Math.log2(60 / d) - lo) * binsPerOctave);
    if (b >= 0 && b < hist.length) hist[b] += d;
  }
  const r = Math.ceil(3 * sigma * binsPerOctave);
  const s = sigma * binsPerOctave;
  let best = -1;
  let arg = 0;
  for (let b = 0; b < hist.length; b++) {
    let v = 0;
    for (let k = -r; k <= r; k++) if (b + k >= 0 && b + k < hist.length) v += hist[b + k] * Math.exp(-0.5 * (k / s) ** 2);
    if (v > best) { best = v; arg = b; }
  }
  return 2 ** (lo + arg / binsPerOctave);
}

const RATIOS = [2 / 3, 3 / 2, 1 / 2, 2];

// Stretches of beats tracked at the wrong metrical level. Each beat interval
// is compared (after a running median over a few beats, so a single odd
// interval at a section change doesn't count) with the dominant tempo; runs at
// about 2/3, 3/2, 1/2 or 2x of it become candidate spans. A span is confirmed
// when a 16th comb at the dominant level (refined around tracked / ratio) fits
// its onsets well enough compared with one at the tracked tempo:
//  - 1/2 or 2x: at least `octaveMargin` (0.9) times as well. A 16th comb can't
//    tell octaves apart when the music moves in eighths, so a tie goes to the
//    dominant tempo.
//  - 2/3 or 3/2: at least `tripleMargin` (1.2) times as well. When a song at
//    128 is misread at 85, the 128 eighths that fall between 85's 16ths make
//    the difference large (0.997 against 0.556 on the synthetic tom groove).
//    A tie means every hit sits on the 85 BPM eighths, which is what a real
//    3:2 tempo change sounds like, so the tracker is left alone.
//
// Returns { dominant, spans: [{ from, to, firstBeat, lastBeat, ratio,
// trackedBpm, bpm, coherence, trackedCoherence, confirmed }] }; `bpm` is the
// corrected local tempo.
export function metricalErrors(beats, onsets, {
  dominant = dominantTempo(beats), tol = 0.05, minBeats = 4, medianBeats = 5,
  minWindowSec = 8, octaveMargin = 0.9, tripleMargin = 1.2, mergeSec = 4,
} = {}) {
  const n = beats.length;
  if (!dominant || n < 2 * minBeats) return { dominant, spans: [] };
  const raw = [];
  for (let i = 0; i + 1 < n; i++) raw.push(60 / (beats[i + 1] - beats[i]));
  const half = medianBeats >> 1;
  const level = raw.map((_, i) => {
    const w = raw.slice(Math.max(0, i - half), Math.min(raw.length, i + half + 1)).sort((a, b) => a - b);
    const q = w[w.length >> 1] / dominant;
    return RATIOS.find((r) => Math.abs(Math.log(q / r)) < Math.log(1 + tol)) ?? 1;
  });

  const spans = [];
  for (let i = 0; i < level.length;) {
    const r = level[i];
    let j = i;
    while (j + 1 < level.length && level[j + 1] === r) j++;
    if (r !== 1 && j - i + 1 >= minBeats) {
      // The tracker can hiccup inside a wrong stretch (a slip of a third of
      // its beat where the groove repeats); a short gap joins the two halves.
      const prev = spans[spans.length - 1];
      if (prev && prev.ratio === r && beats[i] - beats[prev.lastBeat] <= mergeSec) prev.lastBeat = j + 1;
      else spans.push({ firstBeat: i, lastBeat: j + 1, ratio: r });
    }
    i = j + 1;
  }

  for (const s of spans) {
    s.from = beats[s.firstBeat];
    s.to = beats[s.lastBeat];
    const ints = raw.slice(s.firstBeat, s.lastBeat).sort((a, b) => a - b);
    s.trackedBpm = ints[ints.length >> 1];
    // A short span is judged on at least `minWindowSec` of audio around it.
    const pad = Math.max(0, (minWindowSec - (s.to - s.from)) / 2);
    const from = s.from - pad;
    const to = s.to + pad;
    const tracked = bestCombTempo(onsets, from, to, s.trackedBpm);
    const fixed = bestCombTempo(onsets, from, to, s.trackedBpm / s.ratio);
    s.bpm = fixed.bpm;
    s.coherence = fixed.coherence;
    s.trackedCoherence = tracked.coherence;
    const margin = s.ratio === 2 || s.ratio === 1 / 2 ? octaveMargin : tripleMargin;
    s.confirmed = fixed.coherence > 0 && fixed.coherence >= margin * tracked.coherence;
  }
  return { dominant, spans };
}

// Local tempo at the dominant level through a span, one value per `hopSec`
// from `from` to `to`, each fitted by 16th-comb coherence over `winSec`.
export function combTempoCurve(onsets, from, to, bpm, { winSec = 15, hopSec = 2.5, spread = 0.04 } = {}) {
  const out = [];
  const n = Math.max(1, Math.ceil((to - from) / hopSec));
  for (let i = 0; i <= n; i++) {
    const t = from + ((to - from) * i) / n;
    const fit = bestCombTempo(onsets, t - winSec / 2, t + winSec / 2, bpm, { spread });
    out.push({ time: t, bpm: fit.coherence > 0 ? fit.bpm : bpm });
  }
  return out;
}

// Finds and repairs stretches tracked at the wrong metrical level.
// `track(period)` runs the beat tracker on a per-frame beat period (frames);
// `period` is the one the beats came from. In each confirmed span, and in the
// frames next to it where the tempo curve sits at the same wrong level, the
// period is replaced by the comb-fitted tempo and the whole song is tracked
// again (so the new beats join the rest without a seam). Repeats while new
// spans turn up, at most `passes` times.
//
// Returns { beats, period, dominant, spans } with every span found, confirmed
// or not, for reporting.
export function repairMetricalLevel(beats, onsets, fps, period, track, { passes = 2, edgeSec = 1, tol = 0.05, ...opts } = {}) {
  const dominant = dominantTempo(beats);
  const found = [];
  let cur = beats;
  let per = period;
  for (let pass = 0; pass < passes; pass++) {
    const { spans } = metricalErrors(cur, onsets, { ...opts, dominant, tol });
    // A span the last pass couldn't move turns up again; report it once.
    for (const s of spans) if (!found.some((f) => f.from < s.to && s.from < f.to)) found.push(s);
    const todo = spans.filter((s) => s.confirmed);
    if (!todo.length) break;
    per = Float32Array.from(per);
    for (const s of todo) {
      const curve = combTempoCurve(onsets, s.from, s.to, s.bpm);
      // Widen to the neighbouring frames that the tempo curve put at the same
      // wrong level, plus a margin: the beats only show the error once the
      // tracker has settled into it.
      const wrong = (f) => Math.abs(Math.log((60 * fps) / per[f] / (dominant * s.ratio))) < Math.log(1 + tol);
      let f0 = Math.max(0, Math.floor(s.from * fps));
      let f1 = Math.min(per.length - 1, Math.ceil(s.to * fps));
      while (f0 > 0 && wrong(f0 - 1)) f0--;
      while (f1 + 1 < per.length && wrong(f1 + 1)) f1++;
      f0 = Math.max(0, f0 - Math.round(edgeSec * fps));
      f1 = Math.min(per.length - 1, f1 + Math.round(edgeSec * fps));
      for (let f = f0; f <= f1; f++) per[f] = (60 * fps) / interpCurve(curve, f / fps);
    }
    cur = Array.from(track(per));
  }
  return { beats: cur, period: per, dominant, spans: found };
}

function interpCurve(curve, t) {
  if (t <= curve[0].time) return curve[0].bpm;
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i].time) {
      const a = (t - curve[i - 1].time) / (curve[i].time - curve[i - 1].time || 1);
      return curve[i - 1].bpm + a * (curve[i].bpm - curve[i - 1].bpm);
    }
  }
  return curve[curve.length - 1].bpm;
}

// Quality check of a beat grid against the onsets: the share of onsets that
// would quantise more than `offMs` from a 16th of the grid, in windows of
// `winSec`. On a steady song a sound grid keeps that share near zero; a
// stretch where it passes `maxShare` (and at least `minOff` onsets miss) is
// reported, with neighbouring windows merged: [{ from, to, share, medianMs }].
// Onsets weaker than `minStrength` are ignored (bleed and noise).
export function gridCheck(beats, onsets, { offMs = 25, maxShare = 0.015, minOff = 2, winSec = 15, hopSec = 5, minStrength = 1.5, division = 4 } = {}) {
  const n = beats.length;
  if (n < 2) return [];
  const errs = [];
  let k = 0;
  for (const o of onsets) {
    if (o.strength < minStrength || o.time < beats[0] || o.time > beats[n - 1]) continue;
    while (k + 2 < n && beats[k + 1] <= o.time) k++;
    const len = beats[k + 1] - beats[k];
    const u = (o.time - beats[k]) / len;
    errs.push({ time: o.time, err: Math.abs(u - Math.round(u * division) / division) * len });
  }
  const out = [];
  let lo = 0;
  for (let t0 = beats[0]; t0 < beats[n - 1]; t0 += hopSec) {
    while (lo < errs.length && errs[lo].time < t0) lo++;
    let hi = lo;
    while (hi < errs.length && errs[hi].time < t0 + winSec) hi++;
    const inWin = errs.slice(lo, hi);
    if (!inWin.length) continue;
    const off = inWin.filter((e) => e.err * 1000 > offMs).length;
    const share = off / inWin.length;
    if (share <= maxShare || off < minOff) continue;
    const sorted = inWin.map((e) => e.err).sort((a, b) => a - b);
    const w = { from: t0, to: Math.min(t0 + winSec, beats[n - 1]), share, medianMs: 1000 * sorted[sorted.length >> 1] };
    const last = out[out.length - 1];
    if (last && w.from <= last.to) {
      last.to = w.to;
      last.share = Math.max(last.share, w.share);
      last.medianMs = Math.max(last.medianMs, w.medianMs);
    } else out.push(w);
  }
  return out;
}
