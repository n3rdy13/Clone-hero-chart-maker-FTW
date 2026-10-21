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
