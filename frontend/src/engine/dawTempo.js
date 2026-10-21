// Tempo maps from DAW session exports (MusicMastering, Reaper, DAWproject),
// turned into a list of beat times in seconds from the start of the session.
// The chart then uses these beats instead of the ones detected in the audio.
//
// Supported:
//   .mid         a tempo-map MIDI (tempo events; notes are ignored)
//   .rpp         Reaper project: the TEMPOENVEX tempo envelope (PT points)
//   .dawproject  DAWproject: TempoAutomation points. MusicMastering's export
//                only stores one tempo, so it can't carry a tempo map.
import { parseMidi, tempoEvents } from './midiread.js';

// --- .mid ---------------------------------------------------------------------

export function beatsFromTempoMidi(bytes, { untilSeconds = null } = {}) {
  const midi = parseMidi(bytes);
  const tempos = tempoEvents(midi);
  const ppq = midi.ppq;
  let notes = 0;
  for (const t of midi.tracks) for (const e of t) if (e.status !== undefined && (e.status & 0xf0) === 0x90 && e.data[1] > 0) notes++;
  const lastTick = tempos[tempos.length - 1].tick;
  const beats = [];
  let seg = 0;
  let segStartTick = 0;
  let segStartSec = 0;
  for (let k = 0; k < 200000; k++) {
    const tick = k * ppq;
    while (seg + 1 < tempos.length && tempos[seg + 1].tick <= tick) {
      segStartSec += ((tempos[seg + 1].tick - segStartTick) / ppq) * (tempos[seg].us / 1e6);
      segStartTick = tempos[seg + 1].tick;
      seg++;
    }
    const t = segStartSec + ((tick - segStartTick) / ppq) * (tempos[seg].us / 1e6);
    if (untilSeconds != null ? t > untilSeconds : tick > lastTick + 8 * ppq) break;
    beats.push(t);
  }
  return finish(beats, { kind: 'mid', tempoCount: tempos.length, notes });
}

// --- .rpp (Reaper) ------------------------------------------------------------

export function beatsFromReaperProject(text, { untilSeconds = null } = {}) {
  const projectTempo = /^\s*TEMPO\s+([\d.]+)/m.exec(text);
  const block = /<TEMPOENVEX([\s\S]*?)\n\s*>/.exec(text);
  const points = [];
  if (block) {
    for (const m of block[1].matchAll(/^\s*PT\s+([-\d.e]+)\s+([-\d.e]+)(?:\s+(\d+))?/gm)) {
      points.push({ time: Number(m[1]), bpm: Number(m[2]), shape: m[3] === undefined ? 0 : Number(m[3]) });
    }
  }
  if (!points.length) {
    const bpm = projectTempo ? Number(projectTempo[1]) : 120;
    return finish(constantBeats(bpm, 0, untilSeconds), { kind: 'rpp', tempoCount: 1, constant: true, bpm });
  }
  points.sort((a, b) => a.time - b.time);
  return finish(beatsFromTimePoints(points, untilSeconds), { kind: 'rpp', tempoCount: points.length });
}

// Tempo points at absolute times (seconds). shape 1 = hold until the next
// point; anything else = linear ramp to the next point (Reaper's default).
// The first point is taken to be a beat; beats before it are extrapolated
// back at its tempo.
function beatsFromTimePoints(points, untilSeconds) {
  const end = untilSeconds ?? points[points.length - 1].time + 16 * (60 / points[points.length - 1].bpm);
  const beats = [];
  const p0 = points[0];
  for (let t = p0.time - 60 / p0.bpm; t >= -1e-9; t -= 60 / p0.bpm) beats.unshift(Math.max(0, t));
  let phase = 0; // beats since points[0]
  let nextBeat = 0;
  const dt = 0.0005;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const segEnd = b ? b.time : end;
    if (a.shape === 1 || !b) {
      const spb = 60 / a.bpm;
      // Exact for held tempo.
      while (nextBeat <= phase + (segEnd - a.time) / spb + 1e-9) {
        const t = a.time + (nextBeat - phase) * spb;
        if (t > end) break;
        beats.push(t);
        nextBeat++;
      }
      phase += (segEnd - a.time) / spb;
    } else {
      // Linear ramp, integrated numerically.
      let t = a.time;
      while (t < segEnd - 1e-12) {
        const step = Math.min(dt, segEnd - t);
        const bpm = a.bpm + ((b.bpm - a.bpm) * (t + step / 2 - a.time)) / (segEnd - a.time);
        const dPhase = (step * bpm) / 60;
        if (phase + dPhase >= nextBeat - 1e-12) {
          const frac = (nextBeat - phase) / dPhase;
          beats.push(t + frac * step);
          nextBeat++;
        }
        phase += dPhase;
        t += step;
      }
    }
    if (segEnd >= end) break;
  }
  return beats;
}

// --- .dawproject ----------------------------------------------------------------

// xml: the text of project.xml inside the .dawproject zip.
export function beatsFromDawProjectXml(xml, { untilSeconds = null } = {}) {
  const tempo = /<Tempo\b[^>]*\bvalue="([\d.]+)"/.exec(xml);
  const bpm0 = tempo ? Number(tempo[1]) : 120;
  const auto = /<TempoAutomation\b([^>]*)>([\s\S]*?)<\/TempoAutomation>/.exec(xml);
  const points = [];
  if (auto) {
    for (const m of auto[2].matchAll(/<RealPoint\b([^>]*)\/?>/g)) {
      const attr = (n) => { const r = new RegExp(`\\b${n}="([^"]*)"`).exec(m[1]); return r ? r[1] : null; };
      points.push({ at: Number(attr('time')), bpm: Number(attr('value')), shape: attr('interpolation') === 'linear' ? 0 : 1 });
    }
  }
  if (!points.length) {
    return finish(constantBeats(bpm0, 0, untilSeconds), { kind: 'dawproject', tempoCount: 1, constant: true, bpm: bpm0 });
  }
  // Point times are in beats unless the arrangement says seconds.
  const inSeconds = /timeUnit="seconds"/.test(auto[1]) || /<Arrangement\b[^>]*timeUnit="seconds"/.test(xml);
  points.sort((a, b) => a.at - b.at);
  if (inSeconds) return finish(beatsFromTimePoints(points.map((p) => ({ time: p.at, bpm: p.bpm, shape: p.shape })), untilSeconds), { kind: 'dawproject', tempoCount: points.length });
  // Beat-positioned points: walk beat by beat.
  const beats = [];
  let t = 0;
  const lastBeat = untilSeconds == null ? Math.ceil(points[points.length - 1].at) + 16 : Infinity;
  for (let k = 0; k <= lastBeat; k++) {
    beats.push(t);
    if (untilSeconds != null && t > untilSeconds) break;
    // Tempo over [k, k+1], sampled finely so ramps integrate correctly.
    const n = 16;
    for (let s = 0; s < n; s++) {
      const b = k + (s + 0.5) / n;
      let i = 0;
      while (i + 1 < points.length && points[i + 1].at <= b) i++;
      const p = points[i];
      const q = points[i + 1];
      const bpm = p.shape === 0 && q ? p.bpm + ((q.bpm - p.bpm) * (b - p.at)) / (q.at - p.at) : p.bpm;
      t += 60 / bpm / n;
    }
  }
  return finish(beats, { kind: 'dawproject', tempoCount: points.length });
}

// --- shared -------------------------------------------------------------------

function constantBeats(bpm, start, untilSeconds) {
  const out = [];
  const end = untilSeconds ?? 600;
  for (let t = start; t <= end; t += 60 / bpm) out.push(t);
  return out;
}

function finish(beats, info) {
  const kept = dropSqueezedLeadIn(beats);
  return { beats: kept, droppedLeadIn: beats.length - kept.length, ...info };
}

// MusicMastering starts its maps with two beats squeezed into the time before
// the first real beat (207 BPM in a 96 BPM song). Those aren't musical beats,
// so they are dropped; the chart adds its own lead-in.
export function dropSqueezedLeadIn(beats) {
  let b = beats;
  while (b.length > 10) {
    const next = [];
    for (let i = 1; i < 9; i++) next.push(b[i + 1] - b[i]);
    next.sort((x, y) => x - y);
    const typical = next[next.length >> 1];
    if (b[1] - b[0] < 0.75 * typical) b = b.slice(1);
    else break;
  }
  return b;
}

// How well DAW beats line up with the beats detected in this audio, and the
// constant shift between them (DAW + shift = detected). A map from the same
// session usually agrees within a few ms; a map from a different edit or
// release of the song won't line up at all.
export function compareWithDetected(dawBeats, detectedBeats, { window = 0.04 } = {}) {
  const det = [...detectedBeats].sort((a, b) => a - b);
  const diffs = [];
  let j = 0;
  for (const b of dawBeats) {
    while (j + 1 < det.length && det[j + 1] <= b) j++;
    let best = null;
    for (const k of [j, j + 1]) {
      if (k < 0 || k >= det.length) continue;
      const d = det[k] - b;
      if (Math.abs(d) <= window && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
    if (best !== null) diffs.push(best);
  }
  diffs.sort((a, b) => a - b);
  const inRange = dawBeats.filter((b) => b >= det[0] - 0.1 && b <= det[det.length - 1] + 0.1).length;
  const median = diffs.length ? diffs[diffs.length >> 1] : 0;
  const close = diffs.filter((d) => Math.abs(d - median) <= 0.02).length;
  return {
    shift: Math.round(median * 1000) / 1000,
    agreement: inRange ? close / inRange : 0, // share of DAW beats within 20 ms (after the shift) of a detected beat
    matched: diffs.length,
  };
}

// The shift worth applying: only a clear, consistent offset of 3 ms or more.
export function dawShiftToApply(cmp) {
  return cmp.agreement >= 0.5 && Math.abs(cmp.shift) >= 0.003 ? cmp.shift : 0;
}
