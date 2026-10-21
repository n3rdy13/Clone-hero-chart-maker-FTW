// Detect mode: drum hits found in the audio, snapped to the beat grid and
// written as a part (General MIDI pitches on grid beats, offset 0) so the rest
// of the chart pipeline treats them like a tab.
import { pickHits } from './drums/transcribe.js';
import { classifyHits } from './drums/toms.js';
import { timeToBeat, snapBeat } from './drums/quantize.js';

// Toms use GM pitches whose default mapping is the matching pad: 48 yellow,
// 45 blue, 41 green.
export const DETECT_GM = { kick: 36, snare: 38, hat: 42, crash: 49, highTom: 48, midTom: 45, floorTom: 41 };
export const DETECT_NAMES = {
  36: 'Kick (detected)', 38: 'Snare (detected)', 42: 'Hi-hat (detected)', 49: 'Crash (detected)',
  48: 'High tom (detected)', 45: 'Mid tom (detected)', 41: 'Floor tom (detected)',
};

// acts: SongAnalyzer.transcribe() result. gridTimes: chart-time grid.
export function detectedPart(acts, gridTimes, pad, { sensitivity = 0.5, division = 4 } = {}) {
  const hits = classifyHits(pickHits(acts.acts, acts.fps, { sensitivity }), acts.features, { stem: acts.source === 'stem', sensitivity });
  const last = gridTimes.length - 1;
  const seen = new Set();
  const notes = [];
  for (const h of hits) {
    const t = h.time + (acts.shift ?? 0) + pad;
    const beat = snapBeat(timeToBeat(gridTimes, t), division);
    if (beat < 0 || beat > last) continue;
    const pitch = DETECT_GM[h.drum];
    const key = `${beat}:${pitch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push({ beat, pitch, velocity: Math.round(64 + 63 * Math.min(1, h.strength)), durBeats: 0 });
  }
  notes.sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
  const counts = {};
  for (const n of notes) counts[n.pitch] = (counts[n.pitch] ?? 0) + 1;
  return {
    name: 'Detected drums', isDrums: true, detected: true, notes,
    timeSigs: [{ beat: 0, num: 4, den: 4 }], tempos: [], bpm: null, tempoRange: null,
    endBeat: notes.length ? notes[notes.length - 1].beat : 0, counts,
  };
}
