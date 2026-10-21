// Tests for the 3:2 / 2:3 metrical-error repair (src/engine/dsp/meter.js) and
// the beat-to-onset fit (fitBeatsToOnsets). Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SongAnalyzer, ANALYSIS_SR as SR } from '../src/engine/analyze.js';
import { pickOnsets, gridCheck } from '../src/engine/dsp/meter.js';
import { fitBeatsToOnsets } from '../src/engine/tempomap.js';
import { buildChart, gridFromBeats } from '../src/songBuilder.js';
import { LEAD_IN_SECONDS as PAD } from '../src/chartGen.js';
import { parseChart, proDrums } from './chartParse.mjs';
import { tomGroovePart, renderHits, tempoBeats, mulberry32 } from './synth.mjs';

const BPM = 128;
const P = 60 / BPM;
const START = 0.6;

// 8 bars of rock, 8 bars of the backbeat-free tom groove, 12 bars of rock, at
// a steady 128 BPM. Analysed once per variant.
const songs = new Map();
function tomGrooveSong({ music = false } = {}) {
  const key = String(music);
  if (songs.has(key)) return songs.get(key);
  const { hits, bars, tomFrom, tomTo } = tomGroovePart({ before: 8, toms: 8, after: 12 });
  const timed = hits.map((h) => ({ ...h, time: START + h.beat * P }));
  const duration = START + bars * 4 * P + 2;
  const audio = renderHits(timed, duration, { sr: SR, music });
  const analyzer = new SongAnalyzer();
  // The drums-only render doubles as its own stem; the full mix has none.
  const summary = analyzer.load({ mix: audio, stem: music ? null : audio, sr: SR });
  const truth = Array.from({ length: bars * 4 }, (_, b) => START + b * P);
  const song = { analyzer, summary, duration, hits: timed, truth, tomFrom: START + tomFrom * P, tomTo: START + tomTo * P };
  songs.set(key, song);
  return song;
}

const tempos = (map) => map.events.filter((e) => !e.leadIn).map((e) => e.bpm);
const nearest = (xs, t) => xs.reduce((m, x) => Math.min(m, Math.abs(x - t)), Infinity);

function assertSteady128(song, beats, label) {
  const map = gridFromBeats(beats, song.duration);
  const bpms = tempos(map);
  const lo = Math.min(...bpms);
  const hi = Math.max(...bpms);
  assert.ok(lo >= BPM - 2 && hi <= BPM + 2, `${label}: map runs ${lo.toFixed(1)}-${hi.toFixed(1)} BPM`);
  // One grid line per real beat, each on the beat (not an eighth or a 16th off).
  const grid = map.gridTimes.map((g) => g - PAD);
  for (const t of song.truth) {
    const err = nearest(grid, t);
    assert.ok(err < 0.015, `${label}: beat at ${t.toFixed(2)}s is ${(err * 1000).toFixed(0)} ms from the grid`);
  }
  const inSong = grid.filter((g) => g > song.truth[0] - P / 2 && g < song.truth[song.truth.length - 1] + P / 2);
  assert.equal(inSong.length, song.truth.length, `${label}: grid beats in the song`);
}

test('a 128 BPM song with an 8-bar backbeat-free tom groove keeps a 128 BPM map (the tracker alone drops to 85)', () => {
  const song = tomGrooveSong();
  assert.equal(song.summary.beatSource, 'stem');

  // The tracker on its own locks onto the tom groove's dotted quarters. If
  // this stops happening, the synthetic no longer exercises the repair.
  const raw = song.analyzer.track({ meterFix: false });
  assert.equal(raw.meter, null);
  const rawMap = gridFromBeats(raw.beats, song.duration);
  const slow = rawMap.perBeat.filter((b) => Math.abs(b.bpm - (BPM * 2) / 3) < 3 && b.time - PAD > song.tomFrom - 1 && b.time - PAD < song.tomTo + 1);
  assert.ok(slow.length >= 8, `expected the bare tracker at ~85 BPM in the tom groove, got ${slow.length} beats there`);

  const res = song.analyzer.track({});
  assertSteady128(song, res.beats, 'stem');

  // The stretch is reported as fixed: tracked at 2/3, put back at 128.
  assert.equal(res.meter.fixed.length, 1, JSON.stringify(res.meter.fixed));
  const fix = res.meter.fixed[0];
  assert.ok(Math.abs(fix.ratio - 2 / 3) < 1e-9);
  assert.ok(fix.from < song.tomTo && fix.to > song.tomFrom, `fixed ${fix.from.toFixed(1)}-${fix.to.toFixed(1)}s`);
  assert.ok(Math.abs(fix.trackedBpm - (BPM * 2) / 3) < 3 && Math.abs(fix.bpm - BPM) < 1, JSON.stringify(fix));
  assert.ok(Math.abs(res.meter.dominantBpm - BPM) < 1);
  assert.deepEqual(res.meter.kept, []);
  assert.deepEqual(res.meter.offGrid, []);
});

test('the same song as a full mix with no stem also keeps a 128 BPM map', () => {
  const song = tomGrooveSong({ music: true });
  assert.equal(song.summary.beatSource, 'mix');
  const res = song.analyzer.track({});
  assertSteady128(song, res.beats, 'mix');
  assert.equal(res.meter.fixed.length, 1);
});

test('the grid check flags the stretch where hits miss the 16ths of the 85 BPM grid, and passes the repaired grid', () => {
  const song = tomGrooveSong();
  const { env, fps } = song.analyzer.onset;
  const onsets = pickOnsets(env, fps);
  const bad = gridCheck(song.analyzer.track({ meterFix: false }).beats, onsets);
  assert.ok(bad.some((w) => w.from < song.tomTo && w.to > song.tomFrom), JSON.stringify(bad));
  for (const w of bad) assert.ok(w.share > 0.015);
  assert.deepEqual(gridCheck(song.analyzer.track({}).beats, onsets), []);
});

test('detect mode: drum hits in the tom groove are snapped onto the hits, not up to ~85 ms off', () => {
  const song = tomGrooveSong();
  const acts = song.analyzer.transcribe();
  const { beats } = song.analyzer.track({});
  const built = buildChart({ analysis: { duration: song.duration, beats, onset: song.analyzer.onset, acts }, drumSource: 'detect' });
  const notes = proDrums(parseChart(built.chart)).map((n) => n.time - PAD);
  const hitTimes = song.hits.map((h) => h.time);
  const inToms = notes.filter((t) => t > song.tomFrom && t < song.tomTo);
  assert.ok(inToms.length >= 16, `${inToms.length} notes in the tom groove`);
  for (const t of notes) {
    const err = nearest(hitTimes, t);
    assert.ok(err < 0.02, `note at ${t.toFixed(3)}s is ${(err * 1000).toFixed(0)} ms from a real hit`);
  }
});

test('a real 3:2 tempo change (128 -> 85.3 BPM with 16th hats -> 128) is left alone', () => {
  // The middle section really is at 2/3 tempo: its 16th hats fall between the
  // 128 BPM 16ths, so the onsets back the tracker and nothing is "fixed".
  const slowFrom = START + 12 * 4 * P;
  const slowTo = slowFrom + (8 * 4 * 60) / ((BPM * 2) / 3);
  const inSlow = (t) => t >= slowFrom - 1e-9 && t < slowTo - 1e-9;
  const truth = tempoBeats((t) => (inSlow(t) ? (BPM * 2) / 3 : BPM), slowTo + 12 * 4 * P + 0.3, START);
  const hits = [];
  truth.forEach((t, i) => {
    const d = (truth[i + 1] ?? t + P) - t;
    hits.push({ time: t, gm: i % 2 ? 38 : 36 }, { time: t, gm: 42 }, { time: t + d / 2, gm: 42 });
    if (inSlow(t)) hits.push({ time: t + d / 4, gm: 42, vel: 0.8 }, { time: t + (3 * d) / 4, gm: 42, vel: 0.8 });
  });
  const duration = truth[truth.length - 1] + 2;
  const audio = renderHits(hits, duration, { sr: SR });
  const a = new SongAnalyzer();
  a.load({ mix: audio, stem: audio, sr: SR });
  const res = a.track({});
  assert.deepEqual(res.meter.fixed, []);
  assert.equal(res.meter.kept.length, 1, JSON.stringify(res.meter.kept));
  const grid = gridFromBeats(res.beats, duration).gridTimes.map((g) => g - PAD);
  for (const t of truth) assert.ok(nearest(grid, t) < 0.015, `beat at ${t.toFixed(2)}s is ${(nearest(grid, t) * 1000).toFixed(0)} ms from the grid`);
});

test('fitting beats to onsets pins the phase with eighths first, so a lagging grid cannot slip a 16th', () => {
  // A 128 BPM band (kick/snare on every beat, hats on the 16ths) and beats
  // that lag it by up to `lag`: what a tracker gives when the band rushes.
  const rand = mulberry32(4);
  const truth = Array.from({ length: 80 }, (_, k) => 1 + k * P);
  const onsets = [];
  for (const t of truth.slice(0, -1)) {
    onsets.push({ time: t + (rand() - 0.5) * 0.006, strength: 6 });
    for (const f of [0.25, 0.5, 0.75]) onsets.push({ time: t + f * P + (rand() - 0.5) * 0.006, strength: f === 0.5 ? 2.5 : 1.8 });
  }
  const worst = (beats) => Math.max(...beats.map((b, k) => Math.abs(b - truth[k])));
  for (const lag of [0.04, 0.08, 0.1]) {
    const off = (k) => (k < 20 ? 0 : k < 30 ? (lag * (k - 20)) / 10 : k < 50 ? lag : k < 60 ? (lag * (60 - k)) / 10 : 0);
    const lagging = truth.map((t, k) => t + off(k));
    const fitted = fitBeatsToOnsets(lagging, onsets);
    assert.ok(worst(fitted) < 0.006, `lag ${lag * 1000} ms: worst beat ${(worst(fitted) * 1000).toFixed(1)} ms off`);
  }
  // Snapping everything to 16ths from the start slips a whole 16th (~117 ms)
  // once the lag passes half a 16th.
  const lagging = truth.map((t, k) => t + (k >= 30 && k < 50 ? 0.08 : k >= 20 && k < 30 ? 0.008 * (k - 20) : k >= 50 && k < 60 ? 0.008 * (60 - k) : 0));
  const naive = fitBeatsToOnsets(lagging, onsets, { iterations: [[7, 'all', 0.02]] });
  assert.ok(worst(naive) > 0.1, `16ths-only worst ${(worst(naive) * 1000).toFixed(1)} ms`);
});
