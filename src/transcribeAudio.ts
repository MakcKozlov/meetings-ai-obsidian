import OpenAI from 'openai';
import { encode, decode } from 'gpt-tokenizer';
import type { AudioChunk } from './utils/audioDataToChunkedFiles';

export type TranscriptionModel = 'whisper-1' | 'gpt-4o-transcribe-diarize';

export interface TranscriptSegment {
  id: number;
  start: number; // seconds
  end: number; // seconds
  text: string;
  speaker?: string; // e.g. "speaker_0", "speaker_1" — only from diarize model
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
}

export interface TranscriptionOptions {
  model: TranscriptionModel;
  prompt: string;
  audioChunks: AudioChunk[];
  onChunkStart?: (i: number, totalChunks: number) => void;
}

// https://platform.openai.com/docs/guides/speech-to-text/prompting
const WHISPER_TOKEN_LIMIT = 224;

/**
 * Transcribe audio files using OpenAI speech-to-text models.
 *
 * Supports two models:
 * - `whisper-1`: classic Whisper with verbose_json segments
 * - `gpt-4o-transcribe-diarize`: newer model with speaker diarization
 *
 * Handles splitting the file into chunks, processing each chunk, and
 * concatenating the results with globally unique segment IDs.
 */
export default async function transcribeAudio(
  client: OpenAI,
  { model, prompt, audioChunks, onChunkStart }: TranscriptionOptions,
): Promise<TranscriptionResult> {
  if (model === 'gpt-4o-transcribe-diarize') {
    return transcribeDiarize(client, { audioChunks, onChunkStart });
  }
  return transcribeWhisper(client, { prompt, audioChunks, onChunkStart });
}

// ─── gpt-4o-transcribe-diarize ───

async function transcribeDiarize(
  client: OpenAI,
  { audioChunks, onChunkStart }: Pick<TranscriptionOptions, 'audioChunks' | 'onChunkStart'>,
): Promise<TranscriptionResult> {
  let allSegments: TranscriptSegment[] = [];
  let segmentIdOffset = 0;
  /** Cumulative time offset — sum of durations of all previous chunks */
  let timeOffset = 0;

  for (const [i, chunk] of audioChunks.entries()) {
    if (onChunkStart) onChunkStart(i, audioChunks.length);

    const res = (await client.audio.transcriptions.create({
      model: 'gpt-4o-transcribe-diarize',
      file: chunk.file,
      response_format: 'diarized_json',
      chunking_strategy: 'auto',
    } as any)) as any;

    // diarized_json returns { segments: [{ speaker, text, start, end }] }
    const rawSegments: any[] = res.segments ?? [];
    for (let j = 0; j < rawSegments.length; j++) {
      const seg = rawSegments[j];
      allSegments.push({
        id: segmentIdOffset + j,
        start: (seg.start as number) + timeOffset,
        end: (seg.end as number) + timeOffset,
        text: (seg.text as string ?? '').trim(),
        speaker: seg.speaker as string | undefined,
      });
    }
    segmentIdOffset = allSegments.length;
    timeOffset += chunk.duration;
  }

  // Build full text from segments
  const fullText = allSegments.map((s) => s.text).join(' ');

  return { text: fullText, segments: allSegments };
}

// ─── whisper-1 (legacy) ───

async function transcribeWhisper(
  client: OpenAI,
  { prompt, audioChunks, onChunkStart }: Pick<TranscriptionOptions, 'prompt' | 'audioChunks' | 'onChunkStart'>,
): Promise<TranscriptionResult> {
  let fullText = '';
  let allSegments: TranscriptSegment[] = [];
  let segmentIdOffset = 0;
  /** Cumulative time offset — sum of durations of all previous chunks */
  let timeOffset = 0;

  for (const [i, chunk] of audioChunks.entries()) {
    if (onChunkStart) onChunkStart(i, audioChunks.length);

    const res = (await client.audio.transcriptions.create({
      model: 'whisper-1',
      file: chunk.file,
      prompt: mixBasePromptAndTranscript(prompt, fullText),
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    } as any)) as any;

    const chunkText = (res.text as string ?? '').trim();
    const sep = i === 0 ? '' : ' ';
    fullText += sep + chunkText;

    const rawSegments: any[] = res.segments ?? [];
    for (let j = 0; j < rawSegments.length; j++) {
      const seg = rawSegments[j];
      allSegments.push({
        id: segmentIdOffset + j,
        start: (seg.start as number) + timeOffset,
        end: (seg.end as number) + timeOffset,
        text: (seg.text as string ?? '').trim(),
      });
    }
    segmentIdOffset = allSegments.length;
    timeOffset += chunk.duration;
  }

  return { text: fullText, segments: allSegments };
}

/**
 * Returns the base prompt concatenated with up to (224 - promptLength) tokens of
 * context from the transcription thus far.
 */
function mixBasePromptAndTranscript(
  basePrompt: string,
  transcript: string,
): string {
  if (transcript.length === 0) return basePrompt;

  const promptTokens = encode(basePrompt + ' … ');
  const transcriptTokens = encode(transcript);
  const availableTokens = WHISPER_TOKEN_LIMIT - promptTokens.length;
  return decode(promptTokens.concat(transcriptTokens.slice(-availableTokens)));
}
