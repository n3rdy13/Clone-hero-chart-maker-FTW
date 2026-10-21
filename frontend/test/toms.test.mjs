// Detect mode: toms vs snare and kick, tom pads, and ghost cymbals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SongAnalyzer, ANALYSIS_SR as SR } from '../src/engine/analyze.js';
import { melSpectrogram } from '../src/engine/drums/transcribe.js';
import { drumFeatures, describeAttack, isTomLike, classifyHits, tomPadsFor, dropGhostCymbals } from '../src/engine/drums/toms.js';
import { buildChart } from '../src/songBuilder.js';
import { LEAD_IN_SECONDS as PAD } from '../src/chartGen.js';
import { parseChart, proDrums } from './chartParse.mjs';
import { tempoBeats, drumPart, renderHits, mulberry32 } from './synth.mjs';

// Mixes voices (fn of seconds since the hit) into a buffer over a little noise.
function render(events, duration, { noise = 0.003, seed = 5 } = {}) {
  const rand = mulberry32(seed);
  const out = new Float32Array(Math.ceil(duration * SR));
  for (let i = 0; i < out.length; i++) out[i] = noise * (rand() * 2 - 1);
  for (const { time, voice, len = 0.6 } of events) {
    const s0 = Math.round(time * SR);
    for (let i = 0; i < len * SR && s0 + i < out.length; i++) out[s0 + i] += voice(i / SR, rand);
  }
  return out;
}

const features = (x) => drumFeatures(x, SR, melSpectrogram(x, SR));
const frameAt = (f, t) => Math.round(t * f.fps);

// A tom: a pitched, slowly decaying sine, with an optional stick click. A
// snare: a noise burst (the wires) with a 200 Hz tone (the shell).
const tom = (hz, decay = 0.2, level = 0.5, stick = 0) => (t, rand) =>
  level * Math.exp(-t / decay) * Math.sin(2 * Math.PI * hz * t) + (stick ? stick * Math.exp(-t / 0.003) * (rand() * 2 - 1) : 0);
const snare = (decay = 0.07, hz = 200) => (t, rand) => 0.4 * Math.exp(-t / decay) * (rand() * 2 - 1 + 0.5 * Math.sin(2 * Math.PI * hz * t));

test('a pitched decaying sine reads as a tom, a noise burst with a 200 Hz tone as a snare', () => {
  for (const hz of [90, 120, 150, 220, 300]) {
    for (const [decay, stick] of [[0.15, 0], [0.3, 0], [0.2, 0.3]]) {
      const f = features(render([{ time: 0.5, voice: tom(hz, decay, 0.5, stick) }], 1.5));
      const d = describeAttack(f, frameAt(f, 0.5));
      const what = `${hz} Hz tom (decay ${decay}, stick ${stick}): buzz ${d.buzz.toFixed(1)} dB, ring ${d.ring.toFixed(1)} dB`;
      assert.ok(isTomLike(d), what);
      assert.ok(d.buzz < -20 && d.ring > -10, what);
      assert.ok(Math.abs(d.pitch / hz - 1) < 0.03, `${hz} Hz tom read as ${d.pitch.toFixed(1)} Hz`);
    }
  }
  // Even a snare that rings as long as a tom (decay 0.12) has its wires.
  for (const decay of [0.05, 0.07, 0.12]) {
    const f = features(render([{ time: 0.5, voice: snare(decay) }], 1.5));
    const d = describeAttack(f, frameAt(f, 0.5));
    assert.ok(!isTomLike(d), `snare (decay ${decay}): buzz ${d.buzz.toFixed(1)} dB, ring ${d.ring.toFixed(1)} dB`);
    assert.ok(d.buzz > -12, `snare buzz ${d.buzz.toFixed(1)} dB`);
    assert.ok(Math.abs(d.pitch / 200 - 1) < 0.03, `snare read as ${d.pitch.toFixed(1)} Hz`);
  }
});

test('snare hits that are toms are split out; a snare with its wires off stays a snare', () => {
  // Backbeat snares, half of them with the wires off (a ringing 196 Hz tone,
  // like the 211 vs 220 Hz in the song this was tuned on), and 140 Hz toms.
  const events = [];
  const truth = [];
  for (let i = 0; i < 24; i++) {
    const time = 0.5 + i * 0.5;
    const kind = i % 3 === 2 ? 'tom' : i % 6 < 2 ? 'wired' : 'wiresOff';
    truth.push({ time, kind });
    events.push({ time, voice: kind === 'tom' ? tom(140, 0.25) : kind === 'wired' ? snare() : tom(196, 0.2, 0.4) });
  }
  const f = features(render(events, 13));
  const hits = truth.map(({ time }) => ({ time, drum: 'snare', strength: 0.8 }));
  const out = classifyHits(hits, f, { stem: true });
  assert.equal(out.length, truth.length);
  for (const { time, kind } of truth) {
    const h = out.find((o) => Math.abs(o.time - time) < 0.03);
    assert.ok(h, `nothing at ${time}`);
    if (kind === 'tom') assert.equal(h.drum, 'highTom', `tom at ${time} came out ${h.drum}`);
    else assert.equal(h.drum, 'snare', `${kind} snare at ${time} came out ${h.drum}`);
  }
});

test('a floor tom in the kick is split out by its long ring; kicks with a beater click stay kicks', () => {
  const kick = (t, rand) => 0.8 * Math.exp(-t / 0.05) * Math.sin(2 * Math.PI * (55 * t + 1.5 * (1 - Math.exp(-t / 0.025)))) + 0.25 * Math.exp(-t / 0.004) * (rand() * 2 - 1);
  const floorTom = (t, rand) => 0.6 * Math.exp(-t / 0.3) * Math.sin(2 * Math.PI * 78 * t) + 0.03 * Math.exp(-t / 0.002) * (rand() * 2 - 1);
  const events = [];
  const truth = [];
  for (let i = 0; i < 20; i++) {
    const time = 0.5 + i * 0.45;
    const kind = i % 4 === 3 ? 'floor' : 'kick';
    truth.push({ time, kind });
    events.push({ time, voice: kind === 'floor' ? floorTom : kick, len: 1 });
  }
  const f = features(render(events, 10.5));
  const hits = truth.map(({ time }) => ({ time, drum: 'kick', strength: 0.9 }));
  const out = classifyHits(hits, f, { stem: true });
  for (const { time, kind } of truth) {
    const h = out.find((o) => Math.abs(o.time - time) < 0.03);
    assert.equal(h?.drum, kind === 'floor' ? 'floorTom' : 'kick', `${kind} at ${time} came out ${h?.drum}`);
  }
  // On a full mix a long low ring is as likely a bass note: kicks stay kicks.
  assert.ok(classifyHits(hits, f, { stem: false }).every((h) => h.drum === 'kick'));
});

test('tom pitches are grouped per song: highest on yellow, middle on blue, lowest on green', () => {
  const PADS = ['Y', 'B', 'G'];
  const pads = (ps) => tomPadsFor(ps).map((p) => PADS[p]).join('');
  // Three toms, a few cents of scatter, and one stray reading.
  assert.equal(pads([220, 214, 226, 160, 156, 163, 118, 115, 121, 300]), 'YYYBBBGGGY');
  // Two rack toms; a rack tom and a floor tom.
  assert.equal(pads([150, 148, 152, 120, 118, 122]), 'YYYBBB');
  assert.equal(pads([150, 148, 152, 75, 76, 74]), 'YYYGGG');
  // One tom: a rack tom on yellow, a floor tom on green.
  assert.equal(pads([140, 142, 138]), 'YYY');
  assert.equal(pads([78, 80, 76]), 'GGG');
});

test('cymbal hits with no attack above 6 kHz (crash wash, snare tails) are dropped', () => {
  const audio = renderHits([
    { time: 0.5, gm: 49 }, // crash
    { time: 0.9, gm: 42 }, // hi-hat while the crash rings
    { time: 1.6, gm: 38 }, // snare
    { time: 2.5, gm: 42 }, // hi-hat on its own
  ], 3.5, { sr: SR, noise: 0.003 });
  const f = features(audio);
  const hits = [
    { time: 0.5, drum: 'crash', strength: 1 },
    { time: 0.7, drum: 'hat', strength: 0.4 }, // crash wash
    { time: 0.9, drum: 'hat', strength: 0.5 },
    { time: 1.2, drum: 'hat', strength: 0.4 }, // crash wash
    { time: 1.6, drum: 'snare', strength: 1 },
    { time: 1.66, drum: 'hat', strength: 0.4 }, // snare tail
    { time: 2.5, drum: 'hat', strength: 0.6 },
  ];
  const kept = dropGhostCymbals(hits, f).map((h) => `${h.drum}@${h.time}`);
  assert.deepEqual(kept, ['crash@0.5', 'hat@0.9', 'snare@1.6', 'hat@2.5']);
});

test('detect mode on a drum stem charts the tom fills on yellow, blue and green, and only there', () => {
  const beats = tempoBeats(() => 100, 50, 0.6);
  const at = (b) => { const i = Math.floor(b); return beats[i] + (b - i) * (beats[i + 1] - beats[i]); };
  const hits = drumPart(16).map((h) => ({ ...h, time: at(h.beat) })); // fills: 220, 220, 160, 120 Hz toms
  const audio = renderHits(hits, hits[hits.length - 1].time + 2, { sr: SR });
  const a = new SongAnalyzer();
  const summary = a.load({ mix: audio, stem: audio, sr: SR });
  const { beats: found } = a.track({});
  const built = buildChart({ analysis: { duration: summary.duration, beats: found, onset: a.onset, acts: a.transcribe() }, drumSource: 'detect' });
  const notes = proDrums(parseChart(built.chart)).map((n) => ({ ...n, time: n.time - PAD }));
  const toms = notes.filter((n) => n.lane !== 'kick' && n.lane !== 'red' && !n.cymbal);
  const truth = hits.filter((h) => [48, 45, 43].includes(h.gm));
  const lane = { 48: 'yellow', 45: 'blue', 43: 'green' };
  assert.equal(toms.length, truth.length, `toms at ${toms.map((n) => `${n.time.toFixed(2)} ${n.lane}`).join(', ')}`);
  truth.forEach((h, i) => {
    assert.ok(Math.abs(toms[i].time - h.time) < 0.025, `tom ${i} at ${toms[i].time.toFixed(3)}s, played at ${h.time.toFixed(3)}s`);
    assert.equal(toms[i].lane, lane[h.gm]);
  });
  // The backbeat snares are all still snares.
  assert.equal(notes.filter((n) => n.lane === 'red').length, hits.filter((h) => h.gm === 38).length);
});

test('detect mode on a full mix turns no snares into toms', () => {
  const beats = tempoBeats(() => 110, 40, 0.6);
  const at = (b) => { const i = Math.floor(b); return beats[i] + (b - i) * (beats[i + 1] - beats[i]); };
  const hits = drumPart(12).filter((h) => ![48, 45, 43].includes(h.gm)).map((h) => ({ ...h, time: at(h.beat) }));
  const audio = renderHits(hits, hits[hits.length - 1].time + 2, { sr: SR, music: true });
  const a = new SongAnalyzer();
  const summary = a.load({ mix: audio, sr: SR });
  const { beats: found } = a.track({});
  const built = buildChart({ analysis: { duration: summary.duration, beats: found, onset: a.onset, acts: a.transcribe() }, drumSource: 'detect' });
  const counts = built.part.counts;
  assert.equal((counts[48] ?? 0) + (counts[45] ?? 0) + (counts[41] ?? 0), 0, `toms: ${JSON.stringify(counts)}`);
  assert.ok(counts[38] >= hits.filter((h) => h.gm === 38).length - 1, `snares: ${counts[38]}`);
});
