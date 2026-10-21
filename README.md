# Clone Hero Master Editor

Turns a drum tab (a Songsterr `.mid` export, any drum MIDI, or a Rock Band / Clone Hero `notes.mid`)
plus the song's audio into a Clone Hero song folder: `notes.chart` (pro drums), `song.ini` and
`song.ogg`. There is a live scrolling preview and a note editor, a batch converter, and a one-shot
command-line builder.

## How it works

The chart's timing comes from the recording, not from the tab. This is the approach of
[drumcharts2026](https://github.com/n3rdy13/drumcharts2026), ported into this app:

1. **Every beat in the recording is found.** The beat tracker follows tempo drift, sudden jumps and
   slow-downs. The beats become the chart's tempo map: one tempo event wherever the music needs one,
   never more than ±20 ms from a detected beat.
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
| This version, with kick check | 0.965 | 0.851 | 7 ms | 0 |

On Torn, the tab now starts on the right beat, where drumcharts2026 placed it 2 bars early. The kick
check flags the 49 tab kicks that have no kick in the stem (intro, breakdown and ending). The beat
grid matches the DAW session's tempo map: typically 6 ms off, with 95% of beats within 13 ms.

Most remaining differences are in the tab itself. Songsterr's AI mixes up crash, ride and open
hi-hat, and leaves out toms. Fix these per sound in the mapping table (for example, open hi-hat →
ride for a whole song), or per note in the editor.

## Using the app

1. **Song files:** load the song audio (MP3, M4A, OGG, WAV or FLAC), optionally the drum stem, and
   the tab `.mid`. Analysis runs in the background and takes a few seconds per song.
2. **Tempo map & alignment:** check the detected tempo, and use ÷2 / ×2 if it's half or double. The
   tab is placed automatically. Press **Play** with *Play chart drums over the song* on to check by
   ear. Nudge by a beat or a bar if needed.
3. **Kick check:** review the flagged kicks and remove them if you agree.
4. **Edit:** click a note in the preview to move it by 1/16, change its lane, switch cymbal ↔ tom,
   or delete it. The mapping table changes a sound's lane for the whole song.
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

On Windows, `CLONE-HERO-CONVERTER.bat` starts both servers and opens the browser.

### Command line (`BUILD-CH-SONG.bat` / `frontend/convert.mjs`)

```bash
node frontend/convert.mjs --midi tab.mid --audio song.m4a --stem drums.m4a \
  --artist "Natalie Imbruglia" --song "Torn" --starpower
```

It prints the tempo map, where the tab was placed (with any close calls), and the bar.beat of every
flagged kick. Add `--drop-unsupported-kicks` to remove them, `--offset <beats>` to place the tab by
hand, or `--detect` to chart detected drums instead of a tab. The song folder is written to your
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
