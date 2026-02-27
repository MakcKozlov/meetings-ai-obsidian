import { toFile } from 'openai';
import { FileLike } from 'openai/uploads';

export interface AudioChunk {
  file: FileLike;
  /** Duration of this chunk in seconds */
  duration: number;
}

/**
 * Given an input file, converts it to mono, splits that mono audio into chunks
 * of a maximum size, and re-encodes the chunks as WAV files.
 * Returns both the files and their durations (needed for timestamp correction
 * when API responses have per-chunk timestamps starting from 0).
 *
 * Fast path: if the raw audioData already fits within maxSize (e.g. a compressed
 * WebM/Opus file), it is sent directly as a single chunk — no decoding or
 * re-encoding needed.
 */
export default async function audioDataToChunkedFiles(
  audioData: ArrayBuffer,
  maxSize: number,
  fileExtension: string = 'wav',
): Promise<AudioChunk[]> {
  // Fast path: compressed audio already fits within the API limit
  if (audioData.byteLength <= maxSize) {
    const file = await toFile(audioData, fileName(0, fileExtension));
    return [{ file, duration: 0 }];
  }

  // Slow path: decode, convert to mono, split into WAV chunks
  const audioContext = new window.AudioContext();
  const sourceBuffer = await audioContext.decodeAudioData(audioData);
  const monoBuffer = audioBufferToMono(audioContext, sourceBuffer);

  // Calculate chunk size in samples: WAV output is 16-bit PCM (2 bytes/sample)
  // with a 44-byte header per chunk
  const chunkSamples = Math.floor((maxSize - 44) / 2);
  const nChunks = Math.ceil(monoBuffer.length / chunkSamples);

  const chunks: AudioChunk[] = [];

  for (let i = 0; i < nChunks; i++) {
    const startSample = i * chunkSamples;
    const endSample = Math.min((i + 1) * chunkSamples, monoBuffer.length);

    // Create a new empty AudioBuffer for each chunk
    const chunkBuffer = audioContext.createBuffer(
      1,
      endSample - startSample,
      monoBuffer.sampleRate,
    );

    const chunkData = chunkBuffer.getChannelData(0);
    const originalData = monoBuffer.getChannelData(0);
    chunkData.set(originalData.slice(startSample, endSample));

    // Convert the chunk to a WAV ArrayBuffer
    const wavArrayBuffer = audioBufferToWav(chunkBuffer);
    const file = await toFile(wavArrayBuffer, fileName(i, 'wav'));

    chunks.push({
      file,
      duration: chunkBuffer.duration,
    });
  }

  return chunks;
}

/**
 * Converts a multi-channel AudioBuffer to mono by averaging all channels.
 */
function audioBufferToMono(
  audioContext: AudioContext,
  audioBuffer: AudioBuffer,
) {
  const numberOfChannels = audioBuffer.numberOfChannels;
  if (numberOfChannels === 1) return audioBuffer;

  const length = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;
  const monoBuffer = audioContext.createBuffer(1, length, sampleRate);

  const monoData = monoBuffer.getChannelData(0);
  // Average all channels
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let channel = 0; channel < numberOfChannels; channel++) {
      sum += audioBuffer.getChannelData(channel)[i];
    }
    monoData[i] = sum / numberOfChannels;
  }

  return monoBuffer;
}

// Look, I'm not gonna pretend ChatGPT didn't write this
export function audioBufferToWav(buffer: AudioBuffer) {
  const numOfChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length * numOfChannels * 2; // 16-bit PCM data
  const wavBuffer = new ArrayBuffer(44 + length);
  const view = new DataView(wavBuffer);

  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* file length */
  view.setUint32(4, 36 + length, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk identifier */
  writeString(view, 12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw) */
  view.setUint16(20, 1, true);
  /* channel count */
  view.setUint16(22, numOfChannels, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * numOfChannels * 2, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, numOfChannels * 2, true);
  /* bits per sample */
  view.setUint16(34, 16, true);
  /* data chunk identifier */
  writeString(view, 36, 'data');
  /* data chunk length */
  view.setUint32(40, length, true);

  // Write interleaved PCM samples
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < numOfChannels; channel++) {
      const sample = buffer.getChannelData(channel)[i] * 0x7fff; // Convert to 16-bit PCM
      view.setInt16(offset, sample < 0 ? sample : sample, true);
      offset += 2;
    }
  }

  return wavBuffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function fileName(i: number, extension: string): string {
  return `audio_${i.toString().padStart(3, '0')}.${extension}`;
}
