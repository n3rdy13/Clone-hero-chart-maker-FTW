// Sustain hygiene for guitar/bass chart events, matching pro-charting practice
// observed in reference charts: a sustain never runs into the next note (leave
// a 1/16-note gap) and anything shorter than a 1/12 note isn't a sustain at
// all. Pure and framework-agnostic (480-PPQ tick domain), shared by the app,
// the CLI, and batch conversion.

const PLAYABLE = (e) => e.type === 'N' && (e.value <= 4 || e.value === 7);

// Returns a NEW event array; input is not mutated. Drums never reach this
// (their durations are already 0), but playability filtering keeps flag events
// (5/6) and cymbal markers (66/67/68) out of the onset list either way.
export const applySustainHygiene = (events, { minSustainTicks = 160, gapTicks = 120 } = {}) => {
  const onsets = [...new Set(events.filter(PLAYABLE).map(e => e.tick))].sort((a, b) => a - b);

  const nextOnsetAfter = (tick) => {
    let lo = 0, hi = onsets.length - 1, ans = Infinity;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (onsets[mid] > tick) { ans = onsets[mid]; hi = mid - 1; } else lo = mid + 1;
    }
    return ans;
  };

  return events.map(e => {
    if (!PLAYABLE(e) || !(e.duration > 0)) return e;
    let duration = e.duration;
    const next = nextOnsetAfter(e.tick);
    if (next !== Infinity) duration = Math.min(duration, next - e.tick - gapTicks);
    if (duration < minSustainTicks) duration = 0;
    return duration === e.duration ? e : { ...e, duration };
  });
};
