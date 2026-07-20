@echo off
REM Clone Hero one-shot song builder.
REM   * Double-click            -> asks for MIDI, MP3, artist, song, charter.
REM   * Drag a .mid and .mp3    -> onto this file, then it asks for the text fields.
REM   * Command line            -> BUILD-CH-SONG.bat --midi x.mid --mp3 x.mp3 --artist A --song S
REM
REM Builds the finished folder directly into your Clone Hero Songs directory.

pushd "%~dp0frontend"
node convert.mjs %*
set ERR=%ERRORLEVEL%
popd
echo.
pause
exit /b %ERR%
