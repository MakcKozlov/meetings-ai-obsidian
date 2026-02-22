# Meeting AI

Obsidian plugin that records, transcribes, and summarizes meetings directly inside your vault. One click to start recording, one click to get a structured summary with action items.

## How it works

1. Click the microphone icon or run the command to create a meeting note
2. Press **Start** to record
3. Press **Stop** when done — the plugin sends audio to OpenAI Whisper, gets a transcript with timestamps, then generates a structured summary

Everything stays in your vault: the audio file, transcript, and summary are saved as part of the note.

## Features

**Interactive widget** — a self-contained meeting panel embedded in your note with tabs for Summary, Notes, Transcript, and Audio.

**Structured summaries** — the AI outputs key points, decisions, and action items. Action items render as checkboxes you can tick off.

**Footnote references** — each summary point has clickable badges like `{1,2,3}` that jump to the exact transcript segments it was based on.

**Timestamped transcript** — Whisper returns segments with start/end times so you can see when each part of the conversation happened.

**Error recovery** — if the network drops, the audio is already saved locally. A retry button lets you re-send for transcription when you're back online. This state persists even if you switch pages or restart Obsidian.

**Meeting description** — add a short description to each meeting for context.

**Auto-archive** — meetings from previous months are automatically moved into `YYYY-MM` subfolders.

**Works on iPad/iOS** — recording uses `audio/mp4` fallback for Safari compatibility.

## Setup

1. Install the plugin
2. Go to Settings > Meeting AI
3. Add your [OpenAI API key](https://platform.openai.com/api-keys)
4. (Optional) Configure output folder, audio folder, summary prompt, and assistants

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| OpenAI API Key | Required for transcription and summarization | — |
| Save audio | Keep audio files in your vault | `true` |
| Link audio | Embed audio link in the note | `true` |
| Output folder | Where meeting notes are created | Obsidian default |
| Audio folder | Where audio files are saved | Same as output |
| Date format | Format for note titles | `DD.MM.YY` |
| Transcription hint | Words/names to help Whisper spell correctly | — |
| Summary model | OpenAI model for summarization | `gpt-4o` |
| Assistants | Custom prompt profiles for different meeting types | 1 default |

## Credits

This project is a fork of [Magic Mic](https://github.com/drewmcdonald/obsidian-magic-mic) by [Drew McDonald](https://github.com/drewmcdonald), which provided the original recording and transcription foundation.

## License

MIT
