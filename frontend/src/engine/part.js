// A "part" is one MIDI track in musical time: notes at beat positions (quarter
// notes from the start of the file), plus the file's bar layout. The tab's
// own tempo is kept only for reference: the chart takes its tempo map from the
// recording, and the part is placed on it by musical position.
//
// Works from a parsed @tonejs/midi `Midi` object (browser and Node).

// Rock Band / Clone Hero notes.mid drum lanes (Expert) -> General MIDI, so an
// existing chart can be re-synced to other audio through the normal GM mapping.
// Pads 98-100 are cymbals unless a tom marker (110-112) covers them.
const RB_EXPERT = { 95: 36, 96: 36, 97: 38 };
const RB_PAD = { 98: [42, 48, 110], 99: [51, 45, 111], 100: [49, 41, 112] }; // [cymbal GM, tom GM, tom marker]

export function isRockBandDrums(track) {
  return /^PART DRUMS$/i.test((track.name || '').trim()) && track.notes.some((n) => n.midi >= 96 && n.midi <= 100);
}

// The track a chart is most likely meant to come from: a drum track on MIDI
// channel 10 (Songsterr exports), a PART DRUMS track, else the busiest track.
export function pickDefaultTrack(midi) {
  let best = -1;
  let bestScore = -1;
  midi.tracks.forEach((t, i) => {
    if (!t.notes.length) return;
    const drum = t.channel === 9 || isRockBandDrums(t) || /drum|perc/i.test(t.name || '');
    const score = (drum ? 1e6 : 0) + t.notes.length;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return Math.max(0, best);
}

export function midiToPart(midi, trackIndex) {
  const ppq = midi.header.ppq || 480;
  const track = midi.tracks[trackIndex];
  if (!track) throw new Error(`MIDI track ${trackIndex} not found`);
  const rb = isRockBandDrums(track);
  let notes;
  if (rb) {
    const markers = { 110: [], 111: [], 112: [] };
    for (const n of track.notes) if (markers[n.midi]) markers[n.midi].push([n.ticks, n.ticks + n.durationTicks]);
    notes = [];
    for (const n of track.notes) {
      let gm = RB_EXPERT[n.midi];
      const pad = RB_PAD[n.midi];
      if (pad) gm = markers[pad[2]].some(([a, b]) => n.ticks >= a && n.ticks < b) ? pad[1] : pad[0];
      if (gm === undefined) continue;
      notes.push({ beat: n.ticks / ppq, pitch: gm, velocity: Math.round(n.velocity * 127), durBeats: 0, double: n.midi === 95 });
    }
  } else {
    notes = track.notes.map((n) => ({
      beat: n.ticks / ppq,
      pitch: n.midi,
      velocity: Math.round(n.velocity * 127),
      durBeats: n.durationTicks / ppq,
    }));
  }
  notes.sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);

  const sigs = (midi.header.timeSignatures || [])
    .map((s) => ({ beat: s.ticks / ppq, num: s.timeSignature[0], den: s.timeSignature[1] || 4 }))
    .sort((a, b) => a.beat - b.beat)
    .filter((s, i, arr) => i === 0 || s.beat !== arr[i - 1].beat || s.num !== arr[i - 1].num || s.den !== arr[i - 1].den);
  // Keep the last signature at each position, then drop repeats.
  const timeSigs = [];
  for (const s of sigs) {
    if (timeSigs.length && Math.abs(timeSigs[timeSigs.length - 1].beat - s.beat) < 1e-9) timeSigs[timeSigs.length - 1] = s;
    else if (!timeSigs.length || timeSigs[timeSigs.length - 1].num !== s.num || timeSigs[timeSigs.length - 1].den !== s.den) timeSigs.push(s);
  }
  if (!timeSigs.length || timeSigs[0].beat > 0) timeSigs.unshift({ beat: 0, num: timeSigs[0]?.num ?? 4, den: timeSigs[0]?.den ?? 4 });

  // The tab's own tempo: the one that covers the most of the part.
  const tempos = (midi.header.tempos || []).map((t) => ({ beat: t.ticks / ppq, bpm: t.bpm })).sort((a, b) => a.beat - b.beat);
  if (!tempos.length || tempos[0].beat > 0) tempos.unshift({ beat: 0, bpm: tempos[0]?.bpm ?? 120 });
  const endBeat = notes.length ? notes[notes.length - 1].beat : 0;
  const spans = new Map();
  tempos.forEach((t, i) => {
    const until = Math.max(t.beat, Math.min(endBeat, tempos[i + 1]?.beat ?? endBeat));
    const b = Math.round(t.bpm * 100) / 100;
    spans.set(b, (spans.get(b) ?? 0) + (until - t.beat));
  });
  const bpm = [...spans.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 120;

  const counts = {};
  for (const n of notes) counts[n.pitch] = (counts[n.pitch] ?? 0) + 1;
  return {
    name: track.name || '',
    channel: track.channel,
    isDrums: rb || track.channel === 9 || /drum|perc/i.test(track.name || ''),
    rockBand: rb,
    notes,
    timeSigs,
    tempos,
    bpm,
    tempoRange: [Math.min(...tempos.map((t) => t.bpm)), Math.max(...tempos.map((t) => t.bpm))],
    endBeat,
    counts,
  };
}

// Seconds of a part beat at the tab's own tempos (used for display only).
export function partBeatToSeconds(part, beat) {
  let s = 0;
  const t = part.tempos;
  for (let i = 0; i < t.length; i++) {
    const a = t[i].beat;
    const b = i + 1 < t.length ? Math.min(beat, t[i + 1].beat) : beat;
    if (b <= a) break;
    s += ((b - a) * 60) / t[i].bpm;
  }
  return s;
}
