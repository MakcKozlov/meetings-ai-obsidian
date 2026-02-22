# Changelog

## [2.0.0] — 2025-02-22

First major release as **Meeting AI**. Complete redesign from the original Magic Mic fork.

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
- Rebranded from Magic Mic to Meeting AI
- Audio is saved locally before any API calls — never lost on network failure
- Widget state persisted in markdown files as hidden HTML comments

## [1.0.5] and earlier

Original Magic Mic plugin by Drew McDonald. Basic recording, transcription, and summarization.
