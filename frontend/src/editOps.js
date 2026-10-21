// Chart editing operations on the editor's event list (pure functions).
//
// Events: pads { id, tick, type: 'N', value, duration, ... }, cymbal flags
// { id, pairId, tick, type: 'N', value: 66-68 } linked to their pad, and star
// power { type: 'S' }. Every operation keeps pads and their flags together and
// never leaves two notes on the same lane at the same tick.

export const isFlag = (e) => e.type === 'N' && e.value >= 66 && e.value <= 68;
export const isPad = (e) => e.type === 'N' && !isFlag(e);

const byTick = (a, b) => a.tick - b.tick || (a.type === b.type ? a.value - b.value : a.type === 'N' ? -1 : 1);

export function nextId(events) {
  let m = 0;
  for (const e of events) if (e.id > m) m = e.id;
  return m + 1;
}

// Pad ids whose tick lies in [fromTick, toTick].
export function idsInTickRange(events, fromTick, toTick) {
  return events.filter((e) => isPad(e) && e.tick >= fromTick && e.tick <= toTick).map((e) => e.id);
}

export function allPadIds(events) {
  return events.filter(isPad).map((e) => e.id);
}

// A clipboard snapshot of the selected pads (with cymbal flags), relative to
// the earliest one.
export function copyNotes(events, ids) {
  const sel = new Set(ids);
  const pads = events.filter((e) => isPad(e) && sel.has(e.id)).sort(byTick);
  if (!pads.length) return null;
  const cymbal = new Set(events.filter((e) => isFlag(e) && sel.has(e.pairId)).map((e) => e.pairId));
  const t0 = pads[0].tick;
  return {
    span: pads[pads.length - 1].tick - t0,
    notes: pads.map((p) => ({
      dt: p.tick - t0, value: p.value, duration: p.duration || 0, cymbal: cymbal.has(p.id),
      mappedType: p.mappedType, originalPitch: p.originalPitch, flagValue: cymbal.has(p.id) ? 64 + p.value : null,
    })),
  };
}

export function deleteNotes(events, ids) {
  const sel = new Set(ids);
  return events.filter((e) => !(sel.has(e.id) || (isFlag(e) && sel.has(e.pairId))));
}

// Removes the pad (and flag) already on `value` at `tick`, unless it's one of `keep`.
function clearSlot(events, tick, value, keep = new Set()) {
  const victims = events.filter((e) => isPad(e) && e.tick === tick && e.value === value && !keep.has(e.id)).map((e) => e.id);
  return victims.length ? deleteNotes(events, victims) : events;
}

// Pastes a clipboard at atTick. Pasted notes replace what's on the same lane
// at the same tick. Returns { events, ids } (ids of the new pads).
export function pasteNotes(events, clip, atTick) {
  if (!clip || !clip.notes.length) return { events, ids: [] };
  let out = events;
  let id = nextId(events);
  const ids = [];
  const added = [];
  for (const n of clip.notes) {
    const tick = Math.max(0, atTick + n.dt);
    out = clearSlot(out, tick, n.value);
    const padId = id++;
    ids.push(padId);
    added.push({ id: padId, tick, type: 'N', value: n.value, duration: n.duration, originalPitch: n.originalPitch, mappedType: n.mappedType });
    if (n.cymbal) added.push({ id: id++, pairId: padId, tick, type: 'N', value: n.flagValue ?? 64 + n.value, duration: 0, originalPitch: n.originalPitch, mappedType: `${n.mappedType}_marker` });
  }
  return { events: [...out, ...added].sort(byTick), ids };
}

// Moves the selected pads (and flags) by deltaTicks. A moved note replaces
// an unselected note it lands on.
export function moveNotes(events, ids, deltaTicks) {
  const sel = new Set(ids);
  const moving = events.filter((e) => isPad(e) && sel.has(e.id));
  if (!moving.length || !deltaTicks) return events;
  const minTick = Math.min(...moving.map((e) => e.tick));
  const d = Math.max(-minTick, deltaTicks);
  let out = events;
  for (const p of moving) out = clearSlot(out, p.tick + d, p.value, sel);
  return out.map((e) => (sel.has(e.id) || (isFlag(e) && sel.has(e.pairId)) ? { ...e, tick: e.tick + d } : e)).sort(byTick);
}

// Puts the selected pads on lane `value` (0-4 drums / 0-7 guitar). For drums,
// cymbal: true/false sets cymbal or tom on lanes 2-4; null keeps each note's
// current cymbal state where possible. mappedTypeFor(value, cymbal) names the
// result for display.
export function setLane(events, ids, value, { cymbal = null, drums = true, mappedTypeFor = null } = {}) {
  const sel = new Set(ids);
  const flagged = new Set(events.filter((e) => isFlag(e) && sel.has(e.pairId)).map((e) => e.pairId));
  let out = events.filter((e) => !(isFlag(e) && sel.has(e.pairId)));
  const targets = out.filter((e) => isPad(e) && sel.has(e.id));
  for (const p of targets) out = clearSlot(out, p.tick, value, sel);
  let id = nextId(events);
  const added = [];
  out = out.map((e) => {
    if (!(isPad(e) && sel.has(e.id))) return e;
    const canCymbal = drums && value >= 2 && value <= 4;
    const cym = canCymbal && (cymbal === null ? flagged.has(e.id) : cymbal);
    const mappedType = mappedTypeFor ? mappedTypeFor(value, cym) : e.mappedType;
    if (cym) added.push({ id: id++, pairId: e.id, tick: e.tick, type: 'N', value: 64 + value, duration: 0, originalPitch: e.originalPitch, mappedType: `${mappedType}_marker` });
    return { ...e, value, mappedType, flagged: value === 0 ? e.flagged : false };
  });
  // Two selected notes on the same tick can't share the new lane: keep one.
  const seen = new Set();
  const dupes = [];
  for (const e of out) {
    if (!(isPad(e) && sel.has(e.id))) continue;
    const k = `${e.tick}:${e.value}`;
    if (seen.has(k)) dupes.push(e.id); else seen.add(k);
  }
  return deleteNotes([...out, ...added], dupes).sort(byTick);
}
