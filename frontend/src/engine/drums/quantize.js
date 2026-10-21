// Conversions between seconds and (fractional) grid beats of a tempo map.

// Seconds -> fractional grid beat. Extrapolates past either end at the
// nearest beat spacing.
export function timeToBeat(grid, t) {
  const n = grid.length;
  if (n < 2) return 0;
  if (t <= grid[0]) return (t - grid[0]) / (grid[1] - grid[0]);
  if (t >= grid[n - 1]) return n - 1 + (t - grid[n - 1]) / (grid[n - 1] - grid[n - 2]);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] <= t) lo = mid; else hi = mid;
  }
  return lo + (t - grid[lo]) / (grid[lo + 1] - grid[lo]);
}

// Fractional grid beat -> seconds.
export function beatToTime(grid, beat) {
  const n = grid.length;
  if (n < 2) return 0;
  const i = Math.max(0, Math.min(n - 2, Math.floor(beat)));
  return grid[i] + (beat - i) * (grid[i + 1] - grid[i]);
}

// Snap to the nearest 1/division of a beat (division 4 = sixteenth notes).
export function snapBeat(beat, division) {
  return Math.round(beat * division) / division;
}
