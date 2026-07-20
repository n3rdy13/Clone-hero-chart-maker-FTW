import React, { useState, useEffect, useRef } from 'react';
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
  CheckCircle, 
  AlertCircle, 
  Sliders, 
  Trash2, 
  Plus, 
  Edit3,
  SlidersHorizontal,
  ChevronRight,
  Volume2,
  VolumeX,
  Info,
  Zap
} from 'lucide-react';
import { Midi } from '@tonejs/midi';
import JSZip from 'jszip';
import { computeOnsetEnvelope, fitTempoMap, anchorsToBpmEvents, fitWeightForPitch, fitBandForPitch } from './tempoAnalysis';
import {
  presetMappingForPitch,
  isDrumsSection,
  compileChartEvents,
  generateChartString as buildChartString,
  generateSongIni as buildSongIni
} from './chartGen';
import { padAudioBuffer, audioBufferToWav } from './audioUtil';
import BatchConverter from './BatchConverter';

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

// Client-side audio helpers (padding + WAV encode) live in audioUtil.js so the
// batch converter can share them.

export default function App() {
  // Global Uploaded File States
  const [midiFile, setMidiFile] = useState(null);
  const [midiMetadata, setMidiMetadata] = useState(null);
  const [rawMidiBuffer, setRawMidiBuffer] = useState(null);
  const [parsedMidi, setParsedMidi] = useState(null);

  const [audioFile, setAudioFile] = useState(null);
  const [audioMetadata, setAudioMetadata] = useState(null);
  const [transcodedAudioBlob, setTranscodedAudioBlob] = useState(null);
  const [transcoding, setTranscoding] = useState(false);

  // Audio Context State Details
  const [audioCtxStatus, setAudioCtxStatus] = useState('uninitialized');

  // INI Configuration states
  const [iniTitle, setIniTitle] = useState('');
  const [iniArtist, setIniArtist] = useState('');
  const [iniCharter, setIniCharter] = useState('CharterMaster');

  // Input & Mapping States
  const [selectedTrackIndex, setSelectedTrackIndex] = useState(0);
  const [targetChartSection, setTargetChartSection] = useState('ExpertDrums');
  const [drumSyncOffset, setDrumSyncOffset] = useState(2.0); // Lead-in / synchronizer delay in seconds
  const [firstNoteTarget, setFirstNoteTarget] = useState(''); // Target timestamp of the first note in seconds
  const [actualBPM, setActualBPM] = useState(0); // Corrected real-song BPM written to the chart; 0 = trust the MIDI tempo

  // Auto-generated star power. Synthesizes S 2 phrase regions from note runs when
  // the source MIDI has no SP markers. Density = target measures between phrases.
  const [autoStarPower, setAutoStarPower] = useState(false);
  const [spDensityMeasures, setSpDensityMeasures] = useState(8);

  // Automatic multi-BPM tempo map fitted against the uploaded audio.
  // { bpmEvents: [{tick, bpm}], globalBPM, offsetSeconds } or null (manual mode).
  const [autoSync, setAutoSync] = useState(null);
  const [autoSyncStatus, setAutoSyncStatus] = useState('idle'); // idle | running | done | failed
  const [autoSyncProgress, setAutoSyncProgress] = useState(0);

  const [pitchMappings, setPitchMappings] = useState({});
  const [activePitches, setActivePitches] = useState([]);
  const [pitchSearchQuery, setPitchSearchQuery] = useState('');

  // Active compiled chart events (derived from MIDI + offsets + user edits)
  const [chartEvents, setChartEvents] = useState([]); // Array of { id, tick, type, value, duration }

  // Canvas Fretboard Preview states
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0); // in seconds
  const [scrollSpeed, setScrollSpeed] = useState(350); // pixels per second
  const [isDrumsMode, setIsDrumsMode] = useState(true);
  const [enableNoteSFX, setEnableNoteSFX] = useState(true); // Play synthesized feedback on note crossing

  // Web Audio Context refs
  const audioContextRef = useRef(null);
  const audioBufferRef = useRef(null);
  const audioSourceRef = useRef(null);
  const startTimeRef = useRef(0);
  const pauseTimeRef = useRef(0);
  const animationFrameRef = useRef(null);

  // Real-time note sound trigger helper
  const lastPlayedTimeRef = useRef(-1);

  // Canvas ref
  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);

  // Selected note for editing
  const [selectedNote, setSelectedNote] = useState(null);

  useEffect(() => {
    setIsDrumsMode(targetChartSection.toLowerCase().includes('drum'));
  }, [targetChartSection]);

  // Handle MIDI Parsing
  const handleMidiUpload = async (file) => {
    try {
      setAutoSync(null);
      setAutoSyncStatus('idle');
      const reader = new FileReader();
      reader.onload = async (e) => {
        // The outer try/catch has already exited by the time this async callback
        // runs, so parse failures must be caught here to reach the user.
        try {
          const buffer = e.target.result;
          setRawMidiBuffer(buffer);
          const midi = new Midi(buffer);
          setParsedMidi(midi);

          const midiTempo = (midi.header.tempos && midi.header.tempos.length > 0) ? midi.header.tempos[0].bpm : 120;
          setActualBPM(parseFloat(midiTempo.toFixed(3)));

          setMidiFile(file);
          setMidiMetadata({
            name: file.name,
            size: (file.size / 1024).toFixed(1) + ' KB',
            ppq: midi.header.ppq,
            duration: midi.duration.toFixed(1) + 's',
            tracksCount: midi.tracks.length
          });

          // Set default song title / artist from file name or midi header
          setIniTitle(midi.header.name || file.name.replace(/\.[^/.]+$/, ""));
          setIniArtist('Unknown Artist');

          // Select the track with the most notes as a default starting point
          let bestIdx = 0;
          let maxNotes = -1;
          midi.tracks.forEach((t, i) => {
            if (t.notes.length > maxNotes) {
              maxNotes = t.notes.length;
              bestIdx = i;
            }
          });
          setSelectedTrackIndex(bestIdx);
        } catch (err) {
          console.error(err);
          alert('Failed to parse MIDI file. Verify that it is not malformed.');
        }
      };
      reader.readAsArrayBuffer(file);
    } catch (err) {
      console.error(err);
      alert('Failed to parse MIDI file. Verify that it is not malformed.');
    }
  };

  // Handle Audio Upload & immediate decoding + transcoding trigger
  const handleAudioUpload = async (file) => {
    setAutoSync(null);
    setAutoSyncStatus('idle');
    setAudioFile(file);
    setAudioMetadata({
      name: file.name,
      size: (file.size / (1024 * 1024)).toFixed(2) + ' MB',
      type: file.type,
      duration: 'Analyzing...'
    });

    const audioCtx = getAudioContext();
    updateAudioContextStatus();

    // 1. Immediate client-side decode to make it playable right away!
    try {
      const arrayBuffer = await file.arrayBuffer();
      const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      
      // Programmatically prepend 2.0 seconds of silence to original raw MP3 buffer client-side
      // so it matches the 2.0s padded backend transcode timeline perfectly in visual previewing!
      const paddedBuffer = padAudioBuffer(audioCtx, decodedBuffer, 2.0);
      audioBufferRef.current = paddedBuffer;
      
      setAudioMetadata(prev => ({
        ...prev,
        duration: paddedBuffer.duration.toFixed(1) + 's',
        sampleRate: paddedBuffer.sampleRate + ' Hz'
      }));
      console.log("Original MP3 loaded, decoded, and client-side programmatically padded successfully.");
    } catch (e) {
      console.error("Local client-side decoding failed:", e);
    }

    // 2. Trigger high-quality backend OGG transcoding in the background
    await triggerTranscode(file);
  };

  const triggerTranscode = async (file) => {
    setTranscoding(true);
    setTranscodedAudioBlob(null);
    try {
      const formData = new FormData();
      formData.append('audio', file);

      // Post to Express backend
      const response = await fetch('/api/transcode', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error('Transcode server returned error: ' + response.statusText);
      }

      const oggBlob = await response.blob();
      setTranscodedAudioBlob(oggBlob);

      // Decode the new OGG audio for Web Audio API playback
      const audioCtx = getAudioContext();
      const arrayBuffer = await oggBlob.arrayBuffer();
      const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      
      // Since the backend OGG stream already has 2.0 seconds of silence prepended by FFmpeg,
      // we DO NOT need to pad this decoded buffer again! We set it directly.
      audioBufferRef.current = decodedBuffer;

      console.log("Transcoded high-quality padded OGG Audio Loaded successfully!", decodedBuffer);
    } catch (err) {
      console.error("Backend transcoding failed, keeping programmatically padded original MP3 buffer:", err);
    } finally {
      setTranscoding(false);
    }
  };

  // Get or initialize Audio Context
  const getAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioContextRef.current;
  };

  const updateAudioContextStatus = () => {
    if (audioContextRef.current) {
      setAudioCtxStatus(audioContextRef.current.state);
    }
  };

  // Tempo helpers: the MIDI's stated tempo vs. the tempo the chart should actually
  // play at. Transcribed MIDIs are often quantized to a nominal tempo (e.g. exactly
  // 100 BPM) that doesn't match the recording, which makes notes drift out of sync
  // no matter what constant offset is applied. Since note ticks are pure musical
  // positions, correcting the BPM written to the SyncTrack re-times every note.
  const getMidiBPM = () => {
    if (parsedMidi && parsedMidi.header.tempos && parsedMidi.header.tempos.length > 0) {
      return parsedMidi.header.tempos[0].bpm;
    }
    return 120;
  };

  const getEffectiveBPM = () => (actualBPM > 0 ? actualBPM : getMidiBPM());

  // Any manual timing change invalidates a previously fitted tempo map.
  const clearAutoSync = () => {
    setAutoSync(null);
    setAutoSyncStatus('idle');
  };

  // Fit a multi-BPM tempo map against the loaded audio: detects the recording's
  // real average tempo, the lead-in offset, and per-section BPM anchors, then
  // applies them (SyncTrack gets the fitted map instead of the MIDI's tempo).
  const runAutoTempoSync = async () => {
    if (!parsedMidi || !audioBufferRef.current) {
      alert('Upload both a MIDI file and an audio file first.');
      return;
    }
    const track = parsedMidi.tracks[selectedTrackIndex];
    if (!track || track.notes.length < 12) {
      alert('The selected MIDI track has too few notes to fit a tempo map.');
      return;
    }

    setAutoSyncStatus('running');
    setAutoSyncProgress(0);
    try {
      const buf = audioBufferRef.current;
      const mono = new Float32Array(buf.length);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const data = buf.getChannelData(c);
        for (let i = 0; i < data.length; i++) mono[i] += data[i] / buf.numberOfChannels;
      }

      const { bands, fps } = await computeOnsetEnvelope(mono, buf.sampleRate,
        p => setAutoSyncProgress(Math.round(p * 40)));

      const sourcePPQ = parsedMidi.header.ppq || 480;
      const hits = track.notes.map(n => ({
        beat: n.ticks / sourcePPQ,
        w: fitWeightForPitch(n.midi),
        band: fitBandForPitch(n.midi)
      }));

      const fit = await fitTempoMap(bands, fps, hits, getMidiBPM(),
        p => setAutoSyncProgress(40 + Math.round(p * 58)));

      // Round exactly like the UI displays them, then derive leadInTicks with the
      // same formula the compile effect uses, so map and notes stay consistent.
      const globalBPM = parseFloat((60 / fit.alpha).toFixed(3));
      const offsetSeconds = parseFloat(Math.max(0, fit.anchors[0].time).toFixed(3));
      const leadInTicks = Math.round(offsetSeconds * globalBPM * 8);
      const bpmEvents = anchorsToBpmEvents(fit.anchors, globalBPM, leadInTicks);

      setActualBPM(globalBPM);
      setDrumSyncOffset(offsetSeconds);
      setFirstNoteTarget('');
      setAutoSync({ bpmEvents, globalBPM, offsetSeconds });
      setAutoSyncProgress(100);
      setAutoSyncStatus('done');
    } catch (err) {
      console.error('Auto tempo sync failed:', err);
      setAutoSyncStatus('failed');
    }
  };

  // Track Analysis & Preset Applications
  useEffect(() => {
    if (!parsedMidi) return;
    const track = parsedMidi.tracks[selectedTrackIndex];
    if (!track) return;

    // Aggregate pitches
    const counts = {};
    track.notes.forEach(note => {
      counts[note.midi] = (counts[note.midi] || 0) + 1;
    });

    const pitches = Object.keys(counts).map(p => ({
      pitch: parseInt(p),
      count: counts[p]
    })).sort((a, b) => a.pitch - b.pitch);

    setActivePitches(pitches);

    // Apply Presets (shared with the CLI via chartGen.presetMappingForPitch)
    const isDrums = isDrumsSection(targetChartSection);
    const initialMappings = {};
    pitches.forEach(({ pitch }) => {
      initialMappings[pitch] = presetMappingForPitch(pitch, isDrums);
    });

    setPitchMappings(initialMappings);
  }, [parsedMidi, selectedTrackIndex, targetChartSection]);

  // With zero lead-in, the first note plays at its musical position rendered at the
  // (possibly corrected) chart tempo — NOT at its original MIDI-file timestamp.
  const computeOffsetForTarget = (targetVal, bpm) => {
    const track = parsedMidi.tracks[selectedTrackIndex];
    if (!track || track.notes.length === 0) return null;
    const sourcePPQ = parsedMidi.header.ppq || 480;
    const firstNote = track.notes[0];
    const baseTime = (firstNote.ticks * (480 / sourcePPQ)) / 480 * (60 / bpm);
    return parseFloat(Math.max(0, targetVal - baseTime).toFixed(3));
  };

  // Recalculate Sync Offset based on Target First Note Timestamp input
  const handleFirstNoteTargetChange = (valStr) => {
    setFirstNoteTarget(valStr);
    clearAutoSync();
    const targetVal = parseFloat(valStr);
    if (isNaN(targetVal) || !parsedMidi) return;

    const offset = computeOffsetForTarget(targetVal, getEffectiveBPM());
    if (offset !== null) setDrumSyncOffset(offset);
  };

  const handleActualBPMChange = (valStr) => {
    const v = parseFloat(valStr);
    const bpm = isNaN(v) || v <= 0 ? 0 : v;
    setActualBPM(bpm);
    clearAutoSync();
    if (!parsedMidi) return;

    // Keep the first-note target honored under the new tempo
    const targetVal = parseFloat(firstNoteTarget);
    if (!isNaN(targetVal)) {
      const offset = computeOffsetForTarget(targetVal, bpm > 0 ? bpm : getMidiBPM());
      if (offset !== null) setDrumSyncOffset(offset);
    }
  };

  // Derive final chart events from mappings & offsets (shared with the CLI).
  useEffect(() => {
    if (!parsedMidi || !parsedMidi.tracks[selectedTrackIndex]) {
      setChartEvents([]);
      return;
    }
    setChartEvents(compileChartEvents({
      parsedMidi,
      trackIndex: selectedTrackIndex,
      pitchMappings,
      drumSyncOffset,
      effectiveBPM: getEffectiveBPM(),
      targetSection: targetChartSection,
      autoStarPower,
      spDensityMeasures
    }));
  }, [parsedMidi, selectedTrackIndex, pitchMappings, drumSyncOffset, targetChartSection, actualBPM, autoStarPower, spDensityMeasures]);

  // Convert current time to tick (Ticks = Seconds * BPM * 8 at 480 PPQ)
  const timeToTick = (timeSecs) => {
    if (!parsedMidi) return 0;
    return Math.round(timeSecs * getEffectiveBPM() * 8);
  };

  // Convert tick to time
  const tickToTime = (tickVal) => {
    if (!parsedMidi) return 0;
    return tickVal / (getEffectiveBPM() * 8);
  };

  // Play synthesized percussive audio feedback for a crossing note
  const playSynthesizedDrumClick = (type) => {
    try {
      const ctx = getAudioContext();
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);

      if (type === 'kick') {
        // Low drum thud
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(65, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12);
        gainNode.gain.setValueAtTime(0.35, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
        osc.start();
        osc.stop(ctx.currentTime + 0.12);
      } else if (type === 'snare') {
        // White noise snare sound
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(180, ctx.currentTime);
        gainNode.gain.setValueAtTime(0.15, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
        osc.start();
        osc.stop(ctx.currentTime + 0.1);
      } else {
        // Standard hi-hat/cymbal click
        osc.type = 'sine';
        osc.frequency.setValueAtTime(900, ctx.currentTime);
        gainNode.gain.setValueAtTime(0.12, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
        osc.start();
        osc.stop(ctx.currentTime + 0.05);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Audition raw MIDI pitch tone
  const auditionNote = (midiNote) => {
    try {
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
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

  // Playback Control Handlers
  const handlePlay = () => {
    if (isPlaying) return;
    const ctx = getAudioContext();
    
    ctx.resume().then(() => {
      updateAudioContextStatus();
      setIsPlaying(true);
      startTimeRef.current = ctx.currentTime - pauseTimeRef.current;
      lastPlayedTimeRef.current = pauseTimeRef.current;
      
      if (audioBufferRef.current) {
        const source = ctx.createBufferSource();
        source.buffer = audioBufferRef.current;
        source.connect(ctx.destination);
        const offset = Math.max(0, pauseTimeRef.current);
        source.start(0, offset);
        audioSourceRef.current = source;
      }

      animate();
    }).catch(err => {
      console.error("Failed to resume AudioContext:", err);
    });
  };

  const handlePause = () => {
    if (!isPlaying) return;
    setIsPlaying(false);
    cancelAnimationFrame(animationFrameRef.current);

    const ctx = getAudioContext();
    pauseTimeRef.current = ctx.currentTime - startTimeRef.current;

    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch (e) {}
      audioSourceRef.current = null;
    }
  };

  const handleStop = () => {
    setIsPlaying(false);
    cancelAnimationFrame(animationFrameRef.current);
    pauseTimeRef.current = 0;
    setCurrentTime(0);
    lastPlayedTimeRef.current = -1;

    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch (e) {}
      audioSourceRef.current = null;
    }
  };

  const handleScrub = (e) => {
    const newTime = parseFloat(e.target.value);
    handlePause();
    pauseTimeRef.current = newTime;
    setCurrentTime(newTime);
    lastPlayedTimeRef.current = newTime;
  };

  const animate = () => {
    const ctx = getAudioContext();
    const elapsed = ctx.currentTime - startTimeRef.current;
    
    if (enableNoteSFX && lastPlayedTimeRef.current >= 0) {
      const prevTime = lastPlayedTimeRef.current;
      chartEvents.forEach(evt => {
        if (evt.value === 66 || evt.value === 67 || evt.value === 68) return;
        if (evt.type === 'S') return;

        const noteTime = tickToTime(evt.tick);
        if (noteTime > prevTime && noteTime <= elapsed) {
          if (isDrumsMode) {
            if (evt.value === 0) playSynthesizedDrumClick('kick');
            else if (evt.value === 1) playSynthesizedDrumClick('snare');
            else playSynthesizedDrumClick('cymbal');
          } else {
            playSynthesizedDrumClick('cymbal');
          }
        }
      });
    }
    lastPlayedTimeRef.current = elapsed;
    setCurrentTime(elapsed);

    const songLen = audioBufferRef.current ? audioBufferRef.current.duration : (parsedMidi ? parsedMidi.duration + drumSyncOffset : 300);
    if (elapsed >= songLen) {
      handleStop();
      return;
    }

    animationFrameRef.current = requestAnimationFrame(animate);
  };

  // Render Fretboard Lane Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = '#020617'; // slate-950
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

    const beatIntervalSec = 60 / getEffectiveBPM();
    const playheadY = height - 100;

    ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
    ctx.fillRect(0, playheadY - 10, width, 20);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, playheadY);
    ctx.lineTo(width, playheadY);
    ctx.stroke();

    const startSec = currentTime - 2;
    const endSec = currentTime + 5;

    const firstBeat = Math.ceil(startSec / beatIntervalSec);
    const lastBeat = Math.floor(endSec / beatIntervalSec);

    for (let b = firstBeat; b <= lastBeat; b++) {
      const beatTime = b * beatIntervalSec;
      const relativeTime = beatTime - currentTime;
      const y = playheadY - (relativeTime * scrollSpeed);

      if (y >= 0 && y <= height) {
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        
        ctx.fillStyle = '#64748b';
        ctx.font = '10px sans-serif';
        ctx.fillText(`Beat ${b}`, 5, y - 4);
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

    // Star power regions (S 2) so notes inside a phrase can be flagged purple.
    const spRegions = chartEvents
      .filter(evt => evt.type === 'S')
      .map(evt => [evt.tick, evt.tick + evt.duration]);
    const inStarPower = (t) => spRegions.some(([start, end]) => t >= start && t <= end);

    chartEvents.forEach(evt => {
      if (evt.value === 66 || evt.value === 67 || evt.value === 68) return;
      if (evt.type === 'S') return;

      const noteTime = tickToTime(evt.tick);
      const relativeTime = noteTime - currentTime;
      const y = playheadY - (relativeTime * scrollSpeed);

      if (y >= -50 && y <= height + 50) {
        let laneIndex = evt.value;
        if (laneIndex > 4) laneIndex = 4;

        if (evt.value === 0 && isDrumsMode) {
          ctx.strokeStyle = inStarPower(evt.tick) ? '#c084fc' : '#ffffff';
          ctx.lineWidth = 8;
          ctx.beginPath();
          ctx.moveTo(5, y);
          ctx.lineTo(width - 5, y);
          ctx.stroke();

          ctx.strokeStyle = '#475569';
          ctx.lineWidth = 2;
          ctx.stroke();
          
          ctx.fillStyle = '#0f172a';
          ctx.font = 'bold 9px sans-serif';
          ctx.fillText("KICK", width / 2 - 12, y + 3);
          return;
        }

        const noteStyles = getNoteStyles(evt.value, evt.mappedType);
        const x = (laneIndex * laneWidth) + (laneWidth / 2);

        if (evt.duration > 0 && !isDrumsMode) {
          const sustainEndTime = tickToTime(evt.tick + evt.duration);
          const sustainRelTime = sustainEndTime - currentTime;
          const endY = playheadY - (sustainRelTime * scrollSpeed);

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

        if (noteStyles.shape === 'diamond') {
          ctx.beginPath();
          ctx.moveTo(x, y - noteStyles.radius - 2);
          ctx.lineTo(x + noteStyles.radius + 2, y);
          ctx.lineTo(x, y + noteStyles.radius + 2);
          ctx.lineTo(x - noteStyles.radius - 2, y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, noteStyles.radius, 0, 2 * Math.PI);
          ctx.fill();
          ctx.stroke();
        }

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
      }
    });

  }, [chartEvents, currentTime, scrollSpeed, isDrumsMode, selectedNote]);

  // Click Canvas handler to select, shift, or edit notes
  const handleCanvasClick = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const laneCount = 5;
    const laneWidth = canvas.width / laneCount;
    const playheadY = canvas.height - 100;

    let found = null;
    chartEvents.forEach(evt => {
      if (evt.value === 66 || evt.value === 67 || evt.value === 68) return;
      
      const noteTime = tickToTime(evt.tick);
      const relativeTime = noteTime - currentTime;
      const y = playheadY - (relativeTime * scrollSpeed);
      
      let laneIndex = evt.value;
      if (laneIndex > 4) laneIndex = 4;
      const x = (laneIndex * laneWidth) + (laneWidth / 2);

      const dist = Math.sqrt(Math.pow(clickX - x, 2) + Math.pow(clickY - y, 2));
      if (dist < 20) {
        found = evt;
      }
    });

    if (found) {
      setSelectedNote(found);
      auditionNote(found.originalPitch);
    } else {
      setSelectedNote(null);
    }
  };

  // Modify note parameters directly. Cymbal notes are two events (pad + flag
  // linked via pairId), so every edit must apply to both or the export ends up
  // with orphaned/mismatched N 66/67/68 flag lines.
  const shiftNoteTime = (deltaSec) => {
    if (!selectedNote) return;
    const deltaTicks = Math.round(timeToTick(deltaSec));

    setChartEvents(prev => prev.map(evt => {
      if (evt.id === selectedNote.id || evt.pairId === selectedNote.id) {
        return { ...evt, tick: Math.max(0, evt.tick + deltaTicks) };
      }
      return evt;
    }));

    setSelectedNote(prev => ({ ...prev, tick: Math.max(0, prev.tick + deltaTicks) }));
  };

  const changeNoteLane = (laneIndex) => {
    if (!selectedNote) return;
    setChartEvents(prev => prev.reduce((acc, evt) => {
      if (evt.id === selectedNote.id) {
        acc.push({ ...evt, value: laneIndex });
      } else if (evt.pairId === selectedNote.id) {
        // Companion cymbal flag: retarget to the new lane's flag note, or drop
        // it entirely when moving to kick/red which have no cymbal form.
        if (laneIndex >= 2 && laneIndex <= 4) {
          acc.push({ ...evt, value: 64 + laneIndex });
        }
      } else {
        acc.push(evt);
      }
      return acc;
    }, []));
    setSelectedNote(prev => ({ ...prev, value: laneIndex }));
  };

  // Generate standard chart file output string
  // Thin wrappers over the shared chartGen module (same logic the CLI uses).
  const generateChartString = () => buildChartString({
    parsedMidi,
    chartEvents,
    targetSection: targetChartSection,
    effectiveBPM: getEffectiveBPM(),
    midiBPM: getMidiBPM(),
    drumSyncOffset,
    autoSync
  });

  const generateSongIni = (musicStream = 'song.ogg') => {
    // song_length should reflect the shipped (padded) audio, not the raw MIDI span.
    // The no-audio fallback rescales the MIDI duration into the corrected-tempo domain.
    const songLengthMs = audioBufferRef.current
      ? Math.round(audioBufferRef.current.duration * 1000)
      : (parsedMidi ? Math.round((parsedMidi.duration * (getMidiBPM() / getEffectiveBPM()) + drumSyncOffset) * 1000) : 180000);
    return buildSongIni({ title: iniTitle, artist: iniArtist, charter: iniCharter, musicStream, songLengthMs });
  };

  // Bundle Export handler creating zip folders with standard song.ogg
  const exportCloneHeroBundle = async () => {
    if (!parsedMidi) {
      alert('Please upload a MIDI file first.');
      return;
    }

    try {
      const zip = new JSZip();

      // 1. notes.chart — Clone Hero only scans for "notes.chart" / "notes.mid".
      // Do NOT also ship the raw source MIDI as notes.mid: it is a GM drum file,
      // not a CH-format chart, and CH would try to load it instead of the .chart.
      const chartContent = generateChartString();
      zip.file('notes.chart', chartContent);

      // 2. Audio stem. Prefer the backend's real Ogg; otherwise encode the
      // decoded + 2s-padded preview buffer to WAV client-side. NEVER ship raw
      // MP3 bytes under an .ogg name — Clone Hero hangs trying to decode that.
      let musicStream = 'song.ogg';
      if (transcodedAudioBlob) {
        zip.file('song.ogg', transcodedAudioBlob);
      } else if (audioBufferRef.current) {
        // This is exactly the buffer the preview played and tempo-sync was fit
        // against, so timing matches the preview. WAV is bigger than Ogg but
        // always loads; run the backend transcoder if you want a smaller Ogg.
        zip.file('song.wav', audioBufferToWav(audioBufferRef.current));
        musicStream = 'song.wav';
      } else if (audioFile) {
        // No decoded buffer at all (client decode failed). Ship the source under
        // its TRUE extension so CH reads the real format; timing may be off since
        // this copy isn't padded with the lead-in.
        const ext = (audioFile.name.split('.').pop() || 'mp3').toLowerCase();
        musicStream = `song.${ext}`;
        zip.file(musicStream, audioFile);
        alert('Warning: the audio could not be decoded for padding, so the original file is packaged as-is. Timing may be off by the lead-in amount.');
      } else {
        alert('Warning: no audio was uploaded, so the bundle contains no audio stem. Clone Hero will list the song but cannot play it.');
      }

      // 3. song.ini (music_stream must name the stem actually written above)
      const iniContent = generateSongIni(musicStream);
      zip.file('song.ini', iniContent);

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(zipBlob);
      link.download = `${iniTitle.replace(/\s+/g, '_') || 'custom_song'}_bundle.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error(err);
      alert('Failed to generate Clone Hero song bundle folder.');
    }
  };

  const starPowerCount = chartEvents.filter(e => e.type === 'S').length;

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
              <p className="text-xs text-slate-400">Full-Stack Dual Asset Pipeline, Visual Sync Canvas, & Song Bundle Exporter</p>
            </div>
          </div>
          <div className="text-xs text-slate-400 bg-slate-850 border border-slate-700/60 px-3 py-1.5 rounded-full flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block animate-ping"></span>
            Active Cloud Run Transcoding Worker Enabled
          </div>
        </div>
      </header>

      {/* Warning/Error banners for Browser AudioContext restrictions */}
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
              onClick={() => {
                const ctx = getAudioContext();
                ctx.resume().then(() => updateAudioContextStatus());
              }}
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
          
          {/* Dual Ingestion Area */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 backdrop-blur">
            <h2 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
              <Upload className="h-4 w-4 text-indigo-400" />
              1. Dual-File Asset Ingestion Pipeline
            </h2>

            <div className="flex flex-col gap-4">
              {/* MIDI input */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Select .MID Track</label>
                <div className="relative border-2 border-dashed border-slate-700 hover:border-indigo-500 bg-slate-950/40 rounded-lg p-3 text-center cursor-pointer group transition">
                  <input 
                    type="file" 
                    accept=".mid,.midi" 
                    onChange={(e) => e.target.files[0] && handleMidiUpload(e.target.files[0])}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div className="flex items-center justify-center gap-2 text-xs">
                    <Music className="h-4 w-4 text-slate-400 group-hover:text-indigo-400" />
                    <span className="font-medium text-slate-300">
                      {midiMetadata ? midiMetadata.name : 'Choose or drag MIDI file'}
                    </span>
                  </div>
                </div>
              </div>

              {/* MP3 Input */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Select Audio Track</label>
                <div className="relative border-2 border-dashed border-slate-700 hover:border-indigo-500 bg-slate-950/40 rounded-lg p-3 text-center cursor-pointer group transition">
                  <input 
                    type="file" 
                    accept=".mp3" 
                    onChange={(e) => e.target.files[0] && handleAudioUpload(e.target.files[0])}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div className="flex items-center justify-center gap-2 text-xs">
                    <FileAudio className="h-4 w-4 text-slate-400 group-hover:text-indigo-400" />
                    <span className="font-medium text-slate-300">
                      {audioMetadata ? audioMetadata.name : 'Choose or drag MP3 audio'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Asset Wrappers Metadata Card */}
            {(midiMetadata || audioMetadata) && (
              <div className="mt-4 p-3 bg-slate-950/60 border border-slate-800 rounded-lg flex flex-col gap-2.5 text-xs">
                {midiMetadata && (
                  <div>
                    <h4 className="font-semibold text-indigo-400 flex items-center gap-1.5">
                      <Music className="h-3 w-3" /> MIDI Details
                    </h4>
                    <div className="grid grid-cols-2 gap-1 mt-1 text-slate-400">
                      <span>Size: {midiMetadata.size}</span>
                      <span>PPQ: {midiMetadata.ppq}</span>
                      <span>Tracks: {midiMetadata.tracksCount}</span>
                      <span>Duration: {midiMetadata.duration}</span>
                    </div>
                  </div>
                )}
                {audioMetadata && (
                  <div className="border-t border-slate-900 pt-2">
                    <h4 className="font-semibold text-emerald-400 flex items-center gap-1.5">
                      <FileAudio className="h-3 w-3" /> Audio Details
                    </h4>
                    <div className="grid grid-cols-2 gap-1 mt-1 text-slate-400">
                      <span>Size: {audioMetadata.size}</span>
                      <span>Sample Rate: {audioMetadata.sampleRate || 'Analyzing...'}</span>
                      <span className="col-span-2">Duration: {audioMetadata.duration}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Import / Timing Properties */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 backdrop-blur">
            <h2 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
              <Settings className="h-4 w-4 text-indigo-400" />
              2. Timeline Sync & Alignment
            </h2>

            <div className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Source MIDI Track</label>
                <select 
                  value={selectedTrackIndex}
                  onChange={(e) => { setSelectedTrackIndex(parseInt(e.target.value)); clearAutoSync(); }}
                  disabled={!parsedMidi}
                  className="w-full bg-slate-950 border border-slate-850 text-slate-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-indigo-500 transition"
                >
                  {parsedMidi ? parsedMidi.tracks.map((track, i) => (
                    <option key={i} value={i}>
                      Track {i}: {track.name || 'Unnamed'} ({track.notes.length} notes)
                    </option>
                  )) : (
                    <option value="0">Upload MIDI file first</option>
                  )}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Target .Chart Track Section</label>
                <select 
                  value={targetChartSection}
                  onChange={(e) => setTargetChartSection(e.target.value)}
                  disabled={!parsedMidi}
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

              {/* Actual BPM / Tempo correction input box */}
              <div className="border-t border-slate-850 pt-3">
                <label className="block text-xs font-semibold text-amber-300 uppercase tracking-wider mb-1">
                  Actual Song BPM (Tempo Correction)
                </label>
                <p className="text-[11px] text-slate-400 mb-2">
                  Tempo written to the chart. Transcribed MIDIs are often quantized to a nominal tempo
                  (MIDI header says {parsedMidi ? getMidiBPM().toFixed(3) : '—'} BPM) — if the recording's real
                  tempo differs, notes drift steadily out of sync and no offset can fix it. Correct it here.
                </p>
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  value={actualBPM || ''}
                  onChange={(e) => handleActualBPMChange(e.target.value)}
                  placeholder="e.g. 103.509"
                  disabled={!parsedMidi}
                  className="w-full bg-slate-950 border border-slate-800 text-amber-200 font-mono text-center rounded-lg py-2 focus:outline-none focus:border-amber-500 text-sm"
                />
              </div>

              {/* Automatic multi-BPM tempo map */}
              <div className="border-t border-slate-850 pt-3">
                <label className="block text-xs font-semibold text-sky-300 uppercase tracking-wider mb-1">
                  Auto-Sync Tempo Map (Multi-BPM)
                </label>
                <p className="text-[11px] text-slate-400 mb-2">
                  Analyzes the uploaded audio's drum transients against the MIDI and builds the
                  tempo map automatically: real average BPM, start offset, and section-by-section
                  BPM anchors for recordings that drift. Fills in the fields above; any manual
                  edit to them switches back to single-BPM mode.
                </p>
                <button
                  onClick={runAutoTempoSync}
                  disabled={!parsedMidi || !audioMetadata || autoSyncStatus === 'running'}
                  className="w-full py-2 px-3 bg-sky-700 hover:bg-sky-600 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold transition flex items-center justify-center gap-2"
                >
                  {autoSyncStatus === 'running' ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      Analyzing audio… {autoSyncProgress}%
                    </>
                  ) : (
                    <>
                      <Sliders className="h-3.5 w-3.5" />
                      Analyze Audio &amp; Build Tempo Map
                    </>
                  )}
                </button>
                {autoSyncStatus === 'done' && autoSync && (
                  <div className="mt-2 text-[11px] text-sky-200 bg-sky-950/40 border border-sky-800/50 rounded-lg px-3 py-2 flex items-start justify-between gap-2">
                    <span>
                      Locked to audio: avg {autoSync.globalBPM.toFixed(2)} BPM,{' '}
                      {autoSync.bpmEvents.length} tempo event{autoSync.bpmEvents.length === 1 ? '' : 's'},{' '}
                      lead-in {autoSync.offsetSeconds.toFixed(3)}s. The exported chart uses this map;
                      the preview approximates timing between anchors.
                    </span>
                    <button
                      onClick={clearAutoSync}
                      className="text-sky-400 hover:text-sky-300 font-semibold shrink-0"
                    >
                      Clear
                    </button>
                  </div>
                )}
                {autoSyncStatus === 'failed' && (
                  <p className="mt-2 text-[11px] text-red-300">
                    Analysis failed — see the browser console, or set the BPM manually above.
                  </p>
                )}
              </div>

              {/* Timestamp of First Note Input box */}
              <div className="border-t border-slate-850 pt-3">
                <label className="block text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-1">
                  First Note Target Timestamp (Seconds)
                </label>
                <p className="text-[11px] text-slate-400 mb-2">
                  Enter exactly when the first note should play in the FINAL exported audio (which includes
                  the 2.0s silence pad). The app will auto-calculate the required timeline shift.
                </p>
                <input 
                  type="number"
                  step="0.01"
                  min="0"
                  value={firstNoteTarget}
                  onChange={(e) => handleFirstNoteTargetChange(e.target.value)}
                  placeholder="e.g. 3.50"
                  disabled={!parsedMidi}
                  className="w-full bg-slate-950 border border-slate-800 text-emerald-200 font-mono text-center rounded-lg py-2 focus:outline-none focus:border-emerald-500 text-sm"
                />
              </div>

              {/* Offset Input Synchronizer */}
              <div className="border-t border-slate-850 pt-3">
                <label className="block text-xs font-semibold text-indigo-300 uppercase tracking-wider mb-1">
                  Calculated Sync Start (Seconds)
                </label>
                <p className="text-[11px] text-slate-400 mb-2">
                  Pre-pads audio lead-in and automatically offsets fretboard notes down the timeline.
                </p>
                <input 
                  type="number" 
                  step="0.05"
                  min="0"
                  value={drumSyncOffset}
                  onChange={(e) => { setDrumSyncOffset(Math.max(0, parseFloat(e.target.value) || 0)); clearAutoSync(); }}
                  disabled={!parsedMidi}
                  className="w-full bg-slate-950 border border-slate-800 text-indigo-200 font-mono text-center rounded-lg py-2 focus:outline-none focus:border-indigo-500 text-sm"
                />
              </div>
            </div>
          </div>

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
                Synthesizes <span className="font-mono text-purple-300">S 2</span> phrases from the note
                runs when the source MIDI has no Star Power markers. Each phrase ends on a real note so it
                stays activatable. A manual pitch → Star Power mapping takes precedence and disables this.
              </p>

              <div>
                <label className="block text-xs font-semibold text-purple-300 uppercase tracking-wider mb-1.5">
                  Phrase Frequency
                </label>
                <select
                  value={spDensityMeasures}
                  onChange={(e) => setSpDensityMeasures(parseInt(e.target.value))}
                  disabled={!parsedMidi || !autoStarPower}
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
                    : 'No phrases yet — upload a MIDI (or the source already defines its own Star Power).'}
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
                <input 
                  type="text" 
                  value={iniTitle}
                  onChange={(e) => setIniTitle(e.target.value)}
                  placeholder="Song Title"
                  className="bg-slate-950 border border-slate-855 rounded px-2 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-slate-400">Artist</label>
                <input 
                  type="text" 
                  value={iniArtist}
                  onChange={(e) => setIniArtist(e.target.value)}
                  placeholder="Artist Name"
                  className="bg-slate-950 border border-slate-855 rounded px-2 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-slate-400">Charter / Mapper Name</label>
                <input 
                  type="text" 
                  value={iniCharter}
                  onChange={(e) => setIniCharter(e.target.value)}
                  placeholder="Charter"
                  className="bg-slate-950 border border-slate-855 rounded px-2 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <button
              onClick={exportCloneHeroBundle}
              disabled={!parsedMidi}
              className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-semibold rounded-lg shadow-lg hover:shadow-emerald-500/10 active:scale-[0.98] transition flex items-center justify-center gap-2 text-sm"
            >
              <Download className="h-4 w-4" />
              Export Clone Hero Song Folder (.ZIP)
            </button>
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
                <p className="text-xs text-slate-400">Web Audio dynamic timeline editor with drag, shift, and click note mapping</p>
              </div>

              {/* Player State Indicator */}
              <div className="flex items-center gap-3">
                <span className="text-[11px] font-mono text-slate-400">
                  Time: {currentTime.toFixed(2)}s / {audioBufferRef.current ? audioBufferRef.current.duration.toFixed(1) : '0.0'}s
                </span>
                <span className={`w-2.5 h-2.5 rounded-full ${isPlaying ? 'bg-emerald-500 animate-ping' : 'bg-slate-600'}`}></span>
              </div>
            </div>

            {/* Canvas Container */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
              
              {/* Actual Fretboard lane (Left side inside component) */}
              <div className="md:col-span-6 flex flex-col items-center">
                <div 
                  ref={canvasContainerRef}
                  className="relative border border-slate-800 rounded-lg overflow-hidden bg-slate-950 w-[240px]"
                >
                  <canvas 
                    ref={canvasRef} 
                    width={240} 
                    height={400} 
                    onClick={handleCanvasClick}
                    className="cursor-crosshair"
                  />
                </div>
                
                {/* Scroll Speed Slider */}
                <div className="w-[240px] mt-2.5 flex justify-between items-center text-xs text-slate-400">
                  <span>Scroll Speed:</span>
                  <input 
                    type="range" 
                    min="150" 
                    max="800" 
                    step="25"
                    value={scrollSpeed} 
                    onChange={(e) => setScrollSpeed(parseInt(e.target.value))}
                    className="w-32 accent-indigo-500" 
                  />
                  <span>{scrollSpeed}</span>
                </div>
              </div>

              {/* Player Timeline Controls & Note Editor panel (Right side inside component) */}
              <div className="md:col-span-6 flex flex-col gap-3">
                {/* Player button controls */}
                <div className="bg-slate-950 p-3.5 border border-slate-850 rounded-lg flex flex-col gap-3">
                  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Transport Controls</h4>
                  
                  <div className="flex justify-between gap-2.5">
                    <button 
                      onClick={handlePlay}
                      disabled={isPlaying}
                      className="flex-1 py-1.5 px-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded text-xs font-semibold transition flex items-center justify-center gap-1.5"
                    >
                      <Play className="h-3.5 w-3.5 fill-current" /> Play
                    </button>
                    <button 
                      onClick={handlePause}
                      disabled={!isPlaying}
                      className="flex-1 py-1.5 px-3 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 rounded text-xs font-semibold transition flex items-center justify-center gap-1.5"
                    >
                      <Pause className="h-3.5 w-3.5 fill-current" /> Pause
                    </button>
                    <button 
                      onClick={handleStop}
                      className="flex-1 py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs font-semibold transition flex items-center justify-center gap-1.5"
                    >
                      <Square className="h-3.5 w-3.5 fill-current" /> Stop
                    </button>
                  </div>

                  {/* Scrubber slider */}
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] font-mono text-slate-500">0s</span>
                    <input 
                      type="range"
                      min="0"
                      max={audioBufferRef.current ? audioBufferRef.current.duration : (parsedMidi ? parsedMidi.duration + drumSyncOffset : 300)}
                      step="0.05"
                      value={currentTime}
                      onChange={handleScrub}
                      className="flex-1 accent-indigo-500"
                    />
                    <span className="text-[10px] font-mono text-slate-500">
                      {audioBufferRef.current ? audioBufferRef.current.duration.toFixed(1) : '300'}s
                    </span>
                  </div>

                  {/* SFX Metronome trigger option */}
                  <div className="flex items-center justify-between border-t border-slate-900 pt-2 text-xs">
                    <label htmlFor="chk-sfx" className="text-slate-400 flex items-center gap-1.5 cursor-pointer">
                      {enableNoteSFX ? <Volume2 className="h-3.5 w-3.5 text-indigo-400 animate-bounce" /> : <VolumeX className="h-3.5 w-3.5 text-slate-500" />}
                      <span>Enable Note SFX (Synth Click Feed)</span>
                    </label>
                    <input 
                      id="chk-sfx" 
                      type="checkbox" 
                      checked={enableNoteSFX} 
                      onChange={(e) => setEnableNoteSFX(e.target.checked)} 
                      className="rounded border-slate-850 bg-slate-950 text-indigo-500 focus:ring-indigo-500 w-4 h-4 cursor-pointer"
                    />
                  </div>

                  {/* Transcoding loading banner */}
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
                          <span>Note ID: <strong className="text-white">{selectedNote.id}</strong></span>
                          <span>Mapped Tick: <strong className="text-indigo-400">{selectedNote.tick}</strong></span>
                        </div>
                        
                        {/* Shifter inputs */}
                        <div className="grid grid-cols-2 gap-2 mt-1">
                          <button 
                            onClick={() => shiftNoteTime(-0.05)}
                            className="p-1 bg-slate-900 border border-slate-800 rounded hover:bg-slate-850 text-[11px]"
                          >
                            Shift Back 50ms
                          </button>
                          <button 
                            onClick={() => shiftNoteTime(0.05)}
                            className="p-1 bg-slate-900 border border-slate-800 rounded hover:bg-slate-850 text-[11px]"
                          >
                            Shift Fwd 50ms
                          </button>
                        </div>

                        {/* Note output lane mapping */}
                        <div className="flex flex-col gap-1.5 mt-1">
                          <span className="text-slate-400 text-[11px]">Output Fret/Pad Lane</span>
                          <div className="grid grid-cols-5 gap-1">
                            {[0, 1, 2, 3, 4].map(idx => (
                              <button 
                                key={idx}
                                onClick={() => changeNoteLane(idx)}
                                className={`p-1.5 font-bold rounded border text-center transition ${selectedNote.value === idx ? 'bg-indigo-600 border-indigo-400 text-white' : 'bg-slate-900 border-slate-850 text-slate-400'}`}
                              >
                                {idx}
                              </button>
                            ))}
                          </div>
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
                      <span className="text-[10px] text-slate-500">Midi note: {selectedNote.originalPitch}</span>
                      <button 
                        onClick={() => {
                          setChartEvents(prev => prev.filter(e => e.id !== selectedNote.id && e.pairId !== selectedNote.id));
                          setSelectedNote(null);
                        }}
                        className="text-red-400 hover:text-red-300 font-semibold flex items-center gap-1 text-[11px]"
                      >
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
                <h2 className="text-sm font-semibold text-slate-200">3. Dynamic Pitch Configuration Map</h2>
                <p className="text-xs text-slate-400">Map specific active MIDI notes down to custom layout targets</p>
              </div>

              {/* Filter inputs */}
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
                    <th className="p-3">GM Instrument Name</th>
                    <th className="p-3 text-center">Count</th>
                    <th className="p-3 text-center">Audition</th>
                    <th className="p-3">Map output config</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-900 text-slate-300">
                  {activePitches.length === 0 ? (
                    <tr>
                      <td colSpan="5" className="p-8 text-center text-slate-500 italic">
                        Upload a MIDI file to configure pitch triggers
                      </td>
                    </tr>
                  ) : (
                    activePitches
                      .filter(({ pitch }) => {
                        const name = GM_DRUM_MAP[pitch] || 'Unknown';
                        return pitch.toString().includes(pitchSearchQuery) || name.toLowerCase().includes(pitchSearchQuery.toLowerCase());
                      })
                      .map(({ pitch, count }) => {
                        const name = GM_DRUM_MAP[pitch] || 'Unknown GM Trigger';
                        const currentVal = pitchMappings[pitch] || 'ignore';
                        const optionsList = isDrumsMode ? MAPPING_OPTIONS_DRUMS : MAPPING_OPTIONS_GUITAR;

                        return (
                          <tr key={pitch} className="hover:bg-slate-900/30 transition">
                            <td className="p-3 font-semibold text-indigo-300">{pitch}</td>
                            <td className="p-3 text-slate-400">{name}</td>
                            <td className="p-3 text-center font-medium text-slate-300">{count}</td>
                            <td className="p-3 text-center">
                              <button 
                                onClick={() => auditionNote(pitch)}
                                className="p-1.5 rounded bg-slate-900 border border-slate-800 hover:bg-slate-850 hover:text-indigo-400 transition"
                              >
                                <Play className="h-3 w-3 fill-current" />
                              </button>
                            </td>
                            <td className="p-3">
                              <select
                                value={currentVal}
                                onChange={(e) => setPitchMappings(prev => ({
                                  ...prev,
                                  [pitch]: e.target.value
                                }))}
                                className="bg-slate-900 border border-slate-800 text-slate-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-indigo-500 transition w-full max-w-[200px]"
                              >
                                {optionsList.map(opt => (
                                  <option key={opt.value} value={opt.value} className={opt.class}>
                                    {opt.label}
                                  </option>
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
                Live Pre-Rendered .Chart Output (First 20 Events)
              </h3>
              <pre className="p-3.5 bg-slate-950 border border-slate-850 rounded-lg font-mono text-[11px] text-slate-400 overflow-x-auto max-h-[160px]">
                {generateChartString().split('\n').slice(0, 25).join('\n')}
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
