// Pure, framework-agnostic Clone Hero chart generation shared by the React app
// (App.jsx), the batch converter and the headless CLI (convert.mjs).
//
// Time model (taken from drumcharts2026): the tempo map comes from the beats
// detected in the recording, and MIDI notes are placed on that grid by musical
// position. A note at part beat b, with alignment offset o, sits on grid beat
// o + b, i.e. chart tick round((o + b) * 480). The grid already includes the
// silent lead-in that is prepended to the exported audio.
import { DRUM_TARGETS, GM_DRUM_DEFAULTS, LANE_INDEX, CYMBAL_FLAG, resolveConflicts } from './engine/drums/lanes.js';
import { beatToTime } from './engine/drums/quantize.js';
import { KICK_FLAG_BELOW } from './engine/align.js';

export const CHART_RES = 480;
export const LEAD_IN_SECONDS = 2.0; // silence prepended to song.ogg

// --- Preset pitch -> mapping ------------------------------------------------

// Default mapping for a MIDI pitch given the target instrument. Drums use the
// General MIDI percussion map; guitar uses the RB/PS note-96 (and octave-60)
// layout, with note 116 as the star power marker.
export const presetMappingForPitch = (pitch, isDrums) => {
  if (isDrums) return GM_DRUM_DEFAULTS[pitch] ?? 'ignore';
  if (pitch === 96 || pitch === 60) return 'g0';
  if (pitch === 97 || pitch === 61) return 'g1';
  if (pitch === 98 || pitch === 62) return 'g2';
  if (pitch === 99 || pitch === 63) return 'g3';
  if (pitch === 100 || pitch === 64) return 'g4';
  if (pitch === 101 || pitch === 65) return 'g5';
  if (pitch === 102 || pitch === 66) return 'g6';
  if (pitch === 103 || pitch === 67) return 'g7';
  if (pitch === 116) return 'starpower';
  return 'ignore';
};

export const isDrumsSection = (targetSection) => targetSection.toLowerCase().includes('drum');

export const getLaneNoteIndex = (mapping) => {
  const t = DRUM_TARGETS[mapping];
  if (t) return t.double ? 32 : LANE_INDEX[t.lane];
  const g = /^g([0-7])$/.exec(mapping || '');
  return g ? Number(g[1]) : 0;
};

// Mapping id for a lane + cymbal flag (after tom moves), for display.
export const drumMappingId = (lane, cymbal, double = false) => {
  if (lane === 'kick') return double ? 'double_kick' : 'kick';
  if (lane === 'red') return 'red';
  return `${lane}_${cymbal ? 'cymbal' : 'pad'}`;
};

// --- Bars -------------------------------------------------------------------

// Time signatures for the chart: the part's bars shifted by the offset, with a
// pickup bar filling whatever comes before bar 1. Ported from drumcharts2026.
export function chartTimeSigs(part, offset, lastBeat) {
  const sigs = part && part.timeSigs && part.timeSigs.length ? part.timeSigs : [{ beat: 0, num: 4, den: 4 }];
  const endBeat = part ? part.endBeat : 0;
  const bars = [];
  let k = 0;
  const partEnd = Math.max(endBeat + 1, lastBeat - offset + 1);
  for (let start = 0; start < partEnd;) {
    while (k + 1 < sigs.length && sigs[k + 1].beat <= start + 1e-9) k++;
    const len = (sigs[k].num * 4) / sigs[k].den;
    bars.push({ start: start + offset, len, num: sigs[k].num, den: sigs[k].den });
    start += len;
  }
  const out = [];
  const first = bars.find((b) => b.start + b.len > 1e-9);
  if (!first) return [{ beat: 0, num: 4, den: 4 }];
  if (first.start > 1e-9) {
    const r = first.start % first.len;
    if (r > 1e-9) out.push({ beat: 0, ...sigForLength(r) });
    out.push({ beat: r, num: first.num, den: first.den });
  } else if (first.start < -1e-9) {
    out.push({ beat: 0, ...sigForLength(first.start + first.len) });
  }
  for (const b of bars) {
    if (b.start < -1e-9 || b.start > lastBeat) continue;
    out.push({ beat: b.start, num: b.num, den: b.den });
  }
  return out.filter((s, i) => i === 0 || s.num !== out[i - 1].num || s.den !== out[i - 1].den || s.pickup || out[i - 1].pickup);
}

function sigForLength(len) {
  if (Math.abs(len - Math.round(len)) < 1e-6) return { num: Math.round(len), den: 4, pickup: true };
  if (Math.abs(len * 2 - Math.round(len * 2)) < 1e-6) return { num: Math.round(len * 2), den: 8, pickup: true };
  return { num: Math.max(1, Math.round(len * 4)), den: 16, pickup: true };
}

// Beat position of every bar line up to lastBeat.
export function barStartBeats(timeSigs, lastBeat) {
  const out = [];
  const sigs = timeSigs.length ? timeSigs : [{ beat: 0, num: 4, den: 4 }];
  let k = 0;
  for (let b = sigs[0].beat; b <= lastBeat + 1e-9;) {
    while (k + 1 < sigs.length && sigs[k + 1].beat <= b + 1e-9) k++;
    out.push(b);
    let len = (sigs[k].num * 4) / sigs[k].den;
    // A signature change mid-bar restarts the bar there.
    if (k + 1 < sigs.length && sigs[k + 1].beat < b + len - 1e-9) len = sigs[k + 1].beat - b;
    b += len;
  }
  return out;
}

// --- Star power -------------------------------------------------------------

// Harmonix-style phrases: one bar long, starting on a bar line, about every
// `everyBars` bars, only on bars with enough notes to be worth it. (The
// Harmonix charts we compared against use 1-bar phrases roughly every 9 bars.)
export function starPowerPhrases(noteTicks, barTicks, { everyBars = 8, minNotes = 4, skipBars = 2 } = {}) {
  const ticks = [...new Set(noteTicks)].sort((a, b) => a - b);
  if (!ticks.length || barTicks.length < 2) return [];
  const phrases = [];
  const firstBar = barTicks.findIndex((t, i) => i + 1 < barTicks.length && barTicks[i + 1] > ticks[0]);
  let next = Math.max(0, firstBar) + skipBars;
  let j = 0;
  for (let i = 0; i + 1 < barTicks.length; i++) {
    const a = barTicks[i];
    const b = barTicks[i + 1];
    while (j < ticks.length && ticks[j] < a) j++;
    if (i < next) continue;
    let count = 0;
    for (let q = j; q < ticks.length && ticks[q] < b; q++) count++;
    if (count < minNotes) continue;
    phrases.push({ tick: a, length: b - a - 1 });
    next = i + everyBars;
  }
  return phrases;
}

// --- Compile note + star-power events --------------------------------------

// part: from engine/part.js. offset: grid beat of part beat 0.
// gridTimes: chart-time seconds of each grid beat (for the kick check).
// kickCheck: from engine/align.js makeKickCheck, or null.
// Returns { events, stats }. Events carry editor metadata (id, pairId,
// mappedType, originalPitch, flagged, support) that the writer ignores.
export const compileChartEvents = ({
  part, offset = 0, pitchMappings, targetSection, gridTimes,
  kickCheck = null, dropFlaggedKicks = false,
  autoStarPower = false, spEveryBars = 8, timeSigs = null,
}) => {
  const stats = { early: 0, late: 0, ignored: 0, moved: 0, dropped: 0, flaggedKicks: 0, removedKicks: 0 };
  if (!part || !gridTimes || gridTimes.length < 2) return { events: [], stats };
  const lastBeat = gridTimes.length - 1;
  const drums = isDrumsSection(targetSection);
  const placed = [];
  const spRegions = [];
  for (const n of part.notes) {
    const mapping = pitchMappings[n.pitch] || 'ignore';
    if (mapping === 'ignore') { stats.ignored++; continue; }
    const beat = offset + n.beat;
    if (beat < -1e-6) { stats.early++; continue; }
    if (beat > lastBeat + 1e-6) { stats.late++; continue; }
    if (mapping === 'starpower') { spRegions.push({ beat, durBeats: n.durBeats }); continue; }
    if (drums) {
      const t = DRUM_TARGETS[mapping];
      if (!t) { stats.ignored++; continue; }
      placed.push({ beat: Math.max(0, beat), lane: t.lane, cymbal: t.cymbal, double: Boolean(t.double || n.double), pitch: n.pitch });
    } else {
      if (DRUM_TARGETS[mapping]) { stats.ignored++; continue; }
      placed.push({ beat: Math.max(0, beat), value: getLaneNoteIndex(mapping), durBeats: n.durBeats, pitch: n.pitch, mapping });
    }
  }

  const events = [];
  let id = 1;
  if (drums) {
    const resolved = resolveConflicts(placed, CHART_RES);
    stats.moved = resolved.moved;
    stats.dropped = resolved.dropped;
    for (const n of resolved.notes) {
      const tick = Math.round(n.beat * CHART_RES);
      let support = null;
      let flagged = false;
      if (kickCheck && n.lane === 'kick') {
        support = kickCheck.strength(beatToTime(gridTimes, n.beat));
        flagged = support < KICK_FLAG_BELOW;
        if (flagged) stats.flaggedKicks++;
        if (flagged && dropFlaggedKicks) { stats.removedKicks++; continue; }
      }
      const mappedType = drumMappingId(n.lane, n.cymbal, n.double);
      const padId = id++;
      events.push({ id: padId, tick, type: 'N', value: n.double ? 32 : LANE_INDEX[n.lane], duration: 0, originalPitch: n.pitch, mappedType, flagged, support });
      if (n.cymbal && CYMBAL_FLAG[n.lane]) {
        events.push({ id: id++, pairId: padId, tick, type: 'N', value: CYMBAL_FLAG[n.lane], duration: 0, originalPitch: n.pitch, mappedType: `${mappedType}_marker` });
      }
    }
  } else {
    const seen = new Set();
    for (const n of placed) {
      const tick = Math.round(n.beat * CHART_RES);
      const key = `${tick}:${n.value}`;
      if (seen.has(key)) { stats.dropped++; continue; }
      seen.add(key);
      const dur = Math.round(n.durBeats * CHART_RES);
      events.push({ id: id++, tick, type: 'N', value: n.value, duration: dur >= CHART_RES / 4 ? dur : 0, originalPitch: n.pitch, mappedType: n.mapping });
    }
  }

  if (spRegions.length) {
    for (const r of spRegions) events.push({ id: id++, tick: Math.round(r.beat * CHART_RES), type: 'S', value: 2, duration: Math.max(1, Math.round(r.durBeats * CHART_RES)) });
  } else if (autoStarPower) {
    const sigs = timeSigs || [{ beat: 0, num: 4, den: 4 }];
    const bars = barStartBeats(sigs, lastBeat).map((b) => Math.round(b * CHART_RES));
    const noteTicks = events.filter((e) => e.type === 'N' && !isFlagValue(e.value)).map((e) => e.tick);
    for (const p of starPowerPhrases(noteTicks, bars, { everyBars: spEveryBars })) {
      events.push({ id: id++, tick: p.tick, type: 'S', value: 2, duration: p.length });
    }
  }

  events.sort((a, b) => a.tick - b.tick || (a.type === b.type ? a.value - b.value : a.type === 'N' ? -1 : 1));
  return { events, stats };
};

export const isFlagValue = (v) => v === 66 || v === 67 || v === 68;

// --- Tempo ------------------------------------------------------------------

// Tempo events for the .chart. A .chart stores tempo as milli-BPM, so each
// segment's value is chosen to land exactly on the grid time of the next
// tempo change, with the rounding error carried forward (no drift).
export function chartTempos(map) {
  const ev = map.events;
  const g = map.gridTimes;
  const out = [];
  let cum = 0;
  for (let k = 0; k < ev.length; k++) {
    const start = ev[k].beat;
    const end = Math.min(g.length - 1, k + 1 < ev.length ? ev[k + 1].beat : g.length - 1);
    const count = end - start;
    let milli;
    if (count >= 1 && g[end] - cum > 0) milli = Math.round((count * 60000) / (g[end] - cum));
    else milli = Math.round(60e9 / ev[k].microsPerBeat);
    milli = Math.max(1, milli);
    out.push({ tick: start * CHART_RES, milli });
    if (count >= 1) cum += (count * 60000) / milli;
  }
  if (!out.length) out.push({ tick: 0, milli: 120000 });
  return out;
}

// Seconds at a chart tick, exactly as Clone Hero computes it from the tempos.
export function makeTickToSeconds(tempos) {
  const segs = [];
  let t = 0;
  for (let i = 0; i < tempos.length; i++) {
    segs.push({ tick: tempos[i].tick, time: t, spt: 60000 / tempos[i].milli / CHART_RES });
    if (i + 1 < tempos.length) t += (tempos[i + 1].tick - tempos[i].tick) * segs[i].spt;
  }
  return (tick) => {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].tick <= tick) lo = mid; else hi = mid - 1; }
    const s = segs[lo];
    return s.time + (tick - s.tick) * s.spt;
  };
}

export function makeSecondsToTick(tempos) {
  const toSec = makeTickToSeconds(tempos);
  return (sec) => {
    let lo = 0;
    let hi = 1;
    while (toSec(hi) < sec) hi *= 2;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (toSec(mid) < sec) lo = mid; else hi = mid; }
    return Math.round((lo + hi) / 2);
  };
}

// --- .chart text ------------------------------------------------------------

const quote = (s) => `"${String(s ?? '').replace(/["\r\n]/g, ' ').trim()}"`;

export const generateChartString = ({
  chartEvents, targetSection, tempos, timeSigs, meta = {}, musicStream = 'song.ogg',
}) => {
  const lines = [];
  lines.push('[Song]', '{');
  if (meta.name) lines.push(`  Name = ${quote(meta.name)}`);
  if (meta.artist) lines.push(`  Artist = ${quote(meta.artist)}`);
  if (meta.charter) lines.push(`  Charter = ${quote(meta.charter)}`);
  if (meta.album) lines.push(`  Album = ${quote(meta.album)}`);
  if (meta.year) lines.push(`  Year = ${quote(`, ${meta.year}`)}`);
  lines.push('  Offset = 0', `  Resolution = ${CHART_RES}`, '  Player2 = bass', '  Difficulty = 0', '  PreviewStart = 0', '  PreviewEnd = 0');
  if (meta.genre) lines.push(`  Genre = ${quote(meta.genre)}`);
  lines.push('  MediaType = "cd"', `  MusicStream = ${quote(musicStream)}`, '}');

  const sync = [];
  for (const s of timeSigs && timeSigs.length ? timeSigs : [{ beat: 0, num: 4, den: 4 }]) {
    const tick = Math.round(s.beat * CHART_RES);
    sync.push({ tick, order: 0, text: s.den === 4 ? `TS ${s.num}` : `TS ${s.num} ${Math.round(Math.log2(s.den))}` });
  }
  for (const t of tempos && tempos.length ? tempos : [{ tick: 0, milli: 120000 }]) sync.push({ tick: t.tick, order: 1, text: `B ${t.milli}` });
  sync.sort((a, b) => a.tick - b.tick || a.order - b.order);
  lines.push('[SyncTrack]', '{');
  const seen = new Set();
  for (const s of sync) {
    const key = `${s.tick}=${s.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  ${s.tick} = ${s.text}`);
  }
  lines.push('}');

  lines.push('[Events]', '{', '}');

  lines.push(`[${targetSection}]`, '{');
  const sorted = [...chartEvents].sort((a, b) => a.tick - b.tick || (a.type === b.type ? a.value - b.value : a.type === 'N' ? -1 : 1));
  for (const e of sorted) {
    if (e.type === 'S') lines.push(`  ${e.tick} = S 2 ${e.duration}`);
    else lines.push(`  ${e.tick} = N ${e.value} ${e.duration}`);
  }
  lines.push('}');
  return lines.join('\r\n') + '\r\n';
};

// --- song.ini ---------------------------------------------------------------

export const generateSongIni = ({ title, artist, charter, album = '', genre = '', year = '', musicStream = 'song.ogg', songLengthMs = 180000, previewMs = 30000 }) => {
  const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
  return [
    '[song]',
    `name = ${clean(title) || 'Custom Chart'}`,
    `artist = ${clean(artist) || 'Unknown Artist'}`,
    `charter = ${clean(charter) || 'Unknown Charter'}`,
    `album = ${clean(album)}`,
    `year = ${clean(year)}`,
    `genre = ${clean(genre)}`,
    `song_length = ${Math.round(songLengthMs)}`,
    `preview_start_time = ${Math.round(previewMs)}`,
    'delay = 0',
    `music_stream = ${musicStream}`,
    'pro_drums = True',
    'diff_drums = 3',
    'diff_drums_real = 3',
    'diff_guitar = 3',
    'multiplier_note = 116',
    '',
  ].join('\r\n');
};
