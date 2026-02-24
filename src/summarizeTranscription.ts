import OpenAI from 'openai';
import type { TranscriptSegment } from './transcribeAudio';

export const models = [
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4o',
  'gpt-4o-mini',
] as const;
export type Model = (typeof models)[number];
export interface SummarizationOptions {
  completionModel: Model;
  completionInstructions: string;
  transcript: string;
  /** Whisper segments with IDs — when present, transcript is sent numbered */
  segments?: TranscriptSegment[];
}

export type SummarizationResult =
  | { state: 'success'; response: string }
  | { state: 'refused'; refusal: string }
  | { state: 'error'; error: Error };

/**
 * Format raw API speaker label into human-friendly form.
 * Handles: "speaker_0" → "Speaker 1", "A" → "Speaker 1", "B" → "Speaker 2"
 */
function formatSpeakerLabel(raw: string): string {
  const numMatch = raw.match(/^speaker_(\d+)$/i);
  if (numMatch) return `Speaker ${parseInt(numMatch[1], 10) + 1}`;
  const letterMatch = raw.match(/^([A-Z])$/i);
  if (letterMatch) {
    const idx = letterMatch[1].toUpperCase().charCodeAt(0) - 64;
    return `Speaker ${idx}`;
  }
  return raw;
}

export default async function summarizeTranscription(
  client: OpenAI,
  { completionModel, completionInstructions, transcript, segments }: SummarizationOptions,
): Promise<SummarizationResult> {
  // When segments are available, format transcript with [N] prefixes
  // so the model can reference segment IDs in its summary.
  // Include speaker labels when available (from diarize model).
  // Raw API labels like "speaker_0" are formatted as "Speaker 1" (1-indexed).
  let userContent: string;
  if (segments && segments.length > 0) {
    userContent = segments.map((s) => {
      const prefix = s.speaker ? `${formatSpeakerLabel(s.speaker)}: ` : '';
      return `[${s.id}] ${prefix}${s.text}`;
    }).join('\n');
  } else {
    userContent = transcript;
  }

  try {
    const response = await client.chat.completions.create({
      model: completionModel,
      messages: [
        { role: 'system', content: completionInstructions },
        { role: 'user', content: userContent },
      ],
    });
    return processResponse(response);
  } catch (error) {
    return { state: 'error', error };
  }
}

function processResponse(
  response: OpenAI.Chat.Completions.ChatCompletion,
): SummarizationResult {
  const { message } = response.choices[0];
  return message.content
    ? { state: 'success', response: message.content }
    : {
        state: 'refused',
        refusal: message.refusal ?? 'no refusal reason',
      };
}
