# Clone Hero Master Editor

Turns a drum tab (a Songsterr `.mid` export, any drum MIDI, or a Rock Band / Clone Hero `notes.mid`)
plus the song's audio into a Clone Hero song folder: `notes.chart` (pro drums), `song.ini` and
`song.ogg`. There is a live scrolling preview with the waveform and a multi-select note editor, a
batch converter, and a one-shot command-line builder.

## How it works

The chart's timing comes from the recording, not from the tab. This is the approach of
[drumcharts2026](https://github.com/n3rdy13/drumcharts2026), ported into this app:

1. **Every beat in the recording is found.** The beat tracker follows tempo drift, sudden jumps and
   slow-downs. By default every beat gets its own tempo (*Tempo map detail: Every beat*), so the grid
   follows each push and pull of the drummer. The beats are lightly smoothed first: a single beat
   knocked a few ms off by a flam or a cymbal smear is pulled back in line, while a sudden tempo
   change is detected and left sharp, so the first beat at the new tempo stays where it was played.
   You can trade detail for fewer tempo events (within ±10, 20 or 40 ms). If you have the song's DAW
   session, its tempo map can be used instead (below).

   **3:2 errors.** A beat tracker can lock onto 2/3 or 3/2 of the real tempo for a long stretch,
   usually starting where there's no clear backbeat. Stavesacre's "Stars and Clouds" is a steady
   128 BPM, but its tom-groove intro (kick only every 2 bars) was read as 85 BPM, and much of the
   song stayed there. Straight 128 BPM eighths can't sit on an 85 BPM grid, so notes snapped to it
   were up to 85 ms off. Now any stretch tracked at 2/3, 3/2, half or double the song's main tempo is
   checked against where the drum hits land. If the hits fit 16th notes at the main tempo clearly
   better, that stretch is tracked again at the main tempo. Then every beat is fitted to the drum
   hits around it. The app lists the stretches it fixed, and warns about any stretch where more than
   1.5% of the hits still miss the 16th grid by over 25 ms. A song that really changes tempo by 3:2
   is left alone when its hits fit the new tempo. If a fix is wrong, untick *Fix stretches tracked
   at 2/3, 3/2, half or double tempo* (`--no-meter-fix` on the command line).
2. **The tab is placed on those beats by musical position.** Tab beat *b* lands on recording beat
   *offset + b*. The tab's own tempo is ignored, so a tab at a rounded 96 BPM still lines up with a
   band that drifts between 95.5 and 96.9.
3. **The offset is found automatically** by matching the tab's kicks, snares and cymbals against the
   drum hits in the audio. An offset that would push tab notes outside the audio only wins if it
   matches clearly better. On songs whose groove repeats every bar, that is what stops the tab
   sliding a bar or two. You can still nudge by a beat or a bar, or pick a close match.
4. **Bars come from the tab.** Time signatures, including odd bars like 3/4 or 5/4, are copied from
   the tab, with a pickup bar before bar 1.
5. **Pro drums rules:** cymbals get the `N 66/67/68` flags, a tom and a cymbal of the same colour
   never share a moment (the tom moves to the next free tom lane), and duplicates are dropped.

### The drum stem (optional, recommended)

Load a drums-only stem split from the same song (for example a MusicMastering or Demucs export).
- It's lined up with the song automatically. Stems are often 20 ms or so off because of AAC padding.
  A stem from a different release, or the wrong song, is detected and ignored.
- Beats are tracked on the stem. On a guitar-heavy mix the tracker can lock onto off-beats or the
  wrong tempo; on the stem it doesn't.
- **Kick check:** every tab kick is checked against the stem's kick drum. Songsterr AI tabs often add
  a kick pattern in intros and breakdowns where the drummer plays none. Those kicks show as dashed
  orange **KICK?** lines in the preview, with a one-click **Remove**. The check needs a stem: on a
  full mix, bass notes look too much like kicks.
- If your song file is itself drums only, load it in both slots.

### DAW tempo maps (optional)

If the song was mapped or recorded in a DAW, load the session's tempo map in the **DAW Tempo Map**
slot (or `--daw` on the command line):

- a tempo-map `.mid` (for example MusicMastering's export; a MIDI with no notes and many tempo
  changes dropped in the tab slot is recognised too),
- a Reaper `.rpp` project (its tempo envelope, including linear ramps),
- a `.dawproject` file. MusicMastering's `.dawproject` only stores one tempo, so the app warns and
  asks for the `.mid` or `.rpp` instead.

The map is checked against the beats found in the recording and the result is shown, for example
*Matches the beats in the recording (97% within 20 ms)*. A small constant offset (a re-encode, AAC
padding) is corrected. A map from a different edit of the song won't line up, and the app says so.
The two beats MusicMastering squeezes in before the first real beat are skipped. Switch between
**The recording** and **DAW file** at any time.

### Detect mode

Without a tab, the app can transcribe kick, snare, hi-hat and crash from the audio (best from a drum
stem), snapped to the beat grid. Weak "snares" sitting on a kick are dropped: they're kick leakage.
Toms and ride aren't detected, so treat it as a draft.

### What it measured on the sample songs

Possum Kingdom was scored against the Harmonix Expert chart. A note counts when it's within 50 ms
of a Harmonix note, and 1.0 is perfect.

| Possum Kingdom, Songsterr AI tab | Hit at the right time | Right drum | Typical timing error | Extra kicks |
|---|---|---|---|---|
| Old version of this app | 0.946 | 0.840 | 15 ms | 14 |
| drumcharts2026 | 0.964 | 0.849 | 7 ms | 8 |
| Previous version, with kick check | 0.965 | 0.851 | 7 ms | 0 |
| This version (every-beat tempo map) | 0.965 | 0.851 | 4 ms | 0 |

On Torn, the tab now starts on the right beat, where drumcharts2026 placed it 2 bars early. The kick
check flags the 49 tab kicks that have no kick in the stem (intro, breakdown and ending). The detected
beat grid matches the DAW session's tempo map: typically 2 ms off, with 95% of beats within 9 ms
(it was 6 ms and 13 ms with the old ±20 ms map). Loading the session's `.mid` or `.rpp` gives the
DAW grid itself; both files give identical beats.

Most remaining differences are in the tab itself. Songsterr's AI mixes up crash, ride and open
hi-hat, and leaves out toms. Fix these per sound in the mapping table (for example, open hi-hat →
ride for a whole song), or per note in the editor.

## Using the app

1. **Song files:** load the song audio (MP3, M4A, AAC, OGG, Opus, WAV, FLAC, AIFF, WMA or WebM),
   optionally the drum stem, the tab `.mid`, and optionally the DAW tempo map. Analysis runs in the
   background and takes a few seconds per song.
2. **Tempo map & alignment:** check the tempo map, and use ÷2 / ×2 if it's half or double. The
   tab is placed automatically. Press **Play** with *Play chart drums over the song* on to check by
   ear. Nudge by a beat or a bar if needed.
3. **Kick check:** review the flagged kicks and remove them if you agree, or select them in the
   preview to look at them first.
4. **Edit** in the preview. The waveform (the drum stem when there is one) is drawn behind the
   notes, so you can see where the hits are.
   - **Select:** click a note; Ctrl+click adds or removes one; Shift+click selects everything
     between; drag a box to select an area; **All** (Ctrl+A); or type a bar range and press
     **Select**.
   - **Cut / Copy / Paste / Delete** (Ctrl+X, Ctrl+C, Ctrl+V, Del). Paste lands at the playhead,
     snapped to the bar, beat, 1/8, 1/16, 1/8 triplet or 1/32 you choose. Pasted notes replace
     notes already in the same lane at the same moment, and pasted kicks are checked against the
     stem again.
   - **Move** the selection by 1/16 (Up/Down) or a beat (Shift+Up/Down), change its lane (keys 1–5),
     or switch yellow/blue/green between cymbal and tom (C / T).
   - **Undo / Redo** (Ctrl+Z, Ctrl+Y). The mouse wheel scrolls through the song while paused, and
     Space plays and pauses.
   - Once you've edited, changing a setting no longer rebuilds the chart behind your back: a
     **Rebuild** button appears instead (and it can be undone too).
   - The mapping table changes a sound's lane for the whole song.
5. **Export** the ZIP and unzip it into your Clone Hero `Songs` folder, or open `notes.chart` in
   Moonscraper. `song.ogg` has a 2.0 s silent lead-in that the chart accounts for.

If your browser can't decode a file (some Firefox builds and M4A), the local backend converts it
with ffmpeg first.

## Running it

Prerequisites: Node.js 18+ (22+ for the tests) and **FFmpeg** (on the PATH, or set `FFMPEG_PATH`).

```bash
npm run install-all     # install backend + frontend
npm run start-backend   # ffmpeg transcode worker on http://localhost:5000
npm run start-frontend  # the app on http://localhost:6969 (proxies /api to the backend)
npm test                # engine tests (synthetic audio, no files needed)
```

On Windows, `CLONE-HERO-CONVERTER.bat` starts both servers from the folder it's in and opens the
browser. (An older copy of the launcher pointed at `C:\clone-hero-converter`, so a shortcut could
start an old copy of the app.)

### Command line (`BUILD-CH-SONG.bat` / `frontend/convert.mjs`)

```bash
node frontend/convert.mjs --midi tab.mid --audio song.m4a --stem drums.m4a \
  --artist "Natalie Imbruglia" --song "Torn" --starpower
```

It prints the tempo map, any stretches re-tracked after a 3:2 error, where the tab was placed (with
any close calls), and the bar.beat of every flagged kick. Add `--daw session.rpp` (or `.mid` /
`.dawproject`) to use a DAW tempo map, `--drop-unsupported-kicks` to remove flagged kicks,
`--offset <beats>` to place the tab by hand, `--no-meter-fix` to keep the tracker's tempo where it
read 2/3 or 3/2 of the song's tempo, or `--detect` to chart detected drums instead of a tab. The song folder is written to your
Clone Hero `Songs` directory (`--out` to change it).

### Batch converter

In Chrome or Edge, point it at a folder of tabs and audio files. Each tab is paired with its song by
name. An audio file with "drums" in its name is used as that song's drum stem. Finished songs are
written straight into your Songs folder.

## Project layout

| Path | What |
|---|---|
| `frontend/src/engine/` | Analysis: onset envelopes, tempo curve, beat tracker, tempo map, stem matching, tab reading and alignment, drum transcription, kick check. Plain JS, runs in a Web Worker and in Node. |
| `frontend/src/chartGen.js` | Notes → `.chart` / `song.ini`: lanes, cymbal flags, time signatures, star power, tempo events. |
| `frontend/src/songBuilder.js` | One-call pipeline used by the CLI, the batch converter and the tests. |
| `frontend/src/engine/dawTempo.js`, `frontend/src/dawImport.js` | DAW tempo maps (`.mid`, `.rpp`, `.dawproject`) → beat times, and the check against the detected beats. |
| `frontend/src/editOps.js` | Editor operations: select ranges, copy, cut, paste, move, change lane. |
| `frontend/src/App.jsx` | The web app. |
| `frontend/convert.mjs` | Command-line builder. |
| `backend/server.js` | ffmpeg transcode endpoint (adds the 2 s lead-in, makes the Ogg). |
| `frontend/test/` | `npm test`. |

## Limits

- Expert only. Make the lower difficulties in Moonscraper.
- The tab must follow the recording's structure. A different intro, or an extra repeat the recording
  lacks, misplaces the notes after that point. Use the nudge buttons, or edit the tab.
- Cymbal type and toms are only as good as the tab. Nothing in the audio check changes them.
- Without a drum stem, beats come from the full mix. Check by ear, and use ÷2 / ×2 if the tempo reads
  half or double.
