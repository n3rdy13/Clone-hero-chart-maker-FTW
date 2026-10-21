// Dynamic-programming beat tracker (after Ellis 2007) that follows a
// time-varying beat period instead of a single global tempo.

export function trackBeats(env, fps, period, { tightness = 100, bandSec = 1 } = {}) {
  const n = env.length;
  if (n < 3) return new Float64Array(0);

  const periodScale = median(period);
  const local = gaussianSmooth(env, Math.max(0.5, periodScale / 32));

  // Around a tempo change the curve's switch point is only accurate to about
  // a second, so any interval inside the local period range costs nothing.
  const radius = Math.max(1, Math.round(bandSec * fps));
  const lo = slidingExtreme(period, radius, (a, b) => a <= b);
  const hi = slidingExtreme(period, radius, (a, b) => a >= b);

  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  let localMax = 0;
  for (let t = 0; t < n; t++) localMax = Math.max(localMax, local[t]);
  let started = false;
  for (let t = 0; t < n; t++) {
    const pLo = lo[t];
    const pHi = hi[t];
    const first = Math.max(0, t - Math.round(2 * pHi));
    const last = t - Math.max(1, Math.round(pLo / 2));
    let best = -Infinity;
    let arg = -1;
    // A virtual beat before the start of the file, so the first real beat
    // isn't forced into a badly spaced link with the silence before it.
    if (t + 1 <= 2 * pHi) {
      const d = Math.max(t + 1, pLo);
      const off = d > pHi ? Math.log(d / pHi) : 0;
      best = -tightness * off * off;
    }
    for (let p = first; p <= last; p++) {
      const d = t - p;
      const off = d < pLo ? Math.log(d / pLo) : d > pHi ? Math.log(d / pHi) : 0;
      const v = score[p] - tightness * off * off;
      if (v > best) { best = v; arg = p; }
    }
    score[t] = local[t] + best;
    // Leading near-silence starts no chain.
    if (!started && local[t] < 0.01 * localMax) {
      back[t] = -1;
    } else {
      back[t] = arg;
      started = true;
    }
  }

  // Start the backtrace at the last strong local maximum of the cumulative score.
  const peaks = [];
  for (let t = 1; t < n - 1; t++) {
    if (score[t] > score[t - 1] && score[t] >= score[t + 1]) peaks.push(t);
  }
  if (peaks.length === 0) return new Float64Array(0);
  const med = median(peaks.map((t) => score[t]));
  let end = peaks[peaks.length - 1];
  for (let i = peaks.length - 1; i >= 0; i--) {
    if (2 * score[peaks[i]] > med) { end = peaks[i]; break; }
  }

  const frames = [];
  for (let t = end; t >= 0; t = back[t]) frames.push(t);
  frames.reverse();

  const kept = trimWeakBeats(frames, local);
  return refine(kept, env, fps);
}

// Drop leading/trailing beats that the backtrace chained through silence.
// Each beat is judged on its own onset strength, so a real first beat after
// silence isn't dragged under the threshold by its empty neighbour.
function trimWeakBeats(frames, local) {
  if (frames.length < 3) return frames;
  const strength = frames.map((f) => local[f]);
  const threshold = 0.3 * median(strength);
  let a = 0;
  let b = frames.length - 1;
  while (a <= b && strength[a] <= threshold) a++;
  while (b >= a && strength[b] <= threshold) b--;
  return frames.slice(a, b + 1);
}

// Snap each beat to the onset peak within two frames, with parabolic
// interpolation for sub-frame timing.
function refine(frames, env, fps) {
  const out = new Float64Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    let f = frames[i];
    for (let k = frames[i] - 2; k <= frames[i] + 2; k++) {
      if (k > 0 && k < env.length - 1 && env[k] > env[f]) f = k;
    }
    let delta = 0;
    if (f > 0 && f < env.length - 1) {
      const y0 = env[f - 1];
      const y1 = env[f];
      const y2 = env[f + 1];
      const denom = y0 - 2 * y1 + y2;
      if (denom < 0) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom));
    }
    out[i] = (f + delta) / fps;
  }
  // Refinement may not reorder beats; keep them strictly increasing.
  for (let i = 1; i < out.length; i++) if (out[i] <= out[i - 1]) out[i] = out[i - 1] + 1e-4;
  return out;
}

function gaussianSmooth(x, sigma) {
  const r = Math.ceil(3 * sigma);
  const k = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-0.5 * (i / sigma) ** 2); k.push(v); sum += v; }
  const out = new Float64Array(x.length);
  for (let t = 0; t < x.length; t++) {
    let s = 0;
    for (let i = -r; i <= r; i++) {
      const j = t + i;
      if (j >= 0 && j < x.length) s += x[j] * k[i + r];
    }
    out[t] = s / sum;
  }
  return out;
}

function slidingExtreme(x, radius, better) {
  const n = x.length;
  const out = new Float64Array(n);
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let t = 0; t < n; t++) {
    while (next < n && next <= t + radius) {
      while (tail > head && better(x[next], x[dq[tail - 1]])) tail--;
      dq[tail++] = next++;
    }
    while (dq[head] < t - radius) head++;
    out[t] = x[dq[head]];
  }
  return out;
}

export function median(values) {
  const a = Array.from(values).sort((p, q) => p - q);
  if (a.length === 0) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}
