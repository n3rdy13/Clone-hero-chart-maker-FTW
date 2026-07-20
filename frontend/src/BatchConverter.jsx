import React, { useState, useRef } from 'react';
import { FolderInput, FolderOutput, Layers, Play, CheckCircle, AlertCircle, RefreshCw, Music } from 'lucide-react';
import { MIDI_EXTS, AUDIO_EXTS, extOf, pairFiles, buildSongToDirectory } from './batchConvert';

const STAGE_LABEL = {
  parsing: 'Parsing MIDI…', decoding: 'Decoding audio…', syncing: 'Fitting tempo…',
  charting: 'Building chart…', encoding: 'Encoding WAV…', writing: 'Writing files…'
};

export default function BatchConverter({ defaultSection = 'ExpertDrums' }) {
  const supported = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

  const [inputDirName, setInputDirName] = useState('');
  const [outputDirName, setOutputDirName] = useState('');
  const outHandleRef = useRef(null);

  const [rows, setRows] = useState([]); // { id, midiName, midiHandle, audioName, audioHandle, artist, song, status, message }
  const [section, setSection] = useState(defaultSection);
  const [density, setDensity] = useState(8);
  const [charter, setCharter] = useState('n3rdy13');
  const [building, setBuilding] = useState(false);
  const [summary, setSummary] = useState(null);

  const updateRow = (id, patch) => setRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));

  const pickInput = async () => {
    try {
      const dir = await window.showDirectoryPicker();
      const midis = [], audios = [];
      for await (const entry of dir.values()) {
        if (entry.kind !== 'file') continue;
        const ext = extOf(entry.name);
        if (MIDI_EXTS.includes(ext)) midis.push({ name: entry.name, handle: entry });
        else if (AUDIO_EXTS.includes(ext)) audios.push({ name: entry.name, handle: entry });
      }
      const paired = pairFiles(midis, audios);
      setRows(paired.map((p, i) => ({
        id: i,
        midiName: p.midi.name,
        midiHandle: p.midi.handle,
        audioName: p.audio ? p.audio.name : null,
        audioHandle: p.audio ? p.audio.handle : null,
        artist: p.artist,
        song: p.song,
        status: p.audio ? 'ready' : 'no-audio',
        message: p.audio ? '' : 'no matching audio file'
      })));
      setInputDirName(dir.name);
      setSummary(null);
    } catch (e) { if (e.name !== 'AbortError') alert('Could not read folder: ' + e.message); }
  };

  const pickOutput = async () => {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      if (dir.requestPermission) {
        const perm = await dir.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') { alert('Write permission is required for the output folder.'); return; }
      }
      outHandleRef.current = dir;
      setOutputDirName(dir.name);
    } catch (e) { if (e.name !== 'AbortError') alert('Could not open output folder: ' + e.message); }
  };

  const buildAll = async () => {
    if (!outHandleRef.current) { alert('Select your Clone Hero Songs output folder first.'); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    setBuilding(true);
    setSummary(null);
    let ok = 0, fail = 0;
    try {
      for (const row of rows) {
        if (!row.audioHandle) continue;
        if (!row.artist || !row.song) { updateRow(row.id, { status: 'error', message: 'artist & song required' }); fail++; continue; }
        updateRow(row.id, { status: 'working', message: 'starting…' });
        try {
          const midiFile = await row.midiHandle.getFile();
          const audioFile = await row.audioHandle.getFile();
          const res = await buildSongToDirectory({
            midiFile, audioFile, artist: row.artist, song: row.song, charter,
            section, density, outDirHandle: outHandleRef.current, audioCtx: ctx,
            onStage: (s) => updateRow(row.id, { message: STAGE_LABEL[s] || s })
          });
          updateRow(row.id, { status: 'done', message: `${res.notes} notes · ${res.starPower} SP · ${res.bpm.toFixed(1)} BPM` });
          ok++;
        } catch (err) {
          updateRow(row.id, { status: 'error', message: err.message });
          fail++;
        }
      }
    } finally {
      try { ctx.close(); } catch (e) {}
      setBuilding(false);
      setSummary({ ok, fail });
    }
  };

  const readyCount = rows.filter(r => r.audioHandle).length;

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 backdrop-blur">
      <h2 className="text-sm font-semibold text-slate-200 mb-1 flex items-center gap-2 border-b border-slate-800 pb-2">
        <Layers className="h-4 w-4 text-fuchsia-400" />
        Batch Folder Converter
      </h2>
      <p className="text-[11px] text-slate-400 mt-2 mb-4">
        Point at a folder of MIDI + audio files; each pair is auto-synced, charted (with star power),
        and written straight into your Clone Hero Songs folder as a ready song — no unzip, no moving.
        Audio is written as <span className="font-mono text-fuchsia-300">song.wav</span> (larger but always loads).
      </p>

      {!supported ? (
        <div className="text-xs text-amber-200 bg-amber-950/40 border border-amber-800/60 rounded-lg px-3 py-2 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />
          Batch mode needs the File System Access API. Open this app in <strong>Chrome</strong> or <strong>Edge</strong> (over localhost).
        </div>
      ) : (
        <>
          {/* Folder pickers */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            <button onClick={pickInput} disabled={building}
              className="flex items-center justify-center gap-2 py-2 px-3 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 rounded-lg text-xs font-semibold transition">
              <FolderInput className="h-4 w-4 text-fuchsia-400" />
              {inputDirName ? `Songs: ${inputDirName}` : 'Select Song Folder'}
            </button>
            <button onClick={pickOutput} disabled={building}
              className="flex items-center justify-center gap-2 py-2 px-3 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 rounded-lg text-xs font-semibold transition">
              <FolderOutput className="h-4 w-4 text-emerald-400" />
              {outputDirName ? `Output: ${outputDirName}` : 'Select Clone Hero Songs Folder'}
            </button>
          </div>

          {/* Global options */}
          <div className="grid grid-cols-3 gap-3 mb-4 text-xs">
            <div className="flex flex-col gap-1">
              <label className="text-slate-400">Target Section</label>
              <select value={section} onChange={e => setSection(e.target.value)} disabled={building}
                className="bg-slate-950 border border-slate-800 text-slate-200 rounded px-2 py-1.5 focus:outline-none focus:border-fuchsia-500">
                <option value="ExpertDrums">Expert Drums</option>
                <option value="HardDrums">Hard Drums</option>
                <option value="ExpertSingle">Expert Guitar</option>
                <option value="HardSingle">Hard Guitar</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-slate-400">Star Power</label>
              <select value={density} onChange={e => setDensity(parseInt(e.target.value))} disabled={building}
                className="bg-slate-950 border border-slate-800 text-slate-200 rounded px-2 py-1.5 focus:outline-none focus:border-fuchsia-500">
                <option value="4">Dense (/4)</option>
                <option value="8">Medium (/8)</option>
                <option value="16">Sparse (/16)</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-slate-400">Charter</label>
              <input value={charter} onChange={e => setCharter(e.target.value)} disabled={building}
                className="bg-slate-950 border border-slate-800 text-slate-200 rounded px-2 py-1.5 focus:outline-none focus:border-fuchsia-500" />
            </div>
          </div>

          {/* Detected songs table */}
          {rows.length > 0 && (
            <div className="overflow-x-auto max-h-[320px] border border-slate-850 rounded-lg bg-slate-950/40 mb-4">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-900/40 text-slate-400 font-semibold sticky top-0 backdrop-blur z-10">
                    <th className="p-2 w-8">#</th>
                    <th className="p-2">Artist</th>
                    <th className="p-2">Song</th>
                    <th className="p-2">Audio</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-900 text-slate-300">
                  {rows.map((r, i) => (
                    <tr key={r.id} className="hover:bg-slate-900/30">
                      <td className="p-2 text-slate-500">{i + 1}</td>
                      <td className="p-2">
                        <input value={r.artist} disabled={building} onChange={e => updateRow(r.id, { artist: e.target.value })}
                          className="w-full bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200 focus:outline-none focus:border-fuchsia-500" />
                      </td>
                      <td className="p-2">
                        <input value={r.song} disabled={building} onChange={e => updateRow(r.id, { song: e.target.value })}
                          className="w-full bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200 focus:outline-none focus:border-fuchsia-500" />
                      </td>
                      <td className="p-2 text-slate-400 truncate max-w-[140px]" title={r.audioName || ''}>
                        {r.audioName || <span className="text-amber-400">— none —</span>}
                      </td>
                      <td className="p-2">
                        {r.status === 'ready' && <span className="text-slate-500">ready</span>}
                        {r.status === 'no-audio' && <span className="text-amber-400">{r.message}</span>}
                        {r.status === 'working' && <span className="text-indigo-300 flex items-center gap-1"><RefreshCw className="h-3 w-3 animate-spin" />{r.message}</span>}
                        {r.status === 'done' && <span className="text-emerald-300 flex items-center gap-1"><CheckCircle className="h-3 w-3" />{r.message}</span>}
                        {r.status === 'error' && <span className="text-red-400" title={r.message}>error: {r.message}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Build */}
          <button onClick={buildAll} disabled={building || readyCount === 0 || !outputDirName}
            className="w-full py-2.5 px-4 bg-fuchsia-700 hover:bg-fuchsia-600 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition flex items-center justify-center gap-2 text-sm">
            {building ? <><RefreshCw className="h-4 w-4 animate-spin" /> Building…</>
              : <><Play className="h-4 w-4 fill-current" /> Build {readyCount || ''} Song{readyCount === 1 ? '' : 's'} → Songs Folder</>}
          </button>

          {summary && (
            <div className="mt-3 text-xs text-slate-300 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 flex items-center gap-2">
              <Music className="h-4 w-4 text-fuchsia-400" />
              Done — <span className="text-emerald-300 font-semibold">{summary.ok} built</span>
              {summary.fail > 0 && <>, <span className="text-red-400 font-semibold">{summary.fail} failed</span></>}. Launch Clone Hero to play them.
            </div>
          )}
        </>
      )}
    </div>
  );
}
