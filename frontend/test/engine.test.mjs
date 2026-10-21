// End-to-end and unit tests for the chart engine. Run: npm test (Node 22+).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pkg from '@tonejs/midi';
import { SongAnalyzer, ANALYSIS_SR as SR, matchStem } from '../src/engine/analyze.js';
import { midiToPart } from '../src/engine/part.js';
import { pickHits } from '../src/engine/drums/transcribe.js';
import { buildChart, gridFromBeats, defaultMappings } from '../src/songBuilder.js';
import {
  LEAD_IN_SECONDS as PAD, compileChartEvents, chartTempos, makeTickToSeconds, chartTimeSigs,
  generateChartString, starPowerPhrases, barStartBeats,
} from '../src/chartGen.js';
import { pairFiles, parseSongName } from '../src/batchConvert.js';
import { fixEdgeDoubling } from '../src/engine/tempomap.js';
import { parseChart, proDrums } from './chartParse.mjs';
import { tempoBeats, drumPart, renderHits, mulberry32 } from './synth.mjs';

const { Midi } = pkg;

// A GM drum tab as a MIDI file (channel 10) at its own constant tempo.
function tabMidi(hits, { bpm = 120, timeSigs = [[0, 4, 4]] } = {}) {
  const midi = new Midi();
  midi.header.setTempo(bpm);
  midi.header.timeSignatures = timeSigs.map(([ticks, num, den]) => ({ ticks, timeSignature: [num, den] }));
  const t = midi.addTrack();
  t.channel = 9;
  for (const h of hits) t.addNote({ midi: h.gm, ticks: Math.round(h.beat * midi.header.ppq), durationTicks: 60, velocity: 0.75 });
  return new Midi(midi.toArray()); // round trip, like loading a file
}

const beatTime = (beats, b) => {
  const i = Math.max(0, Math.min(beats.length - 2, Math.floor(b)));
  return beats[i] + (b - i) * (beats[i + 1] - beats[i]);
};

function analyse(audio, stem = null) {
  const a = new SongAnalyzer();
  const summary = a.load({ mix: audio, stem, sr: SR });
  const { beats } = a.track({});
  return { duration: summary.duration, beats, onset: a.onset, acts: a.transcribe(), summary };
}

function chartNotes(chart) {
  return proDrums(parseChart(chart)).map((n) => ({ ...n, time: n.time - PAD }));
}

test('a tab lands on the real hits of a recording whose tempo jumps, and its own tempo is ignored', () => {
  const truthBeats = tempoBeats((t) => (t < 20 ? 100 : 128), 50, 1.1);
  const part = drumPart(16);
  const hits = part.map((h) => ({ ...h, time: beatTime(truthBeats, h.beat) }));
  const duration = hits[hits.length - 1].time + 2;
  const audio = renderHits(hits, duration, { sr: SR, music: true });
  const analysis = analyse(audio, audio); // the drums-only render doubles as its own stem
  assert.equal(analysis.summary.beatSource, 'stem');

  const midi = tabMidi(part, { bpm: 120 });
  const built = buildChart({ analysis, midi });
  const notes = chartNotes(built.chart);
  assert.equal(notes.length, built.events.filter((e) => e.type === 'N' && e.value <= 4).length);
  // Every kick within 25 ms of a real kick.
  const realKicks = hits.filter((h) => h.gm === 36).map((h) => h.time);
  for (const k of notes.filter((n) => n.lane === 'kick')) {
    const err = Math.min(...realKicks.map((t) => Math.abs(t - k.time)));
    assert.ok(err < 0.025, `kick at ${k.time.toFixed(3)}s is ${(err * 1000).toFixed(0)} ms off`);
  }
  assert.equal(notes.filter((n) => n.lane === 'kick').length, realKicks.length);
  // The tab's 120 BPM never appears in the chart; the recording's tempos do.
  const bpms = parseChart(built.chart).tempos.map((t) => t.milli / 1000);
  assert.ok(!bpms.some((b) => Math.abs(b - 120) < 0.5), `tab tempo leaked: ${bpms}`);
  assert.ok(bpms.some((b) => Math.abs(b - 100) < 1.5) && bpms.some((b) => Math.abs(b - 128) < 1.5), `tempos ${bpms}`);
  // Every kick in the tab is real, so nothing is flagged.
  assert.equal(built.stats.flaggedKicks, 0);
});

test('kicks the tab adds where the drummer plays none are flagged, and the tab still starts in the right place', () => {
  const truthBeats = tempoBeats(() => 104, 46, 0.9);
  const part = drumPart(18); // the tab: kicks in every bar
  // The recording: no kick in the first two bars (an intro the AI tab filled in).
  const played = part.filter((h) => !(h.gm === 36 && h.beat < 8));
  const hits = played.map((h) => ({ ...h, time: beatTime(truthBeats, h.beat) }));
  const duration = hits[hits.length - 1].time + 2;
  const audio = renderHits(hits, duration, { sr: SR });
  const analysis = analyse(audio, audio);
  const built = buildChart({ analysis, midi: tabMidi(part, { bpm: 100 }) });

  // Tab beat 0 sits on the first real hit.
  const start = built.map.gridTimes[built.offset] - PAD;
  assert.ok(Math.abs(start - truthBeats[0]) < 0.03, `tab starts at ${start.toFixed(3)}s, expected ${truthBeats[0].toFixed(3)}s`);
  // Exactly the intro kicks are flagged.
  const flagged = built.events.filter((e) => e.flagged);
  const introKicks = part.filter((h) => h.gm === 36 && h.beat < 8).length;
  assert.equal(flagged.length, introKicks, `flagged ${flagged.length}, expected ${introKicks}`);
  for (const e of flagged) assert.ok(e.tick / 480 - built.offset < 8 + 1e-6);

  // And removing them leaves only kicks that are really there.
  const dropped = buildChart({ analysis, midi: tabMidi(part, { bpm: 100 }), dropFlaggedKicks: true });
  assert.equal(dropped.stats.removedKicks, introKicks);
  assert.equal(chartNotes(dropped.chart).filter((n) => n.lane === 'kick').length, played.filter((h) => h.gm === 36).length);
});

test('without a drum stem the kick check is off (a full mix fools it)', () => {
  const truthBeats = tempoBeats(() => 110, 30, 0.8);
  const part = drumPart(10);
  const hits = part.map((h) => ({ ...h, time: beatTime(truthBeats, h.beat) }));
  const audio = renderHits(hits, hits[hits.length - 1].time + 2, { sr: SR, music: true });
  const built = buildChart({ analysis: analyse(audio), midi: tabMidi(part) });
  assert.equal(built.kickCheck, null);
  assert.equal(built.stats.flaggedKicks, 0);
});

test('a drum stem is lined up with the song, and a stem from another song is rejected', () => {
  const rand = mulberry32(7);
  const beats = tempoBeats(() => 96, 40, 0.7);
  const hits = drumPart(14).map((h) => ({ ...h, time: beatTime(beats, h.beat) }));
  const stem = renderHits(hits, 40, { sr: SR });
  const shift = Math.round(0.0125 * SR); // the song is 12.5 ms later than the stem
  const music = renderHits([], 40, { sr: SR, music: true, noise: 0 });
  const mix = new Float32Array(stem.length);
  for (let i = 0; i < mix.length; i++) mix[i] = (stem[i - shift] ?? 0) + music[i] + 0.01 * (rand() * 2 - 1);
  const m = matchStem(mix, stem, SR);
  assert.ok(Math.abs(m.shift - 0.0125) < 0.001, `shift ${m.shift}`);
  assert.ok(m.match > 0.15, `match ${m.match}`);

  const other = renderHits(drumPart(14).map((h) => ({ ...h, time: beatTime(tempoBeats(() => 131, 40, 0.3), h.beat) })), 40, { sr: SR, seed: 9 });
  assert.ok(matchStem(mix, other, SR).match < 0.15);
});

test('chart tempos reproduce the beat grid exactly (no drift)', () => {
  const rand = mulberry32(3);
  const beats = [];
  let t = 0.73;
  for (let i = 0; i < 400; i++) { beats.push(t); t += 60 / (96 + 8 * Math.sin(i / 40)) + 0.004 * (rand() - 0.5); }
  const map = gridFromBeats(beats, t + 1, { toleranceMs: 20 });
  const toSec = makeTickToSeconds(chartTempos(map));
  let worst = 0;
  map.gridTimes.forEach((g, b) => { worst = Math.max(worst, Math.abs(toSec(b * 480) - g)); });
  assert.ok(worst < 0.001, `worst grid error ${(worst * 1000).toFixed(3)} ms`);
  // And the grid follows the detected beats within the tolerance.
  const off = beats.map((b) => Math.min(...map.gridTimes.map((g) => Math.abs(g - (b + PAD)))));
  assert.ok(Math.max(...off) < 0.021, `max ${Math.max(...off)}`);
  assert.ok(map.gridTimes[map.gridTimes.length - 1] >= t + 1 + PAD - 0.7, 'grid reaches the end of the audio');
});

test('a Rock Band / Clone Hero notes.mid keeps its cymbals and toms', () => {
  const midi = new Midi();
  midi.header.setTempo(150);
  const t = midi.addTrack();
  t.name = 'PART DRUMS';
  const ppq = midi.header.ppq;
  const add = (beat, n, len = 60) => t.addNote({ midi: n, ticks: Math.round(beat * ppq), durationTicks: len, velocity: 0.8 });
  add(0, 96); add(0, 100); // kick + green cymbal (crash)
  add(1, 97); add(1, 98); // snare + yellow cymbal (hi-hat)
  add(2, 99); // blue cymbal (ride)
  add(3, 98); add(3, 110, ppq); // yellow tom (marker covers it)
  add(3.5, 99); add(3.5, 111, 60); // blue tom
  add(3.75, 100); add(3.75, 112, 60); // green tom
  add(0, 60); add(0, 72); add(0, 84); // lower difficulties are ignored
  const part = midiToPart(new Midi(midi.toArray()), 0);
  assert.ok(part.rockBand);
  const beats = [];
  for (let b = 0; b <= 8; b++) beats.push(b * 0.4);
  const map = gridFromBeats(beats, 3.2, { toleranceMs: 1 });
  const offset = map.leadInBeats;
  const { events } = compileChartEvents({ part, offset, pitchMappings: defaultMappings(part, true), targetSection: 'ExpertDrums', gridTimes: map.gridTimes });
  const chart = generateChartString({ chartEvents: events, targetSection: 'ExpertDrums', tempos: chartTempos(map), timeSigs: [{ beat: 0, num: 4, den: 4 }] });
  const got = chartNotes(chart).map((n) => `${(n.time).toFixed(2)} ${n.lane}${n.cymbal ? ' cym' : ''}`);
  assert.deepEqual(got, [
    '0.00 kick', '0.00 green cym', '0.40 red', '0.40 yellow cym', '0.80 blue cym',
    '1.20 yellow', '1.40 blue', '1.50 green',
  ]);
});

test('a cymbal and a tom on the same colour: the tom moves; duplicate notes are dropped', () => {
  const part = {
    notes: [
      { beat: 0, pitch: 42, velocity: 90, durBeats: 0 }, { beat: 0, pitch: 48, velocity: 90, durBeats: 0 },
      { beat: 1, pitch: 36, velocity: 90, durBeats: 0 }, { beat: 1, pitch: 35, velocity: 90, durBeats: 0 },
    ],
    counts: { 35: 1, 36: 1, 42: 1, 48: 1 }, timeSigs: [{ beat: 0, num: 4, den: 4 }], endBeat: 1,
  };
  const grid = [0, 0.5, 1, 1.5, 2];
  const { events, stats } = compileChartEvents({ part, offset: 0, pitchMappings: defaultMappings(part, true), targetSection: 'ExpertDrums', gridTimes: grid });
  const pads = events.filter((e) => e.value <= 4).map((e) => `${e.tick}:${e.value}:${e.mappedType}`);
  assert.deepEqual(pads, ['0:2:yellow_cymbal', '0:3:blue_pad', '480:0:kick']);
  assert.equal(stats.moved, 1);
  assert.equal(stats.dropped, 1);
});

test('time signatures: the tab\'s bars are shifted by the offset with a pickup bar before bar 1', () => {
  const part = { timeSigs: [{ beat: 0, num: 4, den: 4 }, { beat: 8, num: 3, den: 4 }, { beat: 11, num: 4, den: 4 }], endBeat: 20 };
  const sigs = chartTimeSigs(part, 6, 40).map((s) => `${s.beat}:${s.num}/${s.den}`);
  assert.deepEqual(sigs, ['0:2/4', '2:4/4', '14:3/4', '17:4/4']);
  assert.deepEqual(barStartBeats(chartTimeSigs(part, 6, 40), 22), [0, 2, 6, 10, 14, 17, 21]);
});

test('auto star power: one-bar phrases on bar lines, about every N bars, only on busy bars', () => {
  const bars = Array.from({ length: 41 }, (_, i) => i * 1920);
  const ticks = [];
  for (let b = 0; b < 40; b++) if (b !== 10) for (let k = 0; k < 8; k++) ticks.push(b * 1920 + k * 240);
  const phrases = starPowerPhrases(ticks, bars, { everyBars: 8 });
  assert.deepEqual(phrases.map((p) => p.tick / 1920), [2, 11, 19, 27, 35]); // bar 10 is empty, so 11
  assert.ok(phrases.every((p) => p.length === 1919));
});

test('detect mode drops weak "snares" that are really kick leakage', () => {
  const fps = 100;
  const n = 400;
  const acts = { kick: new Float32Array(n), snare: new Float32Array(n), cymbal: new Float32Array(n), high: new Float32Array(n) };
  const pulse = (arr, f, v) => { arr[f] = v; arr[f + 1] = v * 0.5; };
  for (let f = 20; f < n - 20; f += 40) pulse(acts.kick, f, 1); // kicks every 400 ms
  for (let f = 41; f < n - 20; f += 80) pulse(acts.snare, f, 1); // real snares, away from the kicks
  for (let f = 20; f < n - 20; f += 80) pulse(acts.snare, f, 0.35); // weak leakage right on kicks
  const raw = pickHits(acts, fps, { snareBleed: 0 }).filter((h) => h.drum === 'snare').length;
  const filtered = pickHits(acts, fps).filter((h) => h.drum === 'snare');
  assert.ok(raw > filtered.length);
  assert.ok(filtered.every((h) => h.strength >= 0.4));
});

test('batch pairing finds the song audio and its drum stem; Songsterr names are cleaned up', () => {
  assert.deepEqual(parseSongName('Unknown Artist-torn Drums-10-21-2026.mid'), { artist: '', song: 'torn' });
  assert.deepEqual(parseSongName('Toadies-Possum Kingdom-06-16-2026.mid'), { artist: 'Toadies', song: 'Possum Kingdom' });
  const rows = pairFiles(
    [{ name: 'Unknown Artist-torn Drums-10-21-2026.mid' }],
    [{ name: 'Torn - Natalie Imbruglia.m4a' }, { name: 'torn_Drums.m4a' }, { name: 'Possum Kingdom.mp3' }],
  );
  assert.equal(rows[0].audio.name, 'Torn - Natalie Imbruglia.m4a');
  assert.equal(rows[0].stem.name, 'torn_Drums.m4a');
  // A drums-only file with no full mix next to it is used as the song itself.
  const solo = pairFiles([{ name: 'possumkingdomdrums.mid' }], [{ name: 'possumkingdomdrums.m4a' }]);
  assert.equal(solo[0].audio.name, 'possumkingdomdrums.m4a');
  assert.equal(solo[0].stem, null);
});

test('beats that jump to double time at the very end of a song are thinned back', () => {
  // A slowdown from 0.63 s to 0.77 s per beat, then four beats at ~0.43 s (the
  // tracker locking onto eighth notes in the last bar).
  const beats = [0];
  for (let i = 0; i < 30; i++) beats.push(beats[beats.length - 1] + 0.6);
  for (const d of [0.63, 0.64, 0.65, 0.66, 0.68, 0.69, 0.71, 0.73, 0.735, 0.755, 0.767]) beats.push(beats[beats.length - 1] + d);
  const lastGood = beats[beats.length - 1];
  for (const d of [0.428, 0.384, 0.44, 0.43]) beats.push(beats[beats.length - 1] + d);
  const fixed = fixEdgeDoubling(beats);
  assert.equal(fixed.length, beats.length - 2);
  assert.equal(fixed[fixed.length - 3], lastGood);
  assert.ok(fixed[fixed.length - 1] - fixed[fixed.length - 2] > 0.8);
  // A steady song, or a real slowdown, is left alone.
  const steady = Array.from({ length: 40 }, (_, i) => 0.5 + i * 0.6);
  assert.deepEqual(fixEdgeDoubling(steady), steady);
  const slowing = beats.slice(0, beats.length - 4);
  assert.deepEqual(fixEdgeDoubling(slowing), slowing);
});
