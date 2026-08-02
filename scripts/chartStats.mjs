// Read-only .chart parser + per-section stats printer. Used to tune/verify the
// difficulty-reduction output against professional reference charts:
//   node scripts/chartStats.mjs path/to/notes.chart [more.chart ...]
// Prints per note-section: note count, distinct positions, chord%, sustain%,
// forced/tap/open counts, SP phrase count, lane histogram, min/median gaps.
import fs from 'fs';

export const parseChart = (text) => {
  const sections = {};
  const re = /\[([^\]]+)\]\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text.replace(/^﻿/, '')))) sections[m[1]] = m[2];
  return sections;
};

export const sectionStats = (body) => {
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  const notes = [];
  let sp = 0;
  for (const l of lines) {
    let mm = /^(\d+)\s*=\s*N\s+(\d+)\s+(\d+)$/.exec(l);
    if (mm) { notes.push({ tick: +mm[1], lane: +mm[2], dur: +mm[3] }); continue; }
    mm = /^(\d+)\s*=\s*S\s+2\s+(\d+)$/.exec(l);
    if (mm) sp++;
  }
  const real = notes.filter(n => n.lane <= 4 || n.lane === 7);
  const byTick = new Map();
  for (const n of real) byTick.set(n.tick, (byTick.get(n.tick) || 0) + 1);
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  const gaps = ticks.slice(1).map((t, i) => t - ticks[i]).filter(g => g > 0).sort((a, b) => a - b);
  const chords = ticks.filter(t => byTick.get(t) > 1).length;
  return {
    notes: real.length,
    positions: ticks.length,
    chordPct: +(100 * chords / Math.max(1, ticks.length)).toFixed(1),
    sustainPct: +(100 * real.filter(n => n.dur > 0).length / Math.max(1, real.length)).toFixed(1),
    forced: notes.filter(n => n.lane === 5).length,
    taps: notes.filter(n => n.lane === 6).length,
    opens: notes.filter(n => n.lane === 7).length,
    sp,
    laneDist: [0, 1, 2, 3, 4].map(L => real.filter(n => n.lane === L).length),
    minGap: gaps[0] ?? 0,
    medGap: gaps[Math.floor(gaps.length / 2)] ?? 0
  };
};

export const chartStats = (text) => {
  const sections = parseChart(text);
  const out = { meta: {}, noteSections: {} };
  const res = /Resolution\s*=\s*(\d+)/.exec(sections.Song || '');
  out.meta.resolution = res ? +res[1] : null;
  out.meta.songKeys = (sections.Song || '').split('\n').map(l => l.trim().split('=')[0].trim()).filter(Boolean);
  out.meta.bpmChanges = ((sections.SyncTrack || '').match(/ B /g) || []).length;
  const evLines = (sections.Events || '').split('\n').map(l => l.trim()).filter(Boolean);
  out.meta.sectionEvents = evLines.filter(l => l.includes('"section')).length;
  for (const [name, body] of Object.entries(sections)) {
    if (['Song', 'SyncTrack', 'Events'].includes(name)) continue;
    out.noteSections[name] = sectionStats(body);
  }
  return out;
};

const main = () => {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node scripts/chartStats.mjs <notes.chart> [...]');
    process.exit(1);
  }
  for (const f of files) {
    const stats = chartStats(fs.readFileSync(f, 'utf8'));
    console.log(`\n=== ${f}`);
    console.log(`  resolution=${stats.meta.resolution} bpmChanges=${stats.meta.bpmChanges} sectionEvents=${stats.meta.sectionEvents}`);
    console.log(`  [Song] keys: ${stats.meta.songKeys.join(', ')}`);
    for (const [name, s] of Object.entries(stats.noteSections)) {
      console.log(`  ${name.padEnd(18)} notes=${String(s.notes).padStart(4)} chord%=${String(s.chordPct).padStart(5)} sustain%=${String(s.sustainPct).padStart(5)} ` +
        `forced=${s.forced} taps=${s.taps} opens=${s.opens} sp=${s.sp} lanes=[${s.laneDist}] minGap=${s.minGap} medGap=${s.medGap}`);
    }
  }
};

if (process.argv[1] && process.argv[1].endsWith('chartStats.mjs')) main();
