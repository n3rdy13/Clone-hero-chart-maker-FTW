// Practice-section generation for [Events]. Reference charts carry 5-21 named
// sections ("Intro", "Verse 1", "Chorus 1", ..., "Outro"); converted MIDIs
// almost never do, so we derive them from (in preference order):
//   1. MIDI marker/cue-point meta events,
//   2. novelty segmentation over the onset-envelope bands that the tempo
//      fitter (tempoAnalysis.js) already computed from the audio,
//   3. a fixed every-N-measures grid.
// Pure, deterministic, framework-agnostic. 480-PPQ tick domain.

// Piecewise time<->tick converters over a fitted BPM map [{tick,bpm}] (sorted
// or not). Falls back to a constant BPM when the map is empty. This is exact
// under multi-BPM maps, unlike the app's single-BPM `seconds * BPM * 8`.
export const makeTimeTickConverters = (bpmEvents, fallbackBPM = 120, resolution = 480) => {
  const evts = (bpmEvents && bpmEvents.length > 0)
    ? [...bpmEvents].sort((a, b) => a.tick - b.tick)
    : [{ tick: 0, bpm: fallbackBPM }];
  if (evts[0].tick > 0) evts.unshift({ tick: 0, bpm: evts[0].bpm });

  // Precompute cumulative seconds at each BPM-change tick.
  const times = [0];
  for (let i = 1; i < evts.length; i++) {
    const dt = (evts[i].tick - evts[i - 1].tick) / resolution * (60 / evts[i - 1].bpm);
    times.push(times[i - 1] + dt);
  }

  const tickToTime = (tick) => {
    let i = evts.length - 1;
    while (i > 0 && evts[i].tick > tick) i--;
    return times[i] + (tick - evts[i].tick) / resolution * (60 / evts[i].bpm);
  };
  const timeToTick = (t) => {
    let i = times.length - 1;
    while (i > 0 && times[i] > t) i--;
    return Math.round(evts[i].tick + (t - times[i]) * (evts[i].bpm / 60) * resolution);
  };
  return { timeToTick, tickToTime };
};

// --- Source 1: MIDI markers -------------------------------------------------

// @tonejs/midi exposes track meta only partially; markers usually surface in
// header.meta as { type: 'marker'|'cuePoint'|'text', text, ticks }.
export const sectionsFromMidiMarkers = (parsedMidi, { leadInTicks = 0, sourcePPQ = 480 } = {}) => {
  const meta = (parsedMidi && parsedMidi.header && parsedMidi.header.meta) || [];
  const markers = meta.filter(m =>
    (m.type === 'marker' || m.type === 'cuePoint' || m.type === 'text') &&
    m.text && m.text.trim().length > 0 && m.text.trim().length <= 48 &&
    !/^@|^%|copyright|generated|http/i.test(m.text.trim()));
  const seen = new Set();
  const out = [];
  for (const m of markers) {
    const tick = Math.max(0, Math.round(m.ticks * (480 / sourcePPQ)) + leadInTicks);
    if (seen.has(tick)) continue;
    seen.add(tick);
    out.push({ tick, name: m.text.trim() });
  }
  return out.sort((a, b) => a.tick - b.tick);
};

// --- Source 2: audio novelty ------------------------------------------------

// bands: [Float32Array, ...] onset envelopes (from computeOnsetEnvelope), fps:
// envelope frame rate. Boundaries are placed where the average band energy of
// the 2 measures after a point stops resembling the 2 measures before it,
// snapped to measure starts. Labels come from 2-means clustering the section
// energies: louder cluster "Chorus n", quieter "Verse n" (or "Section n" when
// clustering is degenerate).
export const sectionsFromNovelty = ({
  bands, fps, tickToTime, measureTicks, firstNoteTick, lastNoteTick,
  minSectionMeasures = 4, maxSections = 16
}) => {
  if (!bands || bands.length === 0 || !bands[0] || bands[0].length === 0) return [];

  const firstMeasure = Math.floor(firstNoteTick / measureTicks);
  const lastMeasure = Math.ceil(lastNoteTick / measureTicks);
  const nMeasures = lastMeasure - firstMeasure;
  if (nMeasures < minSectionMeasures * 2) return [];

  // Per-measure feature vector: mean energy of each band across the measure.
  const feats = [];
  for (let m = 0; m < nMeasures; m++) {
    const t0 = tickToTime((firstMeasure + m) * measureTicks);
    const t1 = tickToTime((firstMeasure + m + 1) * measureTicks);
    const i0 = Math.max(0, Math.floor(t0 * fps));
    const i1 = Math.min(bands[0].length, Math.max(i0 + 1, Math.floor(t1 * fps)));
    const v = bands.map(band => {
      let s = 0;
      for (let i = i0; i < i1; i++) s += band[i];
      return s / (i1 - i0);
    });
    feats.push(v);
  }

  const avg = (a, b) => {
    const v = new Array(feats[0].length).fill(0);
    let n = 0;
    for (let i = a; i < b; i++) { for (let k = 0; k < v.length; k++) v[k] += feats[i][k]; n++; }
    return v.map(x => x / Math.max(1, n));
  };
  const cosSim = (a, b) => {
    let dot = 0, na = 0, nb = 0;
    for (let k = 0; k < a.length; k++) { dot += a[k] * b[k]; na += a[k] * a[k]; nb += b[k] * b[k]; }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d > 0 ? dot / d : 1;
  };

  const W = 2;
  const novelty = new Array(nMeasures).fill(0);
  for (let m = W; m <= nMeasures - W; m++) {
    novelty[m] = 1 - cosSim(avg(m - W, m), avg(m, Math.min(nMeasures, m + W)));
  }
  const mean = novelty.reduce((s, x) => s + x, 0) / novelty.length;
  const std = Math.sqrt(novelty.reduce((s, x) => s + (x - mean) ** 2, 0) / novelty.length);
  const thresh = mean + 0.8 * std;

  // Peak-pick with minimum separation.
  const peaks = [];
  for (let m = W; m <= nMeasures - W; m++) {
    if (novelty[m] >= thresh &&
        novelty[m] >= (novelty[m - 1] || 0) && novelty[m] >= (novelty[m + 1] || 0)) {
      if (peaks.length > 0 && m - peaks[peaks.length - 1] < minSectionMeasures) {
        if (novelty[m] > novelty[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = m;
      } else peaks.push(m);
    }
  }

  let boundaries = [0, ...peaks.filter(p => p >= minSectionMeasures)];
  boundaries = [...new Set(boundaries)].sort((a, b) => a - b).slice(0, maxSections);

  // Section energies -> 2-means labels.
  const segEnds = [...boundaries.slice(1), nMeasures];
  const energies = boundaries.map((b, i) => {
    const v = avg(b, segEnds[i]);
    return v.reduce((s, x) => s + x, 0);
  });
  let lo = Math.min(...energies), hi = Math.max(...energies);
  let labels = null;
  if (hi - lo > 1e-9 && boundaries.length > 2) {
    for (let iter = 0; iter < 12; iter++) {
      const assign = energies.map(e => (Math.abs(e - hi) < Math.abs(e - lo) ? 1 : 0));
      const g0 = energies.filter((_, i) => assign[i] === 0);
      const g1 = energies.filter((_, i) => assign[i] === 1);
      if (g0.length === 0 || g1.length === 0) break;
      lo = g0.reduce((s, x) => s + x, 0) / g0.length;
      hi = g1.reduce((s, x) => s + x, 0) / g1.length;
      labels = assign;
    }
  }

  let verse = 0, chorus = 0;
  return boundaries.map((b, i) => {
    let name;
    if (i === 0) name = 'Intro';
    else if (i === boundaries.length - 1 && b >= nMeasures * 0.8) name = 'Outro';
    else if (labels) name = labels[i] === 1 ? `Chorus ${++chorus}` : `Verse ${++verse}`;
    else name = `Section ${i + 1}`;
    return { tick: (firstMeasure + b) * measureTicks, name };
  });
};

// --- Source 3: fixed grid ---------------------------------------------------

export const fallbackSections = ({ firstNoteTick, lastNoteTick, measureTicks, everyMeasures = 8, maxSections = 12 }) => {
  const firstMeasure = Math.floor(firstNoteTick / measureTicks);
  const lastMeasure = Math.ceil(lastNoteTick / measureTicks);
  const out = [];
  for (let m = firstMeasure; m < lastMeasure && out.length < maxSections; m += everyMeasures) {
    out.push({ tick: m * measureTicks, name: out.length === 0 ? 'Intro' : `Section ${out.length + 1}` });
  }
  return out;
};

// --- Orchestrator -----------------------------------------------------------

export const generatePracticeSections = ({
  parsedMidi, leadInTicks = 0, sourcePPQ = 480,
  bands, fps, bpmEvents, fallbackBPM = 120,
  measureTicks = 1920, firstNoteTick = 0, lastNoteTick = 0
}) => {
  const fromMarkers = sectionsFromMidiMarkers(parsedMidi, { leadInTicks, sourcePPQ });
  if (fromMarkers.length >= 2) return fromMarkers;

  if (bands && bands.length > 0) {
    const { tickToTime } = makeTimeTickConverters(bpmEvents, fallbackBPM);
    const novel = sectionsFromNovelty({ bands, fps, tickToTime, measureTicks, firstNoteTick, lastNoteTick });
    if (novel.length >= 2) return novel;
  }

  if (lastNoteTick > firstNoteTick) {
    return fallbackSections({ firstNoteTick, lastNoteTick, measureTicks });
  }
  return [];
};
