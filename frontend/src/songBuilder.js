// One-call chart building on top of the engine, shared by the CLI
// (convert.mjs), the batch converter and the tests. The web app uses the same
// pieces step by step so each one can be adjusted live.
import { buildTempoMap } from './engine/tempomap.js';
import { midiToPart, pickDefaultTrack } from './engine/part.js';
import { makeEvidence, autoAlign, makeKickCheck } from './engine/align.js';
import { detectedPart } from './engine/detect.js';
import { evidenceClass } from './engine/drums/lanes.js';
import {
  LEAD_IN_SECONDS, presetMappingForPitch, isDrumsSection, chartTimeSigs,
  compileChartEvents, chartTempos, generateChartString,
} from './chartGen.js';

// Chart-time grid (song time + lead-in) from detected beats, reaching to the
// end of the audio.
export function gridFromBeats(beats, duration, { pad = LEAD_IN_SECONDS, toleranceMs = 20 } = {}) {
  return buildTempoMap(beats.map((b) => b + pad), { toleranceMs, endTime: duration + pad });
}

export function defaultMappings(part, isDrums) {
  const m = {};
  for (const p of Object.keys(part.counts)) m[p] = presetMappingForPitch(Number(p), isDrums);
  return m;
}

// The evidence a part is aligned against: drum activations when they come
// from a drum stem, otherwise onset envelopes (activations from a full mix
// are too easily fooled by bass and guitar).
export function alignmentEvidence({ onset, acts, pad = LEAD_IN_SECONDS }) {
  if (acts && acts.source === 'stem') return makeEvidence({ acts, pad });
  return makeEvidence({ onset, pad });
}

export function alignPart({ part, pitchMappings, isDrums, map, evidence, duration, pad = LEAD_IN_SECONDS }) {
  const notes = [];
  for (const n of part.notes) {
    if (n.velocity <= 20) continue;
    const mapping = pitchMappings[n.pitch] || 'ignore';
    if (mapping === 'ignore' || mapping === 'starpower') continue;
    const cls = isDrums ? evidenceClass(mapping) : 'any';
    if (cls) notes.push({ beat: n.beat, cls });
  }
  return autoAlign(notes, map.gridTimes, evidence, { audioStart: pad, audioEnd: duration + pad });
}

// The kick check only runs on a drum stem: on a full mix it can't tell a kick
// from a bass note (on a guitar-heavy Harmonix mix it would have flagged 60%
// of the real kicks).
export function kickCheckFor(acts, pad = LEAD_IN_SECONDS) {
  return acts && acts.source === 'stem' ? makeKickCheck(acts, pad) : null;
}

// analysis: { duration, beats, onset, acts } from SongAnalyzer.
// midi: parsed @tonejs/midi (omit for drumSource 'detect').
export function buildChart({
  analysis, midi = null, trackIndex = null, section = 'ExpertDrums', drumSource = 'tab',
  pitchMappings = null, offset = null, meta = {}, musicStream = 'song.ogg',
  autoStarPower = false, spEveryBars = 8, dropFlaggedKicks = false,
  sensitivity = 0.5, division = 4, pad = LEAD_IN_SECONDS, toleranceMs = 20,
}) {
  const { duration, beats, onset, acts } = analysis;
  const map = gridFromBeats(beats, duration, { pad, toleranceMs });
  if (map.gridTimes.length < 2) throw new Error('No steady beat found in the audio.');
  const isDrums = isDrumsSection(section);
  let part;
  let align = null;
  if (drumSource === 'detect') {
    if (!acts) throw new Error('Drum detection needs the drum activations (run transcribe first).');
    part = detectedPart(acts, map.gridTimes, pad, { sensitivity, division });
    offset = 0;
  } else {
    if (!midi) throw new Error('No MIDI file given.');
    part = midiToPart(midi, trackIndex ?? pickDefaultTrack(midi));
  }
  const mappings = pitchMappings ?? defaultMappings(part, isDrums);
  if (offset == null) {
    align = alignPart({ part, pitchMappings: mappings, isDrums, map, evidence: alignmentEvidence({ onset, acts, pad }), duration, pad });
    offset = align.offset;
  }
  const lastBeat = map.gridTimes.length - 1;
  const timeSigs = part.detected ? [{ beat: 0, num: 4, den: 4 }] : chartTimeSigs(part, offset, lastBeat);
  const kickCheck = isDrums ? kickCheckFor(acts, pad) : null;
  const { events, stats } = compileChartEvents({
    part, offset, pitchMappings: mappings, targetSection: section, gridTimes: map.gridTimes,
    kickCheck, dropFlaggedKicks, autoStarPower, spEveryBars, timeSigs,
  });
  const tempos = chartTempos(map);
  const chart = generateChartString({ chartEvents: events, targetSection: section, tempos, timeSigs, meta, musicStream });
  return { chart, events, stats, align, offset, map, tempos, timeSigs, part, kickCheck, pitchMappings: mappings };
}
