// Minimal .chart reader for tests: sync track and one instrument section.
// Times are computed from the B (milli-BPM) events the way Clone Hero does.
export function parseChart(text) {
  const sections = {};
  let name = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^\[(.+)\]$/.exec(line);
    if (h) { name = h[1]; sections[name] = []; continue; }
    if (!name || line === '{' || line === '}' || !line) continue;
    sections[name].push(line);
  }
  const song = {};
  for (const l of sections.Song || []) { const m = /^(\w+)\s*=\s*(.*)$/.exec(l); if (m) song[m[1]] = m[2].replace(/^"|"$/g, ''); }
  const res = Number(song.Resolution || 192);
  const tempos = [], sigs = [];
  for (const l of sections.SyncTrack || []) {
    const m = /^(\d+)\s*=\s*(B|TS)\s+(\d+)(?:\s+(\d+))?$/.exec(l);
    if (!m) continue;
    if (m[2] === 'B') tempos.push({ tick: +m[1], milli: +m[3] });
    else sigs.push({ tick: +m[1], num: +m[3], den: m[4] ? 2 ** +m[4] : 4 });
  }
  tempos.sort((a, b) => a.tick - b.tick);
  const toSec = (tick) => { let s = 0; for (let i = 0; i < tempos.length; i++) { const a = tempos[i].tick, b = i + 1 < tempos.length ? Math.min(tick, tempos[i + 1].tick) : tick; if (b <= a) break; s += ((b - a) / res) * (60000 / tempos[i].milli); } return s; };
  const tracks = {};
  for (const [sec, lines] of Object.entries(sections)) {
    if (['Song', 'SyncTrack', 'Events'].includes(sec)) continue;
    const notes = [], sp = [];
    for (const l of lines) {
      const m = /^(\d+)\s*=\s*([NS])\s+(\d+)\s+(\d+)$/.exec(l);
      if (!m) continue;
      if (m[2] === 'N') notes.push({ tick: +m[1], value: +m[3], len: +m[4] }); else sp.push({ tick: +m[1], len: +m[4] });
    }
    tracks[sec] = { notes, sp };
  }
  return { song, res, tempos, sigs, tracks, toSec };
}

// Pro drums notes of a parsed drum section: [{ time, lane, cymbal, tick }].
export function proDrums(chart, section = 'ExpertDrums') {
  const t = chart.tracks[section];
  if (!t) return [];
  const flags = new Set(t.notes.filter((n) => n.value >= 66 && n.value <= 68).map((n) => `${n.tick}:${n.value - 64}`));
  const lanes = ['kick', 'red', 'yellow', 'blue', 'green'];
  return t.notes.filter((n) => n.value <= 4 || n.value === 32).map((n) => {
    const lane = n.value === 32 ? 'kick' : lanes[n.value];
    return { tick: n.tick, time: chart.toSec(n.tick), lane, cymbal: n.value >= 2 && n.value <= 4 && flags.has(`${n.tick}:${n.value}`) };
  });
}
