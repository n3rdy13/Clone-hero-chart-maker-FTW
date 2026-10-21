// Headless Clone Hero song builder — automates the whole workflow:
//   song audio (+ optional drum stem) -> beat-mapped tempo map -> tab placed on
//   the beats -> kick check -> song folder written into the Clone Hero Songs
//   directory.
//
// Reuses the SAME engine as the web app (src/engine + src/songBuilder.js), so
// the output matches what the UI produces. Audio is decoded and re-encoded with
// ffmpeg (a real 2 s-padded Ogg Vorbis — no MP3-as-ogg, no CH freeze).
//
// Usage (flags, positional files, or interactive prompts for anything missing):
//   node convert.mjs --midi tab.mid --audio song.m4a --stem drums.m4a --artist "Deftones" --song "Around the Fur"
//   node convert.mjs "tab.mid" "song.mp3"           (then it prompts for text)
//   node convert.mjs                                 (fully interactive)
// Options:
//   --stem <file>              drum stem split from the same song (better beats + kick check)
//   --daw <file>               tempo map from the DAW session (.mid, .rpp or .dawproject) instead of detecting beats
//   --detect                   chart detected drums instead of a MIDI tab
//   --drop-unsupported-kicks   remove tab kicks the drum stem doesn't back up (default: just report them)
//   --offset <beats>           place the tab by hand (grid beat of tab beat 0)
//   --no-meter-fix             keep stretches the beat tracker read at 2/3, 3/2, half or double tempo
//   --starpower --density 8    auto star power, one phrase per N bars
//   --section ExpertDrums  --track <index>  --charter <name>  --out "<dir>"

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';
import pkg from '@tonejs/midi';
const { Midi } = pkg;
import { SongAnalyzer, ANALYSIS_SR, DEFAULT_TRACKING } from './src/engine/analyze.js';
import { buildChart } from './src/songBuilder.js';
import { LEAD_IN_SECONDS, generateSongIni, barStartBeats, isFlagValue } from './src/chartGen.js';
import { readDawTempo } from './src/dawImport.js';
import { compareWithDetected, dawShiftToApply } from './src/engine/dawTempo.js';

const DEFAULT_OUT = 'C:\\Users\\test\\Documents\\Clone Hero\\Songs';

// --- ffmpeg -----------------------------------------------------------------
const resolveFfmpeg = () => {
  const candidates = [
    process.env.FFMPEG_PATH,
    'ffmpeg',
    'C:\\Users\\test\\Downloads\\ffmpeg-8.1-full_build-shared\\ffmpeg-8.1-full_build-shared\\bin\\ffmpeg.exe'
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['-version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  throw new Error('ffmpeg not found. Install it or set FFMPEG_PATH.');
};

// --- arg parsing ------------------------------------------------------------
const FLAGS = new Set(['starpower', 'detect', 'drop-unsupported-kicks', 'no-meter-fix']);
const parseArgs = (argv) => {
  const opts = { section: 'ExpertDrums', density: 8, out: DEFAULT_OUT };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (FLAGS.has(key)) { opts[key] = true; continue; }
      const val = argv[i + 1]; i++;
      if (key === 'density' || key === 'track' || key === 'offset') opts[key] = parseInt(val);
      else if (key === 'mp3') opts.audio = val;
      else opts[key] = val;
    } else positionals.push(a);
  }
  // Sort loose file args by extension: MIDI, then song audio, then a stem;
  // a Reaper or DAWproject file is the DAW tempo map.
  for (const p of positionals) {
    const ext = path.extname(p).toLowerCase();
    if (['.mid', '.midi'].includes(ext) && !opts.midi) opts.midi = p;
    else if (['.rpp', '.dawproject'].includes(ext) && !opts.daw) opts.daw = p;
    else if (['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.opus', '.aac', '.wma', '.aiff', '.aif', '.webm'].includes(ext)) {
      if (!opts.audio) opts.audio = p;
      else if (!opts.stem) opts.stem = p;
    }
  }
  return opts;
};

const prompt = (rl, q, def) => new Promise(res => {
  rl.question(def ? `${q} [${def}]: ` : `${q}: `, ans => res((ans && ans.trim()) || def || ''));
});

const sanitize = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim();

// --- audio via ffmpeg -------------------------------------------------------
const decodeMonoPCM = (ffmpeg, input) => {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', input, '-f', 'f32le', '-ac', '1', '-ar', String(ANALYSIS_SR), '-'],
    { maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('ffmpeg decode failed: ' + (r.stderr ? r.stderr.toString() : r.status));
  const buf = r.stdout;
  const n = Math.floor(buf.length / 4);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = buf.readFloatLE(i * 4);
  return mono;
};

const encodeOgg = (ffmpeg, input, outPath) => {
  // -vn drops embedded album art; -map_metadata -1 strips ALL source tags.
  // Carried-over MP4/ID3 tags in the Vorbis comments make Clone Hero black-screen.
  const ms = Math.round(LEAD_IN_SECONDS * 1000);
  const r = spawnSync(ffmpeg, ['-y', '-v', 'error', '-i', input,
    '-af', `adelay=${ms}|${ms}`, '-vn', '-map_metadata', '-1',
    '-acodec', 'libvorbis', '-q:a', '6', '-f', 'ogg', outPath]);
  if (r.status !== 0) throw new Error('ffmpeg encode failed: ' + (r.stderr ? r.stderr.toString() : r.status));
};

const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

// --- main -------------------------------------------------------------------
const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  const ffmpeg = resolveFfmpeg();
  const detect = Boolean(opts.detect);

  // Fill missing inputs interactively.
  const needPrompt = (!detect && !opts.midi) || !opts.audio || !opts.artist || !opts.song;
  if (needPrompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!detect && !opts.midi) opts.midi = await prompt(rl, 'Path to drum tab / MIDI (.mid)');
    if (!opts.audio) opts.audio = await prompt(rl, 'Path to song audio (.mp3 / .m4a / .ogg / .wav)');
    if (opts.stem === undefined) opts.stem = await prompt(rl, 'Path to drum stem (optional, Enter to skip)');
    if (!opts.artist) opts.artist = await prompt(rl, 'Artist');
    if (!opts.song) opts.song = await prompt(rl, 'Song title');
    if (!opts.charter) opts.charter = await prompt(rl, 'Charter', 'n3rdy13');
    rl.close();
  }
  if (!opts.charter) opts.charter = 'n3rdy13';

  // Strip accidental surrounding quotes from drag-dropped paths.
  const clean = p => p && p.replace(/^"(.*)"$/, '$1');
  opts.midi = clean(opts.midi); opts.audio = clean(opts.audio); opts.stem = clean(opts.stem) || null; opts.daw = clean(opts.daw) || null;
  if (opts.daw && !fs.existsSync(opts.daw)) throw new Error('DAW tempo file not found: ' + opts.daw);

  if (!detect && !fs.existsSync(opts.midi)) throw new Error('MIDI not found: ' + opts.midi);
  if (!fs.existsSync(opts.audio)) throw new Error('Audio not found: ' + opts.audio);
  if (opts.stem && !fs.existsSync(opts.stem)) throw new Error('Drum stem not found: ' + opts.stem);

  const midi = detect ? null : new Midi(fs.readFileSync(opts.midi));
  if (midi) console.log(`\n[1/5] Parsed MIDI: ${path.basename(opts.midi)} (${midi.tracks.length} tracks)`);

  console.log(`[2/5] Decoding audio and finding beats…`);
  const analyzer = new SongAnalyzer();
  const summary = analyzer.load({
    mix: decodeMonoPCM(ffmpeg, opts.audio),
    stem: opts.stem ? decodeMonoPCM(ffmpeg, opts.stem) : null,
    sr: ANALYSIS_SR
  });
  if (summary.stem) {
    console.log(summary.beatSource === 'stem'
      ? `      drum stem lines up with the song (offset ${(summary.stem.shift * 1000).toFixed(1)} ms, match ${summary.stem.match.toFixed(2)})`
      : `      WARNING: the drum stem doesn't match the song (match ${summary.stem.match.toFixed(2)}); using the song for beats, kick check off`);
  }
  const { beats, meter } = analyzer.track({ ...DEFAULT_TRACKING, meterFix: !opts['no-meter-fix'] });
  console.log(`      ${beats.length} beats from the ${summary.beatSource === 'stem' ? 'drum stem' : 'song'}; detecting drums…`);
  if (meter) {
    const range = (s) => `${fmtTime(s.from)}–${fmtTime(s.to)}`;
    for (const s of meter.fixed) console.log(`      fixed ${range(s)}: tracked at ${s.trackedBpm.toFixed(1)} BPM, re-tracked at ${s.bpm.toFixed(1)} (song tempo ${meter.dominantBpm.toFixed(1)}; --no-meter-fix keeps the tracked tempo)`);
    for (const s of meter.kept) console.log(`      kept ${range(s)} at ${s.trackedBpm.toFixed(1)} BPM: the drum hits don't fit ${s.bpm.toFixed(1)} any better, so it may be a real tempo change`);
    for (const w of meter.offGrid) console.log(`      WARNING: ${(w.share * 100).toFixed(0)}% of drum hits miss the 16th grid at ${range(w)}; check the tempo map there`);
  }
  const acts = analyzer.transcribe();
  let dawBeats = null;
  if (opts.daw) {
    const daw = await readDawTempo(path.basename(opts.daw), new Uint8Array(fs.readFileSync(opts.daw)));
    console.log(`      DAW ${daw.label}`);
    if (daw.warning) console.log(`      WARNING: ${daw.warning}`);
    const cmp = compareWithDetected(daw.beats, beats);
    const shift = dawShiftToApply(cmp);
    console.log(`      DAW beats vs detected: ${Math.round(cmp.agreement * 100)}% agree within 20 ms, offset ${(cmp.shift * 1000).toFixed(1)} ms${shift ? ` (applied)` : ''}`);
    if (cmp.agreement < 0.5) console.log('      WARNING: the DAW map does not line up with this audio. Is it from the same song and version?');
    dawBeats = daw.beats.map(b => b + shift);
  }

  console.log(`[3/5] Building chart…`);
  const built = buildChart({
    analysis: { duration: summary.duration, beats, onset: analyzer.onset, acts },
    midi, trackIndex: Number.isInteger(opts.track) ? opts.track : null,
    section: opts.section, drumSource: detect ? 'detect' : 'tab',
    offset: Number.isInteger(opts.offset) ? opts.offset : null,
    meta: { name: opts.song, artist: opts.artist, charter: opts.charter },
    musicStream: 'song.ogg', autoStarPower: Boolean(opts.starpower), spEveryBars: opts.density,
    dropFlaggedKicks: Boolean(opts['drop-unsupported-kicks']), dawBeats
  });
  const bpms = built.map.events.filter(e => !e.leadIn).map(e => e.bpm);
  console.log(`      tempo map (${dawBeats ? 'from the DAW file' : 'detected, one tempo per beat'}): ${bpms.length} tempo events, ${Math.min(...bpms).toFixed(1)}–${Math.max(...bpms).toFixed(1)} BPM`);
  if (!detect) {
    const start = built.map.gridTimes[Math.max(0, Math.min(built.map.gridTimes.length - 1, built.offset))] - LEAD_IN_SECONDS;
    const alts = built.align?.alternatives?.length ? ` (close calls: ${built.align.alternatives.map(a => `${a.offset - built.offset > 0 ? '+' : ''}${a.offset - built.offset}${a.outside ? ` (cuts ${a.outside} notes)` : ''}`).join(', ')} beats — use --offset to override)` : '';
    console.log(`      tab bar 1 placed at ${fmtTime(Math.max(0, start))} (grid beat ${built.offset})${alts}`);
  }
  const s = built.stats;
  const noteCount = built.events.filter(e => e.type === 'N' && !isFlagValue(e.value)).length;
  console.log(`      ${noteCount} notes, ${built.events.filter(e => e.type === 'S').length} star power phrase(s)` +
    (s.early ? `, ${s.early} before the song` : '') + (s.late ? `, ${s.late} after the end` : '') + (s.moved ? `, ${s.moved} toms moved` : ''));
  if (built.kickCheck) {
    if (s.flaggedKicks) {
      const bars = barStartBeats(built.timeSigs, built.map.gridTimes.length - 1);
      const label = (beat) => { let i = 0; while (i + 1 < bars.length && bars[i + 1] <= beat + 1e-9) i++; return `${i + 1}.${Number((beat - bars[i] + 1).toFixed(2))}`; };
      const flagged = built.events.filter(e => e.flagged).map(e => label(e.tick / 480));
      console.log(`      kick check: ${s.flaggedKicks} kicks have no kick in the drum stem${s.removedKicks ? ' (removed)' : ' (kept; add --drop-unsupported-kicks to remove them)'}`);
      if (!s.removedKicks) console.log(`        at bar.beat: ${flagged.slice(0, 40).join(', ')}${flagged.length > 40 ? ', …' : ''}`);
    } else {
      console.log('      kick check: every kick has a kick in the drum stem');
    }
  } else if (!detect) {
    console.log('      kick check: skipped (needs --stem)');
  }

  // Output folder.
  const folderName = sanitize(`${opts.artist} - ${opts.song}`);
  const destDir = path.join(opts.out, folderName);
  fs.mkdirSync(destDir, { recursive: true });

  console.log(`[4/5] Encoding padded Ogg…`);
  encodeOgg(ffmpeg, opts.audio, path.join(destDir, 'song.ogg'));

  console.log(`[5/5] Writing chart + ini…`);
  const songLengthMs = Math.round((summary.duration + LEAD_IN_SECONDS) * 1000);
  fs.writeFileSync(path.join(destDir, 'notes.chart'), built.chart);
  fs.writeFileSync(path.join(destDir, 'song.ini'), generateSongIni({
    title: opts.song, artist: opts.artist, charter: opts.charter, musicStream: 'song.ogg', songLengthMs
  }));

  console.log(`\n✅ Done → ${destDir}`);
  console.log(`   notes.chart, song.ini, song.ogg`);
};

main().catch(err => { console.error('\n❌ ' + err.message); process.exit(1); });
