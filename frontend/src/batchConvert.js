// Browser-side batch conversion. Pairs MIDI + audio files from a picked folder
// and writes finished Clone Hero song folders to a picked output folder via the
// File System Access API. Reuses the same pure logic as the single-file flow.
//
// Name parsing/pairing are pure and unit-tested in Node; buildSongToDirectory is
// browser-only (Web Audio decode + WAV encode + FS Access writes).

import { Midi } from '@tonejs/midi';
import { computeOnsetEnvelope, fitTempoMap, anchorsToBpmEvents, fitWeightForPitch, fitBandForPitch } from './tempoAnalysis.js';
import { presetMappingForPitch, isDrumsSection, compileChartEvents, generateChartString, generateSongIni } from './chartGen.js';
import { padAudioBuffer, audioBufferToWav } from './audioUtil.js';

export const MIDI_EXTS = ['mid', 'midi'];
export const AUDIO_EXTS = ['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus'];

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
  .replace(/custom|export|final|drums?|\bv\d+\b/g, '')
  .replace(/[^a-z0-9]/g, '');

// Best-effort artist/song from a chart filename like "Artist-Song-06-16-2026".
export const parseSongName = (filename) => {
  const base = stripExt(filename)
    .replace(/_custom_export$/i, '')                          // strip tag first…
    .replace(/[-_ ]\d{1,2}[-_]\d{1,2}[-_]\d{2,4}\s*$/, '')    // …so the date is now trailing
    .trim();
  const m = base.match(/^(.*?)\s*-\s*(.+)$/);
  if (m) return { artist: m[1].trim(), song: m[2].trim() };
  return { artist: '', song: base };
};

// Pair each MIDI entry to its best-matching audio entry. Entries are
// { name, handle }. Returns rows with { midi, audio|null, artist, song }.
export const pairFiles = (midis, audios) => midis.map((m) => {
  const mn = normalizeName(m.name);
  let best = null, bestScore = 0;
  for (const a of audios) {
    const an = normalizeName(a.name);
    let score;
    if (an === mn) score = 10000;
    else if (an.includes(mn) || mn.includes(an)) score = Math.min(an.length, mn.length) + 100;
    else {
      let i = 0;
      while (i < an.length && i < mn.length && an[i] === mn[i]) i++;
      score = i;
    }
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return { midi: m, audio: bestScore >= 4 ? best : null, ...parseSongName(m.name) };
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

// Build one song folder under outDirHandle. midiFile/audioFile are File objects.
export const buildSongToDirectory = async ({
  midiFile, audioFile, artist, song, charter = 'n3rdy13',
  section = 'ExpertDrums', density = 8, autoStarPower = false, outDirHandle, audioCtx, onStage = () => {}
}) => {
  if (!artist || !song) throw new Error('artist and song are required');

  onStage('parsing');
  const midi = new Midi(await midiFile.arrayBuffer());
  const midiBPM = (midi.header.tempos && midi.header.tempos.length) ? midi.header.tempos[0].bpm : 120;

  let trackIndex = 0, max = -1;
  midi.tracks.forEach((t, i) => { if (t.notes.length > max) { max = t.notes.length; trackIndex = i; } });
  const trk = midi.tracks[trackIndex];
  if (!trk || !trk.notes.length) throw new Error('MIDI has no notes');

  const isDrums = isDrumsSection(section);
  const pitchMappings = {};
  new Set(trk.notes.map((n) => n.midi)).forEach((p) => { pitchMappings[p] = presetMappingForPitch(p, isDrums); });

  onStage('decoding');
  const decoded = await audioCtx.decodeAudioData(await audioFile.arrayBuffer());
  const padded = padAudioBuffer(audioCtx, decoded, 2.0);

  let effectiveBPM = midiBPM, drumSyncOffset = 2.0, autoSync = null;
  if (trk.notes.length >= 12) {
    onStage('syncing');
    const mono = new Float32Array(padded.length);
    for (let c = 0; c < padded.numberOfChannels; c++) {
      const d = padded.getChannelData(c);
      for (let i = 0; i < d.length; i++) mono[i] += d[i] / padded.numberOfChannels;
    }
    const { bands, fps } = await computeOnsetEnvelope(mono, padded.sampleRate);
    const ppq = midi.header.ppq || 480;
    const hits = trk.notes.map((n) => ({ beat: n.ticks / ppq, w: fitWeightForPitch(n.midi), band: fitBandForPitch(n.midi) }));
    const fit = await fitTempoMap(bands, fps, hits, midiBPM);
    const globalBPM = parseFloat((60 / fit.alpha).toFixed(3));
    const offsetSeconds = parseFloat(Math.max(0, fit.anchors[0].time).toFixed(3));
    const leadInTicks = Math.round(offsetSeconds * globalBPM * 8);
    autoSync = { bpmEvents: anchorsToBpmEvents(fit.anchors, globalBPM, leadInTicks), globalBPM, offsetSeconds };
    effectiveBPM = globalBPM; drumSyncOffset = offsetSeconds;
  }

  onStage('charting');
  const chartEvents = compileChartEvents({
    parsedMidi: midi, trackIndex, pitchMappings, drumSyncOffset,
    effectiveBPM, targetSection: section, autoStarPower, spDensityMeasures: density
  });
  const chartString = generateChartString({
    parsedMidi: midi, chartEvents, targetSection: section, effectiveBPM, midiBPM, drumSyncOffset, autoSync
  });
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
  await writeFile(dir, 'notes.chart', chartString);
  await writeFile(dir, 'song.ini', iniString);
  await writeFile(dir, 'song.wav', wavBlob);

  return {
    folderName,
    notes: chartEvents.filter((e) => e.type === 'N' && ![66, 67, 68].includes(e.value)).length,
    starPower: chartEvents.filter((e) => e.type === 'S').length,
    bpm: effectiveBPM, autoSynced: !!autoSync
  };
};
