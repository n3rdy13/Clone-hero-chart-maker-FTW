// Pro drums lanes (Rock Band / Clone Hero 4-lane pro) and the default mapping
// from General MIDI drum notes. Mapping ids are the ones the web app's pitch
// table already uses (kick, red, yellow_cymbal, yellow_pad, ...).
//
// resolveConflicts is ported from drumcharts2026 (src/drums/lanes.js).

export const LANES = ['kick', 'red', 'yellow', 'blue', 'green'];
export const LANE_INDEX = { kick: 0, red: 1, yellow: 2, blue: 3, green: 4 };
export const CYMBAL_FLAG = { yellow: 66, blue: 67, green: 68 };

// What each drum mapping id means on the pad.
export const DRUM_TARGETS = {
  kick: { lane: 'kick', cymbal: false },
  double_kick: { lane: 'kick', cymbal: false, double: true },
  red: { lane: 'red', cymbal: false },
  yellow_cymbal: { lane: 'yellow', cymbal: true },
  blue_cymbal: { lane: 'blue', cymbal: true },
  green_cymbal: { lane: 'green', cymbal: true },
  yellow_pad: { lane: 'yellow', cymbal: false },
  blue_pad: { lane: 'blue', cymbal: false },
  green_pad: { lane: 'green', cymbal: false },
};

// General MIDI percussion -> mapping id. Same defaults as drumcharts2026.
export const GM_DRUM_DEFAULTS = {
  35: 'kick', 36: 'kick',
  37: 'red', 38: 'red', 39: 'red', 40: 'red',
  42: 'yellow_cymbal', 44: 'yellow_cymbal', 46: 'yellow_cymbal',
  51: 'blue_cymbal', 53: 'blue_cymbal', 59: 'blue_cymbal',
  49: 'green_cymbal', 52: 'green_cymbal', 55: 'green_cymbal', 57: 'green_cymbal',
  48: 'yellow_pad', 50: 'yellow_pad',
  45: 'blue_pad', 47: 'blue_pad',
  41: 'green_pad', 43: 'green_pad',
};

// Which audio evidence a mapping should line up with when aligning a tab.
export const evidenceClass = (mapping) => {
  const t = DRUM_TARGETS[mapping];
  if (!t) return null;
  if (t.lane === 'kick') return 'kick';
  if (t.lane === 'red') return 'snare';
  if (t.cymbal) return 'cymbal';
  return 'any'; // toms
};

const isTom = (n) => ['yellow', 'blue', 'green'].includes(n.lane) && !n.cymbal;

// Collapses a list of { beat, lane, cymbal, ... } notes into something
// playable: one note per lane per instant, and never a cymbal and a tom
// sharing a lane at the same time (the tom moves to the next free tom lane,
// or is dropped). Extra fields on each note are kept.
export function resolveConflicts(notes, ppq = 480) {
  const groups = new Map();
  for (const n of notes) {
    if (!n.lane) continue;
    const key = Math.round(n.beat * ppq);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const out = [];
  let moved = 0;
  let dropped = 0;
  for (const key of [...groups.keys()].sort((a, b) => a - b)) {
    const taken = new Map(); // lane -> note
    const group = groups.get(key);
    // Cymbals and kick/red first so toms are the ones that move.
    group.sort((a, b) => Number(isTom(a)) - Number(isTom(b)));
    for (const n of group) {
      const beat = key / ppq;
      if (!taken.has(n.lane)) { taken.set(n.lane, { ...n, beat }); continue; }
      const existing = taken.get(n.lane);
      if (existing.cymbal === n.cymbal) { dropped++; continue; }
      if (isTom(n)) {
        const order = ['yellow', 'blue', 'green'];
        const free = order.slice(order.indexOf(n.lane) + 1).find((l) => !taken.has(l));
        if (free) { taken.set(free, { ...n, lane: free, beat }); moved++; } else { dropped++; }
      } else {
        dropped++;
      }
    }
    for (const lane of LANES) if (taken.has(lane)) out.push(taken.get(lane));
  }
  return { notes: out, moved, dropped };
}
