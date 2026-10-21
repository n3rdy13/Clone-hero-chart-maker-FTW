// Client-side audio helpers shared by the single-file exporter (App.jsx) and the
// batch converter (batchConvert.js). No React/DOM beyond the Web Audio types the
// caller passes in.

// Prepend N seconds of absolute silence to an AudioBuffer (the chart timeline
// expects this lead-in), returning a new buffer created from the given context.
export const padAudioBuffer = (audioCtx, originalBuffer, padSeconds) => {
  const sampleRate = originalBuffer.sampleRate;
  const padSamples = Math.round(padSeconds * sampleRate);
  const newLength = originalBuffer.length + padSamples;
  const newBuffer = audioCtx.createBuffer(originalBuffer.numberOfChannels, newLength, sampleRate);
  for (let channel = 0; channel < originalBuffer.numberOfChannels; channel++) {
    const originalData = originalBuffer.getChannelData(channel);
    const newData = newBuffer.getChannelData(channel);
    newData.set(originalData, padSamples);
  }
  return newBuffer;
};

// Encode an AudioBuffer to a 16-bit PCM WAV Blob entirely client-side. Clone
// Hero loads song.wav natively and PCM has no encoder quirks, so this is a safe
// offline format — unlike shipping raw MP3 bytes under an .ogg name, which makes
// CH hang while trying to decode them.
export const audioBufferToWav = (buffer) => {
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const view = new DataView(new ArrayBuffer(44 + dataSize));

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM fmt chunk size
  view.setUint16(20, 1, true);           // audio format = PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);      // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
};

// Decodes any format the browser supports (mp3, m4a/aac, ogg, opus, wav, flac)
// and returns the full-quality AudioBuffer for playback plus a mono copy
// resampled to `sr` for analysis.
export async function decodeForAnalysis(file, sr = 22050) {
  const data = await file.arrayBuffer();
  let buffer;
  try {
    buffer = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(data);
  } catch {
    throw new Error(`Couldn't decode "${file.name}". Try MP3, M4A, OGG, WAV or FLAC.`);
  }
  const length = Math.max(1, Math.ceil(buffer.duration * sr));
  const ctx = new OfflineAudioContext(1, length, sr);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return { buffer, samples: rendered.getChannelData(0).slice() };
}

// Simple synthetic kit for previewing chart notes against the recording
// (after drumcharts2026's Player.drum). lane: kick | red | yellow | blue | green.
const noiseByCtx = new WeakMap();
export function playDrumSound(ctx, when, lane, cymbal) {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  if (lane === 'kick') {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(140, when);
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.12);
    out.gain.setValueAtTime(0.9, when);
    out.gain.exponentialRampToValueAtTime(0.0001, when + 0.25);
    osc.connect(out);
    osc.start(when);
    osc.stop(when + 0.26);
    return;
  }
  if (lane !== 'red' && !cymbal) {
    const osc = ctx.createOscillator();
    const pitch = { yellow: 220, blue: 165, green: 110 }[lane] ?? 165;
    osc.frequency.setValueAtTime(pitch * 1.4, when);
    osc.frequency.exponentialRampToValueAtTime(pitch, when + 0.08);
    out.gain.setValueAtTime(0.6, when);
    out.gain.exponentialRampToValueAtTime(0.0001, when + 0.3);
    osc.connect(out);
    osc.start(when);
    osc.stop(when + 0.31);
    return;
  }
  let noise = noiseByCtx.get(ctx);
  if (!noise) {
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseByCtx.set(ctx, noise);
  }
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = lane === 'red' ? 'bandpass' : 'highpass';
  filter.frequency.value = lane === 'red' ? 1800 : 7000;
  const decay = lane === 'red' ? 0.15 : lane === 'yellow' ? 0.06 : 0.6;
  out.gain.setValueAtTime(lane === 'red' ? 0.8 : 0.35, when);
  out.gain.exponentialRampToValueAtTime(0.0001, when + decay);
  src.connect(filter).connect(out);
  src.start(when);
  src.stop(when + decay + 0.01);
}
