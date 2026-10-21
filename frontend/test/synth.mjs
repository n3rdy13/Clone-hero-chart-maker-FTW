// Synthetic drum audio with a known beat grid, for the tests.
// Copied from drumcharts2026 (src/synth.js).

export function constantBeats(bpm, duration, start = 0.5) {
  return tempoBeats(() => bpm, duration, start);
}

// sections: [{ bpm, until }] — tempo jumps at each `until` (seconds).
export function stepBeats(sections, duration, start = 0.5) {
  return tempoBeats((t) => (sections.find((s) => t < s.until) ?? sections[sections.length - 1]).bpm, duration, start);
}

export function rampBeats(bpm0, bpm1, rampStart, rampEnd, duration, start = 0.5) {
  return tempoBeats((t) => {
    if (t <= rampStart) return bpm0;
    if (t >= rampEnd) return bpm1;
    return bpm0 + ((bpm1 - bpm0) * (t - rampStart)) / (rampEnd - rampStart);
  }, duration, start);
}

// Each beat lasts 60 / tempo(t) seconds, with tempo read at the beat's start,
// so tempo steps land exactly on a beat.
export function tempoBeats(tempo, duration, start = 0.5) {
  const beats = [];
  for (let t = start; t < duration - 0.2; t += 60 / tempo(t)) beats.push(t);
  return beats;
}

export function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Drum grooves over a sustained bass drone and background noise.
//   rock: kick on 1 and 3, snare on 2 and 4, closed hi-hat on every eighth
//   four: kick on every beat, clap on 2 and 4, open hi-hat on the off-beats
export function renderDrums(beats, duration, { sr = 22050, noise = 0.03, seed = 1, pattern = 'rock' } = {}) {
  const rand = mulberry32(seed);
  const out = new Float32Array(Math.ceil(duration * sr));
  const add = (at, len, fn) => {
    const s0 = Math.round(at * sr);
    const n = Math.round(len * sr);
    for (let i = 0; i < n && s0 + i < out.length; i++) if (s0 + i >= 0) out[s0 + i] += fn(i / sr);
  };
  const kick = (at) => add(at, 0.25, (t) => 0.7 * Math.exp(-t / 0.08) * Math.sin(2 * Math.PI * (50 * t + 60 * 0.03 * (1 - Math.exp(-t / 0.03)))));
  const snare = (at) => add(at, 0.2, (t) => 0.35 * Math.exp(-t / 0.06) * (rand() * 2 - 1 + 0.5 * Math.sin(2 * Math.PI * 190 * t)));
  const hat = (at, decay, level) => add(at, 6 * decay, (t) => level * Math.exp(-t / decay) * (rand() * 2 - 1));
  beats.forEach((b, i) => {
    const next = beats[i + 1];
    const off = next === undefined ? undefined : (b + next) / 2;
    if (pattern === 'four') {
      kick(b);
      if (i % 2 === 1) snare(b);
      if (off !== undefined) hat(off, 0.05, 0.12);
    } else {
      if (i % 2 === 0) kick(b); else snare(b);
      hat(b, 0.015, 0.12);
      if (off !== undefined) hat(off, 0.015, 0.12);
    }
  });
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    out[i] += 0.05 * Math.sin(2 * Math.PI * 55 * t) + noise * (rand() * 2 - 1);
  }
  return out;
}

export function encodeWav(samples, sr) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Uint8Array(buf);
}

// A drum part in beats with GM note numbers: a rock groove with a crash at
// the top of every 4 bars and a tom fill at the end of every 8th bar.
export function drumPart(bars, { beatsPerBar = 4, startBeat = 0 } = {}) {
  const hits = [];
  for (let bar = 0; bar < bars; bar++) {
    const b0 = startBeat + bar * beatsPerBar;
    const fill = bar % 8 === 7;
    for (let beat = 0; beat < beatsPerBar; beat++) {
      const b = b0 + beat;
      const lastBeat = beat === beatsPerBar - 1;
      if (fill && lastBeat) {
        [48, 48, 45, 43].forEach((gm, i) => hits.push({ beat: b + i / 4, gm }));
        continue;
      }
      if (beat % 2 === 0) hits.push({ beat: b, gm: 36 }); else hits.push({ beat: b, gm: 38 });
      if (beat === 0 && bar % 4 === 0) hits.push({ beat: b, gm: 49 });
      else hits.push({ beat: b, gm: 42 });
      hits.push({ beat: b + 0.5, gm: 42 });
    }
  }
  return hits;
}

// Renders [{ time, gm }] with simple synthetic drum voices. `music` adds a
// bass line and chord pad so the drums sit in a full mix.
export function renderHits(hits, duration, { sr = 22050, noise = 0.02, seed = 3, music = false } = {}) {
  const rand = mulberry32(seed);
  const out = new Float32Array(Math.ceil(duration * sr));
  const add = (at, len, fn) => {
    const s0 = Math.round(at * sr);
    const n = Math.round(len * sr);
    for (let i = 0; i < n && s0 + i < out.length; i++) if (s0 + i >= 0) out[s0 + i] += fn(i / sr);
  };
  // One-pole high-pass state per voice call keeps cymbals bright.
  const bright = (level, decay) => {
    let prev = 0;
    return (t) => { const x = rand() * 2 - 1; const y = x - prev; prev = x; return level * Math.exp(-t / decay) * y; };
  };
  const voices = {
    kick: (at) => add(at, 0.3, (t) => 0.7 * Math.exp(-t / 0.08) * Math.sin(2 * Math.PI * (50 * t + 60 * 0.03 * (1 - Math.exp(-t / 0.03))))),
    snare: (at) => add(at, 0.25, (t) => 0.4 * Math.exp(-t / 0.07) * (rand() * 2 - 1 + 0.5 * Math.sin(2 * Math.PI * 190 * t))),
    hat: (at) => add(at, 0.08, bright(0.18, 0.015)),
    crash: (at) => add(at, 1.6, bright(0.22, 0.45)),
    ride: (at) => add(at, 0.8, (t) => 0.08 * Math.exp(-t / 0.3) * (Math.sin(2 * Math.PI * 3100 * t) + Math.sin(2 * Math.PI * 4700 * t)) + bright(0.04, 0.2)(t)),
    tom: (f) => (at) => add(at, 0.45, (t) => 0.5 * Math.exp(-t / 0.18) * Math.sin(2 * Math.PI * f * (1 + 0.3 * Math.exp(-t / 0.05)) * t)),
  };
  const byGm = {
    35: voices.kick, 36: voices.kick, 37: voices.snare, 38: voices.snare, 40: voices.snare,
    42: voices.hat, 44: voices.hat, 46: voices.hat, 49: voices.crash, 57: voices.crash, 52: voices.crash, 55: voices.crash,
    51: voices.ride, 59: voices.ride, 48: voices.tom(220), 50: voices.tom(260), 45: voices.tom(160), 47: voices.tom(180), 41: voices.tom(100), 43: voices.tom(120),
  };
  for (const h of hits) byGm[h.gm]?.(h.time);
  const roots = [55, 55 * 1.335, 55 * 1.498, 55 * 1.26];
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    out[i] += noise * (rand() * 2 - 1);
    if (music) {
      const f = roots[Math.floor(t / 2) % 4];
      out[i] += 0.12 * Math.sin(2 * Math.PI * f * t) + 0.04 * (Math.sin(2 * Math.PI * f * 4 * t) + Math.sin(2 * Math.PI * f * 5 * t) + Math.sin(2 * Math.PI * f * 6 * t));
    }
  }
  return out;
}
