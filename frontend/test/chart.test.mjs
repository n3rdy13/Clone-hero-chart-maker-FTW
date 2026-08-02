// Unit tests for the chart-quality modules (writer, sustains, difficulty
// reduction, sections). Run with: node --test frontend/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateChartString, generateSongIni, SECTION_ORDER, sectionName, parseSectionName
} from '../src/chartGen.js';
import { applySustainHygiene } from '../src/sustain.js';
import {
  metricStrength, reduceGuitar, reduceDrums, buildAllDifficulties,
  mirrorStarPowerPhrases, computeForcedFlags
} from '../src/difficultyReduction.js';
import {
  makeTimeTickConverters, fallbackSections, generatePracticeSections
} from '../src/sections.js';

const N = (tick, value, duration = 0, extra = {}) => ({ tick, type: 'N', value, duration, ...extra });
const playable = (evts) => evts.filter(e => e.type === 'N' && (e.value <= 4 || e.value === 7));
const lanes = (evts) => new Set(playable(evts).map(e => e.value));

// --- writer -----------------------------------------------------------------

const emptyMidi = { header: { ppq: 480, timeSignatures: [], tempos: [] } };

test('legacy single-section output is preserved without songMeta', () => {
  const s = generateChartString({
    parsedMidi: emptyMidi, chartEvents: [N(0, 0)], targetSection: 'ExpertDrums',
    effectiveBPM: 120, midiBPM: 120, drumSyncOffset: 0
  });
  assert.match(s, /\[Song\]\n\{\n {2}Resolution = 480\n {2}MusicStream = "song\.ogg"\n\}/);
  assert.match(s, /\[ExpertDrums\]/);
  assert.match(s, /0 = N 0 0/);
});

test('songMeta emits the full reference [Song] block with real musicStream', () => {
  const s = generateChartString({
    parsedMidi: emptyMidi, chartEvents: [], targetSection: 'ExpertSingle',
    effectiveBPM: 120, midiBPM: 120, drumSyncOffset: 0,
    songMeta: { name: 'Beer', artist: 'Reel Big Fish', charter: 'me', album: 'Turn', year: 1996, genre: 'Ska', musicStream: 'song.wav' }
  });
  for (const key of ['Name', 'Artist', 'Charter', 'Album', 'Year', 'Offset', 'Player2', 'Difficulty', 'PreviewStart', 'PreviewEnd', 'Genre', 'MediaType']) {
    assert.match(s, new RegExp(`  ${key} = `), `missing [Song] key ${key}`);
  }
  assert.match(s, /MusicStream = "song\.wav"/);
  assert.match(s, /Year = ", 1996"/);
});

test('noteSections are emitted in canonical order with section events', () => {
  const s = generateChartString({
    parsedMidi: emptyMidi, effectiveBPM: 120, midiBPM: 120, drumSyncOffset: 0,
    sectionEvents: [{ tick: 960, name: 'Verse 1' }, { tick: 0, name: 'Intro' }],
    noteSections: [
      { section: 'EasySingle', events: [N(0, 0)] },
      { section: 'ExpertSingle', events: [N(0, 2)] }
    ]
  });
  assert.match(s, /0 = E "section Intro"\n {2}960 = E "section Verse 1"/);
  assert.ok(s.indexOf('[ExpertSingle]') < s.indexOf('[EasySingle]'), 'Expert must precede Easy');
});

test('sectionName/parseSectionName round-trip', () => {
  assert.equal(sectionName('Hard', 'DoubleBass'), 'HardDoubleBass');
  assert.deepEqual(parseSectionName('HardDoubleBass'), { difficulty: 'Hard', instrument: 'DoubleBass' });
  assert.equal(SECTION_ORDER.length, 12);
});

test('generateSongIni carries new metadata and per-instrument diffs', () => {
  const ini = generateSongIni({
    title: 'T', artist: 'A', charter: 'C', album: 'Alb', genre: 'Ska', year: 1998,
    diffGuitar: 3, diffBass: -1, diffDrums: 3
  });
  assert.match(ini, /album = Alb/);
  assert.match(ini, /genre = Ska/);
  assert.match(ini, /year = 1998/);
  assert.match(ini, /diff_bass = -1/);
});

// --- sustains ---------------------------------------------------------------

test('sustain hygiene trims to next onset and zeroes stubs', () => {
  const out = applySustainHygiene([
    N(0, 0, 700),   // overlaps next onset at 480 -> trimmed to 480-120=360
    N(480, 1, 100), // stub < 160 -> zeroed
    N(960, 2, 400)  // final note, long enough -> untouched
  ]);
  assert.equal(out[0].duration, 360);
  assert.equal(out[1].duration, 0);
  assert.equal(out[2].duration, 400);
});

test('sustain hygiene ignores flags and markers', () => {
  const out = applySustainHygiene([N(0, 0, 480), N(100, 5, 0), N(2000, 1, 0)]);
  assert.equal(out[0].duration, 480, 'flag at tick 100 must not truncate the sustain');
});

// --- guitar reduction -------------------------------------------------------

// A dense 2-measure line: 1/8-note run + chords, lanes 0-4.
const guitarExpert = [];
for (let i = 0; i < 16; i++) guitarExpert.push(N(i * 240, i % 5));
guitarExpert.push(N(3840, 0), N(3840, 4)); // chord on downbeat
guitarExpert.push(N(4320, 3), N(4800, 2, 900));

test('easy guitar: no chords, lanes 0-2, min spacing ~1/2 note', () => {
  const out = reduceGuitar(guitarExpert, 'Easy', { measureTicks: 1920 });
  const byTick = new Map();
  for (const e of playable(out)) byTick.set(e.tick, (byTick.get(e.tick) || 0) + 1);
  for (const [, count] of byTick) assert.equal(count, 1, 'Easy must have no chords');
  for (const lane of lanes(out)) assert.ok(lane <= 2, `lane ${lane} > 2 on Easy`);
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] - ticks[i - 1] >= 960 - 30);
});

test('medium guitar: lanes 0-3, max 2-note chords, min spacing ~1/4', () => {
  const out = reduceGuitar(guitarExpert, 'Medium', { measureTicks: 1920 });
  for (const lane of lanes(out)) assert.ok(lane <= 3);
  const byTick = new Map();
  for (const e of playable(out)) byTick.set(e.tick, (byTick.get(e.tick) || 0) + 1);
  for (const [, count] of byTick) assert.ok(count <= 2);
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] - ticks[i - 1] >= 480 - 30);
});

test('hard guitar keeps more notes than medium, medium more than easy', () => {
  const h = playable(reduceGuitar(guitarExpert, 'Hard', { measureTicks: 1920 })).length;
  const m = playable(reduceGuitar(guitarExpert, 'Medium', { measureTicks: 1920 })).length;
  const e = playable(reduceGuitar(guitarExpert, 'Easy', { measureTicks: 1920 })).length;
  assert.ok(h > m && m > e && e > 0, `expected ${h} > ${m} > ${e} > 0`);
});

test('easy/medium convert removed runs into sustains', () => {
  const run = [];
  for (let i = 0; i < 8; i++) run.push(N(i * 240, i % 3)); // continuous eighth run over 1 measure
  run.push(N(1920, 0));
  const out = reduceGuitar(run, 'Easy', { measureTicks: 1920 });
  assert.ok(playable(out).some(e => e.duration > 0), 'expected a run->sustain conversion');
});

test('forced/tap flags are stripped below hard, forced kept on hard', () => {
  const evts = [N(0, 0), N(240, 1), N(240, 5), N(480, 2), N(480, 6)];
  const hard = reduceGuitar(evts, 'Hard', { measureTicks: 1920 });
  const medium = reduceGuitar(evts, 'Medium', { measureTicks: 1920 });
  assert.ok(hard.some(e => e.value === 5), 'Hard keeps forced flags');
  assert.ok(!hard.some(e => e.value === 6), 'Hard strips tap flags');
  assert.ok(!medium.some(e => e.value >= 5 && e.value <= 6), 'Medium strips all flags');
});

test('opens convert to green on guitar below expert, stay on bass', () => {
  const evts = [N(0, 7), N(960, 1)];
  const g = reduceGuitar(evts, 'Hard', { measureTicks: 1920 });
  assert.ok(!g.some(e => e.value === 7) && g.some(e => e.value === 0));
  const b = reduceGuitar(evts, 'Hard', { measureTicks: 1920, isBass: true });
  assert.ok(b.some(e => e.value === 7), 'bass keeps opens');
});

test('bass never has chords at any difficulty', () => {
  const evts = [N(0, 0), N(0, 2), N(960, 1), N(960, 3)];
  for (const d of ['Hard', 'Medium', 'Easy']) {
    const out = reduceGuitar(evts, d, { measureTicks: 1920, isBass: true });
    const byTick = new Map();
    for (const e of playable(out)) byTick.set(e.tick, (byTick.get(e.tick) || 0) + 1);
    for (const [t, count] of byTick) assert.equal(count, 1, `bass chord at ${t} on ${d}`);
  }
});

// --- drums reduction --------------------------------------------------------

const drumExpert = [];
// 2 measures: kick on beats, snare on 2+4, 1/8 hi-hat (yellow cymbal).
for (let m = 0; m < 2; m++) {
  const base = m * 1920;
  for (let b = 0; b < 4; b++) {
    const t = base + b * 480;
    if (b % 2 === 0) drumExpert.push(N(t, 0, 0, { id: `k${m}${b}` }));
    else { drumExpert.push(N(t, 1, 0, { id: `s${m}${b}` })); drumExpert.push(N(t, 0, 0, { id: `ks${m}${b}` })); }
  }
  for (let e16 = 0; e16 < 16; e16++) {
    const t = base + e16 * 120;
    drumExpert.push(N(t, 2, 0, { id: `h${m}${e16}` }));
    drumExpert.push(N(t, 66, 0, { pairId: `h${m}${e16}` }));
  }
}
drumExpert.push(N(3840, 32)); // double kick
drumExpert.sort((a, b) => a.tick - b.tick || a.value - b.value);

test('drum backbone: kicks locked to kept snares survive on easy', () => {
  const out = reduceDrums(drumExpert, 'Easy', { measureTicks: 1920 });
  const snareTicks = out.filter(e => e.value === 1).map(e => e.tick);
  assert.ok(snareTicks.length > 0, 'snares survive');
  for (const st of snareTicks) {
    assert.ok(out.some(e => e.value === 0 && Math.abs(e.tick - st) <= 30), `kick+snare backbone broken at ${st}`);
  }
});

test('drum reduction thins hi-hat subdivisions and drops double kick', () => {
  const expertHats = drumExpert.filter(e => e.value === 2).length;
  for (const d of ['Hard', 'Medium', 'Easy']) {
    const out = reduceDrums(drumExpert, d, { measureTicks: 1920 });
    assert.ok(out.filter(e => e.value === 2).length < expertHats, `${d} must thin hats`);
    assert.ok(!out.some(e => e.value === 32), `${d} must drop double kick`);
  }
});

test('cymbal markers are regenerated only for surviving cymbal pads', () => {
  const out = reduceDrums(drumExpert, 'Medium', { measureTicks: 1920 });
  const cymbalPads = out.filter(e => e.value === 2).map(e => e.tick).sort();
  const markers = out.filter(e => e.value === 66).map(e => e.tick).sort();
  assert.deepEqual(markers, cymbalPads);
  assert.ok(!out.some(e => e.value === 67 || e.value === 68), 'no orphaned markers');
});

// --- SP mirroring & buildAllDifficulties ------------------------------------

test('SP phrases mirror onto surviving notes and drop when empty', () => {
  const phrases = [{ tick: 0, duration: 900 }, { tick: 5000, duration: 200 }];
  const reduced = [N(100, 0), N(600, 1), N(900, 2)];
  const out = mirrorStarPowerPhrases(phrases, reduced);
  assert.equal(out.length, 1);
  assert.equal(out[0].tick, 100, 'phrase snaps to first surviving onset');
});

test('buildAllDifficulties returns 4 difficulties with equal SP phrase counts when notes survive', () => {
  const evts = [...guitarExpert, { type: 'S', value: 2, tick: 0, duration: 1900 }];
  const all = buildAllDifficulties(evts, { measureTicks: 1920 });
  assert.deepEqual(Object.keys(all).sort(), ['Easy', 'Expert', 'Hard', 'Medium']);
  for (const d of ['Expert', 'Hard', 'Medium', 'Easy']) {
    assert.equal(all[d].filter(e => e.type === 'S').length, 1, `${d} SP mirrored`);
  }
});

// --- HOPO forcing -----------------------------------------------------------

test('natural mode emits nothing; strum-downbeats forces measure starts only', () => {
  const evts = [N(1800, 0), N(1920, 1), N(2040, 2)];
  assert.equal(computeForcedFlags(evts, { mode: 'natural' }).length, 3);
  const forced = computeForcedFlags(evts, { mode: 'strum-downbeats', measureTicks: 1920 });
  const flags = forced.filter(e => e.value === 5);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].tick, 1920);
});

// --- sections ---------------------------------------------------------------

test('time/tick converters are exact under a multi-BPM map', () => {
  const { timeToTick, tickToTime } = makeTimeTickConverters([{ tick: 0, bpm: 120 }, { tick: 480, bpm: 60 }]);
  assert.equal(tickToTime(480), 0.5);        // one beat at 120
  assert.equal(tickToTime(960), 1.5);        // plus one beat at 60
  assert.equal(timeToTick(1.5), 960);
});

test('fallback sections cover the song at 8-measure spacing', () => {
  const out = fallbackSections({ firstNoteTick: 0, lastNoteTick: 1920 * 24, measureTicks: 1920 });
  assert.equal(out.length, 3);
  assert.equal(out[0].name, 'Intro');
  assert.equal(out[1].tick, 1920 * 8);
});

test('generatePracticeSections prefers midi markers', () => {
  const midi = { header: { ppq: 480, meta: [
    { type: 'marker', text: 'Intro', ticks: 0 },
    { type: 'marker', text: 'Chorus', ticks: 1920 }
  ] } };
  const out = generatePracticeSections({ parsedMidi: midi, measureTicks: 1920, firstNoteTick: 0, lastNoteTick: 3840 });
  assert.deepEqual(out.map(s => s.name), ['Intro', 'Chorus']);
});
