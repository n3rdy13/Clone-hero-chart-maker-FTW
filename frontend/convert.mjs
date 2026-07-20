// Headless Clone Hero song builder — automates the whole manual workflow:
//   add MIDI -> add MP3 -> auto-sync tempo map -> set artist/song/charter ->
//   build the song folder straight into the Clone Hero Songs directory.
//
// Reuses the SAME pure logic as the web app (tempoAnalysis.js + chartGen.js),
// so the output matches what the UI produces. Audio is decoded and re-encoded
// with ffmpeg (a real 2s-padded Ogg Vorbis — no MP3-as-ogg, no CH freeze).
//
// Usage (flags, positional files, or interactive prompts for anything missing):
//   node convert.mjs --midi song.mid --mp3 song.mp3 --artist "Deftones" --song "Around the Fur" --charter n3rdy13
//   node convert.mjs "song.mid" "song.mp3"        (then it prompts for text)
//   node convert.mjs                              (fully interactive)
// Optional: --section ExpertDrums  --density 8  --track <index>  --out "<dir>"

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';
import pkg from '@tonejs/midi';
const { Midi } = pkg;
import { computeOnsetEnvelope, fitTempoMap, anchorsToBpmEvents, fitWeightForPitch, fitBandForPitch } from './src/tempoAnalysis.js';
import { presetMappingForPitch, isDrumsSection, compileChartEvents, generateChartString, generateSongIni } from './src/chartGen.js';

const DEFAULT_OUT = 'C:\\Users\\test\\Documents\\Clone Hero\\Songs';
const SR = 44100;

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
const parseArgs = (argv) => {
  const opts = { section: 'ExpertDrums', density: 8, out: DEFAULT_OUT };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'starpower') { opts.starpower = true; continue; } // boolean flag (default off)
      const val = argv[i + 1]; i++;
      if (key === 'density' || key === 'track') opts[key] = parseInt(val);
      else opts[key] = val;
    } else positionals.push(a);
  }
  // Sort loose file args by extension.
  for (const p of positionals) {
    const ext = path.extname(p).toLowerCase();
    if (['.mid', '.midi'].includes(ext) && !opts.midi) opts.midi = p;
    else if (['.mp3', '.wav', '.ogg', '.flac', '.m4a'].includes(ext) && !opts.mp3) opts.mp3 = p;
  }
  return opts;
};

const prompt = (rl, q, def) => new Promise(res => {
  rl.question(def ? `${q} [${def}]: ` : `${q}: `, ans => res((ans && ans.trim()) || def || ''));
});

const sanitize = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim();

// --- audio via ffmpeg -------------------------------------------------------
const decodeMonoPCM = (ffmpeg, input) => {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', input, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'],
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
  const r = spawnSync(ffmpeg, ['-y', '-v', 'error', '-i', input,
    '-af', 'adelay=2000|2000', '-vn', '-map_metadata', '-1',
    '-acodec', 'libvorbis', '-q:a', '6', '-f', 'ogg', outPath]);
  if (r.status !== 0) throw new Error('ffmpeg encode failed: ' + (r.stderr ? r.stderr.toString() : r.status));
};

// --- main -------------------------------------------------------------------
const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  const ffmpeg = resolveFfmpeg();

  // Fill missing inputs interactively.
  const needPrompt = !opts.midi || !opts.mp3 || !opts.artist || !opts.song;
  if (needPrompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!opts.midi) opts.midi = await prompt(rl, 'Path to MIDI (.mid)');
    if (!opts.mp3) opts.mp3 = await prompt(rl, 'Path to audio (.mp3)');
    if (!opts.artist) opts.artist = await prompt(rl, 'Artist');
    if (!opts.song) opts.song = await prompt(rl, 'Song title');
    if (!opts.charter) opts.charter = await prompt(rl, 'Charter', 'n3rdy13');
    rl.close();
  }
  if (!opts.charter) opts.charter = 'n3rdy13';

  // Strip accidental surrounding quotes from drag-dropped paths.
  const clean = p => p && p.replace(/^"(.*)"$/, '$1');
  opts.midi = clean(opts.midi); opts.mp3 = clean(opts.mp3);

  if (!fs.existsSync(opts.midi)) throw new Error('MIDI not found: ' + opts.midi);
  if (!fs.existsSync(opts.mp3)) throw new Error('Audio not found: ' + opts.mp3);

  console.log(`\n[1/5] Parsing MIDI: ${path.basename(opts.midi)}`);
  const midi = new Midi(fs.readFileSync(opts.midi));
  const midiBPM = (midi.header.tempos && midi.header.tempos.length) ? midi.header.tempos[0].bpm : 120;

  // Track: explicit --track, else the one with the most notes (app default).
  let trackIndex = Number.isInteger(opts.track) ? opts.track : 0;
  if (!Number.isInteger(opts.track)) {
    let max = -1;
    midi.tracks.forEach((t, i) => { if (t.notes.length > max) { max = t.notes.length; trackIndex = i; } });
  }
  const track = midi.tracks[trackIndex];
  if (!track || !track.notes.length) throw new Error('Selected MIDI track has no notes.');
  console.log(`      track [${trackIndex}] "${track.name || 'Unnamed'}" — ${track.notes.length} notes, MIDI tempo ${midiBPM.toFixed(2)} BPM`);

  // Preset pitch mappings.
  const isDrums = isDrumsSection(opts.section);
  const pitchMappings = {};
  new Set(track.notes.map(n => n.midi)).forEach(p => { pitchMappings[p] = presetMappingForPitch(p, isDrums); });

  // Auto-sync tempo map against the audio (mirrors the app's runAutoTempoSync).
  console.log(`[2/5] Decoding audio + fitting tempo map (this can take ~10-30s)…`);
  let effectiveBPM = midiBPM, drumSyncOffset = 2.0, autoSync = null;
  if (track.notes.length >= 12) {
    const rawMono = decodeMonoPCM(ffmpeg, opts.mp3);
    const padSamples = Math.round(2.0 * SR);
    const mono = new Float32Array(padSamples + rawMono.length);
    mono.set(rawMono, padSamples); // 2s silence lead-in, matching the exported Ogg
    const { bands, fps } = await computeOnsetEnvelope(mono, SR);
    const ppq = midi.header.ppq || 480;
    const hits = track.notes.map(n => ({ beat: n.ticks / ppq, w: fitWeightForPitch(n.midi), band: fitBandForPitch(n.midi) }));
    const fit = await fitTempoMap(bands, fps, hits, midiBPM);
    const globalBPM = parseFloat((60 / fit.alpha).toFixed(3));
    const offsetSeconds = parseFloat(Math.max(0, fit.anchors[0].time).toFixed(3));
    const leadInTicks = Math.round(offsetSeconds * globalBPM * 8);
    autoSync = { bpmEvents: anchorsToBpmEvents(fit.anchors, globalBPM, leadInTicks), globalBPM, offsetSeconds };
    effectiveBPM = globalBPM; drumSyncOffset = offsetSeconds;
    console.log(`      fitted ${globalBPM.toFixed(2)} BPM, lead-in ${offsetSeconds.toFixed(3)}s, ${autoSync.bpmEvents.length} tempo event(s)`);
  } else {
    console.log(`      too few notes to fit — using MIDI tempo ${midiBPM.toFixed(2)} with a 2.0s lead-in`);
  }

  // Compile chart. Star power is opt-in via --starpower (off by default).
  console.log(`[3/5] Compiling chart events${opts.starpower ? ' + star power' : ''}…`);
  const chartEvents = compileChartEvents({
    parsedMidi: midi, trackIndex, pitchMappings, drumSyncOffset,
    effectiveBPM, targetSection: opts.section, autoStarPower: !!opts.starpower, spDensityMeasures: opts.density
  });
  const noteCount = chartEvents.filter(e => e.type === 'N' && ![66, 67, 68].includes(e.value)).length;
  const spCount = chartEvents.filter(e => e.type === 'S').length;
  console.log(`      ${noteCount} notes, ${spCount} star power phrase(s)`);

  const chartString = generateChartString({
    parsedMidi: midi, chartEvents, targetSection: opts.section, effectiveBPM, midiBPM, drumSyncOffset, autoSync
  });

  // Output folder.
  const folderName = sanitize(`${opts.artist} - ${opts.song}`);
  const destDir = path.join(opts.out, folderName);
  fs.mkdirSync(destDir, { recursive: true });

  console.log(`[4/5] Encoding padded Ogg…`);
  encodeOgg(ffmpeg, opts.mp3, path.join(destDir, 'song.ogg'));

  console.log(`[5/5] Writing chart + ini…`);
  const rawDuration = (() => {
    // Derive shipped length from the padded Ogg we just wrote.
    const probe = spawnSync(ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', path.join(destDir, 'song.ogg')],
      { encoding: 'utf8' });
    const d = parseFloat((probe.stdout || '').trim());
    return isFinite(d) ? d : null;
  })();
  const songLengthMs = rawDuration ? Math.round(rawDuration * 1000) : 180000;

  fs.writeFileSync(path.join(destDir, 'notes.chart'), chartString);
  fs.writeFileSync(path.join(destDir, 'song.ini'), generateSongIni({
    title: opts.song, artist: opts.artist, charter: opts.charter, musicStream: 'song.ogg', songLengthMs
  }));

  console.log(`\n✅ Done → ${destDir}`);
  console.log(`   notes.chart, song.ini, song.ogg`);
};

main().catch(err => { console.error('\n❌ ' + err.message); process.exit(1); });
