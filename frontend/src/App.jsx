import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  FileAudio,
  Music,
  Upload,
  RefreshCw,
  Settings,
  Play,
  Pause,
  Square,
  Download,
  AlertCircle,
  Trash2,
  Edit3,
  SlidersHorizontal,
  ChevronRight,
  Volume2,
  VolumeX,
  Zap,
  Drum,
  ShieldCheck
} from 'lucide-react';
import { Midi } from '@tonejs/midi';
import JSZip from 'jszip';
import { createEngine } from './engine/client';
import { ANALYSIS_SR, DEFAULT_TRACKING } from './engine/analyze';
import { midiToPart, pickDefaultTrack, isRockBandDrums } from './engine/part';
import { detectedPart, DETECT_NAMES } from './engine/detect';
import {
  LEAD_IN_SECONDS,
  isDrumsSection,
  presetMappingForPitch,
  chartTimeSigs,
  barStartBeats,
  compileChartEvents,
  chartTempos,
  makeTickToSeconds,
  generateChartString as buildChartString,
  generateSongIni as buildSongIni,
  isFlagValue,
  drumMappingId
} from './chartGen';
import { gridFromBeats, alignmentEvidence, alignPart, kickCheckFor } from './songBuilder';
import { partBeatToSeconds } from './engine/part';
import { decodeForAnalysis, padAudioBuffer, audioBufferToWav, playDrumSound } from './audioUtil';
import { parseSongName, stripExt } from './batchConvert';
import BatchConverter from './BatchConverter';

const PAD = LEAD_IN_SECONDS;
const AUDIO_ACCEPT = '.mp3,.m4a,.aac,.ogg,.opus,.wav,.flac';

// General MIDI Drum Pitches Map
const GM_DRUM_MAP = {
  35: "Acoustic Bass Drum", 36: "Bass Drum 1", 37: "Side Stick", 38: "Acoustic Snare",
  39: "Hand Clap", 40: "Electric Snare", 41: "Low Floor Tom", 42: "Closed Hi-Hat",
  43: "High Floor Tom", 44: "Pedal Hi-Hat", 45: "Low Tom", 46: "Open Hi-Hat",
  47: "Low-Mid Tom", 48: "Hi-Mid Tom", 49: "Crash Cymbal 1", 50: "High Tom",
  51: "Ride Cymbal 1", 52: "Chinese Cymbal", 53: "Ride Bell", 54: "Tambourine",
  55: "Splash Cymbal", 56: "Cowbell", 57: "Crash Cymbal 2", 58: "Vibraslap",
  59: "Ride Cymbal 2", 60: "Hi Bongo", 61: "Low Bongo", 62: "Mute Hi Conga",
  63: "Open Hi Conga", 64: "Low Conga", 65: "High Timbale", 66: "Low Timbale",
  67: "High Agogo", 68: "Low Agogo", 69: "Cabasa", 70: "Maracas",
  71: "Short Whistle", 72: "Long Whistle", 73: "Short Guiro", 74: "Long Guiro",
  75: "Claves", 76: "Hi Wood Block", 77: "Low Wood Block", 78: "Mute Cuica",
  79: "Open Cuica", 80: "Mute Triangle", 81: "Open Triangle"
};

const MAPPING_OPTIONS_DRUMS = [
  { value: "ignore", label: "Ignore / Unmapped", class: "bg-slate-800 text-slate-400" },
  { value: "kick", label: "Kick Pedal (Lane 0 / Note 0)", class: "bg-slate-700 text-slate-100 font-semibold" },
  { value: "double_kick", label: "Double Kick (Note 32)", class: "bg-indigo-900/60 text-indigo-200" },
  { value: "red", label: "Red Pad (Snare / Lane 1 / Note 1)", class: "bg-red-950/60 text-red-200" },
  { value: "yellow_pad", label: "Yellow Pad (Tom / Lane 2 / Note 2)", class: "bg-amber-950/60 text-amber-200" },
  { value: "yellow_cymbal", label: "Yellow Cymbal (Hi-Hat / Lane 2 / Note 2+66)", class: "bg-yellow-900/50 text-yellow-100 font-bold" },
  { value: "blue_pad", label: "Blue Pad (Tom / Lane 3 / Note 3)", class: "bg-blue-950/60 text-blue-200" },
  { value: "blue_cymbal", label: "Blue Cymbal (Ride / Lane 3 / Note 3+67)", class: "bg-blue-900/50 text-blue-100 font-bold" },
  { value: "green_pad", label: "Green Pad (Floor Tom / Lane 4 / Note 4)", class: "bg-emerald-950/60 text-emerald-200" },
  { value: "green_cymbal", label: "Green Cymbal (Crash / Lane 4 / Note 4+68)", class: "bg-emerald-900/50 text-emerald-100 font-bold" },
  { value: "starpower", label: "Star Power / Overdrive (Special S 2)", class: "bg-purple-950/60 text-purple-200 font-bold" }
];

const MAPPING_OPTIONS_GUITAR = [
  { value: "ignore", label: "Ignore / Unmapped", class: "bg-slate-800 text-slate-400" },
  { value: "g0", label: "Green (Lane 0 / Note 0)", class: "bg-emerald-900/60 text-emerald-200 font-semibold" },
  { value: "g1", label: "Red (Lane 1 / Note 1)", class: "bg-red-900/60 text-red-200 font-semibold" },
  { value: "g2", label: "Yellow (Lane 2 / Note 2)", class: "bg-amber-900/60 text-amber-200 font-semibold" },
  { value: "g3", label: "Blue (Lane 3 / Note 3)", class: "bg-blue-900/60 text-blue-200 font-semibold" },
  { value: "g4", label: "Orange (Lane 4 / Note 4)", class: "bg-orange-900/60 text-orange-200 font-semibold" },
  { value: "g5", label: "Forced Flag (HOPO / Note 5)", class: "bg-slate-800 text-slate-200" },
  { value: "g6", label: "Tap Flag (Note 6)", class: "bg-slate-800 text-slate-200" },
  { value: "g7", label: "Open Note (Lane 7 / Note 7)", class: "bg-slate-700 text-slate-300" },
  { value: "starpower", label: "Star Power (Special S 2)", class: "bg-purple-950/60 text-purple-200 font-bold" }
];

const LANE_NAMES = ['kick', 'red', 'yellow', 'blue', 'green'];
const SIXTEENTH = 120; // ticks at 480 resolution

const fmtTime = (t) => {
  if (!isFinite(t)) return '—';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

// Bar.beat label of a chart beat, from bar line positions.
const barBeatLabel = (beat, bars) => {
  let i = 0;
  while (i + 1 < bars.length && bars[i + 1] <= beat + 1e-9) i++;
  const into = beat - (bars[i] ?? 0);
  return `${i + 1}.${Number((into + 1).toFixed(2))}`;
};

const readMeta = (file, extra = {}) => ({
  name: file.name,
  size: file.size > 1024 * 1024 ? (file.size / (1024 * 1024)).toFixed(2) + ' MB' : (file.size / 1024).toFixed(1) + ' KB',
  ...extra
});

export default function App() {
  // --- Files ---------------------------------------------------------------
  const [midiMetadata, setMidiMetadata] = useState(null);
  const [parsedMidi, setParsedMidi] = useState(null);

  const [audioFile, setAudioFile] = useState(null);
  const [audioMetadata, setAudioMetadata] = useState(null);
  const [stemMetadata, setStemMetadata] = useState(null);
  const [transcodedAudioBlob, setTranscodedAudioBlob] = useState(null);
  const [transcoding, setTranscoding] = useState(false);
  const mixSamplesRef = useRef(null);
  const stemSamplesRef = useRef(null);
  const [audioVersion, setAudioVersion] = useState(0); // bumps when song/stem samples change
  const [songDuration, setSongDuration] = useState(0); // seconds, without the lead-in

  const [audioCtxStatus, setAudioCtxStatus] = useState('uninitialized');

  // INI Configuration states
  const [iniTitle, setIniTitle] = useState('');
  const [iniArtist, setIniArtist] = useState('');
  const [iniCharter, setIniCharter] = useState('CharterMaster');

  // --- Analysis (beats + drum activations) ---------------------------------
  const engineRef = useRef(null);
  const analysisTokenRef = useRef(0);
  const [analysis, setAnalysis] = useState({ status: 'idle', message: '', summary: null, beats: [], onset: null, acts: null });
  const [tracking, setTracking] = useState(DEFAULT_TRACKING);
  const [toleranceMs, setToleranceMs] = useState(20);

  // --- Chart source & mapping ----------------------------------------------
  const [selectedTrackIndex, setSelectedTrackIndex] = useState(0);
  const [targetChartSection, setTargetChartSection] = useState('ExpertDrums');
  const [drumSource, setDrumSource] = useState('tab'); // tab | detect
  const [sensitivity, setSensitivity] = useState(50);
  const [snapDivision, setSnapDivision] = useState(4);
  const [manualOffset, setManualOffset] = useState(null); // null = auto
  const [dropFlaggedKicks, setDropFlaggedKicks] = useState(false);

  const [autoStarPower, setAutoStarPower] = useState(false);
  const [spDensityMeasures, setSpDensityMeasures] = useState(8);

  const [pitchMappings, setPitchMappings] = useState({});
  const [pitchSearchQuery, setPitchSearchQuery] = useState('');

  const [chartEvents, setChartEvents] = useState([]);
  const [compileStats, setCompileStats] = useState(null);

  // --- Preview / transport --------------------------------------------------
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [scrollSpeed, setScrollSpeed] = useState(350);
  const [enableNoteSFX, setEnableNoteSFX] = useState(true);
  const [selectedNote, setSelectedNote] = useState(null);

  const audioContextRef = useRef(null);
  const audioBufferRef = useRef(null);
  const audioSourceRef = useRef(null);
  const startTimeRef = useRef(0);
  const pauseTimeRef = useRef(0);
  const animationFrameRef = useRef(null);
  const schedulerRef = useRef(null);
  const playingRef = useRef(false);
  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);

  const isDrumsMode = isDrumsSection(targetChartSection);

  const getEngine = () => {
    if (!engineRef.current) engineRef.current = createEngine();
    return engineRef.current;
  };

  const getAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioContextRef.current;
  };

  const updateAudioContextStatus = () => {
    if (audioContextRef.current) setAudioCtxStatus(audioContextRef.current.state);
  };

  // --- File handlers --------------------------------------------------------

  const handleMidiUpload = async (file) => {
    try {
      const midi = new Midi(await file.arrayBuffer());
      setParsedMidi(midi);
      setMidiMetadata(readMeta(file, {
        ppq: midi.header.ppq,
        duration: midi.duration.toFixed(1) + 's',
        tracksCount: midi.tracks.length
      }));
      setSelectedTrackIndex(pickDefaultTrack(midi));
      setManualOffset(null);
      setDrumSource('tab');
      // Songsterr exports are named like "Artist-Song-10-21-2026.mid".
      const guess = parseSongName(file.name);
      if (!iniTitle) setIniTitle(midi.header.name && !/^unknown/i.test(midi.header.name) ? midi.header.name : guess.song);
      if (!iniArtist && guess.artist && !/^unknown artist$/i.test(guess.artist)) setIniArtist(guess.artist);
    } catch (err) {
      console.error(err);
      alert('Failed to parse MIDI file. Verify that it is not malformed.');
    }
  };

  // Ask the backend (ffmpeg) to convert a file to a padded Ogg.
  const transcodeOnServer = async (file) => {
    const formData = new FormData();
    formData.append('audio', file);
    const response = await fetch('/api/transcode', { method: 'POST', body: formData });
    if (!response.ok) throw new Error('Transcode server returned error: ' + response.statusText);
    return response.blob();
  };

  // Decode in the browser; if the browser lacks the codec (e.g. M4A/AAC in
  // some Firefox or Chromium builds), let the backend convert it first. The
  // backend's Ogg already carries the PAD-second lead-in.
  const decodeWithFallback = async (file, setMeta) => {
    try {
      return { ...(await decodeForAnalysis(file, ANALYSIS_SR)), serverOgg: null };
    } catch (e) {
      setMeta(prev => ({ ...prev, duration: 'Converting on the local server…' }));
      let ogg;
      try {
        ogg = await transcodeOnServer(file);
      } catch (e2) {
        throw new Error(`${e.message} The local server couldn't convert it either (is the backend running?).`);
      }
      const d = await decodeForAnalysis(new File([ogg], 'converted.ogg', { type: 'audio/ogg' }), ANALYSIS_SR);
      return { buffer: d.buffer, samples: d.samples.slice(Math.round(PAD * ANALYSIS_SR)), serverOgg: ogg };
    }
  };

  const handleAudioUpload = async (file) => {
    setAudioFile(file);
    setAudioMetadata(readMeta(file, { duration: 'Decoding…' }));
    setManualOffset(null);
    const ctx = getAudioContext();
    updateAudioContextStatus();
    let decoded;
    try {
      decoded = await decodeWithFallback(file, setAudioMetadata);
    } catch (e) {
      console.error('Decoding failed:', e);
      setAudioMetadata(prev => ({ ...prev, duration: 'Could not decode' }));
      alert(e.message);
      return;
    }
    const { buffer, samples, serverOgg } = decoded;
    mixSamplesRef.current = samples;
    // The exported song.ogg starts with PAD seconds of silence; the preview
    // plays the same padded audio so it matches the chart exactly.
    audioBufferRef.current = serverOgg ? buffer : padAudioBuffer(ctx, buffer, PAD);
    const duration = serverOgg ? buffer.duration - PAD : buffer.duration;
    setSongDuration(duration);
    setAudioMetadata(prev => ({ ...prev, duration: duration.toFixed(1) + 's', sampleRate: buffer.sampleRate + ' Hz' }));
    setAudioVersion(v => v + 1);
    // Audio files are named "Artist - Song" or "Song - Artist", so don't guess
    // which half is which: use the whole name until the tab or the user says.
    if (!iniTitle) setIniTitle(stripExt(file.name));
    if (serverOgg) setTranscodedAudioBlob(serverOgg);
    else triggerTranscode(file);
  };

  const handleStemUpload = async (file) => {
    setStemMetadata(readMeta(file, { duration: 'Decoding…' }));
    try {
      const { buffer, samples, serverOgg } = await decodeWithFallback(file, setStemMetadata);
      stemSamplesRef.current = samples;
      setStemMetadata(prev => ({ ...prev, duration: (serverOgg ? buffer.duration - PAD : buffer.duration).toFixed(1) + 's' }));
      setManualOffset(null);
      setAudioVersion(v => v + 1);
    } catch (e) {
      setStemMetadata(prev => ({ ...prev, duration: 'Could not decode' }));
      alert(e.message);
    }
  };

  const clearStem = () => {
    stemSamplesRef.current = null;
    setStemMetadata(null);
    setManualOffset(null);
    setAudioVersion(v => v + 1);
  };

  const triggerTranscode = async (file) => {
    setTranscoding(true);
    setTranscodedAudioBlob(null);
    try {
      const oggBlob = await transcodeOnServer(file);
      setTranscodedAudioBlob(oggBlob);
      // The backend Ogg already has the lead-in; use it for playback too.
      const decoded = await getAudioContext().decodeAudioData(await oggBlob.arrayBuffer());
      audioBufferRef.current = decoded;
    } catch (err) {
      console.error('Backend transcoding failed, keeping the client-side padded audio:', err);
    } finally {
      setTranscoding(false);
    }
  };

  // --- Analysis -------------------------------------------------------------

  // Song (and stem) changed: find beats, then drum activations.
  useEffect(() => {
    const mix = mixSamplesRef.current;
    if (!mix) return;
    const token = ++analysisTokenRef.current;
    const stem = stemSamplesRef.current;
    (async () => {
      const started = performance.now();
      setAnalysis({ status: 'running', message: stem ? 'Lining up the drum stem and finding beats…' : 'Finding beats…', summary: null, beats: [], onset: null, acts: null });
      try {
        const engine = await getEngine();
        const res = await engine.load(mix, stem, ANALYSIS_SR, tracking);
        if (token !== analysisTokenRef.current) return;
        setAnalysis({ status: 'drums', message: 'Beats found. Detecting drums for alignment and the kick check…', summary: res.summary, beats: res.beats, onset: res.onset, acts: null });
        const acts = await engine.transcribe();
        if (token !== analysisTokenRef.current) return;
        setAnalysis(prev => ({ ...prev, status: 'done', acts, message: `Analysed in ${((performance.now() - started) / 1000).toFixed(1)} s.` }));
      } catch (err) {
        console.error(err);
        if (token !== analysisTokenRef.current) return;
        setAnalysis(prev => ({ ...prev, status: 'failed', message: `Analysis failed: ${err.message}` }));
      }
    })();
    // tracking is applied by the retrack effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioVersion]);

  // Tempo range or ÷2/×2 changed: re-track beats (cheap, reuses the envelopes).
  const trackingKey = `${tracking.minBpm}:${tracking.maxBpm}:${tracking.tempoScale}`;
  const lastTrackingKeyRef = useRef(trackingKey);
  useEffect(() => {
    if (lastTrackingKeyRef.current === trackingKey) return;
    lastTrackingKeyRef.current = trackingKey;
    if (!analysis.summary) return;
    const token = analysisTokenRef.current;
    (async () => {
      try {
        const res = await (await getEngine()).track(tracking);
        if (token !== analysisTokenRef.current) return;
        setManualOffset(null);
        setAnalysis(prev => ({ ...prev, beats: res.beats, message: 'Beats re-tracked.' }));
      } catch (err) {
        setAnalysis(prev => ({ ...prev, message: `Re-tracking failed: ${err.message}` }));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackingKey]);

  // MIDI part (tab) in musical time.
  const midiPart = useMemo(() => {
    if (!parsedMidi || !parsedMidi.tracks[selectedTrackIndex]) return null;
    try { return midiToPart(parsedMidi, selectedTrackIndex); } catch (e) { console.error(e); return null; }
  }, [parsedMidi, selectedTrackIndex]);

  // Beat grid (chart time = song time + PAD). Without audio, the MIDI's own
  // tempo is used so a MIDI-only chart can still be previewed and exported.
  const tempoMap = useMemo(() => {
    if (analysis.beats.length >= 2) return gridFromBeats(analysis.beats, songDuration, { toleranceMs });
    if (midiPart && !audioFile) {
      const beats = [];
      for (let b = 0; b <= Math.ceil(midiPart.endBeat) + 8; b++) beats.push(partBeatToSeconds(midiPart, b));
      return gridFromBeats(beats, beats[beats.length - 1], { toleranceMs: 1 });
    }
    return null;
  }, [analysis.beats, songDuration, toleranceMs, midiPart, audioFile]);
  const lastBeat = tempoMap ? tempoMap.gridTimes.length - 1 : 0;
  const tempos = useMemo(() => (tempoMap ? chartTempos(tempoMap) : [{ tick: 0, milli: 120000 }]), [tempoMap]);
  const tickToSec = useMemo(() => makeTickToSeconds(tempos), [tempos]);

  // The part being charted: the tab, or drums detected in the audio.
  const part = useMemo(() => {
    if (drumSource === 'detect') {
      if (!analysis.acts || !tempoMap) return null;
      return detectedPart(analysis.acts, tempoMap.gridTimes, PAD, { sensitivity: sensitivity / 100, division: snapDivision });
    }
    return midiPart;
  }, [drumSource, analysis.acts, tempoMap, sensitivity, snapDivision, midiPart]);

  // Default pitch mappings whenever the set of pitches or instrument changes.
  const pitchKey = part ? Object.keys(part.counts).join(',') : '';
  useEffect(() => {
    if (!part) return;
    const m = {};
    Object.keys(part.counts).forEach(p => { m[p] = presetMappingForPitch(Number(p), isDrumsMode); });
    setPitchMappings(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pitchKey, isDrumsMode, drumSource]);

  const activePitches = useMemo(() => (part ? Object.entries(part.counts).map(([p, c]) => ({ pitch: Number(p), count: c })).sort((a, b) => a.pitch - b.pitch) : []), [part]);

  // Alignment of the tab against the audio.
  const evidence = useMemo(() => (analysis.onset ? alignmentEvidence({ onset: analysis.onset, acts: analysis.acts, pad: PAD }) : null), [analysis.onset, analysis.acts]);
  const alignResult = useMemo(() => {
    if (!part || part.detected || !tempoMap || !evidence || !Object.keys(pitchMappings).length) return null;
    return alignPart({ part, pitchMappings, isDrums: isDrumsMode, map: tempoMap, evidence, duration: songDuration, pad: PAD });
  }, [part, tempoMap, evidence, pitchMappings, isDrumsMode, songDuration]);
  const noAudioOffset = tempoMap && !audioFile ? tempoMap.leadInBeats : 0;
  const offset = part?.detected ? 0 : (manualOffset ?? alignResult?.offset ?? noAudioOffset);

  const timeSigs = useMemo(() => {
    if (!part || !tempoMap) return [{ beat: 0, num: 4, den: 4 }];
    return part.detected ? [{ beat: 0, num: 4, den: 4 }] : chartTimeSigs(part, offset, lastBeat);
  }, [part, tempoMap, offset, lastBeat]);
  const bars = useMemo(() => barStartBeats(timeSigs, lastBeat), [timeSigs, lastBeat]);

  const kickCheck = useMemo(() => (isDrumsMode ? kickCheckFor(analysis.acts, PAD) : null), [analysis.acts, isDrumsMode]);

  // Compile chart events (manual edits apply on top until inputs change).
  useEffect(() => {
    if (!part || !tempoMap) { setChartEvents([]); setCompileStats(null); return; }
    const { events, stats } = compileChartEvents({
      part, offset, pitchMappings, targetSection: targetChartSection, gridTimes: tempoMap.gridTimes,
      kickCheck, dropFlaggedKicks, autoStarPower, spEveryBars: spDensityMeasures, timeSigs
    });
    setChartEvents(events);
    setCompileStats(stats);
    setSelectedNote(null);
  }, [part, offset, pitchMappings, targetChartSection, tempoMap, kickCheck, dropFlaggedKicks, autoStarPower, spDensityMeasures, timeSigs]);

  // --- Tempo / alignment helpers -------------------------------------------

  const tempoSummary = useMemo(() => {
    if (!tempoMap) return null;
    const changes = tempoMap.events.filter(e => !e.leadIn);
    if (!changes.length) return null;
    const bpms = changes.map(e => e.bpm).sort((a, b) => a - b);
    return { count: changes.length, lo: bpms[0], hi: bpms[bpms.length - 1], median: bpms[bpms.length >> 1] };
  }, [tempoMap]);

  const tempoMismatch = useMemo(() => {
    if (!midiPart || !tempoSummary || drumSource !== 'tab' || !audioFile) return null;
    const ratio = midiPart.bpm / tempoSummary.median;
    if (ratio > 1.75 && ratio < 2.3) return 2;
    if (ratio > 0.43 && ratio < 0.57) return 0.5;
    return null;
  }, [midiPart, tempoSummary, drumSource, audioFile]);

  const setScale = (scale) => {
    if (scale < 0.25 || scale > 4) return;
    setTracking(t => ({ ...t, tempoScale: scale }));
  };

  const barLength = () => {
    const s = midiPart?.timeSigs?.[0];
    return s ? Math.round((s.num * 4) / s.den) : 4;
  };

  const nudgeOffset = (delta) => setManualOffset(offset + delta);

  const flaggedKicks = useMemo(() => chartEvents.filter(e => e.flagged), [chartEvents]);

  // --- Audio preview --------------------------------------------------------

  // Sorted note list for the drum-sound scheduler.
  const soundNotes = useMemo(() => {
    const flags = new Set(chartEvents.filter(e => isFlagValue(e.value)).map(e => `${e.tick}:${e.value - 64}`));
    return chartEvents
      .filter(e => e.type === 'N' && !isFlagValue(e.value) && (e.value <= 4 || e.value === 32))
      .map(e => ({ time: tickToSec(e.tick), lane: e.value === 32 ? 'kick' : LANE_NAMES[e.value], cymbal: flags.has(`${e.tick}:${e.value}`) }))
      .sort((a, b) => a.time - b.time);
  }, [chartEvents, tickToSec]);
  const soundNotesRef = useRef(soundNotes);
  soundNotesRef.current = soundNotes;
  const sfxRef = useRef(enableNoteSFX);
  sfxRef.current = enableNoteSFX;
  const drumsModeRef = useRef(isDrumsMode);
  drumsModeRef.current = isDrumsMode;

  const auditionNote = (midiNote) => {
    try {
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') ctx.resume();
      const freq = 440 * Math.pow(2, (midiNote - 69) / 12);
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gainNode.gain.setValueAtTime(0.18, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
      updateAudioContextStatus();
    } catch (e) {
      console.error(e);
    }
  };

  // Look-ahead scheduler: queue preview drum sounds 150 ms ahead on the audio
  // clock, so they stay in time with the music (frame-based triggering jitters).
  const startScheduler = (fromTime) => {
    const ctx = getAudioContext();
    let i = 0;
    const notes0 = soundNotesRef.current;
    while (i < notes0.length && notes0[i].time < fromTime - 0.001) i++;
    let list = notes0;
    const tick = () => {
      if (soundNotesRef.current !== list) {
        // Chart changed while playing: re-find our place.
        list = soundNotesRef.current;
        const now = ctx.currentTime - startTimeRef.current;
        i = 0;
        while (i < list.length && list[i].time < now) i++;
      }
      const now = ctx.currentTime - startTimeRef.current;
      while (i < list.length && list[i].time < now + 0.15) {
        const n = list[i];
        if (sfxRef.current && n.time >= now - 0.01) {
          const when = startTimeRef.current + n.time;
          if (drumsModeRef.current) playDrumSound(ctx, when, n.lane, n.cymbal);
          else playDrumSound(ctx, when, 'yellow', true);
        }
        i++;
      }
    };
    tick();
    schedulerRef.current = setInterval(tick, 25);
  };

  const stopScheduler = () => {
    if (schedulerRef.current) clearInterval(schedulerRef.current);
    schedulerRef.current = null;
  };

  const playbackLength = () => (audioBufferRef.current ? audioBufferRef.current.duration : (tempoMap ? tempoMap.gridTimes[lastBeat] : 300));

  const handlePlay = () => {
    if (playingRef.current) return;
    playingRef.current = true;
    const ctx = getAudioContext();
    ctx.resume().then(() => {
      if (!playingRef.current) return;
      updateAudioContextStatus();
      setIsPlaying(true);
      const from = Math.max(0, pauseTimeRef.current);
      startTimeRef.current = ctx.currentTime + 0.05 - from;
      if (audioBufferRef.current) {
        const source = ctx.createBufferSource();
        source.buffer = audioBufferRef.current;
        source.connect(ctx.destination);
        source.start(ctx.currentTime + 0.05, from);
        audioSourceRef.current = source;
      }
      startScheduler(from);
      animate();
    }).catch(err => { playingRef.current = false; console.error('Failed to resume AudioContext:', err); });
  };

  const stopSource = () => {
    if (audioSourceRef.current) {
      try { audioSourceRef.current.stop(); } catch (e) { /* already stopped */ }
      audioSourceRef.current = null;
    }
  };

  const handlePause = () => {
    if (!playingRef.current) return;
    playingRef.current = false;
    setIsPlaying(false);
    cancelAnimationFrame(animationFrameRef.current);
    stopScheduler();
    pauseTimeRef.current = Math.max(0, getAudioContext().currentTime - startTimeRef.current);
    stopSource();
  };

  const handleStop = () => {
    playingRef.current = false;
    setIsPlaying(false);
    cancelAnimationFrame(animationFrameRef.current);
    stopScheduler();
    pauseTimeRef.current = 0;
    setCurrentTime(0);
    stopSource();
  };

  const seekTo = (t) => {
    const was = playingRef.current;
    if (was) handlePause();
    pauseTimeRef.current = Math.max(0, t);
    setCurrentTime(Math.max(0, t));
    if (was) handlePlay();
  };

  const handleScrub = (e) => seekTo(parseFloat(e.target.value));

  const animate = () => {
    if (!playingRef.current) return;
    const ctx = getAudioContext();
    const elapsed = Math.max(0, ctx.currentTime - startTimeRef.current);
    setCurrentTime(elapsed);
    if (elapsed >= playbackLength()) {
      handleStop();
      return;
    }
    animationFrameRef.current = requestAnimationFrame(animate);
  };

  useEffect(() => () => { stopScheduler(); cancelAnimationFrame(animationFrameRef.current); }, []);

  // --- Fretboard canvas ----------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, width, height);

    const laneCount = 5;
    const laneWidth = width / laneCount;
    for (let i = 0; i <= laneCount; i++) {
      ctx.strokeStyle = i === 0 || i === laneCount ? '#475569' : '#1e293b';
      ctx.lineWidth = i === 0 || i === laneCount ? 3 : 1;
      ctx.beginPath();
      ctx.moveTo(i * laneWidth, 0);
      ctx.lineTo(i * laneWidth, height);
      ctx.stroke();
    }

    const playheadY = height - 100;
    ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
    ctx.fillRect(0, playheadY - 10, width, 20);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, playheadY);
    ctx.lineTo(width, playheadY);
    ctx.stroke();

    const yOf = (t) => playheadY - (t - currentTime) * scrollSpeed;

    // Beat and bar lines from the real tempo map.
    if (tempoMap) {
      const g = tempoMap.gridTimes;
      const barSet = new Set(bars.map(b => Math.round(b * 1000)));
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      for (let b = 0; b < g.length; b++) {
        const y = yOf(g[b]);
        if (y < -10 || y > height + 10) continue;
        const isBar = barSet.has(b * 1000);
        ctx.strokeStyle = isBar ? '#64748b' : '#334155';
        ctx.lineWidth = isBar ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        if (isBar) {
          ctx.fillStyle = '#94a3b8';
          ctx.font = '10px sans-serif';
          ctx.fillText(`Bar ${bars.findIndex(x => Math.round(x * 1000) === b * 1000) + 1}`, 5, y - 4);
        }
      }
    }

    const getNoteStyles = (noteValue, mappedType) => {
      if (isDrumsMode) {
        if (noteValue === 0) return { fill: '#ffffff', stroke: '#94a3b8', radius: 10, label: 'K' };
        if (noteValue === 32) return { fill: '#818cf8', stroke: '#4f46e5', radius: 10, label: '2K' };
        if (noteValue === 1) return { fill: '#ef4444', stroke: '#b91c1c', radius: 12, label: 'R' };
        if (mappedType && mappedType.includes('cymbal')) {
          if (noteValue === 2) return { fill: '#facc15', stroke: '#ca8a04', radius: 11, shape: 'diamond', label: 'YC' };
          if (noteValue === 3) return { fill: '#3b82f6', stroke: '#1d4ed8', radius: 11, shape: 'diamond', label: 'BC' };
          if (noteValue === 4) return { fill: '#22c55e', stroke: '#15803d', radius: 11, shape: 'diamond', label: 'GC' };
        } else {
          if (noteValue === 2) return { fill: '#f59e0b', stroke: '#b45309', radius: 12, label: 'YP' };
          if (noteValue === 3) return { fill: '#1d4ed8', stroke: '#172554', radius: 12, label: 'BP' };
          if (noteValue === 4) return { fill: '#15803d', stroke: '#022c22', radius: 12, label: 'GP' };
        }
      } else {
        if (noteValue === 0) return { fill: '#22c55e', stroke: '#15803d', radius: 12, label: 'G' };
        if (noteValue === 1) return { fill: '#ef4444', stroke: '#b91c1c', radius: 12, label: 'R' };
        if (noteValue === 2) return { fill: '#facc15', stroke: '#ca8a04', radius: 12, label: 'Y' };
        if (noteValue === 3) return { fill: '#3b82f6', stroke: '#1d4ed8', radius: 12, label: 'B' };
        if (noteValue === 4) return { fill: '#f97316', stroke: '#c2410c', radius: 12, label: 'O' };
        if (noteValue === 7) return { fill: '#94a3b8', stroke: '#475569', radius: 12, label: 'Open' };
      }
      return { fill: '#c084fc', stroke: '#7e22ce', radius: 10, label: '?' };
    };

    const spRegions = chartEvents.filter(evt => evt.type === 'S').map(evt => [evt.tick, evt.tick + evt.duration]);
    const inStarPower = (t) => spRegions.some(([start, end]) => t >= start && t <= end);

    chartEvents.forEach(evt => {
      if (isFlagValue(evt.value) || evt.type === 'S') return;
      const y = yOf(tickToSec(evt.tick));
      if (y < -50 || y > height + 50) return;
      let laneIndex = evt.value;
      if (laneIndex > 4) laneIndex = evt.value === 32 ? 0 : 4;

      if (laneIndex === 0 && isDrumsMode) {
        ctx.setLineDash(evt.flagged ? [6, 4] : []);
        ctx.strokeStyle = evt.flagged ? '#fb923c' : (inStarPower(evt.tick) ? '#c084fc' : (evt.value === 32 ? '#818cf8' : '#ffffff'));
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.moveTo(5, y);
        ctx.lineTo(width - 5, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(evt.flagged ? 'KICK?' : (evt.value === 32 ? '2X KICK' : 'KICK'), width / 2, y);
        if (selectedNote && selectedNote.id === evt.id) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 2]);
          ctx.strokeRect(2, y - 8, width - 4, 16);
          ctx.setLineDash([]);
        }
        return;
      }

      const noteStyles = getNoteStyles(evt.value, evt.mappedType);
      const x = (laneIndex * laneWidth) + (laneWidth / 2);

      if (evt.duration > 0 && !isDrumsMode) {
        const endY = yOf(tickToSec(evt.tick + evt.duration));
        ctx.strokeStyle = noteStyles.fill;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, endY);
        ctx.stroke();
      }

      ctx.fillStyle = noteStyles.fill;
      ctx.strokeStyle = noteStyles.stroke;
      ctx.lineWidth = 3;
      ctx.beginPath();
      if (noteStyles.shape === 'diamond') {
        ctx.moveTo(x, y - noteStyles.radius - 2);
        ctx.lineTo(x + noteStyles.radius + 2, y);
        ctx.lineTo(x, y + noteStyles.radius + 2);
        ctx.lineTo(x - noteStyles.radius - 2, y);
        ctx.closePath();
      } else {
        ctx.arc(x, y, noteStyles.radius, 0, 2 * Math.PI);
      }
      ctx.fill();
      ctx.stroke();

      if (inStarPower(evt.tick)) {
        ctx.strokeStyle = '#c084fc';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, noteStyles.radius + 4, 0, 2 * Math.PI);
        ctx.stroke();
      }

      ctx.fillStyle = '#000000';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(noteStyles.label, x, y);

      if (selectedNote && selectedNote.id === evt.id) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.arc(x, y, noteStyles.radius + 6, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
  }, [chartEvents, currentTime, scrollSpeed, isDrumsMode, selectedNote, tempoMap, bars, tickToSec]);

  // Click the canvas to select a note.
  const handleCanvasClick = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = (e.clientX - rect.left) * (canvas.width / rect.width);
    const clickY = (e.clientY - rect.top) * (canvas.height / rect.height);
    const laneWidth = canvas.width / 5;
    const playheadY = canvas.height - 100;

    let found = null;
    let bestDist = 20;
    chartEvents.forEach(evt => {
      if (isFlagValue(evt.value) || evt.type === 'S') return;
      const y = playheadY - (tickToSec(evt.tick) - currentTime) * scrollSpeed;
      let laneIndex = evt.value;
      if (laneIndex > 4) laneIndex = evt.value === 32 ? 0 : 4;
      if (laneIndex === 0 && isDrumsMode) {
        if (Math.abs(clickY - y) < 8 && bestDist >= 8) { found = evt; bestDist = Math.abs(clickY - y); }
        return;
      }
      const x = (laneIndex * laneWidth) + (laneWidth / 2);
      const dist = Math.hypot(clickX - x, clickY - y);
      if (dist < bestDist) { found = evt; bestDist = dist; }
    });

    if (found) {
      setSelectedNote(found);
      if (found.originalPitch) auditionNote(found.originalPitch);
    } else {
      setSelectedNote(null);
    }
  };

  // --- Note editing (cymbal notes are a pad + flag pair linked by pairId) ---

  const shiftNoteTicks = (delta) => {
    if (!selectedNote) return;
    setChartEvents(prev => prev.map(evt => (
      evt.id === selectedNote.id || evt.pairId === selectedNote.id ? { ...evt, tick: Math.max(0, evt.tick + delta) } : evt
    )).sort((a, b) => a.tick - b.tick));
    setSelectedNote(prev => ({ ...prev, tick: Math.max(0, prev.tick + delta) }));
  };

  const selectedIsCymbal = selectedNote ? chartEvents.some(e => e.pairId === selectedNote.id) : false;

  const setNoteLane = (laneIndex, cymbal) => {
    if (!selectedNote) return;
    const canCymbal = isDrumsMode && laneIndex >= 2 && laneIndex <= 4;
    const wantCymbal = canCymbal && cymbal;
    const mappedType = isDrumsMode ? drumMappingId(LANE_NAMES[laneIndex], wantCymbal) : selectedNote.mappedType;
    setChartEvents(prev => {
      const out = [];
      let maxId = 0;
      for (const evt of prev) maxId = Math.max(maxId, evt.id);
      for (const evt of prev) {
        if (evt.pairId === selectedNote.id) continue; // re-added below if needed
        if (evt.id === selectedNote.id) {
          out.push({ ...evt, value: laneIndex, mappedType, flagged: laneIndex === 0 ? evt.flagged : false });
          if (wantCymbal) out.push({ id: maxId + 1, pairId: evt.id, tick: evt.tick, type: 'N', value: 64 + laneIndex, duration: 0, originalPitch: evt.originalPitch, mappedType: `${mappedType}_marker` });
        } else {
          out.push(evt);
        }
      }
      return out;
    });
    setSelectedNote(prev => ({ ...prev, value: laneIndex, mappedType }));
  };

  const deleteSelectedNote = () => {
    if (!selectedNote) return;
    setChartEvents(prev => prev.filter(e => e.id !== selectedNote.id && e.pairId !== selectedNote.id));
    setSelectedNote(null);
  };

  // --- Export ---------------------------------------------------------------

  const meta = { name: iniTitle, artist: iniArtist, charter: iniCharter };
  const generateChartString = (musicStream = 'song.ogg') => buildChartString({
    chartEvents, targetSection: targetChartSection, tempos, timeSigs, meta, musicStream
  });

  const generateSongIni = (musicStream = 'song.ogg') => {
    const songLengthMs = audioBufferRef.current
      ? Math.round(audioBufferRef.current.duration * 1000)
      : (tempoMap ? Math.round(tempoMap.gridTimes[lastBeat] * 1000) : 180000);
    return buildSongIni({ title: iniTitle, artist: iniArtist, charter: iniCharter, musicStream, songLengthMs });
  };

  const exportCloneHeroBundle = async () => {
    if (!chartEvents.length) {
      alert('There are no chart notes yet. Load a MIDI tab (or pick Detect) and the song audio first.');
      return;
    }
    try {
      const zip = new JSZip();
      // Audio stem. Prefer the backend's real Ogg; otherwise encode the padded
      // preview buffer to WAV. Never ship MP3/M4A bytes under an .ogg name —
      // Clone Hero hangs trying to decode that.
      let musicStream = 'song.ogg';
      if (transcodedAudioBlob) {
        zip.file('song.ogg', transcodedAudioBlob);
      } else if (audioBufferRef.current) {
        zip.file('song.wav', audioBufferToWav(audioBufferRef.current));
        musicStream = 'song.wav';
      } else {
        alert('Warning: no audio was uploaded, so the bundle contains no audio stem. Clone Hero will list the song but cannot play it.');
      }
      // Clone Hero only scans for notes.chart / notes.mid, so the source MIDI
      // is not included (it would be read instead of the chart).
      zip.file('notes.chart', generateChartString(musicStream));
      zip.file('song.ini', generateSongIni(musicStream));

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(zipBlob);
      const folder = [iniArtist, iniTitle].filter(Boolean).join(' - ').replace(/[<>:"/\\|?*]+/g, '_').trim();
      link.download = `${folder || 'custom_song'}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error(err);
      alert('Failed to generate Clone Hero song bundle folder.');
    }
  };

  const starPowerCount = chartEvents.filter(e => e.type === 'S').length;
  const noteCount = chartEvents.filter(e => e.type === 'N' && !isFlagValue(e.value)).length;
  const stemInfo = analysis.summary?.stem;
  const busy = analysis.status === 'running' || analysis.status === 'drums';
  const pitchName = (pitch) => (part?.detected ? DETECT_NAMES[pitch] : null) || (isDrumsMode ? GM_DRUM_MAP[pitch] : null) || `MIDI ${pitch}`;
  const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}`;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500 selection:text-white pb-12">
      {/* Top Banner Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600 rounded-lg text-white shadow-lg shadow-indigo-500/20">
              <Music className="h-6 w-6 animate-pulse" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">Clone Hero Master Editor</h1>
              <p className="text-xs text-slate-400">Beat-mapped tempo from the recording, tab placement, drum checks, preview & song bundle export</p>
            </div>
          </div>
          <div className="text-xs text-slate-400 bg-slate-850 border border-slate-700/60 px-3 py-1.5 rounded-full flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full inline-block ${busy ? 'bg-amber-400 animate-ping' : 'bg-emerald-500'}`}></span>
            {busy ? 'Analysing audio…' : 'Transcoding worker ready'}
          </div>
        </div>
      </header>

      {audioCtxStatus === 'suspended' && (
        <div className="max-w-7xl mx-auto px-4 mt-4">
          <div className="bg-amber-950/40 border border-amber-800/60 text-amber-200 px-4 py-3 rounded-lg flex items-center justify-between text-xs gap-3">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />
              <span>
                <strong>Browser Audio Blocked:</strong> Click <strong>Play</strong> or any <strong>Audition</strong> button to activate standard Web Audio API output!
              </span>
            </div>
            <button
              onClick={() => { getAudioContext().resume().then(() => updateAudioContextStatus()); }}
              className="px-3 py-1 bg-amber-800 hover:bg-amber-700 text-white rounded font-semibold transition"
            >
              Unmute Audio
            </button>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">

        {/* Left Column Controls */}
        <div className="lg:col-span-4 flex flex-col gap-6">

          {/* 1. Files */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 backdrop-blur">
            <h2 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
              <Upload className="h-4 w-4 text-indigo-400" />
              1. Song Files
            </h2>

            <div className="flex flex-col gap-4">
              <FileDrop
                label="Song Audio"
                hint="The full song. Any format: MP3, M4A, OGG, WAV, FLAC."
                accept={AUDIO_ACCEPT}
                icon={FileAudio}
                fileName={audioMetadata?.name}
                placeholder="Choose or drag the song audio"
                onFile={handleAudioUpload}
              />
              <FileDrop
                label="Drum Stem (optional, recommended)"
                hint="Drums only, split from this same song. Used for beats, tab alignment and the kick check. If your song file is already drums only, load it here too."
                accept={AUDIO_ACCEPT}
                icon={Drum}
                fileName={stemMetadata?.name}
                placeholder="Choose or drag a drum stem"
                onFile={handleStemUpload}
                onClear={stemMetadata ? clearStem : null}
              />
              <FileDrop
                label="Drum Tab / MIDI (.mid)"
                hint="A Songsterr .mid export, any drum MIDI, or a Rock Band / Clone Hero notes.mid."
                accept=".mid,.midi"
                icon={Music}
                fileName={midiMetadata?.name}
                placeholder="Choose or drag MIDI file"
                onFile={handleMidiUpload}
              />
            </div>

            {(midiMetadata || audioMetadata || stemMetadata) && (
              <div className="mt-4 p-3 bg-slate-950/60 border border-slate-800 rounded-lg flex flex-col gap-2.5 text-xs">
                {audioMetadata && (
                  <div>
                    <h4 className="font-semibold text-emerald-400 flex items-center gap-1.5">
                      <FileAudio className="h-3 w-3" /> Song Audio
                    </h4>
                    <div className="grid grid-cols-2 gap-1 mt-1 text-slate-400">
                      <span>Size: {audioMetadata.size}</span>
                      <span>Sample Rate: {audioMetadata.sampleRate || '…'}</span>
                      <span className="col-span-2">Duration: {audioMetadata.duration}</span>
                    </div>
                  </div>
                )}
                {stemMetadata && (
                  <div className="border-t border-slate-900 pt-2">
                    <h4 className="font-semibold text-sky-400 flex items-center gap-1.5">
                      <Drum className="h-3 w-3" /> Drum Stem
                    </h4>
                    <div className="grid grid-cols-2 gap-1 mt-1 text-slate-400">
                      <span>Size: {stemMetadata.size}</span>
                      <span>Duration: {stemMetadata.duration}</span>
                      {stemInfo && (
                        <span className={`col-span-2 ${stemInfo.match >= 0.15 ? 'text-sky-300' : 'text-amber-300'}`}>
                          {stemInfo.match >= 0.15
                            ? `Lines up with the song (offset ${(stemInfo.shift * 1000).toFixed(1)} ms, match ${stemInfo.match.toFixed(2)}).`
                            : `Doesn't match the song audio (match ${stemInfo.match.toFixed(2)}), so it isn't used. Use a stem split from this exact file.`}
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {midiMetadata && (
                  <div className="border-t border-slate-900 pt-2">
                    <h4 className="font-semibold text-indigo-400 flex items-center gap-1.5">
                      <Music className="h-3 w-3" /> MIDI Details
                    </h4>
                    <div className="grid grid-cols-2 gap-1 mt-1 text-slate-400">
                      <span>Size: {midiMetadata.size}</span>
                      <span>PPQ: {midiMetadata.ppq}</span>
                      <span>Tracks: {midiMetadata.tracksCount}</span>
                      <span>Duration: {midiMetadata.duration}</span>
                      {midiPart && <span className="col-span-2">Tab tempo: {midiPart.bpm} BPM ({midiPart.notes.length} notes)</span>}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 2. Tempo map & alignment */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 backdrop-blur">
            <h2 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
              <Settings className="h-4 w-4 text-indigo-400" />
              2. Tempo Map & Alignment
            </h2>

            <div className="flex flex-col gap-4">
              {/* Analysis status */}
              <div className={`text-[11px] rounded-lg px-3 py-2 border flex items-start gap-2 ${analysis.status === 'failed' ? 'text-red-200 bg-red-950/40 border-red-800/50' : 'text-sky-200 bg-sky-950/40 border-sky-800/50'}`}>
                {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin shrink-0 mt-0.5" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 mt-0.5" />}
                <span>
                  {analysis.status === 'idle' && (parsedMidi && !audioFile
                    ? "No audio yet: the preview uses the MIDI's own tempo. Load the song audio to map the real tempo."
                    : 'Load the song audio. Every beat in the recording is found and turned into the tempo map.')}
                  {analysis.status !== 'idle' && analysis.message}
                </span>
              </div>

              {tempoSummary && (
                <div className="text-[11px] text-slate-300 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 flex flex-col gap-1">
                  <span>
                    Tempo map: <strong className="text-white">{tempoSummary.count}</strong> tempo {tempoSummary.count === 1 ? 'event' : 'events'},{' '}
                    {tempoSummary.hi - tempoSummary.lo < 0.05 ? `${tempoSummary.lo.toFixed(1)} BPM` : `${tempoSummary.lo.toFixed(1)}–${tempoSummary.hi.toFixed(1)} BPM`}
                    {audioFile && <> · beats from the {analysis.summary?.beatSource === 'stem' ? 'drum stem' : 'song'}</>}
                  </span>
                  {audioFile && <span className="text-slate-500">The tab&apos;s own tempo is ignored; notes are placed on the recording&apos;s beats.</span>}
                </div>
              )}

              {tempoMismatch && (
                <div className="text-[11px] text-amber-200 bg-amber-950/40 border border-amber-800/50 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                  <span>The tab is at {midiPart.bpm.toFixed(0)} BPM but the recording was detected at about {tempoSummary.median.toFixed(0)}.</span>
                  <button onClick={() => setScale(tracking.tempoScale * tempoMismatch)} className="px-2 py-1 bg-amber-800 hover:bg-amber-700 rounded font-semibold shrink-0">
                    {tempoMismatch === 2 ? 'Double it' : 'Halve it'}
                  </button>
                </div>
              )}

              {audioFile && (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="col-span-2 flex items-center justify-between gap-2">
                    <span className="text-slate-400">Detected tempo is half / double?</span>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => setScale(tracking.tempoScale / 2)} disabled={busy} className="px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded font-semibold">÷2</button>
                      <span className="font-mono text-slate-300 w-8 text-center">{tracking.tempoScale >= 1 ? `×${tracking.tempoScale}` : `÷${1 / tracking.tempoScale}`}</span>
                      <button onClick={() => setScale(tracking.tempoScale * 2)} disabled={busy} className="px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded font-semibold">×2</button>
                    </div>
                  </div>
                  <label className="flex flex-col gap-1 text-slate-400">
                    Tempo range (BPM)
                    <div className="flex items-center gap-1">
                      <NumberField value={tracking.minBpm} min={30} max={300} onCommit={v => setTracking(t => ({ ...t, minBpm: v, maxBpm: Math.max(t.maxBpm, Math.round(v * 1.25)) }))} />
                      <span>–</span>
                      <NumberField value={tracking.maxBpm} min={40} max={400} onCommit={v => setTracking(t => ({ ...t, maxBpm: v, minBpm: Math.min(t.minBpm, Math.round(v / 1.25)) }))} />
                    </div>
                  </label>
                  <label className="flex flex-col gap-1 text-slate-400">
                    Grid tolerance
                    <select value={toleranceMs} onChange={e => setToleranceMs(Number(e.target.value))} className="bg-slate-950 border border-slate-800 text-slate-200 rounded px-2 py-1">
                      <option value={0}>Every beat</option>
                      <option value={10}>±10 ms</option>
                      <option value={20}>±20 ms</option>
                      <option value={40}>±40 ms</option>
                    </select>
                  </label>
                </div>
              )}

              <div className="border-t border-slate-850 pt-3">
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Drum Notes From</label>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <button
                    onClick={() => setDrumSource('tab')}
                    className={`py-1.5 rounded-lg border font-semibold transition ${drumSource === 'tab' ? 'bg-indigo-600 border-indigo-400 text-white' : 'bg-slate-950 border-slate-800 text-slate-400'}`}
                  >
                    MIDI tab
                  </button>
                  <button
                    onClick={() => setDrumSource('detect')}
                    disabled={!audioFile}
                    className={`py-1.5 rounded-lg border font-semibold transition disabled:opacity-40 ${drumSource === 'detect' ? 'bg-indigo-600 border-indigo-400 text-white' : 'bg-slate-950 border-slate-800 text-slate-400'}`}
                  >
                    Detect from audio
                  </button>
                </div>
              </div>

              {drumSource === 'tab' && (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Source MIDI Track</label>
                    <select
                      value={selectedTrackIndex}
                      onChange={(e) => { setSelectedTrackIndex(parseInt(e.target.value)); setManualOffset(null); }}
                      disabled={!parsedMidi}
                      className="w-full bg-slate-950 border border-slate-850 text-slate-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-indigo-500 transition"
                    >
                      {parsedMidi ? parsedMidi.tracks.map((track, i) => (
                        <option key={i} value={i}>
                          Track {i}: {track.name || 'Unnamed'} ({track.notes.length} notes{track.channel === 9 ? ', drums' : ''}{isRockBandDrums(track) ? ', chart' : ''})
                        </option>
                      )) : (
                        <option value="0">Upload MIDI file first</option>
                      )}
                    </select>
                  </div>

                  {midiPart && tempoMap && (
                    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3 flex flex-col gap-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Tab bar 1 starts at</span>
                        <span className="font-mono text-indigo-200">
                          {fmtTime(Math.max(0, tempoMap.gridTimes[Math.max(0, Math.min(lastBeat, offset))] - PAD))} <span className="text-slate-500">(grid beat {signed(offset)})</span>
                        </span>
                      </div>
                      <div className="grid grid-cols-5 gap-1">
                        <button onClick={() => nudgeOffset(-barLength())} className="py-1 bg-slate-900 border border-slate-800 rounded hover:bg-slate-850">−bar</button>
                        <button onClick={() => nudgeOffset(-1)} className="py-1 bg-slate-900 border border-slate-800 rounded hover:bg-slate-850">−beat</button>
                        <button onClick={() => setManualOffset(null)} className={`py-1 border rounded font-semibold ${manualOffset == null ? 'bg-indigo-700 border-indigo-500 text-white' : 'bg-slate-900 border-slate-800 hover:bg-slate-850'}`}>Auto</button>
                        <button onClick={() => nudgeOffset(1)} className="py-1 bg-slate-900 border border-slate-800 rounded hover:bg-slate-850">+beat</button>
                        <button onClick={() => nudgeOffset(barLength())} className="py-1 bg-slate-900 border border-slate-800 rounded hover:bg-slate-850">+bar</button>
                      </div>
                      <p className="text-[11px] text-slate-400">
                        {!audioFile
                          ? 'Load the song audio to line the tab up with the recording.'
                          : manualOffset != null
                            ? 'Set by hand. Press Auto to match the recording again.'
                            : alignResult
                              ? `Matched to the recording${analysis.acts?.source === 'stem' ? ' using the drum stem' : ''}. Press Play with note sounds on to check it by ear.`
                              : 'Matching the tab to the recording…'}
                      </p>
                      {manualOffset == null && alignResult && alignResult.alternatives.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className="text-slate-500">Close matches:</span>
                          {alignResult.alternatives.map(a => (
                            <button key={a.offset} onClick={() => setManualOffset(a.offset)} className="px-2 py-0.5 bg-slate-900 border border-slate-700 rounded hover:border-indigo-500">
                              {signed(a.offset - offset)} beats{a.outside ? ` (cuts ${a.outside} notes)` : ''}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {drumSource === 'detect' && (
                <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3 flex flex-col gap-3 text-xs">
                  <p className="text-[11px] text-slate-400">
                    Finds kick, snare, hi-hat and crash {analysis.acts?.source === 'stem' ? 'in the drum stem' : 'in the song (a drum stem gives much cleaner results)'}, snapped to the beat grid. A draft to edit: toms and ride aren&apos;t detected.
                  </p>
                  <label className="flex items-center justify-between gap-2 text-slate-400">
                    Sensitivity
                    <input type="range" min="0" max="100" value={sensitivity} onChange={e => setSensitivity(Number(e.target.value))} className="w-32 accent-indigo-500" />
                    <span className="font-mono w-8 text-right">{sensitivity}</span>
                  </label>
                  <label className="flex items-center justify-between gap-2 text-slate-400">
                    Snap to
                    <select value={snapDivision} onChange={e => setSnapDivision(Number(e.target.value))} className="bg-slate-950 border border-slate-800 text-slate-200 rounded px-2 py-1">
                      <option value={2}>1/8 notes</option>
                      <option value={3}>1/8 triplets</option>
                      <option value={4}>1/16 notes</option>
                      <option value={6}>1/16 triplets</option>
                      <option value={8}>1/32 notes</option>
                    </select>
                  </label>
                  {!analysis.acts && audioFile && <span className="text-slate-500">Waiting for drum detection to finish…</span>}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Target .Chart Track Section</label>
                <select
                  value={targetChartSection}
                  onChange={(e) => setTargetChartSection(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-850 text-slate-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-indigo-500 transition"
                >
                  <option value="ExpertDrums">Expert Drums</option>
                  <option value="HardDrums">Hard Drums</option>
                  <option value="MediumDrums">Medium Drums</option>
                  <option value="EasyDrums">Easy Drums</option>
                  <option value="ExpertSingle">Expert Single (Guitar)</option>
                  <option value="HardSingle">Hard Single (Guitar)</option>
                  <option value="MediumSingle">Medium Single (Guitar)</option>
                  <option value="EasySingle">Easy Single (Guitar)</option>
                  <option value="ExpertDoubleBass">Expert Double Bass</option>
                </select>
              </div>

              {compileStats && (
                <p className="text-[11px] text-slate-400">
                  {noteCount} notes in the chart.
                  {compileStats.early > 0 && ` ${compileStats.early} tab notes fall before the song starts.`}
                  {compileStats.late > 0 && ` ${compileStats.late} fall after it ends.`}
                  {compileStats.ignored > 0 && ` ${compileStats.ignored} on ignored sounds.`}
                  {compileStats.moved > 0 && ` ${compileStats.moved} toms moved to a free lane.`}
                  {compileStats.dropped > 0 && ` ${compileStats.dropped} duplicates dropped.`}
                </p>
              )}
            </div>
          </div>

          {/* Note check */}
          {isDrumsMode && (
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 backdrop-blur">
              <h2 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
                <ShieldCheck className="h-4 w-4 text-orange-400" />
                Kick Check
              </h2>
              {!kickCheck ? (
                <p className="text-[11px] text-slate-400">
                  {stemInfo && stemInfo.match < 0.15
                    ? "The drum stem doesn't match the song, so tab kicks can't be checked."
                    : analysis.status === 'drums'
                      ? 'Checking the tab against the drum stem…'
                      : 'Load a drum stem to check every tab kick against the real drums. Songsterr AI tabs often add kicks in intros and breakdowns where the drummer plays none. (It needs a stem: on a full mix, bass notes look too much like kicks.)'}
                </p>
              ) : (
                <div className="flex flex-col gap-3 text-xs">
                  <div className={`text-[11px] rounded-lg px-3 py-2 border ${compileStats?.flaggedKicks ? 'text-orange-200 bg-orange-950/40 border-orange-800/50' : 'text-emerald-200 bg-emerald-950/40 border-emerald-800/50'}`}>
                    {compileStats?.flaggedKicks
                      ? `${compileStats.flaggedKicks} of the chart's kicks have no kick in the drum stem.${dropFlaggedKicks ? ' They are removed.' : ' They show as dashed orange KICK? lines in the preview.'}`
                      : 'Every kick in the chart has a kick in the drum stem.'}
                  </div>
                  {flaggedKicks.length > 0 && !dropFlaggedKicks && (
                    <div className="text-[11px] text-slate-400 max-h-20 overflow-y-auto">
                      At bar.beat: {flaggedKicks.slice(0, 60).map(e => barBeatLabel(e.tick / 480, bars)).join(', ')}{flaggedKicks.length > 60 ? ', …' : ''}
                    </div>
                  )}
                  {(compileStats?.flaggedKicks > 0) && (
                    <button
                      onClick={() => setDropFlaggedKicks(v => !v)}
                      className={`w-full py-2 px-3 rounded-lg font-semibold transition ${dropFlaggedKicks ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-orange-700 hover:bg-orange-600 text-white'}`}
                    >
                      {dropFlaggedKicks ? 'Put them back' : `Remove ${compileStats.flaggedKicks} unsupported kicks`}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Auto Star Power Card */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 backdrop-blur">
            <h2 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
              <Zap className="h-4 w-4 text-purple-400" />
              Auto Star Power
            </h2>

            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="chk-auto-sp" className="text-slate-300 cursor-pointer">
                  Auto-generate Star Power phrases
                </label>
                <input
                  id="chk-auto-sp"
                  type="checkbox"
                  checked={autoStarPower}
                  onChange={(e) => setAutoStarPower(e.target.checked)}
                  className="rounded border-slate-850 bg-slate-950 text-purple-500 focus:ring-purple-500 w-4 h-4 cursor-pointer"
                />
              </div>

              <p className="text-[11px] text-slate-400 -mt-2">
                Adds one-bar <span className="font-mono text-purple-300">S 2</span> phrases on bar lines, Harmonix style, on bars
                with enough notes. A manual pitch → Star Power mapping takes precedence and disables this.
              </p>

              <div>
                <label className="block text-xs font-semibold text-purple-300 uppercase tracking-wider mb-1.5">
                  Phrase Frequency
                </label>
                <select
                  value={spDensityMeasures}
                  onChange={(e) => setSpDensityMeasures(parseInt(e.target.value))}
                  disabled={!autoStarPower}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-purple-500 transition disabled:opacity-50"
                >
                  <option value="4">Dense — ~1 phrase / 4 measures</option>
                  <option value="8">Medium — ~1 phrase / 8 measures</option>
                  <option value="16">Sparse — ~1 phrase / 16 measures</option>
                </select>
              </div>

              <div className="text-[11px] text-purple-200 bg-purple-950/40 border border-purple-800/50 rounded-lg px-3 py-2">
                {!autoStarPower
                  ? 'Auto Star Power is off — no S 2 phrases are added unless a pitch is mapped to Star Power.'
                  : starPowerCount > 0
                    ? `${starPowerCount} Star Power phrase${starPowerCount === 1 ? '' : 's'} in the current map.`
                    : 'No phrases yet — load a tab and the song audio (or the source already defines its own Star Power).'}
              </div>
            </div>
          </div>

          {/* Export Bundle Card */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 backdrop-blur flex flex-col gap-4">
            <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2 border-b border-slate-800 pb-2">
              <Download className="h-4 w-4 text-emerald-400" />
              3. INI Configuration & ZIP Packager
            </h2>

            <div className="flex flex-col gap-3.5 text-xs">
              <div className="flex flex-col gap-1">
                <label className="text-slate-400">Song Name</label>
                <input type="text" value={iniTitle} onChange={(e) => setIniTitle(e.target.value)} placeholder="Song Title"
                  className="bg-slate-950 border border-slate-855 rounded px-2 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-indigo-500" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-slate-400">Artist</label>
                <input type="text" value={iniArtist} onChange={(e) => setIniArtist(e.target.value)} placeholder="Artist Name"
                  className="bg-slate-950 border border-slate-855 rounded px-2 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-indigo-500" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-slate-400">Charter / Mapper Name</label>
                <input type="text" value={iniCharter} onChange={(e) => setIniCharter(e.target.value)} placeholder="Charter"
                  className="bg-slate-950 border border-slate-855 rounded px-2 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-indigo-500" />
              </div>
            </div>

            <button
              onClick={exportCloneHeroBundle}
              disabled={!chartEvents.length}
              className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-semibold rounded-lg shadow-lg hover:shadow-emerald-500/10 active:scale-[0.98] transition flex items-center justify-center gap-2 text-sm"
            >
              <Download className="h-4 w-4" />
              Export Clone Hero Song Folder (.ZIP)
            </button>
            <p className="text-[11px] text-slate-500 -mt-2">
              notes.chart + song.ini + song.ogg (with a {PAD.toFixed(1)} s lead-in). Unzip into your Clone Hero songs folder, or open notes.chart in Moonscraper.
            </p>
          </div>

        </div>

        {/* Right Column Canvas Preview & Map */}
        <div className="lg:col-span-8 flex flex-col gap-6">

          {/* Batch folder -> Songs converter */}
          <BatchConverter defaultSection={targetChartSection} />

          {/* Fretboard Preview & Canvas Player */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 backdrop-blur flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                  <SlidersHorizontal className="h-4 w-4 text-indigo-400" />
                  Live Scrolling Fretboard Preview & Chart Editor
                </h2>
                <p className="text-xs text-slate-400">Notes, beats and bars follow the real tempo map. Click a note to edit it.</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[11px] font-mono text-slate-400">
                  {fmtTime(currentTime)} / {fmtTime(playbackLength())}
                </span>
                <span className={`w-2.5 h-2.5 rounded-full ${isPlaying ? 'bg-emerald-500 animate-ping' : 'bg-slate-600'}`}></span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
              <div className="md:col-span-6 flex flex-col items-center">
                <div ref={canvasContainerRef} className="relative border border-slate-800 rounded-lg overflow-hidden bg-slate-950 w-[240px]">
                  <canvas ref={canvasRef} width={240} height={400} onClick={handleCanvasClick} className="cursor-crosshair" />
                </div>
                <div className="w-[240px] mt-2.5 flex justify-between items-center text-xs text-slate-400">
                  <span>Scroll Speed:</span>
                  <input type="range" min="150" max="800" step="25" value={scrollSpeed} onChange={(e) => setScrollSpeed(parseInt(e.target.value))} className="w-32 accent-indigo-500" />
                  <span>{scrollSpeed}</span>
                </div>
              </div>

              <div className="md:col-span-6 flex flex-col gap-3">
                <div className="bg-slate-950 p-3.5 border border-slate-850 rounded-lg flex flex-col gap-3">
                  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Transport Controls</h4>
                  <div className="flex justify-between gap-2.5">
                    <button onClick={handlePlay} disabled={isPlaying}
                      className="flex-1 py-1.5 px-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded text-xs font-semibold transition flex items-center justify-center gap-1.5">
                      <Play className="h-3.5 w-3.5 fill-current" /> Play
                    </button>
                    <button onClick={handlePause} disabled={!isPlaying}
                      className="flex-1 py-1.5 px-3 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 rounded text-xs font-semibold transition flex items-center justify-center gap-1.5">
                      <Pause className="h-3.5 w-3.5 fill-current" /> Pause
                    </button>
                    <button onClick={handleStop}
                      className="flex-1 py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs font-semibold transition flex items-center justify-center gap-1.5">
                      <Square className="h-3.5 w-3.5 fill-current" /> Stop
                    </button>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] font-mono text-slate-500">0s</span>
                    <input type="range" min="0" max={playbackLength()} step="0.05" value={currentTime} onChange={handleScrub} className="flex-1 accent-indigo-500" />
                    <span className="text-[10px] font-mono text-slate-500">{playbackLength().toFixed(1)}s</span>
                  </div>
                  <div className="flex items-center justify-between border-t border-slate-900 pt-2 text-xs">
                    <label htmlFor="chk-sfx" className="text-slate-400 flex items-center gap-1.5 cursor-pointer">
                      {enableNoteSFX ? <Volume2 className="h-3.5 w-3.5 text-indigo-400" /> : <VolumeX className="h-3.5 w-3.5 text-slate-500" />}
                      <span>Play chart drums over the song</span>
                    </label>
                    <input id="chk-sfx" type="checkbox" checked={enableNoteSFX} onChange={(e) => setEnableNoteSFX(e.target.checked)}
                      className="rounded border-slate-850 bg-slate-950 text-indigo-500 focus:ring-indigo-500 w-4 h-4 cursor-pointer" />
                  </div>
                  {transcoding && (
                    <div className="flex items-center gap-2 p-2 bg-indigo-950/40 border border-indigo-800/50 rounded-lg mt-1">
                      <RefreshCw className="h-3.5 w-3.5 animate-spin text-indigo-400" />
                      <span className="text-[11px] text-indigo-200">Processing audio via high-quality FFmpeg OGG transcode pipeline...</span>
                    </div>
                  )}
                </div>

                {/* Selected Note Live Editor */}
                <div className="bg-slate-950 p-3.5 border border-slate-850 rounded-lg flex-1 flex flex-col justify-between">
                  <div>
                    <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <Edit3 className="h-3.5 w-3.5 text-indigo-400" />
                      Active Note Editor
                    </h4>
                    {selectedNote ? (
                      <div className="flex flex-col gap-2.5 text-xs text-slate-300">
                        <div className="flex justify-between items-center">
                          <span>Bar.beat: <strong className="text-white">{barBeatLabel(selectedNote.tick / 480, bars)}</strong></span>
                          <span>Time: <strong className="text-indigo-400">{fmtTime(tickToSec(selectedNote.tick) - PAD)}</strong></span>
                        </div>
                        {selectedNote.flagged && (
                          <div className="text-[11px] text-orange-200 bg-orange-950/40 border border-orange-800/50 rounded px-2 py-1">
                            No kick in the drum stem here (strength {selectedNote.support?.toFixed(2)}).
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-2 mt-1">
                          <button onClick={() => shiftNoteTicks(-SIXTEENTH)} className="p-1 bg-slate-900 border border-slate-800 rounded hover:bg-slate-850 text-[11px]">◀ 1/16 earlier</button>
                          <button onClick={() => shiftNoteTicks(SIXTEENTH)} className="p-1 bg-slate-900 border border-slate-800 rounded hover:bg-slate-850 text-[11px]">1/16 later ▶</button>
                        </div>
                        <div className="flex flex-col gap-1.5 mt-1">
                          <span className="text-slate-400 text-[11px]">Output Fret/Pad Lane</span>
                          <div className="grid grid-cols-5 gap-1">
                            {[0, 1, 2, 3, 4].map(idx => (
                              <button key={idx} onClick={() => setNoteLane(idx, selectedIsCymbal)}
                                className={`p-1.5 font-bold rounded border text-center transition ${selectedNote.value === idx ? 'bg-indigo-600 border-indigo-400 text-white' : 'bg-slate-900 border-slate-850 text-slate-400'}`}>
                                {isDrumsMode ? ['K', 'R', 'Y', 'B', 'G'][idx] : idx}
                              </button>
                            ))}
                          </div>
                          {isDrumsMode && selectedNote.value >= 2 && selectedNote.value <= 4 && (
                            <div className="grid grid-cols-2 gap-1">
                              <button onClick={() => setNoteLane(selectedNote.value, true)}
                                className={`p-1 rounded border text-[11px] font-semibold ${selectedIsCymbal ? 'bg-indigo-600 border-indigo-400 text-white' : 'bg-slate-900 border-slate-850 text-slate-400'}`}>Cymbal</button>
                              <button onClick={() => setNoteLane(selectedNote.value, false)}
                                className={`p-1 rounded border text-[11px] font-semibold ${!selectedIsCymbal ? 'bg-indigo-600 border-indigo-400 text-white' : 'bg-slate-900 border-slate-850 text-slate-400'}`}>Tom</button>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500 italic py-6 text-center">
                        Click any note on the left fretboard lane to load it into the active editor
                      </div>
                    )}
                  </div>
                  {selectedNote && (
                    <div className="flex justify-between items-center border-t border-slate-900 pt-2.5 mt-2">
                      <span className="text-[10px] text-slate-500">{selectedNote.originalPitch ? `From: ${pitchName(selectedNote.originalPitch)}` : 'Added by hand'}</span>
                      <button onClick={deleteSelectedNote} className="text-red-400 hover:text-red-300 font-semibold flex items-center gap-1 text-[11px]">
                        <Trash2 className="h-3 w-3" /> Delete Note
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Dynamic Pitch Mapping Table */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 backdrop-blur">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4 pb-2 border-b border-slate-800">
              <div>
                <h2 className="text-sm font-semibold text-slate-200">4. Drum Sound → Lane Mapping</h2>
                <p className="text-xs text-slate-400">Change a sound&apos;s lane for the whole song (e.g. open hi-hat → ride, or a crash the tab got wrong).</p>
              </div>
              <input
                type="text"
                placeholder="Search MIDI pitch..."
                value={pitchSearchQuery}
                onChange={(e) => setPitchSearchQuery(e.target.value)}
                disabled={activePitches.length === 0}
                className="bg-slate-950 border border-slate-850 text-slate-200 text-xs px-2.5 py-1.5 rounded-lg focus:outline-none focus:border-indigo-500 w-full sm:w-48"
              />
            </div>

            <div className="overflow-x-auto max-h-[300px] border border-slate-850 rounded-lg bg-slate-950/40">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-900/40 text-slate-400 font-semibold sticky top-0 backdrop-blur z-10">
                    <th className="p-3">MIDI Pitch</th>
                    <th className="p-3">Sound</th>
                    <th className="p-3 text-center">Count</th>
                    <th className="p-3 text-center">Audition</th>
                    <th className="p-3">Map output config</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-900 text-slate-300">
                  {activePitches.length === 0 ? (
                    <tr>
                      <td colSpan="5" className="p-8 text-center text-slate-500 italic">
                        Upload a MIDI file (or detect drums) to configure pitch triggers
                      </td>
                    </tr>
                  ) : (
                    activePitches
                      .filter(({ pitch }) => pitch.toString().includes(pitchSearchQuery) || pitchName(pitch).toLowerCase().includes(pitchSearchQuery.toLowerCase()))
                      .map(({ pitch, count }) => {
                        const currentVal = pitchMappings[pitch] || 'ignore';
                        const optionsList = isDrumsMode ? MAPPING_OPTIONS_DRUMS : MAPPING_OPTIONS_GUITAR;
                        return (
                          <tr key={pitch} className="hover:bg-slate-900/30 transition">
                            <td className="p-3 font-semibold text-indigo-300">{pitch}</td>
                            <td className="p-3 text-slate-400">{pitchName(pitch)}</td>
                            <td className="p-3 text-center font-medium text-slate-300">{count}</td>
                            <td className="p-3 text-center">
                              <button onClick={() => auditionNote(pitch)} className="p-1.5 rounded bg-slate-900 border border-slate-800 hover:bg-slate-850 hover:text-indigo-400 transition">
                                <Play className="h-3 w-3 fill-current" />
                              </button>
                            </td>
                            <td className="p-3">
                              <select
                                value={currentVal}
                                onChange={(e) => setPitchMappings(prev => ({ ...prev, [pitch]: e.target.value }))}
                                className="bg-slate-900 border border-slate-800 text-slate-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-indigo-500 transition w-full max-w-[200px]"
                              >
                                {optionsList.map(opt => (
                                  <option key={opt.value} value={opt.value} className={opt.class}>{opt.label}</option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        );
                      })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Generated Text Live Preview Panel */}
          {chartEvents.length > 0 && (
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 backdrop-blur">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5 text-indigo-400" />
                Live Pre-Rendered .Chart Output (First Lines)
              </h3>
              <pre className="p-3.5 bg-slate-950 border border-slate-850 rounded-lg font-mono text-[11px] text-slate-400 overflow-x-auto max-h-[160px]">
                {generateChartString(transcodedAudioBlob ? 'song.ogg' : 'song.wav').split('\r\n').slice(0, 40).join('\n')}
                {'\n\n... [Active track content continues]'}
              </pre>
            </div>
          )}

        </div>
      </main>

      <footer className="border-t border-slate-900 bg-slate-950 py-6 mt-12 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p>© 2026 Clone Hero Master Editor. Robust React + Node Full-Stack Workspace Environment.</p>
          <div className="flex gap-4">
            <span>Powered by Web Audio API</span>
            <span>·</span>
            <span>Tone.js/Midi</span>
            <span>·</span>
            <span>Fluent-FFmpeg</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// Drop zone / file picker in the app's style.
function FileDrop({ label, hint, accept, icon: Icon, fileName, placeholder, onFile, onClear = null }) {
  const [over, setOver] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{label}</label>
        {onClear && <button onClick={onClear} className="text-[11px] text-slate-500 hover:text-red-300">Remove</button>}
      </div>
      <div
        className={`relative border-2 border-dashed ${over ? 'border-indigo-500' : 'border-slate-700'} hover:border-indigo-500 bg-slate-950/40 rounded-lg p-3 text-center cursor-pointer group transition`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }}
      >
        <input
          type="file"
          accept={accept}
          onChange={(e) => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ''; }}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
        <div className="flex items-center justify-center gap-2 text-xs">
          <Icon className="h-4 w-4 text-slate-400 group-hover:text-indigo-400 shrink-0" />
          <span className="font-medium text-slate-300 truncate">{fileName || placeholder}</span>
        </div>
      </div>
      {hint && <p className="text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

// Number input that commits on blur / Enter (so typing "1" on the way to
// "120" doesn't re-track the beats).
function NumberField({ value, min, max, onCommit }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => {
    const v = Math.round(Number(text));
    if (!isFinite(v)) { setText(String(value)); return; }
    const c = Math.max(min, Math.min(max, v));
    setText(String(c));
    if (c !== value) onCommit(c);
  };
  return (
    <input
      type="number"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
      className="w-16 bg-slate-950 border border-slate-800 text-slate-200 rounded px-2 py-1 font-mono"
    />
  );
}
