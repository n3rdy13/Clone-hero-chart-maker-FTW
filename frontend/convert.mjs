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
// Optional flags:
//   --album "X" --genre "X" --year 1998           song metadata (chart + ini)
//   --guitar-track N --bass-track N --drums-track N   multi-instrument chart
//   --section ExpertDrums --track N               legacy single-instrument pick
//   --expert-only                                 skip Hard/Medium/Easy generation
//   --no-sections                                 skip [Events] practice sections
//   --hopo-mode strum-downbeats                   force strums on downbeat HOPOs
//   --starpower --density 8 --out "<dir>"

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';
import pkg from '@tonejs/midi';
const { Midi } = pkg;
import { computeOnsetEnvelope, fitTempoMap, anchorsToBpmEvents, fitWeightForPitch, fitBandForPitch } from './src/tempoAnalysis.js';
import {
  presetMappingForPitch, isDrumsSection, compileChartEvents, generateChartString,
  generateSongIni, parseSectionName, measureTicksFromTS
} from './src/chartGen.js';
import { buildAllDifficulties, computeForcedFlags } from './src/difficultyReduction.js';
import { generatePracticeSections } from './src/sections.js';

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
  const opts = { density: 8, out: DEFAULT_OUT };
  const positionals = [];
  const boolFlags = ['starpower', 'expert-only', 'no-sections'];
  const intFlags = ['density', 'track', 'year', 'guitar-track', 'bass-track', 'drums-track'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (boolFlags.includes(key)) { opts[key] = true; continue; }
      const val = argv[i + 1]; i++;
      if (intFlags.includes(key)) opts[key] = parseInt(val);
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

// --- instrument assignment --------------------------------------------------

// A GM drum transcription lives on channel 9 or keeps ~all pitches in the GM
// percussion range (35-59).
const looksLikeDrums = (trk) => {
  if (trk.channel === 9) return true;
  if (!trk.notes.length) return false;
  const inRange = trk.notes.filter(n => n.midi >= 35 && n.midi <= 59).length;
  return inRange / trk.notes.length > 0.9;
};

// Decide which MIDI tracks become which chart instruments.
// Priority: explicit --guitar-track/--bass-track/--drums-track flags, then the
// legacy --section/--track pair, then name/channel auto-detection.
const resolveInstrumentAssignments = (midi, opts) => {
  const flagMap = { 'guitar-track': 'Single', 'bass-track': 'DoubleBass', 'drums-track': 'Drums' };
  const explicit = Object.entries(flagMap)
    .filter(([flag]) => Number.isInteger(opts[flag]))
    .map(([flag, instrument]) => ({ instrument, trackIndex: opts[flag] }));
  if (explicit.length > 0) {
    for (const a of explicit) {
      const t = midi.tracks[a.trackIndex];
      if (!t || !t.notes.length) throw new Error(`--${a.instrument} track ${a.trackIndex} has no notes.`);
    }
    return explicit;
  }

  const densest = () => {
    let idx = 0, max = -1;
    midi.tracks.forEach((t, i) => { if (t.notes.length > max) { max = t.notes.length; idx = i; } });
    return idx;
  };

  if (opts.section || Number.isInteger(opts.track)) {
    const { instrument } = parseSectionName(opts.section || 'ExpertDrums');
    const trackIndex = Number.isInteger(opts.track) ? opts.track : densest();
    const t = midi.tracks[trackIndex];
    if (!t || !t.notes.length) throw new Error('Selected MIDI track has no notes.');
    // Normalize legacy names (e.g. ExpertDoubleBass -> DoubleBass; anything
    // drum-ish -> Drums; everything else -> Single).
    const inst = /drum/i.test(instrument) ? 'Drums' : (/bass/i.test(instrument) ? 'DoubleBass' : 'Single');
    return [{ instrument: inst, trackIndex }];
  }

  // Auto-detect: name regex first, channel/pitch profile as backup; keep the
  // densest candidate per instrument.
  const byInstrument = {};
  midi.tracks.forEach((t, i) => {
    if (!t.notes.length) return;
    const name = t.name || '';
    let inst = null;
    if (/drum|perc/i.test(name) || looksLikeDrums(t)) inst = 'Drums';
    else if (/bass/i.test(name)) inst = 'DoubleBass';
    else if (/guitar|lead|gtr/i.test(name)) inst = 'Single';
    if (!inst) return;
    if (!byInstrument[inst] || midi.tracks[byInstrument[inst]].notes.length < t.notes.length) byInstrument[inst] = i;
  });
  const detected = Object.entries(byInstrument).map(([instrument, trackIndex]) => ({ instrument, trackIndex }));
  if (detected.length > 0) return detected;

  // Nothing recognizable by name: densest track, drums if it profiles like a
  // GM drum transcription (this tool's historical primary input), else guitar.
  const trackIndex = densest();
  if (!midi.tracks[trackIndex] || !midi.tracks[trackIndex].notes.length) throw new Error('MIDI has no notes.');
  return [{ instrument: looksLikeDrums(midi.tracks[trackIndex]) ? 'Drums' : 'Single', trackIndex }];
};

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

  // Instrument assignments: explicit per-instrument flags, else the legacy
  // --section/--track pair, else auto-detect from track names/channels.
  const assignments = resolveInstrumentAssignments(midi, opts);
  for (const a of assignments) {
    const t = midi.tracks[a.trackIndex];
    console.log(`      ${a.instrument.padEnd(10)} <- track [${a.trackIndex}] "${t.name || 'Unnamed'}" — ${t.notes.length} notes`);
  }
  console.log(`      MIDI tempo ${midiBPM.toFixed(2)} BPM`);

  // Tempo fit anchors to the drum track when present (best onsets), else the
  // densest assigned track.
  const fitAssignment = assignments.find(a => a.instrument === 'Drums') || assignments[0];
  const track = midi.tracks[fitAssignment.trackIndex];

  // Auto-sync tempo map against the audio (mirrors the app's runAutoTempoSync).
  console.log(`[2/5] Decoding audio + fitting tempo map (this can take ~10-30s)…`);
  let effectiveBPM = midiBPM, drumSyncOffset = 2.0, autoSync = null, bands = null, fps = 0;
  if (track.notes.length >= 12) {
    const rawMono = decodeMonoPCM(ffmpeg, opts.mp3);
    const padSamples = Math.round(2.0 * SR);
    const mono = new Float32Array(padSamples + rawMono.length);
    mono.set(rawMono, padSamples); // 2s silence lead-in, matching the exported Ogg
    ({ bands, fps } = await computeOnsetEnvelope(mono, SR));
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

  // Compile + reduce every assigned instrument. Star power is opt-in via
  // --starpower; when on, phrases are generated at Expert and mirrored down.
  console.log(`[3/5] Compiling chart events${opts.starpower ? ' + star power' : ''}…`);
  const ts = (midi.header.timeSignatures && midi.header.timeSignatures.length > 0)
    ? midi.header.timeSignatures[0].timeSignature : [4, 4];
  const measureTicks = measureTicksFromTS(ts);

  const noteSections = [];
  let allExpertEvents = [];
  const diffs = { Single: -1, DoubleBass: -1, Drums: -1 };
  for (const a of assignments) {
    const trk = midi.tracks[a.trackIndex];
    const isDrums = a.instrument === 'Drums';
    const pitchMappings = {};
    new Set(trk.notes.map(n => n.midi)).forEach(p => { pitchMappings[p] = presetMappingForPitch(p, isDrums); });

    let expertEvents = compileChartEvents({
      parsedMidi: midi, trackIndex: a.trackIndex, pitchMappings, drumSyncOffset,
      effectiveBPM, targetSection: `Expert${a.instrument}`,
      autoStarPower: !!opts.starpower, spDensityMeasures: opts.density
    });
    if (!isDrums && opts['hopo-mode'] === 'strum-downbeats') {
      expertEvents = computeForcedFlags(expertEvents, { mode: 'strum-downbeats', measureTicks });
    }
    allExpertEvents = allExpertEvents.concat(expertEvents);
    diffs[a.instrument] = 3;

    if (opts['expert-only']) {
      noteSections.push({ section: `Expert${a.instrument}`, events: expertEvents });
    } else {
      const all = buildAllDifficulties(expertEvents, {
        isDrums, isBass: a.instrument === 'DoubleBass', measureTicks
      });
      for (const [difficulty, events] of Object.entries(all)) {
        noteSections.push({ section: `${difficulty}${a.instrument}`, events });
      }
    }
    const noteCount = expertEvents.filter(e => e.type === 'N' && ![66, 67, 68].includes(e.value)).length;
    const spCount = expertEvents.filter(e => e.type === 'S').length;
    console.log(`      ${a.instrument}: ${noteCount} expert notes, ${spCount} star power phrase(s)${opts['expert-only'] ? '' : ', 4 difficulties'}`);
  }

  // Practice sections for [Events]: MIDI markers -> audio novelty -> 8-measure grid.
  let sectionEvents = [];
  if (!opts['no-sections']) {
    const playable = allExpertEvents.filter(e => e.type === 'N' && (e.value <= 4 || e.value === 7));
    const firstNoteTick = playable.length ? Math.min(...playable.map(e => e.tick)) : 0;
    const lastNoteTick = playable.length ? Math.max(...playable.map(e => e.tick)) : 0;
    sectionEvents = generatePracticeSections({
      parsedMidi: midi, leadInTicks: Math.round(drumSyncOffset * effectiveBPM * 8),
      sourcePPQ: midi.header.ppq || 480,
      bands, fps, bpmEvents: autoSync ? autoSync.bpmEvents : null, fallbackBPM: effectiveBPM,
      measureTicks, firstNoteTick, lastNoteTick
    });
    console.log(`      ${sectionEvents.length} practice section(s)`);
  }

  const chartString = generateChartString({
    parsedMidi: midi, effectiveBPM, midiBPM, drumSyncOffset, autoSync,
    songMeta: {
      name: opts.song, artist: opts.artist, charter: opts.charter,
      album: opts.album || '', genre: opts.genre || 'Custom', year: opts.year || '',
      musicStream: 'song.ogg'
    },
    sectionEvents, noteSections
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
    title: opts.song, artist: opts.artist, charter: opts.charter, musicStream: 'song.ogg', songLengthMs,
    album: opts.album || 'Custom Single', genre: opts.genre || 'Custom', year: opts.year || 2026,
    diffGuitar: diffs.Single, diffBass: diffs.DoubleBass, diffDrums: diffs.Drums
  }));

  console.log(`\n✅ Done → ${destDir}`);
  console.log(`   notes.chart, song.ini, song.ogg`);
};

main().catch(err => { console.error('\n❌ ' + err.message); process.exit(1); });
