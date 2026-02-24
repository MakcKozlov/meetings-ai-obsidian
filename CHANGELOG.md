# Changelog

## [2.2.0] — 2026-02-26

### Speaker Diarization
- Switched transcription model to **`gpt-4o-transcribe-diarize`** with speaker identification
- Speaker labels displayed as **Speaker 1, Speaker 2** instead of raw API labels (`speaker_0`, `A`, `B`)
- Editable speaker name pills — click to rename speakers, names persist across sessions
- Speaker names applied consistently across transcript and summary

### Custom Audio Player
- Replaced default HTML `<audio>` element with a fully custom player
- **Play/Pause** button with accent color styling
- **±10 second** skip buttons for quick navigation
- **Seekable progress bar** with thumb indicator (mouse and touch support)
- **Playback speed** control: 1x → 1.25x → 1.5x → 2x
- **Download button** — save audio files locally via browser download dialog (useful for syncing audio from iPad)
- Time display with current position and total duration

### Re-transcribe from Audio
- **Re-process button** (refresh icon in tab bar) now performs full re-transcription + re-summarization when audio file is available
- Falls back to re-summarization from existing segments when audio is missing
- Useful for re-processing old meetings recorded with Whisper through the new `gpt-4o-transcribe-diarize` model

### Multi-chunk Timestamp Fix
- Fixed a bug where audio files split into multiple chunks had timestamps resetting to 0 for each chunk
- Timestamps now correctly accumulate across chunks using chunk duration offsets
- Introduced `AudioChunk` interface with `{ file, duration }` for proper offset tracking

### Summary Footnote Preservation
- Fixed footnote badges `{1,2,3}` disappearing after switching tabs in the summary view
- Rewrote `htmlToMarkdown()` with recursive `inlineText()` helper that properly preserves footnote badge elements, bold, and italic formatting during content round-trips

### iOS Keep-Alive
- Added silent audio loop to prevent iOS from suspending the app during long recordings
- Ensures uninterrupted recording on iPad and iPhone

## [2.1.1] — 2026-02-24

### Fixed
- iOS keep-alive: prevent app suspension during recording with silent audio loop

## [2.1.0] — 2026-02-23

### Meetings Index — Home Page
- New **Meetings Index** page: a central hub listing all meeting notes grouped by date
- Home button in the widget tab bar navigates to the index
- "+" button to quickly create a new meeting from anywhere
- Index auto-updates when new meetings are created

### Unified Recording Experience
- The card **no longer switches screens** when recording starts — same layout throughout idle, recording, and paused states
- Pause, Resume, and Stop controls appear as pill-style buttons in the tab bar
- Inline recording timer displayed in the tab bar

### Real-time Audio Visualization
- **5 live mini-bars** in the tab bar that react to microphone volume in real-time
- Powered by Web Audio API (`AudioContext` + `AnalyserNode`)
- Dual measurement: frequency spectrum + RMS volume for better sensitivity
- Green accent color (#21A038) for the mini-bars
- Exposed `stream` getter on `AudioRecorder` for real-time audio access

### Delete Meeting with Confirmation
- Trash button in the tab bar (present in both idle and done states)
- **Two-click safety**: first click shows red "Delete?" pill, second click confirms
- Auto-reverts to trash icon after 3 seconds if not confirmed
- Deletes all data: summary, transcript, audio, notes, and segments
- Navigates to Meetings Index after deletion

### User Notes in Summary
- Notes written before recording now appear **at the top of the Summary tab** after transcription
- Displayed in a distinct block with "Notes" label, visually separated from the AI summary

### Microphone Selector
- New **microphone selector** in plugin settings
- Refresh button to re-enumerate audio devices
- Selected device persists across sessions

### UI/UX Improvements
- Removed border and highlight from Notes textarea in done state
- Removed white rectangle flash when clicking inline notes before recording
- Fixed textarea height jumping when recording starts (fixed at 160px)
- Increased body text size from 14px to 15px for better readability
- Tightened spacing between section headings
- Removed large canvas spectrogram in favor of compact mini-bars

## [2.0.1] — 2026-02-23

### Fixed
- iOS: Recording produced empty audio data (added timeslice to MediaRecorder)
- Mobile: Tab bar overflow on small screens (tabs now flex-fill)

### Changed
- Removed settings gear button from widget tab bar

## [2.0.0] — 2026-02-22

First major release as **Meetings Ai**. Complete redesign from the original Magic Mic fork.

### Added
- Interactive meeting widget with tabs: Summary, Notes, Transcript, Audio
- Clickable footnote badges `{1,2,3}` in summary linking to transcript segments
- Timestamped transcript via Whisper `verbose_json` with segment-level timestamps
- Task checkboxes for action items in summary
- Meeting description field per note
- Error recovery with retry button when network fails during transcription
- Persistent error state across page switches and Obsidian restarts
- Auto-archive: old meetings moved to `YYYY-MM` subfolders automatically
- Russian summarization prompt with structured output
- Settings gear button in widget for quick access
- Tab icons (SVG) for visual clarity
- iPad/iOS support via `audio/mp4` fallback

### Fixed
- Large spacing between bullet points (rewrote HTML parser)
- Visible `%%` markers in Reading mode (switched to HTML comments)
- Time format in filenames now uses dashes (`HH-mm`), filesystem-safe

### Changed
- Rebranded from Magic Mic to Meetings Ai
- Audio is saved locally before any API calls — never lost on network failure
- Widget state persisted in markdown files as hidden HTML comments

## [1.0.5] and earlier

Original [Magic Mic](https://github.com/drewmcdonald/obsidian-magic-mic) plugin by [Drew McDonald](https://github.com/drewmcdonald). Basic recording, transcription, and summarization via OpenAI Whisper + GPT.
