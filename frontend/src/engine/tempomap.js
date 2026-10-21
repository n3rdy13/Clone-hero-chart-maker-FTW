// Turns detected beat times into a tempo map: tempo events on an integer beat
// grid, chosen so the grid never strays more than `toleranceMs` from a detected
// beat. Steady passages collapse to one event, jumps become a single change and
// gradual drift becomes as many steps as the tolerance needs.
//
// Ported from drumcharts2026 (src/tempomap.js). Change: the grid can be
// extended past the last detected beat to `endTime`, so notes in a fade-out or
// a final ring after the beat tracker stops still have beats to land on.

export function buildTempoMap(rawBeats, { toleranceMs = 20, beatsPerBar = 4, endTime = null } = {}) {
  const beats = fixEdgeDoubling(rawBeats);
  const n = beats.length;
  const perBeat = [];
  for (let i = 0; i + 1 < n; i++) perBeat.push({ time: beats[i], bpm: 60 / (beats[i + 1] - beats[i]) });
  if (n < 2) return { events: [], gridTimes: [], perBeat, anchor: 0, leadInBeats: 0, beatsPerBar };

  // The first beat on the grid. A beat sitting very close to the start of the
  // file is skipped so the lead-in doesn't need an absurdly fast tempo.
  let anchor = 0;
  if (n >= 3 && beats[0] > 0.001 && beats[0] < 0.5 * (beats[1] - beats[0])) anchor = 1;

  const cuts = segmentByTolerance(beats, anchor, n - 1, toleranceMs / 1000);

  const events = [];
  let cumUs = 0;
  let leadInBeats = 0;
  const startUs = Math.round(beats[anchor] * 1e6);
  if (startUs > 1000) {
    const firstPeriod = (beats[cuts[1]] - beats[cuts[0]]) / (cuts[1] - cuts[0]);
    leadInBeats = Math.max(1, Math.round(beats[anchor] / firstPeriod));
    const us = Math.round(startUs / leadInBeats);
    events.push({ beat: 0, time: 0, microsPerBeat: us, leadIn: true });
    cumUs = us * leadInBeats;
  }

  // Integer microseconds per beat, with the rounding error carried forward so
  // the grid stays locked to the detected beat at every change.
  for (let s = 0; s + 1 < cuts.length; s++) {
    const i = cuts[s];
    const j = cuts[s + 1];
    const count = j - i;
    const us = Math.max(1, Math.min(0xffffff, Math.round((Math.round(beats[j] * 1e6) - cumUs) / count)));
    events.push({ beat: leadInBeats + (i - anchor), time: cumUs / 1e6, microsPerBeat: us, leadIn: false });
    cumUs += us * count;
  }

  // Drop events that don't change the tempo. A lead-in that runs straight into
  // the same tempo is just the start of the first section.
  const merged = [];
  for (const e of events) {
    const prev = merged[merged.length - 1];
    if (prev && prev.microsPerBeat === e.microsPerBeat) {
      prev.leadIn = prev.leadIn && e.leadIn;
      continue;
    }
    merged.push(e);
  }
  for (const e of merged) {
    e.bpm = 60e6 / e.microsPerBeat;
    e.bar = Math.floor(e.beat / beatsPerBar) + 1;
    e.beatInBar = (e.beat % beatsPerBar) + 1;
  }

  let lastBeat = leadInBeats + (n - 1 - anchor);
  if (endTime != null && merged.length) {
    const lastUs = merged[merged.length - 1].microsPerBeat;
    const tail = endTime - beats[n - 1];
    if (tail > 0) lastBeat += Math.ceil((tail * 1e6) / lastUs);
  }

  return {
    events: merged,
    gridTimes: gridTimes(merged, lastBeat),
    perBeat,
    anchor,
    leadInBeats,
    beatsPerBar,
  };
}

// The beat tracker can switch to double time for the last (or first) few
// beats: a final ring-out or a run of eighth notes after a slowdown. On
// Possum Kingdom it put the last three beats 0.4 s apart after a ritardando
// to 0.77 s, which squeezed the tab's final bar to half its length. At the
// edges of a song a sudden 2x is always a tracking error, so those beats are
// thinned back to the tempo of the beats before them.
export function fixEdgeDoubling(beats, { edge = 8, ref = 4 } = {}) {
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const fixTail = (b) => {
    const n = b.length;
    if (n < edge + ref + 2) return b;
    // Longest run of at least two final intervals that are each about half
    // the intervals just before the run (which also follows a slowdown).
    let start = -1;
    for (let s = n - 3; s >= n - 1 - edge; s--) {
      const before = [];
      for (let i = s - ref; i < s; i++) before.push(b[i + 1] - b[i]);
      const p = median(before);
      let all = true;
      for (let j = s; j < n - 1; j++) {
        const d = b[j + 1] - b[j];
        if (!(d > 0.35 * p && d < 0.7 * p)) { all = false; break; }
      }
      if (all) start = s; else if (start >= 0) break;
    }
    if (start < 0) return b;
    const out = b.slice(0, start + 1);
    for (let j = start + 2; j < n; j += 2) out.push(b[j]);
    return out;
  };
  const tail = fixTail(Array.from(beats));
  const lead = fixTail(tail.map((t) => -t).reverse()).map((t) => -t).reverse();
  return lead;
}

// Greedy: extend each constant-tempo segment for as long as every beat inside
// stays within `tol` seconds of the evenly spaced grid between its endpoints.
function segmentByTolerance(t, from, to, tol) {
  const cuts = [from];
  let i = from;
  while (i < to) {
    let j = i + 1;
    while (j + 1 <= to && fits(t, i, j + 1, tol)) j++;
    cuts.push(j);
    i = j;
  }
  return cuts;
}

function fits(t, i, j, tol) {
  const p = (t[j] - t[i]) / (j - i);
  for (let k = i + 1; k < j; k++) {
    if (Math.abs(t[i] + (k - i) * p - t[k]) > tol) return false;
  }
  return true;
}

// Time of every grid beat from 0 through `lastBeat`, exactly as a MIDI player
// would place them from the integer tempos.
export function gridTimes(events, lastBeat) {
  const out = [];
  if (events.length === 0) return out;
  let us = 0;
  let k = 0;
  for (let beat = 0; beat <= lastBeat; beat++) {
    while (k + 1 < events.length && events[k + 1].beat <= beat) k++;
    out.push(us / 1e6);
    us += events[k].microsPerBeat;
  }
  return out;
}

// Robust smoothing of detected beat times. Each beat is pulled towards a
// smooth tempo curve (second-difference penalty). Both terms are robust: a
// beat more than ~10 ms off the curve, and a change in beat length of more
// than ~4 ms, are charged less than squared. So a real tempo jump or a push
// in a fill survives, while single stray beats (a flam, a cymbal smear
// moving the onset peak) are pulled back in line. Measured against the
// Harmonix grid of Possum Kingdom and the DAW grid of Torn, a per-beat map of
// smoothed beats was about twice as close as the old +-20 ms segments.
// Sudden tempo changes (see tempoJumps) are not smoothed at all, so the beat
// where the tempo changes stays exactly where the drummer played it.
export function smoothBeats(beats, { smooth = 2, iterations = 8 } = {}) {
  const n = beats.length;
  if (n < 5 || !(smooth > 0)) return Array.from(beats);
  const S = 0.005; // residuals in units of 5 ms
  const C = 0.75; // beat-length changes above ~4 ms are charged linearly
  const jumps = new Set(tempoJumps(beats).map((j) => j.beat));
  const t = Float64Array.from(beats);
  let T = Float64Array.from(beats);
  for (let it = 0; it < iterations; it++) {
    const A = new Float64Array(n * 3); // banded: A[i*3+d] = M[i][i+d]
    const B = new Float64Array(n);
    const add = (i, j, v) => { if (j < i) [i, j] = [j, i]; A[i * 3 + (j - i)] += v; };
    for (let k = 0; k < n; k++) {
      const r = Math.abs(T[k] - t[k]) / S;
      const w = r <= 2 ? 1 : 2 / r; // Huber at 10 ms
      add(k, k, w);
      B[k] += w * t[k];
    }
    for (let k = 1; k + 1 < n; k++) {
      if (jumps.has(k)) continue;
      // Edge-preserving: a big change in beat length (a real tempo jump,
      // well supported by the beats on both sides) is charged less than
      // squared, so it stays sharp instead of being smeared over many beats.
      const d2 = Math.abs(T[k - 1] - 2 * T[k] + T[k + 1]) / S;
      const ws = smooth * (d2 <= C ? 1 : C / d2);
      const ix = [k - 1, k, k + 1];
      const v = [1, -2, 1];
      for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) add(ix[a], ix[b], ws * v[a] * v[b]);
    }
    T = solveBanded(A, B, n);
  }
  for (let k = 1; k < n; k++) if (T[k] <= T[k - 1]) T[k] = T[k - 1] + 1e-4;
  return Array.from(T);
}

// Fits beat times to the drum onsets around them: a regularised least-squares
// fit in which each onset pulls the grid point nearest to it (a fixed
// fraction of its beat) onto itself, with a second-difference penalty on the
// beats and a weak pull back to where the tracker put them.
//
// The first passes use only strong onsets (kick, snare, toms: the loudest
// third or so) snapped to eighths, so the grid's phase is pinned by the hits
// least likely to be ghost notes. Later passes snap every onset to 16ths.
// Doing 16ths straight away lets the fit slip by a 16th when the band rushes:
// every hit then finds a neighbouring 16th and the error never shows.
//
// Onsets far from any grid point (flams, triplets, a swung note) are charged
// with a redescending (Cauchy) weight, so they barely pull at all. The
// smoothness term is edge-preserving and skipped at sudden tempo changes, as
// in smoothBeats.
export function fitBeatsToOnsets(beats, onsets, {
  smooth = 0.5, prior = 0.02, strongShare = 0.35, iterations = [[2, 'strong', 0.04], [2, 'all', 0.02], [3, 'all', 0.012]],
} = {}) {
  const n = beats.length;
  if (n < 5 || !onsets.length) return Array.from(beats);
  const B = Float64Array.from(beats);
  const inRange = onsets.filter((o) => o.time > B[0] && o.time < B[n - 1]);
  if (inRange.length < n / 2) return Array.from(beats);
  const strengths = inRange.map((o) => o.strength).sort((a, b) => b - a);
  const strongMin = strengths[Math.max(0, Math.floor(strongShare * strengths.length) - 1)];
  // Strengths are capped at a typical strong hit so no one onset dominates.
  const cap = strengths[Math.floor(0.1 * strengths.length)];
  const jumps = new Set(tempoJumps(beats).map((j) => j.beat));
  // Weights of the regularising terms, scaled to the data: the onset weight
  // a typical beat carries.
  let total = 0;
  for (const o of inRange) total += Math.min(cap, o.strength);
  const perBeat = total / (n - 1);
  const wSmooth = smooth * perBeat;
  const wPrior = prior * perBeat;
  const S = 0.005;
  const C = 0.75;

  let T = Float64Array.from(B);
  for (const [count, which, scale] of iterations) {
    const division = which === 'strong' ? 2 : 4;
    const use = which === 'strong' ? inRange.filter((o) => o.strength >= strongMin) : inRange;
    for (let it = 0; it < count; it++) {
      const A = new Float64Array(n * 3);
      const rhs = new Float64Array(n);
      const add = (i, j, v) => { if (j < i) [i, j] = [j, i]; A[i * 3 + (j - i)] += v; };
      let k = 0;
      for (const o of use) {
        while (k + 2 < n && T[k + 1] <= o.time) k++;
        if (o.time < T[k] || o.time > T[k + 1]) continue;
        const u = (o.time - T[k]) / (T[k + 1] - T[k]);
        const g = Math.round(u * division) / division;
        const r = (1 - g) * T[k] + g * T[k + 1] - o.time;
        const w = Math.min(cap, o.strength) / (1 + (r / scale) ** 2);
        add(k, k, w * (1 - g) * (1 - g));
        add(k, k + 1, w * (1 - g) * g);
        add(k + 1, k + 1, w * g * g);
        rhs[k] += w * (1 - g) * o.time;
        rhs[k + 1] += w * g * o.time;
      }
      for (let i = 0; i < n; i++) {
        add(i, i, wPrior);
        rhs[i] += wPrior * B[i];
      }
      for (let i = 1; i + 1 < n; i++) {
        if (jumps.has(i)) continue;
        const d2 = Math.abs(T[i - 1] - 2 * T[i] + T[i + 1]) / S;
        const ws = wSmooth * (d2 <= C ? 1 : C / d2);
        const ix = [i - 1, i, i + 1];
        const v = [1, -2, 1];
        for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) add(ix[a], ix[b], ws * v[a] * v[b]);
      }
      T = solveBanded(A, rhs, n);
      for (let i = 1; i < n; i++) if (T[i] <= T[i - 1]) T[i] = T[i - 1] + 1e-4;
    }
  }
  return Array.from(T);
}

// Sudden tempo changes: beats where the beat length steps from one steady
// value to another (a section at a new tempo), as opposed to a gradual
// speed-up or slow-down. A step is reported when the beat lengths on each
// side are steady, the step is at least `minJump` seconds and clearly bigger
// than the beat-to-beat jitter, and a single straight line (a ramp) fits the
// lengths much worse than two flat levels. Returns [{ beat, jump }].
export function tempoJumps(beats, { window = 6, minJump = 0.012, ratio = 0.65 } = {}) {
  const W = window;
  const d = [];
  for (let i = 0; i + 1 < beats.length; i++) d.push(beats[i + 1] - beats[i]);
  const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const found = [];
  for (let k = W; k + W <= d.length; k++) {
    const before = d.slice(k - W, k);
    const after = d.slice(k, k + W);
    const mb = median(before);
    const ma = median(after);
    const jump = ma - mb;
    if (Math.abs(jump) < minJump) continue;
    let stepRes = 0;
    for (const x of before) stepRes += Math.abs(x - mb);
    for (const x of after) stepRes += Math.abs(x - ma);
    const ys = before.concat(after);
    const m = ys.length;
    const xm = (m - 1) / 2;
    const ym = ys.reduce((a, b) => a + b, 0) / m;
    let sxy = 0;
    let sxx = 0;
    ys.forEach((y, i) => { sxy += (i - xm) * (y - ym); sxx += (i - xm) ** 2; });
    const slope = sxy / sxx;
    let lineRes = 0;
    ys.forEach((y, i) => { lineRes += Math.abs(y - (ym + slope * (i - xm))); });
    if (stepRes < ratio * lineRes && Math.abs(jump) > (4 * stepRes) / m) found.push({ beat: k, jump, score: lineRes - stepRes });
  }
  found.sort((a, b) => b.score - a.score);
  const out = [];
  for (const f of found) if (!out.some((o) => Math.abs(o.beat - f.beat) < W)) out.push(f);
  return out.sort((a, b) => a.beat - b.beat).map(({ beat, jump }) => ({ beat, jump }));
}

// Banded Cholesky for a symmetric positive definite matrix of bandwidth 2.
function solveBanded(A, B, n) {
  const L = new Float64Array(n * 3); // L[i*3+d] = l[i][i-d]
  for (let i = 0; i < n; i++) {
    const l2 = i >= 2 ? A[(i - 2) * 3 + 2] / L[(i - 2) * 3] : 0;
    const l1 = i >= 1 ? (A[(i - 1) * 3 + 1] - (i >= 2 ? l2 * L[(i - 1) * 3 + 1] : 0)) / L[(i - 1) * 3] : 0;
    L[i * 3] = Math.sqrt(Math.max(A[i * 3] - l1 * l1 - l2 * l2, 1e-12));
    L[i * 3 + 1] = l1;
    L[i * 3 + 2] = l2;
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = B[i];
    if (i >= 1) s -= L[i * 3 + 1] * y[i - 1];
    if (i >= 2) s -= L[i * 3 + 2] * y[i - 2];
    y[i] = s / L[i * 3];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    if (i + 1 < n) s -= L[(i + 1) * 3 + 1] * x[i + 1];
    if (i + 2 < n) s -= L[(i + 2) * 3 + 2] * x[i + 2];
    x[i] = s / L[i * 3];
  }
  return x;
}
