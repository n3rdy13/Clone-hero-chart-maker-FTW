// Pure, framework-agnostic Clone Hero chart generation shared by the React app
// (App.jsx) and the headless CLI (convert.mjs). No React/DOM imports — mirrors
// tempoAnalysis.js so both surfaces produce byte-identical charts from the same
// logic. Everything works in the 480-PPQ tick domain the exporter expects.

// --- Preset pitch -> mapping ------------------------------------------------

// Default mapping for a MIDI pitch given the target instrument. Drums use the
// GM percussion map; guitar uses the RB/PS note-96 (and octave-60) layout, with
// note 116 as the star power marker.
export const presetMappingForPitch = (pitch, isDrums) => {
  if (isDrums) {
    if (pitch === 35 || pitch === 36) return 'kick';
    if (pitch === 38 || pitch === 40) return 'red';
    if (pitch === 42 || pitch === 44 || pitch === 46) return 'yellow_cymbal';
    if (pitch === 48 || pitch === 50) return 'yellow_pad';
    if (pitch === 45 || pitch === 47) return 'blue_pad';
    if (pitch === 51 || pitch === 53 || pitch === 59) return 'blue_cymbal';
    if (pitch === 41 || pitch === 43) return 'green_pad';
    if (pitch === 49 || pitch === 52 || pitch === 55 || pitch === 57) return 'green_cymbal';
    return 'ignore';
  }
  if (pitch === 96 || pitch === 60) return 'g0';
  if (pitch === 97 || pitch === 61) return 'g1';
  if (pitch === 98 || pitch === 62) return 'g2';
  if (pitch === 99 || pitch === 63) return 'g3';
  if (pitch === 100 || pitch === 64) return 'g4';
  if (pitch === 101 || pitch === 65) return 'g5';
  if (pitch === 102 || pitch === 66) return 'g6';
  if (pitch === 103 || pitch === 67) return 'g7';
  if (pitch === 116) return 'starpower';
  return 'ignore';
};

export const isDrumsSection = (targetSection) => targetSection.toLowerCase().includes('drum');

export const getLaneNoteIndex = (mapping) => {
  switch (mapping) {
    case 'kick': return 0;
    case 'double_kick': return 32;
    case 'red': return 1;
    case 'yellow_pad':
    case 'yellow_cymbal': return 2;
    case 'blue_pad':
    case 'blue_cymbal': return 3;
    case 'green_pad':
    case 'green_cymbal': return 4;
    // Guitar mappings
    case 'g0': return 0;
    case 'g1': return 1;
    case 'g2': return 2;
    case 'g3': return 3;
    case 'g4': return 4;
    case 'g5': return 5;
    case 'g6': return 6;
    case 'g7': return 7;
    default: return 0;
  }
};

// Measure length in the 480-PPQ domain from a MIDI time-signature pair [num,den].
export const measureTicksFromTS = (ts) => {
  const t = ts && ts.length ? ts : [4, 4];
  return Math.max(1, Math.round(t[0] * (4 / (t[1] || 4)) * 480));
};

// --- Star power -------------------------------------------------------------

// Auto-generate Clone Hero star power phrases from compiled note events.
// A .chart SP phrase is a region "<tick> = S 2 <length>": every note inside
// [tick, tick+length] becomes an SP note and the LAST note in the region is the
// activation note, so a phrase must start and end on real notes. Transcribed
// MIDIs carry no note-116 SP markers, so we synthesize phrases from the notes.
//
// Strategy (windowed): step along the timeline every `densityMeasures` measures
// and carve a bounded phrase (~`maxPhraseMeasures` measures) that starts on the
// next real onset and ends on the last onset inside the window. A pure rest-gap
// grouping would collapse a steady, gapless groove (e.g. a continuous hi-hat)
// into ONE giant phrase spanning the whole song — this bounds every phrase and
// keeps the density knob meaningful. Deterministic (no Date/random) so it can
// run inside a React effect.
export const generateStarPowerPhrases = (noteEvents, { measureTicks, densityMeasures, minNotes = 3, maxPhraseMeasures = 2 }) => {
  const onsets = [...new Set(
    noteEvents
      .filter(e => e.type === 'N' && !(e.value === 66 || e.value === 67 || e.value === 68))
      .map(e => e.tick)
  )].sort((a, b) => a - b);

  if (onsets.length < minNotes) return [];

  const lastOnset = onsets[onsets.length - 1];
  const targetSpacing = Math.max(1, densityMeasures) * measureTicks;
  const maxPhraseLen = Math.min(maxPhraseMeasures * measureTicks, Math.floor(targetSpacing * 0.5));

  const phrases = [];
  let cursor = onsets[0];
  let oi = 0;

  while (cursor <= lastOnset) {
    while (oi < onsets.length && onsets[oi] < cursor) oi++;
    if (oi >= onsets.length) break;
    const start = onsets[oi];

    const windowEnd = start + maxPhraseLen;
    let j = oi, count = 0, endOnset = start;
    while (j < onsets.length && onsets[j] <= windowEnd) { endOnset = onsets[j]; count++; j++; }

    if (count >= minNotes && endOnset > start) {
      const nextOnset = j < onsets.length ? onsets[j] : Infinity;
      const tail = Math.max(1, Math.min(240, Math.floor((nextOnset - endOnset) / 2)));
      phrases.push({ tick: start, length: (endOnset - start) + tail });
    }

    cursor = start + targetSpacing;
  }

  return phrases;
};

// --- Compile note + star-power events --------------------------------------

// Turn a parsed MIDI track + pitch mappings into sorted chart events
// ({ id, tick, type, value, duration, ... }). Includes editor metadata
// (pairId/mappedType/originalPitch) that the app uses and the writer ignores.
export const compileChartEvents = ({
  parsedMidi, trackIndex, pitchMappings, drumSyncOffset,
  effectiveBPM, targetSection, autoStarPower = false, spDensityMeasures = 8
}) => {
  const track = parsedMidi.tracks[trackIndex];
  if (!track) return [];

  const sourcePPQ = parsedMidi.header.ppq || 480;
  const drumsMode = isDrumsSection(targetSection);
  const leadInTicks = Math.round(drumSyncOffset * effectiveBPM * 8);

  const compiledEvents = [];
  let idCounter = 1;

  track.notes.forEach(note => {
    const mapping = pitchMappings[note.midi] || 'ignore';
    if (mapping === 'ignore') return;

    const targetTick = Math.round(note.ticks * (480 / sourcePPQ)) + leadInTicks;
    const durationTicks = Math.round(note.durationTicks * (480 / sourcePPQ));

    if (mapping === 'starpower') {
      compiledEvents.push({ id: idCounter++, tick: targetTick, type: 'S', value: 2, duration: durationTicks, originalPitch: note.midi });
    } else {
      const padId = idCounter++;
      compiledEvents.push({
        id: padId, tick: targetTick, type: 'N', value: getLaneNoteIndex(mapping),
        duration: drumsMode ? 0 : durationTicks, originalPitch: note.midi, mappedType: mapping
      });
      const cymbalFlag = { yellow_cymbal: 66, blue_cymbal: 67, green_cymbal: 68 }[mapping];
      if (cymbalFlag !== undefined) {
        compiledEvents.push({
          id: idCounter++, pairId: padId, tick: targetTick, type: 'N', value: cymbalFlag,
          duration: 0, originalPitch: note.midi, mappedType: mapping + '_marker'
        });
      }
    }
  });

  // Auto-generate SP only when the source carries no explicit SP markers.
  const hasExistingSP = compiledEvents.some(e => e.type === 'S');
  if (autoStarPower && !hasExistingSP) {
    const ts = (parsedMidi.header.timeSignatures && parsedMidi.header.timeSignatures.length > 0)
      ? parsedMidi.header.timeSignatures[0].timeSignature : [4, 4];
    const phrases = generateStarPowerPhrases(compiledEvents, {
      measureTicks: measureTicksFromTS(ts), densityMeasures: spDensityMeasures
    });
    phrases.forEach(p => compiledEvents.push({ id: idCounter++, tick: p.tick, type: 'S', value: 2, duration: p.length }));
  }

  compiledEvents.sort((a, b) => a.tick - b.tick);
  return compiledEvents;
};

// --- .chart text ------------------------------------------------------------

// Build the full notes.chart text. autoSync (optional) is the fitted multi-BPM
// map { bpmEvents: [{tick,bpm}] }; when absent the MIDI tempos are scaled by
// effectiveBPM/midiBPM.
export const generateChartString = ({
  parsedMidi, chartEvents, targetSection, effectiveBPM, midiBPM, drumSyncOffset, autoSync
}) => {
  const lines = [];
  lines.push('[Song]');
  lines.push('{');
  lines.push('  Resolution = 480');
  lines.push('  MusicStream = "song.ogg"');
  lines.push('}');

  lines.push('[SyncTrack]');
  lines.push('{');

  const sourcePPQ = parsedMidi ? (parsedMidi.header.ppq || 480) : 480;
  const tempoRatio = effectiveBPM / midiBPM;
  const leadInTicks = Math.round(drumSyncOffset * effectiveBPM * 8);
  const syncLines = [];

  let midiTS = (parsedMidi && parsedMidi.header.timeSignatures && parsedMidi.header.timeSignatures.length > 0)
    ? [...parsedMidi.header.timeSignatures].sort((a, b) => a.ticks - b.ticks)
    : [{ ticks: 0, timeSignature: [4, 4] }];
  if (midiTS[0].ticks > 0) {
    midiTS = [{ ticks: 0, timeSignature: midiTS[0].timeSignature }, ...midiTS];
  }
  midiTS.forEach(ts => {
    const scaled = Math.round(ts.ticks * (480 / sourcePPQ));
    const tick = scaled === 0 ? 0 : scaled + leadInTicks;
    const denomLog = Math.round(Math.log2(ts.timeSignature[1] || 4));
    syncLines.push({ tick, order: 0, text: `TS ${ts.timeSignature[0]} ${denomLog}` });
  });

  if (autoSync && autoSync.bpmEvents && autoSync.bpmEvents.length > 0) {
    autoSync.bpmEvents.forEach(ev => {
      syncLines.push({ tick: ev.tick, order: 1, text: `B ${Math.round(ev.bpm * 1000)}` });
    });
  } else {
    let midiTempos = (parsedMidi && parsedMidi.header.tempos && parsedMidi.header.tempos.length > 0)
      ? [...parsedMidi.header.tempos].sort((a, b) => a.ticks - b.ticks)
      : [{ ticks: 0, bpm: 120 }];
    if (midiTempos[0].ticks > 0) {
      midiTempos = [{ ticks: 0, bpm: midiTempos[0].bpm }, ...midiTempos];
    }
    midiTempos.forEach(t => {
      const scaled = Math.round(t.ticks * (480 / sourcePPQ));
      const tick = scaled === 0 ? 0 : scaled + leadInTicks;
      syncLines.push({ tick, order: 1, text: `B ${Math.round(t.bpm * tempoRatio * 1000)}` });
    });
  }

  syncLines.sort((a, b) => (a.tick !== b.tick ? a.tick - b.tick : a.order - b.order));
  // Collapse duplicates: multi-track MIDIs often repeat identical TS/tempo meta
  // events (one per track), which would emit redundant SyncTrack lines.
  const seenSync = new Set();
  syncLines.forEach(s => {
    const key = `${s.tick}=${s.text}`;
    if (seenSync.has(key)) return;
    seenSync.add(key);
    lines.push(`  ${s.tick} = ${s.text}`);
  });
  lines.push('}');

  lines.push('[Events]');
  lines.push('{');
  lines.push('}');

  lines.push(`[${targetSection}]`);
  lines.push('{');

  const sorted = [...chartEvents].sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    return a.value - b.value;
  });

  sorted.forEach(evt => {
    if (evt.type === 'S') lines.push(`  ${evt.tick} = S 2 ${evt.duration}`);
    else lines.push(`  ${evt.tick} = N ${evt.value} ${evt.duration}`);
  });

  lines.push('}');
  return lines.join('\n');
};

// --- song.ini ---------------------------------------------------------------

export const generateSongIni = ({ title, artist, charter, musicStream = 'song.ogg', songLengthMs = 180000 }) =>
  `[song]\nname = ${title || 'Custom Chart'}\nartist = ${artist || 'Various Artists'}\ncharter = ${charter || 'Master Utility'}\nalbum = Custom Single\nyear = 2026\ngenre = Custom\nplaylist_track = 1\nsong_length = ${Math.round(songLengthMs)}\npreview_start_time = 30000\ndelay = 0\nmusic_stream = ${musicStream}\npro_drums = True\ndiff_drums = 3\ndiff_guitar = 3\nsysex_slider = True\nmultiplier_note = 116\n`;
