// Browser-side batch conversion. Pairs MIDI + audio files (and optional drum
// stems) from a picked folder and writes finished Clone Hero song folders to a
// picked output folder via the File System Access API. Uses the same engine as
// the single-song editor.
//
// Name parsing/pairing are pure and unit-tested in Node; buildSongToDirectory
// is browser-only (Web Audio decode + WAV encode + FS Access writes).

import * as midiModule from '@tonejs/midi';
// Vite loads the package's ES build (named export), Node its CommonJS build.
const Midi = midiModule.Midi ?? midiModule.default?.Midi;
import { createEngine } from './engine/client.js';
import { ANALYSIS_SR, DEFAULT_TRACKING } from './engine/analyze.js';
import { buildChart } from './songBuilder.js';
import { LEAD_IN_SECONDS, generateSongIni, isFlagValue } from './chartGen.js';
import { padAudioBuffer, audioBufferToWav, decodeForAnalysis } from './audioUtil.js';

export const MIDI_EXTS = ['mid', 'midi'];
export const AUDIO_EXTS = ['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus', 'aac'];

export const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
export const stripExt = (name) => name.replace(/\.[^.]+$/, '');
// Make a string safe as a Windows/Chromium file-or-folder name: drop illegal
// characters (incl. path separators, which trigger the FS Access API's "Name is
// not allowed"), collapse whitespace, strip trailing dots/spaces, avoid reserved
// device names, and never return empty.
export const sanitize = (s, fallback = 'Untitled') => {
  let out = String(s == null ? '' : s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')  // illegal -> space (don't fuse words)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');                 // Windows forbids trailing dot/space
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out)) out += '_';
  return out || fallback;
};

// Assemble "Artist - Song" (dropping an empty half) into a safe folder name.
export const songFolderName = (artist, song) =>
  sanitize([artist, song].map(x => String(x == null ? '' : x).trim()).filter(Boolean).join(' - '), 'Untitled Song');

// Normalize a filename for fuzzy matching: drop extension, date stamps, common
// tags, and all non-alphanumerics.
export const normalizeName = (name) => stripExt(name).toLowerCase()
  .replace(/[-_ ]\d{1,2}[-_]\d{1,2}[-_]\d{2,4}\b/g, '')
  .replace(/songsterr|unknown artist/g, '')
  .replace(/custom|export|final|drums?|stem|\bv\d+\b/g, '')
  .replace(/[^a-z0-9]/g, '');

export const isDrumStemName = (name) => /drum|stem/i.test(stripExt(name));

// Best-effort artist/song from a chart filename like "Artist-Song-06-16-2026".
// Songsterr's "Unknown Artist" placeholder and a trailing "Drums" are dropped.
export const parseSongName = (filename) => {
  const base = stripExt(filename)
    .replace(/_custom_export$/i, '')                          // strip tag first…
    .replace(/[-_ ]\d{1,2}[-_]\d{1,2}[-_]\d{2,4}\s*$/, '')    // …so the date is now trailing
    .trim();
  const m = base.match(/^(.*?)\s*-\s*(.+)$/);
  if (m) {
    const artist = /^unknown artist$/i.test(m[1].trim()) ? '' : m[1].trim();
    return { artist, song: m[2].replace(/[\s_-]*(songsterr|drums?)\s*$/i, '').trim() || m[2].trim() };
  }
  return { artist: '', song: base.replace(/[\s_-]*(songsterr|drums?)\s*$/i, '').trim() || base };
};

const similarity = (a, b) => {
  if (a === b) return 10000;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) + 100;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

// Pair each MIDI entry to its best-matching song audio, plus a drum stem when
// one matches too. Entries are { name, handle }. Returns rows with
// { midi, audio|null, stem|null, artist, song }.
export const pairFiles = (midis, audios) => midis.map((m) => {
  const mn = normalizeName(m.name);
  const scored = audios.map((a) => ({ a, score: similarity(normalizeName(a.name), mn) })).filter((x) => x.score >= 4);
  scored.sort((x, y) => y.score - x.score);
  const songs = scored.filter((x) => !isDrumStemName(x.a.name));
  const stems = scored.filter((x) => isDrumStemName(x.a.name));
  // A lone "drums" file with nothing else is used as the song audio itself.
  const audio = songs[0]?.a ?? stems[0]?.a ?? null;
  const stem = songs[0] ? stems[0]?.a ?? null : null;
  return { midi: m, audio, stem, ...parseSongName(m.name) };
});

const writeFile = async (dirHandle, name, data) => {
  let fh;
  try {
    fh = await dirHandle.getFileHandle(name, { create: true });
  } catch (e) {
    throw new Error(`couldn't create file "${name}" (${e.name}: ${e.message})`);
  }
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
};

let enginePromise = null;
const getEngine = () => (enginePromise ??= createEngine());

// Build one song folder under outDirHandle. midiFile/audioFile/stemFile are File objects.
export const buildSongToDirectory = async ({
  midiFile, audioFile, stemFile = null, artist, song, charter = 'n3rdy13',
  section = 'ExpertDrums', density = 8, autoStarPower = false, dropFlaggedKicks = false,
  outDirHandle, audioCtx, onStage = () => {}
}) => {
  if (!artist || !song) throw new Error('artist and song are required');

  onStage('parsing');
  const midi = new Midi(await midiFile.arrayBuffer());

  onStage('decoding');
  const { buffer, samples } = await decodeForAnalysis(audioFile, ANALYSIS_SR);
  const stem = stemFile ? (await decodeForAnalysis(stemFile, ANALYSIS_SR)).samples : null;

  onStage('syncing');
  const engine = await getEngine();
  const res = await engine.load(samples, stem, ANALYSIS_SR, DEFAULT_TRACKING);
  onStage('drums');
  const acts = await engine.transcribe();

  onStage('charting');
  const built = buildChart({
    analysis: { duration: res.summary.duration, beats: res.beats, onset: res.onset, acts },
    midi, section, meta: { name: song, artist, charter }, musicStream: 'song.wav',
    autoStarPower, spEveryBars: density, dropFlaggedKicks
  });
  const padded = padAudioBuffer(audioCtx, buffer, LEAD_IN_SECONDS);
  const iniString = generateSongIni({
    title: song, artist, charter, musicStream: 'song.wav', songLengthMs: Math.round(padded.duration * 1000)
  });

  onStage('encoding');
  const wavBlob = audioBufferToWav(padded);

  onStage('writing');
  const folderName = songFolderName(artist, song);
  let dir;
  try {
    dir = await outDirHandle.getDirectoryHandle(folderName, { create: true });
  } catch (e) {
    throw new Error(`couldn't create folder "${folderName}" (${e.name}: ${e.message})`);
  }
  await writeFile(dir, 'notes.chart', built.chart);
  await writeFile(dir, 'song.ini', iniString);
  await writeFile(dir, 'song.wav', wavBlob);

  const bpms = built.map.events.filter((e) => !e.leadIn).map((e) => e.bpm).sort((a, b) => a - b);
  return {
    folderName,
    notes: built.events.filter((e) => e.type === 'N' && !isFlagValue(e.value)).length,
    starPower: built.events.filter((e) => e.type === 'S').length,
    bpm: bpms.length ? bpms[bpms.length >> 1] : 0,
    flaggedKicks: built.stats.flaggedKicks,
    removedKicks: built.stats.removedKicks,
    beatSource: res.summary.beatSource,
  };
};
