// Derive Hard/Medium/Easy note sections from compiled Expert-level chart
// events, following the reduction patterns measured across 10 professional
// reference charts (see plan): lower difficulties thin to coarser beat grids,
// strip chords and flags, clamp lanes, and grow sustains where runs were
// removed. Pure and deterministic, 480-PPQ tick domain, framework-agnostic.

import { applySustainHygiene } from './sustain.js';

export { DIFFICULTIES } from './chartGen.js';

const JITTER = 30;          // transcription jitter tolerance (ticks)
const SIXTEENTH = 120;
const EIGHTH = 240;
const BEAT = 480;

// Metric strength of a tick within a measure (snap to the 1/16 grid for
// classification only — output ticks are never re-quantized):
// 5 = measure start, 4 = beat, 3 = eighth, 2 = sixteenth, 1 = off-grid.
export const metricStrength = (tick, measureTicks = 1920) => {
  const snapped = Math.round(tick / SIXTEENTH) * SIXTEENTH;
  const pos = ((snapped % measureTicks) + measureTicks) % measureTicks;
  if (pos === 0) return 5;
  if (pos % BEAT === 0) return 4;
  if (pos % EIGHTH === 0) return 3;
  if (pos % SIXTEENTH === 0) return 2;
  return 1;
};

// Per-difficulty guitar/bass parameters (grids measured from the references:
// Hard bottoms out at 1/8 notes, Medium ~1/4, Easy ~1/2; Easy plays 3 lanes,
// Medium 4; forced/tap flags and opens don't survive below Hard for guitar).
const GUITAR_PARAMS = {
  Hard:   { minGap: EIGHTH, maxChord: 2, laneMax: 4, minStrength: 3, runToSustain: false, keepForced: true },
  Medium: { minGap: BEAT,   maxChord: 2, laneMax: 3, minStrength: 4, runToSustain: true,  keepForced: false },
  Easy:   { minGap: 960,    maxChord: 1, laneMax: 2, minStrength: 4, runToSustain: true,  keepForced: false }
};

const DRUM_PARAMS = {
  Hard:   { kickGap: EIGHTH, snareStrength: 1, cymbalGap: EIGHTH, tomGap: EIGHTH, cymbalRemap: null },
  Medium: { kickGap: BEAT,   snareStrength: 3, cymbalGap: BEAT,   tomGap: BEAT,   cymbalRemap: { 3: 2 } },
  Easy:   { kickGap: BEAT,   snareStrength: 3, cymbalGap: null,   tomGap: 960,    cymbalRemap: { 2: 2, 3: 2, 4: 2 }, kickStrength: 4, tomRemap: { 4: 3 } }
};

const isPlayable = (e) => e.type === 'N' && (e.value <= 4 || e.value === 7);

// --- Guitar / bass ----------------------------------------------------------

export const reduceGuitar = (expertEvents, difficulty, { measureTicks = 1920, isBass = false } = {}) => {
  const base = GUITAR_PARAMS[difficulty];
  if (!base) return expertEvents.slice();
  // Bass lines in the references are strictly single-note at every difficulty.
  const p = isBass ? { ...base, maxChord: 1 } : base;

  // Columnize playable notes by tick; flags (5/6) ride along by tick.
  const byTick = new Map();
  const flagsByTick = new Map();
  for (const e of expertEvents) {
    if (isPlayable(e)) {
      if (!byTick.has(e.tick)) byTick.set(e.tick, []);
      byTick.get(e.tick).push(e);
    } else if (e.type === 'N' && (e.value === 5 || e.value === 6)) {
      if (!flagsByTick.has(e.tick)) flagsByTick.set(e.tick, []);
      flagsByTick.get(e.tick).push(e);
    }
  }
  const columns = [...byTick.entries()]
    .map(([tick, notes]) => ({
      tick, notes,
      strength: metricStrength(tick, measureTicks),
      maxDur: Math.max(...notes.map(n => n.duration || 0))
    }))
    .sort((a, b) => a.tick - b.tick);
  if (columns.length === 0) return [];

  // Pass 1 — grid filter. Always keep the song's first column and columns that
  // start a real sustain (>= 1 beat): those are musical anchors.
  let kept = columns.filter((c, i) =>
    i === 0 || c.strength >= p.minStrength || c.maxDur >= BEAT);

  // Pass 2 — spacing enforcement: drop the weaker of two too-close columns.
  const spaced = [];
  for (const c of kept) {
    const last = spaced[spaced.length - 1];
    if (last && c.tick - last.tick < p.minGap - JITTER) {
      if (c.strength > last.strength) spaced[spaced.length - 1] = c;
      // else: keep last, drop c
    } else spaced.push(c);
  }
  kept = spaced;
  const keptTicks = new Set(kept.map(c => c.tick));

  // Per-column note shaping: chord strip -> open handling -> lane clamp.
  let prevOrigLane = null, prevOutLane = null;
  const out = [];
  for (const c of kept) {
    // Chord strip: keep the lowest lanes (open sorts below green).
    const sorted = [...c.notes].sort((a, b) => (a.value === 7 ? -1 : a.value) - (b.value === 7 ? -1 : b.value));
    const picked = sorted.slice(0, p.maxChord);
    const laneOf = (n) => (n.value === 7 ? (isBass ? 7 : 0) : n.value);

    const usedLanes = new Set();
    for (const n of picked) {
      const orig = laneOf(n);
      let lane = orig === 7 ? 7 : Math.min(orig, p.laneMax);
      // Contour repair for single-note lines: if clamping flattened a moving
      // line, nudge in the original direction of movement.
      if (picked.length === 1 && lane !== 7 && prevOrigLane !== null && prevOutLane !== null &&
          lane === prevOutLane && orig !== prevOrigLane) {
        const dir = Math.sign(orig - prevOrigLane);
        const nudged = lane + dir;
        if (nudged >= 0 && nudged <= p.laneMax) lane = nudged;
      }
      if (lane !== 7 && usedLanes.has(lane)) {
        // Clamp collision inside a chord: slide down to a free lane.
        let alt = lane;
        while (alt > 0 && usedLanes.has(alt)) alt--;
        if (usedLanes.has(alt)) continue;
        lane = alt;
      }
      usedLanes.add(lane);
      out.push({ ...n, value: lane });
      if (picked.length === 1) { prevOrigLane = orig === 7 ? 0 : orig; prevOutLane = lane === 7 ? 0 : lane; }
    }
    if (p.keepForced && flagsByTick.has(c.tick)) {
      for (const f of flagsByTick.get(c.tick)) if (f.value === 5) out.push({ ...f });
    }
  }

  // Run->sustain conversion: when a continuous run of dropped columns (max
  // inter-onset gap < 1 beat) spans the space to the next kept column, extend
  // the earlier kept note(s) to fill it — reproduces the reference pattern of
  // sustain% rising at lower difficulties.
  if (p.runToSustain) {
    const allTicks = columns.map(c => c.tick);
    const keptSorted = kept.map(c => c.tick);
    for (let i = 0; i < keptSorted.length - 1; i++) {
      const a = keptSorted[i], b = keptSorted[i + 1];
      const between = allTicks.filter(t => t > a && t < b && !keptTicks.has(t));
      if (between.length === 0) continue;
      const run = [a, ...between, b];
      let continuous = true;
      for (let j = 1; j < run.length; j++) if (run[j] - run[j - 1] >= BEAT) { continuous = false; break; }
      if (!continuous || b - a < BEAT) continue;
      const newDur = b - a - SIXTEENTH;
      for (const e of out) {
        if (e.tick === a && isPlayable(e) && newDur > (e.duration || 0)) e.duration = newDur;
      }
    }
  }

  const cleaned = applySustainHygiene(out);
  cleaned.sort((a, b) => a.tick - b.tick || a.value - b.value);
  return cleaned;
};

// --- Drums ------------------------------------------------------------------

const classifyDrum = (e, markerTicks) => {
  if (e.value === 0) return 'kick';
  if (e.value === 32) return 'double_kick';
  if (e.value === 1) return 'snare';
  if (e.value >= 2 && e.value <= 4) {
    return markerTicks.has(`${e.tick}:${64 + e.value}`) ? 'cymbal' : 'tom';
  }
  return 'other';
};

export const reduceDrums = (expertEvents, difficulty, { measureTicks = 1920 } = {}) => {
  const p = DRUM_PARAMS[difficulty];
  if (!p) return expertEvents.slice();

  // Cymbal markers (66/67/68) mark which pads are cymbals; they're regenerated
  // from surviving pads at the end rather than carried through remaps.
  const markerTicks = new Set();
  for (const e of expertEvents) {
    if (e.type === 'N' && e.value >= 66 && e.value <= 68) markerTicks.add(`${e.tick}:${e.value}`);
  }

  const pads = expertEvents.filter(e => e.type === 'N' && e.value <= 4);
  const byClass = { kick: [], snare: [], cymbal: [], tom: [] };
  for (const e of pads) {
    const cls = classifyDrum(e, markerTicks);
    if (byClass[cls]) byClass[cls].push(e);
  }
  for (const k of Object.keys(byClass)) byClass[k].sort((a, b) => a.tick - b.tick);

  const thinByGap = (list, gap) => {
    if (gap == null) return [];
    const keep = []; let lastTick = -Infinity;
    for (const e of list) {
      if (e.tick - lastTick >= gap - JITTER) { keep.push(e); lastTick = e.tick; }
    }
    return keep;
  };

  // Snare: backbeats survive everywhere (Hard keeps all).
  const snares = byClass.snare.filter(e => metricStrength(e.tick, measureTicks) >= p.snareStrength);
  const snareTicks = new Set(snares.map(e => e.tick));

  // Kick: thinned by gap (Easy also grid-filtered to beats), but a kick locked
  // to a kept snare (+-jitter) is NEVER dropped — that kick+snare backbone is
  // why reference drum chord% RISES at lower difficulties.
  const kickBase = p.kickStrength
    ? byClass.kick.filter(e => metricStrength(e.tick, measureTicks) >= p.kickStrength)
    : byClass.kick;
  const kicksThinned = thinByGap(kickBase, p.kickGap);
  const kickKept = new Set(kicksThinned.map(e => e.tick));
  for (const e of byClass.kick) {
    if (kickKept.has(e.tick)) continue;
    for (const st of snareTicks) if (Math.abs(e.tick - st) <= JITTER) { kicksThinned.push(e); kickKept.add(e.tick); break; }
  }
  kicksThinned.sort((a, b) => a.tick - b.tick);

  // Cymbals: per-lane thinning kills 1/16 hi-hat subdivisions first; Easy keeps
  // only measure-start crashes.
  let cymbals;
  if (p.cymbalGap == null) {
    cymbals = byClass.cymbal.filter(e => metricStrength(e.tick, measureTicks) === 5);
  } else {
    cymbals = [];
    for (const lane of [2, 3, 4]) {
      cymbals.push(...thinByGap(byClass.cymbal.filter(e => e.value === lane), p.cymbalGap));
    }
  }
  const toms = [];
  for (const lane of [2, 3, 4]) {
    toms.push(...thinByGap(byClass.tom.filter(e => e.value === lane), p.tomGap));
  }

  // Remaps (Medium: blue cym -> yellow; Easy: all cyms -> yellow, green pad -> blue).
  const remapped = [];
  for (const e of cymbals) {
    const lane = p.cymbalRemap ? (p.cymbalRemap[e.value] ?? e.value) : e.value;
    remapped.push({ ...e, value: lane, isCymbal: true });
  }
  for (const e of toms) {
    const lane = p.tomRemap ? (p.tomRemap[e.value] ?? e.value) : e.value;
    remapped.push({ ...e, value: lane, isCymbal: false });
  }

  // Assemble, dedupe (remaps can collide), regenerate cymbal markers.
  const out = [];
  const seen = new Set();
  const push = (e) => {
    const key = `${e.tick}:${e.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { isCymbal, ...rest } = e;
    out.push({ ...rest, duration: 0 });
    if (isCymbal) out.push({ tick: e.tick, type: 'N', value: 64 + e.value, duration: 0, mappedType: 'cymbal_marker', pairId: e.id });
  };
  kicksThinned.forEach(e => push({ ...e, isCymbal: false }));
  snares.forEach(e => push({ ...e, isCymbal: false }));
  remapped.forEach(push);
  // double_kick (32) survives only on Expert — dropped here by construction.

  out.sort((a, b) => a.tick - b.tick || a.value - b.value);
  return out;
};

// --- Star power mirroring ---------------------------------------------------

// Re-fit Expert SP phrases onto a reduced difficulty's surviving onsets:
// phrases must start and end on real notes. Empty phrases are dropped.
export const mirrorStarPowerPhrases = (expertPhrases, reducedEvents) => {
  const onsets = [...new Set(reducedEvents.filter(isPlayable).map(e => e.tick))].sort((a, b) => a - b);
  const phrases = [];
  for (const p of expertPhrases) {
    const inside = onsets.filter(t => t >= p.tick && t <= p.tick + p.duration);
    if (inside.length === 0) continue;
    const first = inside[0], last = inside[inside.length - 1];
    const after = onsets.find(t => t > last);
    const tail = Math.max(1, Math.min(EIGHTH, after ? Math.floor((after - last) / 2) : EIGHTH));
    phrases.push({ tick: first, duration: (last - first) + tail });
  }
  return phrases;
};

// --- All difficulties in one call -------------------------------------------

// expertEvents: compiled Expert-level events (notes + flags + markers + S).
// Returns { Expert, Hard, Medium, Easy } event arrays with SP mirrored.
export const buildAllDifficulties = (expertEvents, { isDrums = false, isBass = false, measureTicks = 1920 } = {}) => {
  const spPhrases = expertEvents.filter(e => e.type === 'S').map(e => ({ tick: e.tick, duration: e.duration }));
  const notes = expertEvents.filter(e => e.type !== 'S');

  const result = { Expert: expertEvents.slice() };
  for (const difficulty of ['Hard', 'Medium', 'Easy']) {
    const reduced = isDrums
      ? reduceDrums(notes, difficulty, { measureTicks })
      : reduceGuitar(notes, difficulty, { measureTicks, isBass });
    const sp = mirrorStarPowerPhrases(spPhrases, reduced).map(p => ({ type: 'S', value: 2, tick: p.tick, duration: p.duration }));
    result[difficulty] = [...reduced, ...sp].sort((a, b) => a.tick - b.tick || (a.value ?? 0) - (b.value ?? 0));
  }
  return result;
};

// --- HOPO forcing (Phase 5) -------------------------------------------------

// Clone Hero applies NATURAL HOPOs in-engine: a non-chord note within the HOPO
// threshold (~1/12 note = 162 ticks at 480 PPQ) of the previous note, on a
// different lane, hammers on automatically. "N 5" FLIPS that default, it does
// not create HOPOs — so 'natural' mode emits nothing. 'strum-downbeats' forces
// a strum on would-be HOPOs that land on a measure start (a common pro
// charting convention that keeps downbeats percussive).
export const computeForcedFlags = (events, { threshold = 162, mode = 'natural', measureTicks = 1920 } = {}) => {
  if (mode !== 'strum-downbeats') return events;

  const columns = new Map();
  for (const e of events) {
    if (!isPlayable(e)) continue;
    if (!columns.has(e.tick)) columns.set(e.tick, new Set());
    columns.get(e.tick).add(e.value);
  }
  const ticks = [...columns.keys()].sort((a, b) => a - b);
  const existingForce = new Set(events.filter(e => e.type === 'N' && e.value === 5).map(e => e.tick));

  const out = events.slice();
  for (let i = 1; i < ticks.length; i++) {
    const tick = ticks[i], prev = ticks[i - 1];
    const lanes = columns.get(tick), prevLanes = columns.get(prev);
    const isChord = lanes.size > 1;
    const sameLane = lanes.size === 1 && prevLanes.size === 1 &&
      [...lanes][0] === [...prevLanes][0];
    const naturalHopo = !isChord && !sameLane && (tick - prev) <= threshold;
    if (naturalHopo && metricStrength(tick, measureTicks) === 5 && !existingForce.has(tick)) {
      out.push({ tick, type: 'N', value: 5, duration: 0, mappedType: 'forced_strum' });
    }
  }
  out.sort((a, b) => a.tick - b.tick || (a.value ?? 0) - (b.value ?? 0));
  return out;
};
