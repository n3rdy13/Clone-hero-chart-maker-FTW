// Reads a tempo map from a DAW session file (browser and Node).
import JSZip from 'jszip';
import { beatsFromTempoMidi, beatsFromReaperProject, beatsFromDawProjectXml } from './engine/dawTempo.js';

export const DAW_EXTS = ['mid', 'midi', 'rpp', 'dawproject'];

const KIND_NAME = { mid: 'tempo map MIDI', rpp: 'Reaper project', dawproject: 'DAWproject' };

// name: file name; bytes: Uint8Array. Returns { beats, kind, tempoCount, warning, label, ... }.
export async function readDawTempo(name, bytes) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  let r;
  if (ext === 'mid' || ext === 'midi') r = beatsFromTempoMidi(bytes);
  else if (ext === 'rpp') r = beatsFromReaperProject(new TextDecoder().decode(bytes));
  else if (ext === 'dawproject') {
    const zip = await JSZip.loadAsync(bytes);
    const project = zip.file('project.xml');
    if (!project) throw new Error('No project.xml inside this .dawproject file.');
    r = beatsFromDawProjectXml(await project.async('string'));
  } else {
    throw new Error(`Can't read a tempo map from .${ext} files. Use the session's .mid, .rpp or .dawproject.`);
  }
  let warning = null;
  if (r.constant) warning = `This file only stores one tempo (${r.bpm} BPM), not a tempo map. Use the .mid or .rpp from the same session instead.`;
  else if (r.notes > 0 && r.tempoCount <= 2) warning = 'This MIDI has notes but almost no tempo changes. It looks like a tab, not a DAW tempo map.';
  return { name, ...r, warning, label: `${KIND_NAME[r.kind] || r.kind}: ${r.tempoCount} tempo ${r.tempoCount === 1 ? 'value' : 'changes'}, ${r.beats.length} beats` };
}
