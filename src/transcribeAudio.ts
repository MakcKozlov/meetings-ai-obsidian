import OpenAI from 'openai';
import { encode, decode } from 'gpt-tokenizer';
import { FileLike } from 'openai/uploads';

export interface TranscriptSegment {
  id: number;
  start: number; // seconds
  end: number; // seconds
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
}

export interface TranscriptionOptions {
  prompt: string;
  audioFiles: FileLike[];
  onChunkStart?: (i: number, totalChunks: number) => void;
}

// https://platform.openai.com/docs/guides/speech-to-text/prompting
const WHISPER_TOKEN_LIMIT = 224;

/**
 * Transcribe an audio file with OpenAI's Whisper model.
 *
 * Uses `verbose_json` response format to get segment-level timestamps
 * for cross-referencing summary points to transcript sections.
 *
 * Handles splitting the file into chunks, processing each chunk, and
 * concatenating the results with globally unique segment IDs.
 */
export default async function transcribeAudio(
  client: OpenAI,
  { prompt, audioFiles, onChunkStart }: TranscriptionOptions,
): Promise<TranscriptionResult> {
  let fullText = '';
  let allSegments: TranscriptSegment[] = [];
  let segmentIdOffset = 0;

  for (const [i, file] of audioFiles.entries()) {
    if (onChunkStart) onChunkStart(i, audioFiles.length);

    const res = (await client.audio.transcriptions.create({
      model: 'whisper-1',
      file,
      prompt: mixBasePromptAndTranscript(prompt, fullText),
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    } as any)) as any; // SDK types don't fully cover verbose_json shape

    const chunkText = (res.text as string ?? '').trim();
    const sep = i === 0 ? '' : ' ';
    fullText += sep + chunkText;

    // Extract segments and reindex across chunks
    const rawSegments: any[] = res.segments ?? [];
    for (let j = 0; j < rawSegments.length; j++) {
      const seg = rawSegments[j];
      allSegments.push({
        id: segmentIdOffset + j,
        start: seg.start as number,
        end: seg.end as number,
        text: (seg.text as string ?? '').trim(),
      });
    }
    segmentIdOffset = allSegments.length;
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

  const promptTokens = encode(basePrompt + ' … '); // some delineation, I guess :shrug:
  const transcriptTokens = encode(transcript);
  const availableTokens = WHISPER_TOKEN_LIMIT - promptTokens.length;
  return decode(promptTokens.concat(transcriptTokens.slice(-availableTokens)));
}
