import {
  MarkdownRenderChild,
  MarkdownPostProcessorContext,
  Notice,
  debounce,
  TFile,
} from 'obsidian';
import type MeetingAIPlugin from './Plugin';
import type { TranscriptSegment } from './transcribeAudio';

export type WidgetState =
  | { status: 'idle' }
  | { status: 'recording'; elapsed: number }
  | { status: 'paused'; elapsed: number }
  | { status: 'processing'; message: string }
  | { status: 'done'; summary: string; transcript: string }
  | { status: 'error'; message: string; audioFilePath: string | null };

interface ResultEntry {
  summary: string;
  transcript: string;
  segments: TranscriptSegment[];
  audioFilePath: string | null;
}

export default class MeetingWidget extends MarkdownRenderChild {
  /** Static cache: survives widget re-creation on tab switch / re-render */
  private static resultCache = new Map<string, ResultEntry[]>();
  private static notesCache = new Map<string, string>();
  private static descriptionCache = new Map<string, string>();
  private static errorCache = new Map<string, { message: string; audioFilePath: string | null }>();
  private static speakerMapCache = new Map<string, Record<string, string>>();

  private plugin: MeetingAIPlugin;
  private ctx: MarkdownPostProcessorContext;
  private state: WidgetState = { status: 'idle' };
  private timerInterval: NodeJS.Timeout | null = null;
  private wrapperEl: HTMLElement;
  private selectedAssistant: string;
  private activeTab: 'summary' | 'notes' | 'transcript' | 'audio' = 'summary';
  /** Accumulated results from multiple recordings */
  private results: ResultEntry[] = [];
  /** Web Audio analyser for real-time spectrogram */
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserSource: MediaStreamAudioSourceNode | null = null;
  private spectrogramAnimId: number | null = null;
  /** User notes content (persisted to note file) */
  private notesContent: string = '';
  /** Meeting description (persisted to note file) */
  private meetingDescription: string = '';
  /** Pending segment to scroll to after tab switch */
  private pendingScrollToSegment: number | null = null;
  /** Speaker name mapping: e.g. { "speaker_0": "Наташа", "speaker_1": "Алена" } */
  private speakerMap: Record<string, string> = {};
  /** Debounced save for speaker map */
  private saveSpeakerMapDebounced = debounce(
    () => this.saveSpeakerMapToFile(),
    500,
    true,
  );
  /** Debounced save for notes */
  private saveNotesDebounced = debounce(
    () => this.saveNotesToFile(),
    1000,
    true,
  );
  /** Debounced save for description */
  private saveDescriptionDebounced = debounce(
    () => this.saveDescriptionToFile(),
    1000,
    true,
  );

  constructor(
    containerEl: HTMLElement,
    plugin: MeetingAIPlugin,
    ctx: MarkdownPostProcessorContext,
    source?: string,
  ) {
    super(containerEl);
    this.plugin = plugin;
    this.ctx = ctx;
    this.wrapperEl = containerEl.createDiv({ cls: 'meeting-ai-widget' });

    // Parse assistant name from code block source (e.g. "assistant: Default")
    const sourceAssistant = source
      ?.split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('assistant:'))
      ?.replace('assistant:', '')
      .trim();
    this.selectedAssistant =
      sourceAssistant || (plugin.settings.assistants[0]?.name ?? 'Default');

    // Prevent Live Preview from switching to source mode on click
    this.wrapperEl.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    // Hide the edit button
    containerEl.classList.add('meeting-ai-block');

    this.render();
  }

  onunload() {
    this.stopTimerInterval();
    this.stopSpectrogram();
  }

  onload() {
    // Restore from static cache first (instant, no async)
    const cachedResults = MeetingWidget.resultCache.get(this.ctx.sourcePath);
    const cachedNotes = MeetingWidget.notesCache.get(this.ctx.sourcePath);
    const cachedDesc = MeetingWidget.descriptionCache.get(this.ctx.sourcePath);
    const cachedError = MeetingWidget.errorCache.get(this.ctx.sourcePath);
    const cachedSpeakers = MeetingWidget.speakerMapCache.get(this.ctx.sourcePath);

    if (cachedResults && cachedResults.length > 0) {
      this.results = cachedResults;
      if (cachedNotes) this.notesContent = cachedNotes;
      if (cachedDesc) this.meetingDescription = cachedDesc;
      if (cachedSpeakers) this.speakerMap = cachedSpeakers;
      const last = this.results[this.results.length - 1];
      this.state = {
        status: 'done',
        summary: last.summary,
        transcript: last.transcript,
      };
      this.render();
    } else if (cachedError) {
      // Restore error state (e.g. transcription failed, user switched pages)
      if (cachedNotes) this.notesContent = cachedNotes;
      if (cachedDesc) this.meetingDescription = cachedDesc;
      this.state = {
        status: 'error',
        message: cachedError.message,
        audioFilePath: cachedError.audioFilePath,
      };
      this.render();
    }
    // Also load from file (in case cache is empty, e.g. fresh Obsidian start)
    this.loadDataFromFile();
  }

  // ─── Persistence markers ───
  // Data is stored in the .md file inside HTML comments so it's
  // completely hidden in Reading mode but accessible via source.
  private static readonly NOTES_START = '<!--meeting-ai-notes';
  private static readonly NOTES_END = 'meeting-ai-notes-end-->';
  private static readonly SUMMARY_START = '<!--meeting-ai-summary';
  private static readonly SUMMARY_END = 'meeting-ai-summary-end-->';
  private static readonly TRANSCRIPT_START = '<!--meeting-ai-transcript';
  private static readonly TRANSCRIPT_END = 'meeting-ai-transcript-end-->';
  private static readonly AUDIO_START = '<!--meeting-ai-audio';
  private static readonly AUDIO_END = 'meeting-ai-audio-end-->';
  private static readonly SEGMENTS_START = '<!--meeting-ai-segments';
  private static readonly SEGMENTS_END = 'meeting-ai-segments-end-->';
  private static readonly DESC_START = '<!--meeting-ai-description';
  private static readonly DESC_END = 'meeting-ai-description-end-->';
  private static readonly ERROR_START = '<!--meeting-ai-error';
  private static readonly ERROR_END = 'meeting-ai-error-end-->';
  private static readonly SPEAKERS_START = '<!--meeting-ai-speakers';
  private static readonly SPEAKERS_END = 'meeting-ai-speakers-end-->';

  /**
   * Resolve the TFile for this widget's note.
   */
  private getNoteFile(): TFile | null {
    const path = this.ctx.sourcePath;
    const f = this.plugin.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) return f;
    return this.plugin.app.workspace.getActiveFile();
  }

  /**
   * Extract content between markers in file content.
   */
  private static extractBetween(content: string, startMarker: string, endMarker: string): string | null {
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
    return content.substring(startIdx + startMarker.length + 1, endIdx).trimEnd();
  }

  /**
   * Replace or append a block between markers in file content.
   */
  private static replaceBlock(content: string, startMarker: string, endMarker: string, newContent: string): string {
    const block = `${startMarker}\n${newContent}\n${endMarker}`;
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.indexOf(endMarker);

    if (startIdx !== -1 && endIdx !== -1) {
      return (
        content.substring(0, startIdx) +
        block +
        content.substring(endIdx + endMarker.length)
      );
    }
    return content + `\n${block}\n`;
  }

  // ─── Load persisted data from file ───

  private async loadDataFromFile() {
    const file = this.getNoteFile();
    if (!file) return;
    const content = await this.plugin.app.vault.read(file);

    // Load notes
    const notes = MeetingWidget.extractBetween(content, MeetingWidget.NOTES_START, MeetingWidget.NOTES_END);
    if (notes !== null) {
      this.notesContent = notes;
    }

    // Load description
    const desc = MeetingWidget.extractBetween(content, MeetingWidget.DESC_START, MeetingWidget.DESC_END);
    if (desc !== null) {
      this.meetingDescription = desc;
    }

    // Load summary
    const summary = MeetingWidget.extractBetween(content, MeetingWidget.SUMMARY_START, MeetingWidget.SUMMARY_END);

    // Load transcript
    const transcript = MeetingWidget.extractBetween(content, MeetingWidget.TRANSCRIPT_START, MeetingWidget.TRANSCRIPT_END);

    // Load audio paths
    const audioPaths = MeetingWidget.extractBetween(content, MeetingWidget.AUDIO_START, MeetingWidget.AUDIO_END);

    // Load segments
    const segmentsRaw = MeetingWidget.extractBetween(content, MeetingWidget.SEGMENTS_START, MeetingWidget.SEGMENTS_END);
    let segments: TranscriptSegment[] = [];
    if (segmentsRaw) {
      try { segments = JSON.parse(segmentsRaw); } catch { /* backward compat */ }
    }

    // Load speaker map
    const speakersRaw = MeetingWidget.extractBetween(content, MeetingWidget.SPEAKERS_START, MeetingWidget.SPEAKERS_END);
    if (speakersRaw) {
      try {
        this.speakerMap = JSON.parse(speakersRaw);
        MeetingWidget.speakerMapCache.set(this.ctx.sourcePath, { ...this.speakerMap });
      } catch { /* ignore corrupt data */ }
    }

    // If we have summary or transcript, restore the result
    if (summary !== null || transcript !== null) {
      const audioFilePath = audioPaths?.trim() || null;
      this.results = [{
        summary: summary ?? '',
        transcript: transcript ?? '',
        segments,
        audioFilePath,
      }];
      // Update static cache
      MeetingWidget.resultCache.set(this.ctx.sourcePath, [...this.results]);
      MeetingWidget.notesCache.set(this.ctx.sourcePath, this.notesContent);
      MeetingWidget.descriptionCache.set(this.ctx.sourcePath, this.meetingDescription);
      // Clear any stale error since we have results
      MeetingWidget.errorCache.delete(this.ctx.sourcePath);
      const last = this.results[this.results.length - 1];
      this.state = {
        status: 'done',
        summary: last.summary,
        transcript: last.transcript,
      };
      this.render();
      return; // don't check for error state if we have results
    }

    // Load persisted error state (transcription failed, audio saved)
    const errorRaw = MeetingWidget.extractBetween(content, MeetingWidget.ERROR_START, MeetingWidget.ERROR_END);
    if (errorRaw) {
      try {
        const errorData = JSON.parse(errorRaw) as { message: string; audioFilePath: string | null };
        MeetingWidget.errorCache.set(this.ctx.sourcePath, errorData);
        this.state = {
          status: 'error',
          message: errorData.message,
          audioFilePath: errorData.audioFilePath,
        };
        this.render();
      } catch {
        // corrupted error data, ignore
      }
    }
  }

  // ─── Save all data to file ───

  private async saveResultsToFile() {
    const file = this.getNoteFile();
    if (!file) return;
    let content = await this.plugin.app.vault.read(file);

    // Combine all summaries
    const allSummaries = this.results.map((r) => r.summary).join('\n\n---\n\n');
    content = MeetingWidget.replaceBlock(content, MeetingWidget.SUMMARY_START, MeetingWidget.SUMMARY_END, allSummaries);

    // Combine all transcripts
    const allTranscripts = this.results.map((r) => r.transcript).join('\n\n---\n\n');
    content = MeetingWidget.replaceBlock(content, MeetingWidget.TRANSCRIPT_START, MeetingWidget.TRANSCRIPT_END, allTranscripts);

    // Save audio file paths
    const audioPaths = this.results
      .filter((r) => r.audioFilePath)
      .map((r) => r.audioFilePath!)
      .join('\n');
    if (audioPaths) {
      content = MeetingWidget.replaceBlock(content, MeetingWidget.AUDIO_START, MeetingWidget.AUDIO_END, audioPaths);
    }

    // Save segments as JSON
    const allSegments = this.results.flatMap((r) => r.segments ?? []);
    if (allSegments.length > 0) {
      content = MeetingWidget.replaceBlock(
        content,
        MeetingWidget.SEGMENTS_START,
        MeetingWidget.SEGMENTS_END,
        JSON.stringify(allSegments),
      );
    }

    await this.plugin.app.vault.modify(file, content);
  }

  private async saveNotesToFile() {
    MeetingWidget.notesCache.set(this.ctx.sourcePath, this.notesContent);
    const file = this.getNoteFile();
    if (!file) return;
    let content = await this.plugin.app.vault.read(file);
    content = MeetingWidget.replaceBlock(content, MeetingWidget.NOTES_START, MeetingWidget.NOTES_END, this.notesContent);
    await this.plugin.app.vault.modify(file, content);
  }

  private async saveDescriptionToFile() {
    MeetingWidget.descriptionCache.set(this.ctx.sourcePath, this.meetingDescription);
    const file = this.getNoteFile();
    if (!file) return;
    let content = await this.plugin.app.vault.read(file);
    content = MeetingWidget.replaceBlock(content, MeetingWidget.DESC_START, MeetingWidget.DESC_END, this.meetingDescription);
    await this.plugin.app.vault.modify(file, content);
  }

  private async saveSpeakerMapToFile() {
    MeetingWidget.speakerMapCache.set(this.ctx.sourcePath, { ...this.speakerMap });
    const file = this.getNoteFile();
    if (!file) return;
    try {
      let content = await this.plugin.app.vault.read(file);
      content = MeetingWidget.replaceBlock(
        content,
        MeetingWidget.SPEAKERS_START,
        MeetingWidget.SPEAKERS_END,
        JSON.stringify(this.speakerMap),
      );
      await this.plugin.app.vault.modify(file, content);
    } catch (e) {
      console.warn('Meetings Ai: failed to save speaker map', e);
    }
  }

  private async saveErrorToFile(message: string, audioFilePath: string | null) {
    const file = this.getNoteFile();
    if (!file) return;
    try {
      let content = await this.plugin.app.vault.read(file);
      const errorData = JSON.stringify({ message, audioFilePath });
      content = MeetingWidget.replaceBlock(content, MeetingWidget.ERROR_START, MeetingWidget.ERROR_END, errorData);
      await this.plugin.app.vault.modify(file, content);
    } catch (e) {
      console.warn('Meetings Ai: failed to save error state', e);
    }
  }

  private async clearErrorFromFile() {
    const file = this.getNoteFile();
    if (!file) return;
    try {
      const content = await this.plugin.app.vault.read(file);
      if (content.indexOf(MeetingWidget.ERROR_START) === -1) return;
      const startIdx = content.indexOf(MeetingWidget.ERROR_START);
      const endIdx = content.indexOf(MeetingWidget.ERROR_END);
      if (startIdx !== -1 && endIdx !== -1) {
        let before = content.substring(0, startIdx);
        let after = content.substring(endIdx + MeetingWidget.ERROR_END.length);
        if (before.endsWith('\n')) before = before.slice(0, -1);
        if (after.startsWith('\n')) after = after.slice(1);
        await this.plugin.app.vault.modify(file, before + after);
      }
    } catch (e) {
      console.warn('Meetings Ai: failed to clear error state', e);
    }
  }

  setState(newState: WidgetState) {
    this.state = newState;
    // Persist error state so it survives page switches
    if (newState.status === 'error') {
      MeetingWidget.errorCache.set(this.ctx.sourcePath, {
        message: newState.message,
        audioFilePath: newState.audioFilePath,
      });
      this.saveErrorToFile(newState.message, newState.audioFilePath);
    } else if (newState.status === 'done' || newState.status === 'idle') {
      // Clear persisted error when we recover or go to idle via new recording
      MeetingWidget.errorCache.delete(this.ctx.sourcePath);
      this.clearErrorFromFile();
    }
    this.render();
  }

  getState(): WidgetState {
    return this.state;
  }

  /** Called by onStopClick after processing completes */
  async addResult(
    summary: string,
    transcript: string,
    segments: TranscriptSegment[],
    audioFilePath: string | null,
  ) {
    this.results.push({ summary, transcript, segments, audioFilePath });
    this.state = { status: 'done', summary, transcript };
    this.activeTab = 'summary';
    // Update static cache immediately (survives widget re-creation)
    MeetingWidget.resultCache.set(this.ctx.sourcePath, [...this.results]);
    MeetingWidget.notesCache.set(this.ctx.sourcePath, this.notesContent);
    MeetingWidget.descriptionCache.set(this.ctx.sourcePath, this.meetingDescription);
    this.render();
    // Persist results as markdown to the .md file
    try {
      await this.saveResultsToFile();
    } catch (e) {
      console.error('Meetings Ai: failed to save results to file', e);
    }
  }

  updateElapsed(seconds: number) {
    if (
      this.state.status === 'recording' ||
      this.state.status === 'paused'
    ) {
      this.state = { ...this.state, elapsed: seconds };
      // Update timer text inline — no re-render needed
      const timerEl = this.wrapperEl.querySelector('.mm-rec-timer');
      if (timerEl) timerEl.textContent = this.formatTime(seconds);
    }
  }

  setProcessingMessage(message: string) {
    if (this.state.status === 'processing') {
      this.state = { status: 'processing', message };
      const msgEl = this.wrapperEl.querySelector('.mm-processing-text');
      if (msgEl) msgEl.textContent = message;
    }
  }

  private formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  private formatTimestamp(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  private render() {
    // Stop spectrogram animation (will be re-created if needed)
    if (this.spectrogramAnimId !== null) {
      cancelAnimationFrame(this.spectrogramAnimId);
      this.spectrogramAnimId = null;
    }
    this.wrapperEl.empty();
    this.wrapperEl.removeClass(
      'mm-state-idle',
      'mm-state-recording',
      'mm-state-paused',
      'mm-state-processing',
      'mm-state-done',
      'mm-state-error',
    );
    this.wrapperEl.addClass(`mm-state-${this.state.status}`);

    switch (this.state.status) {
      case 'idle':
      case 'recording':
      case 'paused':
        this.renderIdle();
        break;
      case 'processing':
        this.renderProcessing();
        break;
      case 'done':
        this.renderDone();
        break;
      case 'error':
        this.renderError();
        break;
    }
  }

  // ─── Idle / Recording / Paused state (unified card) ───

  private renderIdle() {
    const isRecording = this.state.status === 'recording';
    const isPaused = this.state.status === 'paused';
    const isActive = isRecording || isPaused;

    const container = this.wrapperEl.createDiv({ cls: 'mm-idle-container' });
    const card = container.createDiv({ cls: 'mm-card' });

    if (this.results.length > 0 && !isActive) {
      // Has previous results and not recording — show full tabs with Record button
      this.renderTabs(card, true);
    } else {
      // Tab-like bar with controls
      const tabRow = card.createDiv({ cls: 'mm-tab-row' });
      const tabBar = tabRow.createDiv({ cls: 'mm-tab-bar' });

      if (isActive) {
        // ── Recording/Paused controls ──
        if (isRecording) {
          // Pause button
          const pauseBtn = tabBar.createEl('button', { cls: 'mm-tab mm-tab-rec-ctrl' });
          pauseBtn.createSpan({ cls: 'mm-tab-icon' }).innerHTML = this.pauseSvg();
          pauseBtn.createSpan({ text: 'Pause', cls: 'mm-tab-label' });
          pauseBtn.addEventListener('click', () => this.onPauseClick());
        } else {
          // Resume button
          const resumeBtn = tabBar.createEl('button', { cls: 'mm-tab mm-tab-start' });
          resumeBtn.createSpan({ cls: 'mm-tab-icon' }).innerHTML = this.playSvg();
          resumeBtn.createSpan({ text: 'Resume', cls: 'mm-tab-label' });
          resumeBtn.addEventListener('click', () => this.onResumeClick());
        }

        // Stop button
        const stopBtn = tabBar.createEl('button', { cls: 'mm-tab mm-tab-stop' });
        stopBtn.createSpan({ cls: 'mm-tab-icon' }).innerHTML = this.stopSvg();
        stopBtn.createSpan({ text: 'Stop', cls: 'mm-tab-label' });
        stopBtn.addEventListener('click', () => this.onStopClick());

        // Timer
        const elapsed = (this.state as any).elapsed ?? 0;
        tabBar.createSpan({
          text: this.formatTime(elapsed),
          cls: 'mm-rec-timer',
        });

        // Mini live bars (5 bars that react to mic volume in real-time)
        const miniBars = tabBar.createDiv({ cls: 'mm-mini-bars' });
        for (let i = 0; i < 5; i++) {
          miniBars.createDiv({ cls: 'mm-mini-bar' });
        }
      } else {
        // ── Idle: Start recording pill ──
        const startBtn = tabBar.createEl('button', { cls: 'mm-tab mm-tab-start' });
        startBtn.createSpan({ cls: 'mm-tab-icon' }).innerHTML = this.micSvg();
        startBtn.createSpan({ text: 'Start recording', cls: 'mm-tab-label' });
        startBtn.addEventListener('click', () => this.onStartClick());

        // Delete button (trash) — next to start recording
        this.renderTrashButton(tabBar);

        // Assistant selector (if more than one)
        if (this.plugin.settings.assistants.length > 1) {
          const select = tabBar.createEl('select', {
            cls: 'mm-assistant-select dropdown',
          });
          for (const assistant of this.plugin.settings.assistants) {
            const opt = select.createEl('option', {
              text: assistant.name,
              value: assistant.name,
            });
            if (assistant.name === this.selectedAssistant) {
              opt.selected = true;
            }
          }
          select.addEventListener('change', () => {
            this.selectedAssistant = select.value;
          });
        }
      }

      // Right-side buttons: home + new meeting
      const rightBtns = tabRow.createDiv({ cls: 'mm-tab-right-btns' });

      const homeBtn = rightBtns.createEl('button', { cls: 'mm-tab-settings-btn' });
      homeBtn.createSpan({ cls: 'mm-tab-icon' }).innerHTML = this.homeSvg();
      homeBtn.setAttribute('aria-label', 'All meetings');
      homeBtn.addEventListener('click', () => {
        this.plugin.openMeetingsIndex();
      });

      const newBtn = rightBtns.createEl('button', { cls: 'mm-tab-settings-btn' });
      newBtn.createSpan({ cls: 'mm-tab-icon' }).innerHTML = this.plusSvg();
      newBtn.setAttribute('aria-label', 'New meeting');
      newBtn.addEventListener('click', () => {
        this.plugin.createMeetingNote();
      });
    }

    // Start mini-bars analyser (no canvas, only mini-bars)
    if (isActive) {
      requestAnimationFrame(() => this.startMiniBarsAnalyser());
    }

    // Notes textarea — borderless Notion-style
    this.renderInlineNotes(card, 8);
  }

  // ─── Inline notes (shared by idle, recording, paused) ───

  private renderInlineNotes(container: HTMLElement, rows = 3) {
    const textarea = container.createEl('textarea', {
      cls: 'mm-inline-notes',
      attr: {
        placeholder: 'Write your notes here...',
        rows: String(rows),
      },
    });
    textarea.value = this.notesContent;
    textarea.addEventListener('input', () => {
      this.notesContent = textarea.value;
      this.saveNotesDebounced();
      // Auto-grow
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    });
  }

  // ─── Processing state ───

  private renderProcessing() {
    const container = this.wrapperEl.createDiv({
      cls: 'mm-processing-container',
    });

    const spinnerRow = container.createDiv({ cls: 'mm-spinner-row' });
    spinnerRow.createDiv({ cls: 'mm-spinner' });
    spinnerRow.createSpan({
      text: (this.state as { message: string }).message,
      cls: 'mm-processing-text',
    });
  }

  // ─── Error state — audio saved but transcription failed ───

  private renderError() {
    const errorState = this.state as { status: 'error'; message: string; audioFilePath: string | null };
    const container = this.wrapperEl.createDiv({ cls: 'mm-error-container' });

    // Error icon + message
    const errorRow = container.createDiv({ cls: 'mm-error-row' });
    const errorIcon = errorRow.createSpan({ cls: 'mm-error-icon' });
    errorIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`;
    errorRow.createSpan({
      text: errorState.message,
      cls: 'mm-error-text',
    });

    // Info about saved audio
    if (errorState.audioFilePath) {
      container.createDiv({
        text: `Аудио сохранено: ${errorState.audioFilePath}`,
        cls: 'mm-error-audio-info',
      });
    }

    // Retry button
    const btnRow = container.createDiv({ cls: 'mm-btn-row' });
    if (errorState.audioFilePath) {
      const retryBtn = btnRow.createEl('button', {
        cls: 'mm-btn mm-btn-retry',
      });
      const retryIcon = retryBtn.createSpan({ cls: 'mm-icon' });
      retryIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>`;
      retryBtn.createSpan({ text: 'Повторить расшифровку', cls: 'mm-btn-label' });
      retryBtn.addEventListener('click', () => this.onRetryClick(errorState.audioFilePath!));
    }

    // Dismiss / start new recording
    const newBtn = btnRow.createEl('button', { cls: 'mm-btn' });
    const micIcon = newBtn.createSpan({ cls: 'mm-icon mm-icon-mic' });
    micIcon.innerHTML = this.micSvg();
    newBtn.createSpan({ text: 'Новая запись', cls: 'mm-btn-label' });
    newBtn.addEventListener('click', () => this.onStartClick());
  }

  // ─── Done state — card with tabs ───

  private renderDone() {
    const container = this.wrapperEl.createDiv({ cls: 'mm-done-container' });

    // Card wrapper — no title, no record button
    const card = container.createDiv({ cls: 'mm-card' });
    this.renderTabs(card);
  }

  private renderTabs(container: HTMLElement, showStartRecording = false) {
    const hasAudio = this.results.some((r) => r.audioFilePath);

    // Tab bar — pill style
    const tabRow = container.createDiv({ cls: 'mm-tab-row' });
    const tabBar = tabRow.createDiv({ cls: 'mm-tab-bar' });

    const tabsLeft: { id: typeof this.activeTab; label: string; icon: string }[] = [
      { id: 'summary', label: 'Summary', icon: this.summarySvg() },
      { id: 'notes', label: 'Notes', icon: this.notesSvg() },
      { id: 'transcript', label: 'Transcript', icon: this.transcriptSvg() },
    ];

    for (const tab of tabsLeft) {
      const tabEl = tabBar.createEl('button', {
        cls: `mm-tab ${this.activeTab === tab.id ? 'mm-tab-active' : ''}`,
      });
      const iconSpan = tabEl.createSpan({ cls: 'mm-tab-icon' });
      iconSpan.innerHTML = tab.icon;
      if (tab.label) tabEl.createSpan({ text: tab.label, cls: 'mm-tab-label' });
      tabEl.addEventListener('click', () => {
        this.activeTab = tab.id;
        this.render();
      });
    }

    // Icon-only buttons: Audio, Re-process, Trash
    if (hasAudio) {
      const audioBtn = tabBar.createEl('button', {
        cls: `mm-tab-settings-btn ${this.activeTab === 'audio' ? 'mm-tab-icon-active' : ''}`,
      });
      audioBtn.createSpan({ cls: 'mm-tab-icon' }).innerHTML = this.audioSvg();
      audioBtn.setAttribute('aria-label', 'Audio');
      audioBtn.addEventListener('click', () => {
        this.activeTab = 'audio';
        this.render();
      });
    }

    // Re-process pill — re-transcribe from audio (if available) or re-summarize from segments
    const hasSegments = this.results.some((r) => (r.segments ?? []).length > 0);
    const hasAudioFile = this.results.some((r) => r.audioFilePath);
    if (hasSegments || hasAudioFile) {
      const reBtn = tabBar.createEl('button', { cls: 'mm-tab-settings-btn mm-tab-resummary' });
      reBtn.createSpan({ cls: 'mm-tab-icon' }).innerHTML = this.refreshSvg();
      reBtn.setAttribute('aria-label', hasAudioFile ? 'Re-transcribe & summarize' : 'Re-summarize');
      reBtn.addEventListener('click', () => this.onResummarizeClick());
    }

    // Delete button (trash) — in tab bar, after tabs
    this.renderTrashButton(tabBar);

    // Right-side buttons
    const rightBtns = tabRow.createDiv({ cls: 'mm-tab-right-btns' });

    // Start Recording pill (when in idle with results)
    if (showStartRecording) {
      const startBtn = rightBtns.createEl('button', { cls: 'mm-tab mm-tab-start' });
      const micIcon = startBtn.createSpan({ cls: 'mm-tab-icon' });
      micIcon.innerHTML = this.micSvg();
      startBtn.createSpan({ text: 'Record', cls: 'mm-tab-label' });
      startBtn.addEventListener('click', () => this.onStartClick());
    }

    // Home button — go to meetings index
    const homeBtn = rightBtns.createEl('button', { cls: 'mm-tab-settings-btn' });
    homeBtn.createSpan({ cls: 'mm-tab-icon' }).innerHTML = this.homeSvg();
    homeBtn.setAttribute('aria-label', 'All meetings');
    homeBtn.addEventListener('click', () => {
      this.plugin.openMeetingsIndex();
    });

    // New meeting button (+)
    const newBtn = rightBtns.createEl('button', { cls: 'mm-tab-settings-btn' });
    newBtn.createSpan({ cls: 'mm-tab-icon' }).innerHTML = this.plusSvg();
    newBtn.setAttribute('aria-label', 'New meeting');
    newBtn.addEventListener('click', () => {
      this.plugin.createMeetingNote();
    });

    // Tab content
    const tabContent = container.createDiv({ cls: 'mm-tab-content' });

    let allSummaries = this.results.map((r) => r.summary).join('\n\n---\n\n');

    // Apply speaker name replacements to summary text
    allSummaries = this.applySpeakerNames(allSummaries);

    switch (this.activeTab) {
      case 'summary': {
        const summaryPanel = tabContent.createDiv({ cls: 'mm-tab-panel mm-summary-panel' });

        // User notes block — shown above AI summary if notes exist
        if (this.notesContent.trim()) {
          const notesBlock = summaryPanel.createDiv({ cls: 'mm-user-notes-block' });
          notesBlock.createDiv({ text: 'Notes', cls: 'mm-user-notes-label' });
          const notesText = notesBlock.createDiv({ cls: 'mm-user-notes-text' });
          notesText.innerHTML = this.notesContent
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
        }

        // Editable summary — contenteditable div with rendered HTML
        const editableDiv = summaryPanel.createDiv({
          cls: 'mm-summary-editable',
          attr: { contenteditable: 'true' },
        });
        editableDiv.innerHTML = this.markdownToHtml(allSummaries);

        // Footnote click handler — switch to transcript and scroll
        editableDiv.addEventListener('click', (e) => {
          const badge = (e.target as HTMLElement).closest('.mm-footnote-badge');
          if (!badge) return;
          e.preventDefault();
          const segId = badge.getAttribute('data-segment-id');
          if (!segId) return;
          this.activeTab = 'transcript';
          this.pendingScrollToSegment = parseInt(segId, 10);
          this.render();
        });

        // Auto-save on blur
        editableDiv.addEventListener('blur', async () => {
          // Convert edited HTML back to plain text for storage
          const editedText = this.htmlToMarkdown(editableDiv);
          if (this.results.length > 0 && editedText !== allSummaries) {
            this.results[this.results.length - 1].summary = editedText;
            MeetingWidget.resultCache.set(this.ctx.sourcePath, [...this.results]);
            await this.saveResultsToFile();
          }
        });

        break;
      }
      case 'notes': {
        const notesPanel = tabContent.createDiv({
          cls: 'mm-tab-panel mm-notes-panel',
        });
        const textarea = notesPanel.createEl('textarea', {
          cls: 'mm-notes-textarea',
          attr: {
            placeholder: 'Write your notes here...',
            rows: '8',
          },
        });
        textarea.value = this.notesContent;
        textarea.addEventListener('input', () => {
          this.notesContent = textarea.value;
          this.saveNotesDebounced();
        });
        setTimeout(() => textarea.focus(), 50);
        break;
      }
      case 'transcript': {
        const transcriptPanel = tabContent.createDiv({
          cls: 'mm-tab-panel mm-transcript-panel',
        });
        this.renderTranscriptPanel(transcriptPanel);

        // Scroll to pending segment
        if (this.pendingScrollToSegment !== null) {
          const targetId = this.pendingScrollToSegment;
          this.pendingScrollToSegment = null;
          requestAnimationFrame(() => {
            const target = transcriptPanel.querySelector(
              `[data-segment-id="${targetId}"]`,
            );
            if (target) {
              target.classList.add('mm-segment-highlight');
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              setTimeout(() => target.classList.remove('mm-segment-highlight'), 2500);
            }
          });
        }
        break;
      }
      case 'audio':
        this.renderAudioTab(tabContent);
        break;
    }
  }

  /**
   * Format raw API speaker label into human-friendly form.
   * Handles multiple formats returned by gpt-4o-transcribe-diarize:
   *   "speaker_0" → "Speaker 1"  (numeric, 0-indexed)
   *   "A" → "Speaker 1", "B" → "Speaker 2"  (single uppercase letter)
   *   "@" or other → kept as-is
   */
  private static formatSpeakerLabel(raw: string): string {
    // speaker_N format (0-indexed)
    const numMatch = raw.match(/^speaker_(\d+)$/i);
    if (numMatch) return `Speaker ${parseInt(numMatch[1], 10) + 1}`;
    // Single letter A-Z format
    const letterMatch = raw.match(/^([A-Z])$/i);
    if (letterMatch) {
      const idx = letterMatch[1].toUpperCase().charCodeAt(0) - 64; // A=1, B=2, ...
      return `Speaker ${idx}`;
    }
    return raw;
  }

  /** Get display name for a speaker (uses speakerMap or formatted label) */
  private getSpeakerDisplayName(speaker: string): string {
    return this.speakerMap[speaker] || MeetingWidget.formatSpeakerLabel(speaker);
  }

  /** Replace speaker references in text with display names from speakerMap */
  private applySpeakerNames(text: string): string {
    for (const [key, name] of Object.entries(this.speakerMap)) {
      if (!name) continue;
      // Always replace the formatted label e.g. "Speaker 1" → "Наташа"
      const formatted = MeetingWidget.formatSpeakerLabel(key);
      const fmtEscaped = formatted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(fmtEscaped, 'gi'), name);
      // Also replace raw API label, but only if it's safe (not a single letter
      // which would match random text). "speaker_0" is safe, "A" is not.
      if (formatted !== key && key.length > 1) {
        const rawEscaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(rawEscaped, 'gi'), name);
      }
    }
    return text;
  }

  /** Render transcript panel: speaker pills + grouped segments */
  private renderTranscriptPanel(panel: HTMLElement): void {
    const allSegments = this.results.flatMap((r) => r.segments ?? []);

    if (allSegments.length === 0) {
      // Fallback for legacy results without segments
      const allTranscripts = this.results
        .map((r) => r.transcript)
        .join('\n\n---\n\n');
      panel.innerHTML = this.markdownToHtml(allTranscripts);
      return;
    }

    // Check if we have speaker data
    const hasSpeakers = allSegments.some((s) => s.speaker);

    // Speaker rename pills (only if diarized)
    if (hasSpeakers) {
      const uniqueSpeakers = [...new Set(allSegments.map((s) => s.speaker).filter(Boolean) as string[])];
      const pillsRow = panel.createDiv({ cls: 'mm-speaker-pills' });
      for (const spk of uniqueSpeakers) {
        this.renderSpeakerPill(pillsRow, spk, panel);
      }
    }

    // Render segments — grouped by speaker if available
    const segContainer = panel.createDiv({ cls: 'mm-segments-container' });

    if (hasSpeakers) {
      // Group consecutive segments by same speaker
      let currentSpeaker: string | null = null;
      let groupEl: HTMLElement | null = null;

      for (const seg of allSegments) {
        const speaker = seg.speaker || 'unknown';
        if (speaker !== currentSpeaker) {
          currentSpeaker = speaker;
          groupEl = segContainer.createDiv({ cls: 'mm-speaker-group' });
          groupEl.createDiv({
            text: this.getSpeakerDisplayName(speaker),
            cls: 'mm-speaker-label',
          });
        }
        this.renderSegmentDiv(groupEl!, seg);
      }
    } else {
      // No speakers — flat list (legacy)
      for (const seg of allSegments) {
        this.renderSegmentDiv(segContainer, seg);
      }
    }
  }

  /** Render a single segment div */
  private renderSegmentDiv(container: HTMLElement, seg: TranscriptSegment): void {
    const segDiv = container.createDiv({ cls: 'mm-segment' });
    segDiv.setAttribute('data-segment-id', String(seg.id));
    segDiv.createSpan({
      text: this.formatTimestamp(seg.start),
      cls: 'mm-segment-time',
    });
    segDiv.createSpan({
      text: seg.text,
      cls: 'mm-segment-text',
    });
  }

  /** Render a clickable speaker pill with inline rename */
  private renderSpeakerPill(container: HTMLElement, speaker: string, transcriptPanel: HTMLElement): void {
    const pill = container.createDiv({ cls: 'mm-speaker-pill' });
    const nameSpan = pill.createSpan({ text: this.getSpeakerDisplayName(speaker) });

    pill.addEventListener('click', () => {
      // Already editing — ignore
      if (pill.querySelector('input')) return;

      const input = document.createElement('input');
      input.type = 'text';
      input.value = this.getSpeakerDisplayName(speaker);
      input.className = 'mm-speaker-pill-input';
      input.size = Math.max(8, input.value.length + 2);

      nameSpan.replaceWith(input);
      input.focus();
      input.select();

      const commit = () => {
        const newName = input.value.trim();
        const defaultLabel = MeetingWidget.formatSpeakerLabel(speaker);
        if (newName && newName !== speaker && newName !== defaultLabel) {
          this.speakerMap[speaker] = newName;
        } else if (!newName || newName === speaker || newName === defaultLabel) {
          delete this.speakerMap[speaker];
        }
        this.saveSpeakerMapDebounced();

        // Re-create the name span
        const newSpan = document.createElement('span');
        newSpan.textContent = this.getSpeakerDisplayName(speaker);
        input.replaceWith(newSpan);

        // Update all speaker labels in transcript
        const labels = transcriptPanel.querySelectorAll('.mm-speaker-label');
        labels.forEach((label) => {
          // Check if this label matches the speaker
          const parentGroup = label.parentElement;
          if (!parentGroup) return;
          const firstSeg = parentGroup.querySelector('.mm-segment');
          if (!firstSeg) return;
          // Find the speaker for the first segment in this group
          const segId = firstSeg.getAttribute('data-segment-id');
          if (segId === null) return;
          const allSegs = this.results.flatMap((r) => r.segments ?? []);
          const seg = allSegs.find((s) => s.id === parseInt(segId, 10));
          if (seg?.speaker === speaker) {
            label.textContent = this.getSpeakerDisplayName(speaker);
          }
        });
      };

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = this.getSpeakerDisplayName(speaker); input.blur(); }
      });
    });
  }

  private renderAudioTab(tabContent: HTMLElement) {
    const panel = tabContent.createDiv({ cls: 'mm-tab-panel mm-audio-panel' });

    const audioResults = this.results.filter((r) => r.audioFilePath);
    if (audioResults.length === 0) {
      panel.createEl('p', {
        text: 'No audio recordings.',
        cls: 'mm-audio-empty',
      });
      return;
    }

    for (const [index, result] of audioResults.entries()) {
      const filePath = result.audioFilePath!;
      const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
      if (!file || !(file instanceof TFile)) continue;

      const item = panel.createDiv({ cls: 'mm-audio-item' });

      if (audioResults.length > 1) {
        item.createEl('div', {
          text: `Recording ${index + 1}`,
          cls: 'mm-audio-label',
        });
      }

      this.renderCustomPlayer(item, file);
    }
  }

  private renderCustomPlayer(container: HTMLElement, file: TFile) {
    const player = container.createDiv({ cls: 'mm-player' });
    const audio = new Audio();
    audio.src = this.plugin.app.vault.getResourcePath(file);
    audio.preload = 'metadata';

    const speeds = [1, 1.25, 1.5, 2];
    let speedIdx = 0;

    const fmt = (sec: number) => {
      if (!isFinite(sec) || isNaN(sec) || sec < 0) return '–:––';
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
      return `${m}:${s.toString().padStart(2, '0')}`;
    };

    // WebM files recorded by MediaRecorder often lack duration metadata.
    // We resolve the real duration by seeking to a huge time, reading
    // the clamped value, then seeking back.
    const resolveDuration = () => {
      if (isFinite(audio.duration) && audio.duration > 0) return;
      const onTimeUpdate = () => {
        if (audio.currentTime > 0) {
          audio.removeEventListener('timeupdate', onTimeUpdate);
          const realDuration = audio.currentTime;
          audio.currentTime = 0;
          // Store resolved duration for fmt
          (audio as any).__resolvedDuration = realDuration;
          timeEl.textContent = `0:00 / ${fmt(realDuration)}`;
        }
      };
      audio.addEventListener('timeupdate', onTimeUpdate);
      audio.currentTime = 1e10; // seek to near-end; browser clamps to real duration
    };

    const getDuration = () => {
      const d = audio.duration;
      if (isFinite(d) && d > 0) return d;
      return (audio as any).__resolvedDuration ?? 0;
    };

    // ─── Progress bar (on top) ───
    const progressWrap = player.createDiv({ cls: 'mm-player-progress' });
    const progressFill = progressWrap.createDiv({ cls: 'mm-player-progress-fill' });
    const progressThumb = progressWrap.createDiv({ cls: 'mm-player-progress-thumb' });

    let dragging = false;

    const seekTo = (e: MouseEvent | TouchEvent) => {
      const rect = progressWrap.getBoundingClientRect();
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const dur = getDuration();
      if (dur > 0) audio.currentTime = pct * dur;
    };

    progressWrap.addEventListener('mousedown', (e) => { dragging = true; seekTo(e); });
    progressWrap.addEventListener('touchstart', (e) => { dragging = true; seekTo(e); }, { passive: true });
    document.addEventListener('mousemove', (e) => { if (dragging) seekTo(e); });
    document.addEventListener('touchmove', (e) => { if (dragging) seekTo(e as any); }, { passive: true });
    document.addEventListener('mouseup', () => { dragging = false; });
    document.addEventListener('touchend', () => { dragging = false; });

    // ─── Controls row ───
    const controls = player.createDiv({ cls: 'mm-player-controls' });

    // Play / pause
    const playBtn = controls.createEl('button', { cls: 'mm-player-btn mm-player-play' });
    playBtn.innerHTML = this.playerPlaySvg();
    playBtn.addEventListener('click', () => {
      if (audio.paused) { audio.play(); } else { audio.pause(); }
    });

    // Rewind 10s
    const rwBtn = controls.createEl('button', { cls: 'mm-player-btn mm-player-skip' });
    rwBtn.innerHTML = this.rewindSvg();
    rwBtn.addEventListener('click', () => {
      audio.currentTime = Math.max(0, audio.currentTime - 10);
    });

    // Forward 10s
    const fwBtn = controls.createEl('button', { cls: 'mm-player-btn mm-player-skip' });
    fwBtn.innerHTML = this.forwardSvg();
    fwBtn.addEventListener('click', () => {
      const dur = getDuration();
      if (dur > 0) audio.currentTime = Math.min(dur, audio.currentTime + 10);
    });

    // Time display
    const timeEl = controls.createEl('span', { cls: 'mm-player-time', text: '0:00 / –:––' });

    // Spacer
    controls.createDiv({ cls: 'mm-player-spacer' });

    // Speed button
    const speedBtn = controls.createEl('button', { cls: 'mm-player-btn mm-player-speed', text: '1x' });
    speedBtn.addEventListener('click', () => {
      speedIdx = (speedIdx + 1) % speeds.length;
      audio.playbackRate = speeds[speedIdx];
      speedBtn.textContent = `${speeds[speedIdx]}x`;
    });

    // Download button
    const dlBtn = controls.createEl('button', { cls: 'mm-player-btn mm-player-dl' });
    dlBtn.innerHTML = this.downloadSvg();
    dlBtn.setAttribute('aria-label', 'Download audio');
    dlBtn.addEventListener('click', async () => {
      const data = await this.plugin.app.vault.readBinary(file);
      const blob = new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      new Notice(`Downloaded ${file.name}`);
    });

    // ─── Events ───
    audio.addEventListener('play', () => { playBtn.innerHTML = this.playerPauseSvg(); });
    audio.addEventListener('pause', () => { playBtn.innerHTML = this.playerPlaySvg(); });
    audio.addEventListener('ended', () => { playBtn.innerHTML = this.playerPlaySvg(); });

    audio.addEventListener('timeupdate', () => {
      const dur = getDuration();
      const cur = audio.currentTime || 0;
      const pct = dur > 0 ? (cur / dur) * 100 : 0;
      progressFill.style.width = `${pct}%`;
      progressThumb.style.left = `${pct}%`;
      timeEl.textContent = `${fmt(cur)} / ${fmt(dur)}`;
    });

    audio.addEventListener('loadedmetadata', () => {
      if (isFinite(audio.duration) && audio.duration > 0) {
        timeEl.textContent = `0:00 / ${fmt(audio.duration)}`;
      } else {
        // WebM without duration header — resolve it
        resolveDuration();
      }
    });

    audio.addEventListener('error', () => {
      timeEl.textContent = 'Audio not available';
      timeEl.addClass('mm-player-time-error');
      playBtn.disabled = true;
      rwBtn.disabled = true;
      fwBtn.disabled = true;
    });
  }

  // ─── Player SVG icons ───

  private playerPlaySvg(): string {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>';
  }

  private playerPauseSvg(): string {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg>';
  }

  private rewindSvg(): string {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h5"/><path d="M4 9a8 8 0 1 1 1.3 4.7"/></svg>';
  }

  private forwardSvg(): string {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4v5h-5"/><path d="M20 9a8 8 0 1 0-1.3 4.7"/></svg>';
  }

  private downloadSvg(): string {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  }

  /** Simple markdown -> HTML with footnote badge support */
  private markdownToHtml(md: string): string {
    if (!md) return '<p style="color:var(--text-muted)">No content yet.</p>';

    const escape = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const lines = md.split('\n');
    const html: string[] = [];
    let inList = false;
    let inTaskSection = false;

    for (const raw of lines) {
      const line = escape(raw);

      // Apply inline formatting
      let fmt = line
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>');

      // Replace {1,2,3} segment references with clickable badges
      fmt = fmt.replace(
        /\{(\d+(?:,\s*\d+)*)\}/g,
        (_match, segIds: string) => {
          const ids = segIds.split(',').map((s: string) => s.trim());
          return '<span class="mm-footnote-group">' +
            ids.map((id: string) =>
              `<span class="mm-footnote-badge" data-segment-id="${id}">${id}</span>`,
            ).join('') +
            '</span>';
        },
      );

      // Track if we're in the tasks section
      const h2Match = fmt.match(/^##\s+(.+)$/);
      if (h2Match) {
        inTaskSection = /задач/i.test(h2Match[1]);
      }

      // Bullet list item (- or •)
      const bulletMatch = fmt.match(/^[-•]\s+(.+)$/);
      if (bulletMatch) {
        if (!inList) { html.push('<ul>'); inList = true; }
        const content = bulletMatch[1];

        // Render as checkbox if in task section
        if (inTaskSection) {
          html.push(
            `<li class="mm-task-item">` +
            `<input type="checkbox" class="mm-task-checkbox" />` +
            `<span class="mm-task-text">${content}</span></li>`,
          );
        } else {
          html.push(`<li>${content}</li>`);
        }
        continue;
      }

      // Close list if we were in one
      if (inList) { html.push('</ul>'); inList = false; }

      // Empty line — skip (no extra spacing)
      if (fmt.trim() === '') continue;

      // Headings
      const h3 = fmt.match(/^###\s+(.+)$/);
      if (h3) { html.push(`<h3>${h3[1]}</h3>`); continue; }
      if (h2Match) { html.push(`<h2>${h2Match[1]}</h2>`); continue; }
      const h1 = fmt.match(/^#\s+(.+)$/);
      if (h1) { html.push(`<h1>${h1[1]}</h1>`); continue; }

      // Horizontal rule
      if (/^---+$/.test(fmt.trim())) { html.push('<hr>'); continue; }

      // Regular paragraph
      html.push(`<p>${fmt}</p>`);
    }

    if (inList) html.push('</ul>');
    return html.join('');
  }

  /** Convert contenteditable HTML back to markdown for storage */
  private htmlToMarkdown(el: HTMLElement): string {
    const lines: string[] = [];

    /**
     * Extract inline text from a node, preserving footnote badges as {id,id}
     * and bold/italic formatting.
     */
    const inlineText = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent ?? '';
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const elem = node as HTMLElement;

      // Footnote group → {id,id}
      if (elem.classList.contains('mm-footnote-group')) {
        const ids = Array.from(elem.querySelectorAll('.mm-footnote-badge'))
          .map((b) => b.getAttribute('data-segment-id') ?? b.textContent)
          .filter(Boolean);
        return `{${ids.join(',')}}`;
      }
      // Single footnote badge (not inside a group)
      if (elem.classList.contains('mm-footnote-badge')) {
        const id = elem.getAttribute('data-segment-id') ?? elem.textContent;
        return `{${id}}`;
      }

      // Bold
      if (elem.tagName === 'STRONG' || elem.tagName === 'B') {
        const inner = Array.from(elem.childNodes).map(inlineText).join('');
        return `**${inner}**`;
      }
      // Italic
      if (elem.tagName === 'EM' || elem.tagName === 'I') {
        const inner = Array.from(elem.childNodes).map(inlineText).join('');
        return `*${inner}*`;
      }

      // Default: recurse into children
      return Array.from(elem.childNodes).map(inlineText).join('');
    };

    const processNode = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? '';
        if (text.trim()) lines.push(text.trim());
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const elem = node as HTMLElement;
      const tag = elem.tagName.toLowerCase();

      switch (tag) {
        case 'h1':
          lines.push(`# ${inlineText(elem).trim()}`);
          break;
        case 'h2':
          lines.push(`## ${inlineText(elem).trim()}`);
          break;
        case 'h3':
          lines.push(`### ${inlineText(elem).trim()}`);
          break;
        case 'hr':
          lines.push('---');
          break;
        case 'ul':
          for (const li of Array.from(elem.children)) {
            const taskText = li.querySelector('.mm-task-text');
            if (taskText) {
              lines.push(`- ${inlineText(taskText).trim()}`);
            } else {
              lines.push(`- ${inlineText(li).trim()}`);
            }
          }
          break;
        case 'p':
          lines.push(inlineText(elem).trim());
          break;
        default:
          // Recurse into children for divs, spans, etc.
          for (const child of Array.from(elem.childNodes)) {
            processNode(child);
          }
          break;
      }
    };

    for (const child of Array.from(el.childNodes)) {
      processNode(child);
    }

    return lines.join('\n');
  }

  // ─── Event handlers ───

  private async onStartClick() {
    try {
      // Pre-create AudioContext in user gesture context (required on iOS)
      if (!this.audioContext || this.audioContext.state === 'closed') {
        this.audioContext = new AudioContext();
      }
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      // Start recording FIRST so stream is available when render() calls startSpectrogram()
      await this.plugin.startMeetingRecording(this.selectedAssistant);
      this.setState({ status: 'recording', elapsed: 0 });
      this.startTimerInterval();
    } catch (e: any) {
      console.error('Failed to start recording:', e);
      new Notice(`Meetings Ai: ${e?.message ?? e}`);
      if (this.results.length > 0) {
        const last = this.results[this.results.length - 1];
        this.state = {
          status: 'done',
          summary: last.summary,
          transcript: last.transcript,
        };
        this.render();
      } else {
        this.setState({ status: 'idle' });
      }
    }
  }

  private onPauseClick() {
    this.plugin.pauseMeetingRecording();
    this.stopTimerInterval();
    this.setState({
      status: 'paused',
      elapsed: this.plugin.audioRecorderPublic.elapsedSeconds,
    });
  }

  private onResumeClick() {
    this.plugin.resumeMeetingRecording();
    this.setState({
      status: 'recording',
      elapsed: this.plugin.audioRecorderPublic.elapsedSeconds,
    });
    this.startTimerInterval();
  }

  private async onStopClick() {
    try {
      this.stopTimerInterval();
      this.stopSpectrogram();
      this.setState({ status: 'processing', message: 'Transcribing audio...' });

      const result = await this.plugin.stopMeetingRecording();

      if (!result) {
        this.setState({ status: 'idle' });
        return;
      }

      if (result.ok) {
        await this.addResult(
          result.summary,
          result.transcript,
          result.segments,
          result.audioFilePath,
        );
      } else {
        // Transcription/summarization failed but audio is saved
        new Notice(`Meetings Ai: ${result.error}`);
        this.setState({
          status: 'error',
          message: result.error,
          audioFilePath: result.audioFilePath,
        });
      }
    } catch (e: any) {
      console.error('Failed to stop recording:', e);
      new Notice(`Meetings Ai: ${e?.message ?? e}`, 30000);
      this.setState({
        status: 'error',
        message: e?.message ?? String(e),
        audioFilePath: null,
      });
    }
  }

  /** Re-process: full re-transcription from audio if available, otherwise re-summarize from segments */
  private async onResummarizeClick() {
    // Check if we have an audio file to re-transcribe from
    const audioFilePath = this.results.find((r) => r.audioFilePath)?.audioFilePath;

    if (audioFilePath) {
      // Full re-transcription + re-summarization from audio
      const file = this.plugin.app.vault.getAbstractFileByPath(audioFilePath);
      if (file && file instanceof TFile) {
        await this.onRetryClick(audioFilePath);
        return;
      }
      // Audio path exists but file is missing — fall through to segment-only re-summarize
      new Notice('Meetings Ai: audio file not found, re-summarizing from transcript only');
    }

    // Fallback: re-summarize from existing segments
    const allSegments = this.results.flatMap((r) => r.segments ?? []);
    if (allSegments.length === 0) {
      new Notice('Meetings Ai: no transcript segments to re-summarize');
      return;
    }

    // Save current state so we can restore on error
    const prevState = this.state;
    try {
      this.setState({ status: 'processing', message: 'Re-summarizing...' });

      const fullText = allSegments.map((s) => s.text).join(' ');
      const assistantName = this.selectedAssistant;

      const summaryResult = await this.plugin.summarizeTranscript({
        transcript: fullText,
        segments: allSegments,
        assistantName,
      });

      const summaryText =
        summaryResult.state === 'success'
          ? summaryResult.response
          : summaryResult.state === 'refused'
            ? `Summary refused: ${summaryResult.refusal}`
            : `Summary error: ${summaryResult.error}`;

      // Update the last result's summary
      if (this.results.length > 0) {
        this.results[this.results.length - 1].summary = summaryText;
        MeetingWidget.resultCache.set(this.ctx.sourcePath, [...this.results]);
        this.state = {
          status: 'done',
          summary: summaryText,
          transcript: this.results[this.results.length - 1].transcript,
        };
        this.activeTab = 'summary';
        this.render();
        await this.saveResultsToFile();
      }
    } catch (e: any) {
      console.error('Meetings Ai: re-summarize failed', e);
      new Notice(`Meetings Ai: ${e?.message ?? e}`);
      // Restore previous state
      this.state = prevState;
      this.render();
    }
  }

  private async onRetryClick(audioFilePath: string) {
    try {
      this.setState({ status: 'processing', message: 'Повторная расшифровка...' });

      const result = await this.plugin.retryFromAudioFile(audioFilePath, this.selectedAssistant);

      if (result.ok) {
        await this.addResult(
          result.summary,
          result.transcript,
          result.segments,
          result.audioFilePath,
        );
      } else {
        new Notice(`Meetings Ai: ${result.error}`);
        this.setState({
          status: 'error',
          message: result.error,
          audioFilePath,
        });
      }
    } catch (e: any) {
      console.error('Meetings Ai: retry failed', e);
      new Notice(`Meetings Ai: ${e?.message ?? e}`);
      this.setState({
        status: 'error',
        message: e?.message ?? String(e),
        audioFilePath,
      });
    }
  }

  // ─── Live Spectrogram (Web Audio API) ───

  private startMiniBarsAnalyser(retryCount = 0) {
    const stream = this.plugin.audioRecorderPublic?.stream;
    if (!stream) {
      if (retryCount < 10) {
        setTimeout(() => this.startMiniBarsAnalyser(retryCount + 1), 100);
      }
      return;
    }

    try {
      // Disconnect previous analyser source if any
      if (this.analyserSource) {
        try { this.analyserSource.disconnect(); } catch { /* ignore */ }
        this.analyserSource = null;
      }

      // Reuse AudioContext created during user gesture (onStartClick), or create new
      if (!this.audioContext || this.audioContext.state === 'closed') {
        this.audioContext = new AudioContext();
      }
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.6;
      this.analyserSource = this.audioContext.createMediaStreamSource(stream);
      this.analyserSource.connect(this.analyser);

      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }

      const analyser = this.analyser;
      const freqData = new Uint8Array(analyser.frequencyBinCount);
      const timeData = new Uint8Array(analyser.fftSize);
      const miniBarsEl = this.wrapperEl.querySelectorAll('.mm-mini-bar');

      const update = () => {
        this.spectrogramAnimId = requestAnimationFrame(update);

        if (this.state.status === 'paused') {
          miniBarsEl.forEach((bar) => {
            (bar as HTMLElement).style.height = '3px';
          });
          return;
        }

        analyser.getByteFrequencyData(freqData);
        analyser.getByteTimeDomainData(timeData);

        // RMS volume from time domain
        let sum = 0;
        for (let i = 0; i < timeData.length; i++) {
          const v = (timeData[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / timeData.length);
        const volume = Math.min(1, rms * 4);

        // Update mini-bars
        const bands = [4, 10, 20, 35, 55];
        const maxBarH = 18;
        const minBarH = 3;

        bands.forEach((binIdx, i) => {
          if (i >= miniBarsEl.length) return;
          const freqVal = (freqData[binIdx] ?? 0) / 255;
          const combined = Math.max(freqVal, volume * 0.8);
          const h = Math.max(minBarH, combined * maxBarH);
          (miniBarsEl[i] as HTMLElement).style.height = `${h}px`;
        });
      };

      update();
    } catch (err) {
      console.warn('Meetings Ai: failed to start mini-bars analyser', err);
    }
  }

  /** Full cleanup — disconnect audio nodes and close context */
  private stopSpectrogram() {
    if (this.spectrogramAnimId !== null) {
      cancelAnimationFrame(this.spectrogramAnimId);
      this.spectrogramAnimId = null;
    }
    if (this.analyserSource) {
      try { this.analyserSource.disconnect(); } catch { /* ignore */ }
      this.analyserSource = null;
    }
    this.analyser = null;
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { this.audioContext.close(); } catch { /* ignore */ }
    }
    this.audioContext = null;
  }

  // ─── Timer ───

  startTimerInterval() {
    this.stopTimerInterval();
    this.timerInterval = setInterval(() => {
      if (this.plugin.audioRecorderPublic) {
        // Check if iOS/system killed the recording while screen was locked
        if (this.plugin.audioRecorderPublic.wasInterrupted) {
          this.stopTimerInterval();
          this.stopSpectrogram();
          new Notice('Recording was interrupted (screen lock or system). Audio data up to that point was preserved.');
          this.setState({ status: 'idle' });
          return;
        }
        this.updateElapsed(this.plugin.audioRecorderPublic.elapsedSeconds);
      }
    }, 200);
  }

  stopTimerInterval() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  // ─── SVG Icons ───

  private micSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`;
  }

  private homeSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
  }

  private plusSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  }

  private pauseSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
  }

  private stopSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
  }

  private playSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  }

  private summarySvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`;
  }

  private notesSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
  }

  private transcriptSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>`;
  }

  private audioSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/></svg>`;
  }

  private editSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
  }

  private settingsSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/></svg>`;
  }

  private refreshSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>`;
  }

  private trashSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;
  }

  // ─── Trash button with two-click confirmation ───

  private renderTrashButton(parent: HTMLElement) {
    const trashBtn = parent.createEl('button', { cls: 'mm-tab-settings-btn mm-tab-trash' });
    trashBtn.createSpan({ cls: 'mm-tab-icon' }).innerHTML = this.trashSvg();
    trashBtn.setAttribute('aria-label', 'Delete meeting');
    let confirmTimeout: NodeJS.Timeout | null = null;

    trashBtn.addEventListener('click', () => {
      // Already in confirm state — execute delete
      if (trashBtn.classList.contains('mm-tab-confirm-active')) {
        if (confirmTimeout) clearTimeout(confirmTimeout);
        this.deleteAllMeetingData();
        return;
      }
      // Switch to confirm state
      trashBtn.classList.add('mm-tab-confirm-active');
      trashBtn.innerHTML = '';
      trashBtn.createSpan({ text: 'Delete?', cls: 'mm-tab-label' });
      // Auto-revert after 3 seconds
      confirmTimeout = setTimeout(() => {
        trashBtn.classList.remove('mm-tab-confirm-active');
        trashBtn.innerHTML = '';
        trashBtn.createSpan({ cls: 'mm-tab-icon' }).innerHTML = this.trashSvg();
        confirmTimeout = null;
      }, 3000);
    });
  }

  // ─── Delete all meeting data ───

  private async deleteAllMeetingData() {
    // Clear in-memory state
    this.results = [];
    this.notesContent = '';
    this.meetingDescription = '';
    this.speakerMap = {};

    // Clear static caches
    MeetingWidget.resultCache.delete(this.ctx.sourcePath);
    MeetingWidget.notesCache.delete(this.ctx.sourcePath);
    MeetingWidget.descriptionCache.delete(this.ctx.sourcePath);
    MeetingWidget.errorCache.delete(this.ctx.sourcePath);
    MeetingWidget.speakerMapCache.delete(this.ctx.sourcePath);

    // Remove all persisted data from file
    await this.clearAllDataFromFile();

    // Navigate to meetings index (main page)
    this.plugin.openMeetingsIndex();
  }

  private async clearAllDataFromFile() {
    const file = this.getNoteFile();
    if (!file) return;

    try {
      let content = await this.plugin.app.vault.read(file);

      // Remove all marker blocks
      const markers: [string, string][] = [
        [MeetingWidget.SUMMARY_START, MeetingWidget.SUMMARY_END],
        [MeetingWidget.TRANSCRIPT_START, MeetingWidget.TRANSCRIPT_END],
        [MeetingWidget.AUDIO_START, MeetingWidget.AUDIO_END],
        [MeetingWidget.SEGMENTS_START, MeetingWidget.SEGMENTS_END],
        [MeetingWidget.NOTES_START, MeetingWidget.NOTES_END],
        [MeetingWidget.DESC_START, MeetingWidget.DESC_END],
        [MeetingWidget.ERROR_START, MeetingWidget.ERROR_END],
        [MeetingWidget.SPEAKERS_START, MeetingWidget.SPEAKERS_END],
      ];

      for (const [startMarker, endMarker] of markers) {
        const startIdx = content.indexOf(startMarker);
        const endIdx = content.indexOf(endMarker);
        if (startIdx !== -1 && endIdx !== -1) {
          let before = content.substring(0, startIdx);
          let after = content.substring(endIdx + endMarker.length);
          // Clean up surrounding newlines
          if (before.endsWith('\n')) before = before.slice(0, -1);
          if (after.startsWith('\n')) after = after.slice(1);
          content = before + after;
        }
      }

      await this.plugin.app.vault.modify(file, content);
    } catch (e) {
      console.warn('Meetings Ai: failed to clear data from file', e);
    }
  }
}
