import { moment } from 'obsidian';

import {
  mimeTypeToFileExtension,
  pickMimeType,
  SupportedMimeType,
} from './utils/mimeType';
import { must } from './utils/must';
import Timer from './utils/Timer';

export interface RecorderOptions {
  bitRate?: number;
  preferredMimeType?: SupportedMimeType;
}

export default class AudioRecorder {
  /** The time at which recording originally began */
  startedAt: moment.Moment | null = null;
  timer: Timer = new Timer();

  private mimeType: SupportedMimeType;
  private bitRate: number;

  private mediaRecorder: MediaRecorder | null = null;
  private data: BlobPart[] = [];
  private _stream: MediaStream | null = null;

  /** Silent audio keep-alive to prevent iOS from suspending audio capture */
  private keepAliveCtx: AudioContext | null = null;
  private keepAliveOsc: OscillatorNode | null = null;
  private wakeLock: any = null;
  private _interrupted = false;

  /** Expose the active MediaStream for real-time audio analysis (AnalyserNode) */
  get stream(): MediaStream | null {
    return this._stream;
  }

  /** True if iOS/system killed the recording while the screen was locked */
  get wasInterrupted(): boolean {
    return this._interrupted;
  }

  constructor(opts: RecorderOptions = {}) {
    this.mimeType = pickMimeType(
      opts.preferredMimeType ?? 'audio/webm; codecs=opus',
    );
    this.bitRate = opts.bitRate ?? 32000;
  }

  get fileExtension() {
    return mimeTypeToFileExtension(this.mimeType);
  }

  get state(): RecordingState {
    return this.mediaRecorder?.state ?? 'inactive';
  }

  get elapsedSeconds() {
    return this.timer.elapsedSeconds;
  }

  private setupMediaRecorder(stream: MediaStream) {
    const rec = new MediaRecorder(stream, {
      mimeType: this.mimeType,
      audioBitsPerSecond: this.bitRate,
    });
    rec.ondataavailable = (e) => this.data.push(e.data);
    rec.onerror = (e) => console.error('Error recording audio:', e);
    rec.onpause = () => this.timer.pause();
    rec.onresume = () => this.timer.start();
    rec.onstart = () => {
      this.timer = new Timer();
      this.timer.start();
    };

    return rec;
  }

  // ─── iOS keep-alive: silent audio + wake lock ───

  private startKeepAlive(): void {
    try {
      this.keepAliveCtx = new AudioContext();
      const osc = this.keepAliveCtx.createOscillator();
      const gain = this.keepAliveCtx.createGain();
      osc.frequency.value = 20000; // inaudible
      gain.gain.value = 0;         // silent
      osc.connect(gain);
      gain.connect(this.keepAliveCtx.destination);
      osc.start();
      this.keepAliveOsc = osc;

      if (this.keepAliveCtx.state === 'suspended') {
        this.keepAliveCtx.resume();
      }
    } catch (e) {
      console.warn('Meetings Ai: keep-alive start failed', e);
    }

    this.requestWakeLock();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private stopKeepAlive(): void {
    document.removeEventListener('visibilitychange', this.onVisibilityChange);

    if (this.keepAliveOsc) {
      try { this.keepAliveOsc.stop(); } catch { /* already stopped */ }
      this.keepAliveOsc = null;
    }
    if (this.keepAliveCtx && this.keepAliveCtx.state !== 'closed') {
      try { this.keepAliveCtx.close(); } catch { /* ignore */ }
    }
    this.keepAliveCtx = null;

    this.releaseWakeLock();
  }

  private async requestWakeLock(): Promise<void> {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await (navigator as any).wakeLock.request('screen');
      }
    } catch { /* not supported or denied */ }
  }

  private releaseWakeLock(): void {
    if (this.wakeLock) {
      try { this.wakeLock.release(); } catch { /* ignore */ }
      this.wakeLock = null;
    }
  }

  private onVisibilityChange = (): void => {
    if (!document.hidden) {
      // User returned — check if recording survived
      if (this.mediaRecorder && this.mediaRecorder.state === 'inactive') {
        this._interrupted = true;
      }
      // Re-request wake lock (released on visibility change)
      this.requestWakeLock();
      // Resume keep-alive AudioContext if suspended
      if (this.keepAliveCtx?.state === 'suspended') {
        this.keepAliveCtx.resume();
      }
    }
  };

  async start(deviceId?: string): Promise<void> {
    if (this.startedAt === null) {
      this.startedAt = moment().local();
    }
    this._interrupted = false;
    try {
      let stream: MediaStream;
      if (deviceId) {
        try {
          // Try exact constraint first (reliable on Desktop/Electron)
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: deviceId } },
          });
        } catch {
          // Fallback: preferred deviceId without exact (works on iOS/mobile)
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: deviceId },
          });
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      this._stream = stream;
      this.mediaRecorder = this.setupMediaRecorder(stream);
      this.mediaRecorder.start(1000); // collect data every 1s to avoid empty recordings on iOS
      this.startKeepAlive();
    } catch (err) {
      console.error('Error accessing microphone:', err);
      throw err;
    }
  }

  pause() {
    if (!this.mediaRecorder || this.mediaRecorder.state !== 'recording') {
      console.error('Cannot pause: not currently recording');
      return;
    }
    this.mediaRecorder.pause();
  }

  resume() {
    if (!this.mediaRecorder || this.mediaRecorder.state !== 'paused') {
      console.error('Cannot resume: not currently paused');
      return;
    }
    this.mediaRecorder.resume();
  }

  stop() {
    this.stopKeepAlive();

    return new Promise<Blob>((resolve, reject) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        throw new Error('Cannot stop: not currently recording');
      }

      this.mediaRecorder.onstop = () => {
        this.timer.pause();

        must(this.mediaRecorder)
          .stream.getTracks()
          .forEach((track) => track.stop()); // stop the stream tracks

        const blob = new Blob(this.data, { type: this.mimeType });

        this.data = []; // reset the data
        this.mediaRecorder = null; // reset the recorder
        this._stream = null;

        if (blob.size === 0) {
          reject(new Error('Recording produced empty audio data. Please try again.'));
          return;
        }

        resolve(blob);
      };

      this.mediaRecorder.stop();
    });
  }
}
