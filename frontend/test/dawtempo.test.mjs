// Tests for DAW tempo map import and the meticulous (smoothed per-beat) mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  beatsFromTempoMidi, beatsFromReaperProject, beatsFromDawProjectXml,
  compareWithDetected, dawShiftToApply,
} from '../src/engine/dawTempo.js';
import { readDawTempo } from '../src/dawImport.js';
import { smoothBeats, tempoJumps } from '../src/engine/tempomap.js';
import { gridFromBeats } from '../src/songBuilder.js';
import { mulberry32 } from './synth.mjs';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

// A format-0 MIDI holding only tempo events: [[tick, microsPerBeat], ...].
function tempoMidi(events, ppq = 480) {
  const vlq = (n) => { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out; };
  const body = [];
  let last = 0;
  for (const [tick, us] of events) {
    body.push(...vlq(tick - last), 0xff, 0x51, 3, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff);
    last = tick;
  }
  body.push(0, 0xff, 0x2f, 0);
  const len = body.length;
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, ppq >> 8, ppq & 0xff,
    0x4d, 0x54, 0x72, 0x6b, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
    ...body,
  ]);
}

test('a tempo-map MIDI gives its beats; the squeezed two-beat lead-in is skipped', () => {
  // Two beats at ~207 BPM, then 96 BPM (the MusicMastering layout).
  const r = beatsFromTempoMidi(tempoMidi([[0, 290000], [960, 625000], [960 + 480 * 16, 625000]]));
  assert.equal(r.droppedLeadIn, 2);
  near(r.beats[0], 0.58, 1e-9, 'first beat');
  near(r.beats[1] - r.beats[0], 0.625, 1e-9, 'beat length');
  assert.ok(r.beats.length >= 20);
});

test('a Reaper tempo envelope: held tempos are exact, linear ramps are integrated', () => {
  const held = beatsFromReaperProject(`<REAPER_PROJECT
  TEMPO 120 4 4
  <TEMPOENVEX
    ACT 1 -1
    PT 0 120 1
    PT 10 90 1
  >
>`, { untilSeconds: 20 });
  near(held.beats[20], 10, 1e-9, 'beat 20');
  near(held.beats[21], 10 + 60 / 90, 1e-9, 'beat 21');

  // 100 -> 140 BPM over 4 s: beat k at t where (100t + 5t^2)/60 = k.
  const ramp = beatsFromReaperProject(`<TEMPOENVEX
    PT 0 100 0
    PT 4 140 1
  >`, { untilSeconds: 5 });
  for (const k of [1, 3, 6, 8]) near(ramp.beats[k], (-100 + Math.sqrt(10000 + 1200 * k)) / 10, 0.001, `ramp beat ${k}`);

  // No envelope: one constant tempo, flagged as such.
  const constant = beatsFromReaperProject('<REAPER_PROJECT\n  TEMPO 100 4 4\n>', { untilSeconds: 5 });
  assert.equal(constant.constant, true);
  near(constant.beats[1], 0.6, 1e-9);
});

test('a .dawproject: beat-positioned tempo points, and a warning when it has only one tempo', async () => {
  const xml = `<Project><Transport><Tempo value="120"/></Transport>
    <Arrangement><TempoAutomation><RealPoint time="0" value="120" interpolation="hold"/><RealPoint time="8" value="60" interpolation="hold"/></TempoAutomation></Arrangement></Project>`;
  const r = beatsFromDawProjectXml(xml, { untilSeconds: 8 });
  near(r.beats[8], 4, 1e-9, 'beat 8');
  near(r.beats[9], 5, 1e-9, 'beat 9');

  const zip = new JSZip();
  zip.file('project.xml', '<Project><Transport><Tempo value="96"/></Transport></Project>');
  const read = await readDawTempo('song.dawproject', await zip.generateAsync({ type: 'uint8array' }));
  assert.equal(read.constant, true);
  assert.match(read.warning, /only stores one tempo/);
});

test('DAW beats are checked against the detected beats; only a clear offset is applied', () => {
  const daw = Array.from({ length: 100 }, (_, i) => 1 + i * 0.5);
  const rand = mulberry32(3);
  const detected = daw.map((b) => b + 0.008 + (rand() - 0.5) * 0.006);
  const same = compareWithDetected(daw, detected);
  near(same.shift, 0.008, 0.002, 'shift');
  assert.ok(same.agreement > 0.95);
  assert.equal(dawShiftToApply(same), same.shift);

  // A map from another edit of the song: half a beat out everywhere.
  const other = compareWithDetected(daw, daw.map((b) => b + 0.25));
  assert.ok(other.agreement < 0.1);
  assert.equal(dawShiftToApply(other), 0);
});

test('smoothing pulls a stray beat back but keeps a sudden tempo jump sharp', () => {
  // 120 -> 150 BPM at beat 39, and a slight ritardando that is not a jump.
  const ramp = [];
  for (let i = 0, t = 0; i < 80; i++) { ramp.push(t); t += 0.5 + Math.max(0, i - 30) * 0.004; }
  assert.equal(tempoJumps(ramp).length, 0);
  const beats = [];
  for (let i = 0; i < 40; i++) beats.push(i * 0.5);
  for (let i = 1; i <= 40; i++) beats.push(19.5 + i * 0.4); // 120 -> 150 BPM at once
  const stray = beats.slice();
  stray[10] += 0.015;
  const s = smoothBeats(stray);
  near(s[10], 5, 0.006, 'stray beat');
  assert.deepEqual(tempoJumps(beats).map((x) => x.beat), [39]);
  const j = smoothBeats(beats);
  for (const k of [37, 38, 39, 40, 41, 42]) near(j[k], beats[k], 0.001, `beat ${k} at the jump`);
  // With 6 ms of jitter on every beat, the jump beat stays within jitter.
  const rand = mulberry32(5);
  const noisy = beats.map((b) => b + (rand() - 0.5) * 0.012);
  const jn = smoothBeats(noisy);
  for (const k of [38, 39, 40]) near(jn[k], beats[k], 0.006, `noisy beat ${k} at the jump`);
});

test('a grid built from DAW beats keeps every beat where the DAW put it', () => {
  // A slight ritardando, as a DAW map would have it: no smoothing, one tempo per beat.
  const daw = [];
  for (let i = 0, t = 0.6; i < 60; i++) { daw.push(t); t += 0.625 + i * 0.001; }
  const map = gridFromBeats(daw, daw[daw.length - 1], { pad: 2, toleranceMs: 0, smooth: 0 });
  for (let k = 0; k < 60; k++) near(map.gridTimes[map.leadInBeats + k] - 2, daw[k], 0.0005, `beat ${k}`);
});
