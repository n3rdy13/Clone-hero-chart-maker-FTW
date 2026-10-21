// Standard MIDI File reader (format 0/1/2, running status, sysex, meta).
// Copied from drumcharts2026 (src/midiread.js).

export function parseMidi(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = (o) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.length < 14 || id(0) !== 'MThd') throw new Error('Not a MIDI file (missing MThd header).');
  const format = v.getUint16(8);
  const ntrks = v.getUint16(10);
  const division = v.getUint16(12);
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported.');
  const ppq = division;
  let off = 8 + v.getUint32(4);
  const tracks = [];
  while (tracks.length < ntrks && off + 8 <= bytes.length) {
    const len = v.getUint32(off + 4);
    const end = Math.min(bytes.length, off + 8 + len);
    if (id(off) !== 'MTrk') { off = end; continue; }
    tracks.push(readTrack(bytes, off + 8, end));
    off = end;
  }
  return { format, ppq, tracks };
}

function readTrack(bytes, start, end) {
  let p = start;
  let tick = 0;
  let status = 0;
  const events = [];
  const readVlq = () => {
    let value = 0;
    for (let i = 0; i < 4 && p < end; i++) {
      const b = bytes[p++];
      value = value * 128 + (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return value;
  };
  while (p < end) {
    tick += readVlq();
    if (p >= end) break;
    let b = bytes[p];
    if (b & 0x80) { p++; } else if (status) { b = status; } else { break; }
    if (b === 0xff) {
      const type = bytes[p++];
      const n = readVlq();
      events.push({ tick, meta: type, data: Array.from(bytes.subarray(p, p + n)) });
      p += n;
      if (type === 0x2f) break;
    } else if (b === 0xf0 || b === 0xf7) {
      const n = readVlq();
      events.push({ tick, sysex: Array.from(bytes.subarray(p, p + n)) });
      p += n;
    } else {
      status = b;
      const size = (b & 0xf0) === 0xc0 || (b & 0xf0) === 0xd0 ? 1 : 2;
      events.push({ tick, status: b, data: Array.from(bytes.subarray(p, p + size)) });
      p += size;
    }
  }
  return events;
}

export function trackName(events) {
  const e = events.find((ev) => ev.meta === 0x03);
  return e ? String.fromCharCode(...e.data) : '';
}

// Tempo events from all tracks as { tick, us }, sorted.
export function tempoEvents(midi) {
  const out = [];
  for (const t of midi.tracks) {
    for (const e of t) if (e.meta === 0x51) out.push({ tick: e.tick, us: (e.data[0] << 16) | (e.data[1] << 8) | e.data[2] });
  }
  out.sort((a, b) => a.tick - b.tick);
  if (!out.length || out[0].tick > 0) out.unshift({ tick: 0, us: 500000 });
  return out;
}

// Converts a tick to seconds using the file's tempo events.
export function tickToSeconds(midi, tick, tempos = tempoEvents(midi)) {
  let s = 0;
  for (let i = 0; i < tempos.length; i++) {
    const t0 = tempos[i].tick;
    const t1 = i + 1 < tempos.length ? Math.min(tick, tempos[i + 1].tick) : tick;
    if (t1 <= t0) break;
    s += ((t1 - t0) / midi.ppq) * (tempos[i].us / 1e6);
  }
  return s;
}
