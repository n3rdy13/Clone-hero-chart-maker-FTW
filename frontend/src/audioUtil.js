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
