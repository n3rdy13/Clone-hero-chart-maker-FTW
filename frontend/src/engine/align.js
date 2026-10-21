// Places a part (e.g. a Songsterr tab) on the detected beat grid: the part's
// beat b lands on grid beat offset + b. The offset is found by matching the
// part's hits against the drum audio.
//
// Based on drumcharts2026's autoAlign, with two changes that matter on real
// songs:
//  - Notes that would land outside the audio (before it starts, after it
//    ends) count against an offset. Before, they were skipped, so on a song
//    whose groove repeats every bar, an offset that threw away the tab's
//    opening bars scored the same as the right one.
//  - A note that lands where the drum audio is silent costs a little, so the
//    edges of the song (intro, breaks, ending) decide between offsets that
//    match the repeated groove equally well.
//
// All times here are chart times: song time + `pad` (the silent lead-in
// added to the exported audio).
import { beatToTime } from './drums/quantize.js';

// Evidence curves, each normalised so a typical strong hit is ~1.
// From NMF activations when available (kick / snare / cymbal), otherwise from
// the onset envelopes (low band for kick, full band for the rest).
export function makeEvidence({ onset = null, acts = null, pad = 0 }) {
  const curves = {};
  let fps;
  let shift;
  if (acts) {
    fps = acts.fps;
    shift = acts.shift ?? 0;
    curves.kick = normalise(acts.acts.kick);
    curves.snare = normalise(acts.acts.snare);
    curves.cymbal = normalise(acts.acts.cymbal);
    const any = new Float32Array(curves.kick.length);
    for (let i = 0; i < any.length; i++) any[i] = Math.max(curves.kick[i], curves.snare[i], curves.cymbal[i]);
    curves.any = any;
  } else if (onset) {
    fps = onset.fps;
    shift = onset.shift ?? 0;
    curves.any = normalise(onset.env);
    curves.kick = onset.envLow ? normalise(onset.envLow) : curves.any;
    curves.snare = curves.any;
    curves.cymbal = curves.any;
  } else {
    throw new Error('No audio evidence to align against');
  }
  const at = (cls, t) => {
    const c = curves[cls] ?? curves.any;
    const f = Math.round((t - pad - shift) * fps);
    let m = 0;
    for (let k = f - 2; k <= f + 2; k++) if (k >= 0 && k < c.length && c[k] > m) m = c[k];
    return m;
  };
  return { at, source: acts ? acts.source ?? 'acts' : 'onset' };
}

// Divide by the 95th percentile of the curve's local peaks, cap at 1.5.
function normalise(curve) {
  const peaks = [];
  for (let i = 1; i < curve.length - 1; i++) if (curve[i] > 0 && curve[i] >= curve[i - 1] && curve[i] > curve[i + 1]) peaks.push(curve[i]);
  peaks.sort((a, b) => a - b);
  const ref = peaks.length ? peaks[Math.floor(peaks.length * 0.95)] : 1;
  const out = new Float32Array(curve.length);
  for (let i = 0; i < curve.length; i++) out[i] = Math.min(1.5, curve[i] / (ref || 1));
  return out;
}

const SILENT = 0.5; // extra cost for a note on silence
const SILENCE_BELOW = 0.1;
// An offset that pushes notes outside the audio only wins if it matches
// clearly better than every offset that keeps the whole part inside: a real
// count-in or an intro the recording lacks shows up as a big improvement,
// a repeated groove shifted by a bar doesn't.
const OUTSIDE_MUST_BEAT_BY = 0.05;

// notes: [{ beat, cls }] where cls is kick | snare | cymbal | any.
// grid: chart-time grid (seconds per grid beat). audioStart/End: chart times.
export function autoAlign(notes, grid, evidence, { audioStart = 0, audioEnd = Infinity, minOffset = -16, maxOffset = null } = {}) {
  const last = grid.length - 1;
  const hi = Math.min(maxOffset ?? last, last);
  const scores = [];
  if (!notes.length || last < 1) return { offset: 0, score: 0, alternatives: [], scores };
  for (let o = minOffset; o <= hi; o++) {
    let s = 0;
    let outside = 0;
    for (const n of notes) {
      const b = o + n.beat;
      const t = beatToTime(grid, b);
      if (b < 0 || t < audioStart - 0.05 || t > audioEnd + 0.5) { outside++; continue; }
      s += evidence.at(n.cls, t);
      if (n.cls !== 'any' && evidence.at('any', t) < SILENCE_BELOW) s -= SILENT;
    }
    scores.push({ offset: o, score: s / notes.length, outside, inside: outside === 0 });
  }
  const ranked = [...scores].sort((a, b) => b.score - a.score);
  const bestAny = ranked[0];
  const bestInside = ranked.find((r) => r.inside);
  const best = !bestInside || bestAny.score > bestInside.score + OUTSIDE_MUST_BEAT_BY * Math.abs(bestInside.score) ? bestAny : bestInside;
  // Close calls worth checking by ear: within 3% of the pick.
  const alternatives = ranked.filter((r) => r !== best && r.score >= best.score - 0.03 * Math.abs(best.score)).slice(0, 3);
  return { offset: best.offset, score: best.score, outside: best.outside, alternatives, scores };
}

// --- kick check -------------------------------------------------------------

// Kicks the drum audio doesn't back up. Strength is the NMF kick activation
// near the note, scaled so a typical strong kick is ~1. Calibrated on a
// Harmonix-charted drum stem: every real kick scored above 0.2, every
// non-kick hit below 0.1, and every tab kick missing from the chart was below
// 0.05.
export const KICK_FLAG_BELOW = 0.15;

export function makeKickCheck(acts, pad = 0) {
  if (!acts) return null;
  const h = acts.acts.kick;
  const peaks = [];
  for (let i = 1; i < h.length - 1; i++) if (h[i] >= h[i - 1] && h[i] > h[i + 1]) peaks.push(h[i]);
  peaks.sort((a, b) => a - b);
  const ref = peaks.length ? peaks[Math.floor(peaks.length * 0.95)] : 1;
  const fps = acts.fps;
  const shift = acts.shift ?? 0;
  const strength = (t) => {
    const f = Math.round((t - pad - shift) * fps);
    let m = 0;
    for (let k = f - 3; k <= f + 3; k++) if (k >= 0 && k < h.length && h[k] > m) m = h[k];
    return m / (ref || 1);
  };
  return { strength, source: acts.source };
}
