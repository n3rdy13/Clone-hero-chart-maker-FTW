// Editor operations: selection, copy/cut/paste, delete, move, lane changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idsInTickRange, allPadIds, copyNotes, deleteNotes, pasteNotes, moveNotes, setLane, isPad } from '../src/editOps.js';

// kick at 0, hi-hat cymbal (pad 2 + flag 66) at 0, snare at 480, crash (4 + 68) at 960
const base = () => [
  { id: 1, tick: 0, type: 'N', value: 0, duration: 0 },
  { id: 2, tick: 0, type: 'N', value: 2, duration: 0, mappedType: 'yellow_cymbal' },
  { id: 3, pairId: 2, tick: 0, type: 'N', value: 66, duration: 0 },
  { id: 4, tick: 480, type: 'N', value: 1, duration: 0 },
  { id: 5, tick: 960, type: 'N', value: 4, duration: 0, mappedType: 'green_cymbal' },
  { id: 6, pairId: 5, tick: 960, type: 'N', value: 68, duration: 0 },
  { id: 7, tick: 0, type: 'S', value: 2, duration: 1919 },
];
const summary = (ev) => ev.filter((e) => e.type === 'N').map((e) => `${e.tick}:${e.value}`).sort().join(' ');

test('select a range or everything picks pads only', () => {
  assert.deepEqual(idsInTickRange(base(), 0, 480).sort(), [1, 2, 4]);
  assert.deepEqual(allPadIds(base()).sort(), [1, 2, 4, 5]);
});

test('delete takes the cymbal flag with its pad and leaves star power alone', () => {
  const out = deleteNotes(base(), [2, 5]);
  assert.equal(summary(out), '0:0 480:1');
  assert.ok(out.some((e) => e.type === 'S'));
});

test('copy + paste keeps spacing, lanes and cymbals, and replaces what is in the way', () => {
  const ev = base();
  const clip = copyNotes(ev, [1, 2, 4]);
  assert.equal(clip.span, 480);
  const { events, ids } = pasteNotes(ev, clip, 960); // lands on the crash at 960? no: kick+hat at 960, snare at 1440
  assert.equal(ids.length, 3);
  assert.equal(summary(events), '0:0 0:2 0:66 1440:1 480:1 960:0 960:2 960:4 960:66 960:68');
  // Pasting the same thing again on top replaces instead of doubling up.
  const again = pasteNotes(events, clip, 960).events;
  assert.equal(again.filter(isPad).length, events.filter(isPad).length);
});

test('cut = copy + delete; paste elsewhere moves the notes', () => {
  const ev = base();
  const clip = copyNotes(ev, [5]);
  const cut = deleteNotes(ev, [5]);
  const { events } = pasteNotes(cut, clip, 1920);
  assert.equal(summary(events), '0:0 0:2 0:66 1920:4 1920:68 480:1');
});

test('move shifts notes and flags, never before the start, replacing a note it lands on', () => {
  const out = moveNotes(base(), [4], 480); // snare onto 960, crash lane is different so both stay
  assert.equal(summary(out), '0:0 0:2 0:66 960:1 960:4 960:68');
  const early = moveNotes(base(), [4, 5], -10000);
  assert.equal(summary(early), '0:0 0:1 0:2 0:66 480:4 480:68'); // clamped: the earliest moved note lands on 0
  const onto = moveNotes(base(), [4], -480); // snare to 0: no snare there, so nothing replaced
  assert.equal(summary(onto), '0:0 0:1 0:2 0:66 960:4 960:68');
});

test('lane change: tom/cymbal follow the choice, and two selected notes never share a lane', () => {
  const toms = setLane(base(), [2], 2, { cymbal: false });
  assert.equal(summary(toms), '0:0 0:2 480:1 960:4 960:68'); // hi-hat became a yellow tom (no flag)
  const blueCym = setLane(base(), [4], 3, { cymbal: true });
  assert.equal(summary(blueCym), '0:0 0:2 0:66 480:3 480:67 960:4 960:68');
  const merged = setLane(base(), [1, 2], 1, {}); // kick and hi-hat both to red at tick 0 -> one red
  assert.equal(summary(merged), '0:1 480:1 960:4 960:68');
});
