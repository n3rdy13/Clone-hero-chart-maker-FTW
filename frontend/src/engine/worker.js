// Runs song analysis off the main thread. Keeps the onset envelopes between
// calls so re-tracking with new settings skips the expensive spectral pass.
import { SongAnalyzer } from './analyze.js';

const analyzer = new SongAnalyzer();

self.onmessage = (e) => {
  const { id, type, mix, stem, sr, tracking } = e.data;
  try {
    let result;
    if (type === 'load') {
      const summary = analyzer.load({ mix, stem, sr });
      result = { summary, ...analyzer.track(tracking), onset: analyzer.onset };
    } else if (type === 'track') {
      result = analyzer.track(tracking);
    } else if (type === 'transcribe') {
      result = analyzer.transcribe();
    } else {
      throw new Error(`Unknown request ${type}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) });
  }
};

self.postMessage({ type: 'ready' });
