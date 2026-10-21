// Picks where the analysis runs: a module worker when the browser allows one,
// otherwise the main thread. Both expose the same calls. (After
// drumcharts2026's src/engine.js.)
import { SongAnalyzer } from './analyze.js';

export async function createEngine({ allowWorker = true } = {}) {
  if (allowWorker && typeof Worker !== 'undefined') {
    try {
      return await workerEngine();
    } catch {
      // Fall through to the main thread.
    }
  }
  return mainThreadEngine();
}

function workerEngine() {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker did not start')); }, 5000);
    const pending = new Map();
    let nextId = 1;
    worker.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(e);
      for (const p of pending.values()) p.reject(new Error('Analysis worker crashed'));
      pending.clear();
    });
    worker.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'ready') { clearTimeout(timer); resolve(engine); return; }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error));
    });
    const call = (payload, transfer = []) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      worker.postMessage({ id, ...payload }, transfer);
    });
    const engine = {
      kind: 'worker',
      // Copies are sent so the caller keeps its own samples.
      load: (mix, stem, sr, tracking) => call({ type: 'load', mix, stem, sr, tracking }),
      track: (tracking) => call({ type: 'track', tracking }),
      transcribe: () => call({ type: 'transcribe' }),
    };
  });
}

function mainThreadEngine() {
  const analyzer = new SongAnalyzer();
  // Yield first so the status line paints before the long synchronous pass.
  const later = (fn) => new Promise((res, rej) => setTimeout(() => { try { res(fn()); } catch (err) { rej(err); } }, 30));
  return {
    kind: 'main',
    load: (mix, stem, sr, tracking) => later(() => { const summary = analyzer.load({ mix, stem, sr }); return { summary, ...analyzer.track(tracking), onset: analyzer.onset }; }),
    track: (tracking) => later(() => analyzer.track(tracking)),
    transcribe: () => later(() => analyzer.transcribe()),
  };
}
