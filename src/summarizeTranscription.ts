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

export default async function summarizeTranscription(
  client: OpenAI,
  { completionModel, completionInstructions, transcript, segments }: SummarizationOptions,
): Promise<SummarizationResult> {
  // When segments are available, format transcript with [N] prefixes
  // so the model can reference segment IDs in its summary
  let userContent: string;
  if (segments && segments.length > 0) {
    userContent = segments.map((s) => `[${s.id}] ${s.text}`).join('\n');
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
