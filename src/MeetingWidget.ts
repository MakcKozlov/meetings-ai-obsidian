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

  private plugin: MeetingAIPlugin;
  private ctx: MarkdownPostProcessorContext;
  private state: WidgetState = { status: 'idle' };
  private timerInterval: NodeJS.Timeout | null = null;
  private wrapperEl: HTMLElement;
  private selectedAssistant: string;
  private activeTab: 'summary' | 'notes' | 'transcript' | 'audio' = 'summary';
  /** Accumulated results from multiple recordings */
  private results: ResultEntry[] = [];
  /** User notes content (persisted to note file) */
  private notesContent: string = '';
  /** Meeting description (persisted to note file) */
  private meetingDescription: string = '';
  /** Pending segment to scroll to after tab switch */
  private pendingScrollToSegment: number | null = null;
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
  ) {
    super(containerEl);
    this.plugin = plugin;
    this.ctx = ctx;
    this.wrapperEl = containerEl.createDiv({ cls: 'meeting-ai-widget' });
    this.selectedAssistant =
      plugin.settings.assistants[0]?.name ?? 'Default';

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
  }

  onload() {
    // Restore from static cache first (instant, no async)
    const cachedResults = MeetingWidget.resultCache.get(this.ctx.sourcePath);
    const cachedNotes = MeetingWidget.notesCache.get(this.ctx.sourcePath);
    const cachedDesc = MeetingWidget.descriptionCache.get(this.ctx.sourcePath);
    const cachedError = MeetingWidget.errorCache.get(this.ctx.sourcePath);

    if (cachedResults && cachedResults.length > 0) {
      this.results = cachedResults;
      if (cachedNotes) this.notesContent = cachedNotes;
      if (cachedDesc) this.meetingDescription = cachedDesc;
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
      const timerEl = this.wrapperEl.querySelector('.mm-elapsed');
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
        this.renderIdle();
        break;
      case 'recording':
        this.renderRecording();
        break;
      case 'paused':
        this.renderPaused();
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

  // ─── Idle state ───

  private renderIdle() {
    const container = this.wrapperEl.createDiv({ cls: 'mm-idle-container' });

    // Toolbar: [Notes badge] ... [assistant?] [Start recording]
    const toolbar = container.createDiv({ cls: 'mm-toolbar' });

    // Left side: Notes badge
    const notesTag = toolbar.createDiv({ cls: 'mm-toolbar-tag' });
    const tagIcon = notesTag.createSpan({ cls: 'mm-toolbar-tag-icon' });
    tagIcon.innerHTML = this.notesSvg();
    notesTag.createSpan({ text: 'Notes', cls: 'mm-toolbar-tag-label' });

    // Right side
    const toolbarRight = toolbar.createDiv({ cls: 'mm-toolbar-right' });

    // Assistant selector (if more than one)
    if (this.plugin.settings.assistants.length > 1) {
      const select = toolbarRight.createEl('select', {
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

    const startBtn = toolbarRight.createEl('button', {
      cls: 'mm-btn mm-btn-start',
    });
    const micIcon = startBtn.createSpan({ cls: 'mm-icon mm-icon-mic' });
    micIcon.innerHTML = this.micSvg();
    startBtn.createSpan({
      text: 'Start recording',
      cls: 'mm-btn-label',
    });
    startBtn.addEventListener('click', () => this.onStartClick());

    // If we have previous results, show tabs below toolbar
    if (this.results.length > 0) {
      this.renderTabs(container);
    }

    // Notes textarea — borderless Notion-style
    this.renderInlineNotes(container, 8);
  }

  // ─── Recording state ───

  private renderRecording() {
    const state = this.state as { status: 'recording'; elapsed: number };
    const container = this.wrapperEl.createDiv({
      cls: 'mm-recording-container',
    });

    const topRow = container.createDiv({ cls: 'mm-top-row' });

    const indicator = topRow.createDiv({ cls: 'mm-rec-indicator' });
    indicator.createSpan({ cls: 'mm-rec-dot' });
    indicator.createSpan({ text: 'Recording', cls: 'mm-rec-label' });

    const waveform = topRow.createDiv({ cls: 'mm-waveform' });
    for (let i = 0; i < 12; i++) {
      const bar = waveform.createDiv({ cls: 'mm-waveform-bar' });
      bar.style.animationDelay = `${i * 0.1}s`;
    }

    topRow.createSpan({
      text: this.formatTime(state.elapsed),
      cls: 'mm-elapsed',
    });

    const btnRow = container.createDiv({ cls: 'mm-btn-row' });

    const pauseBtn = btnRow.createEl('button', {
      cls: 'mm-btn mm-btn-pause',
    });
    pauseBtn.createSpan({ cls: 'mm-icon mm-icon-pause' }).innerHTML =
      this.pauseSvg();
    pauseBtn.createSpan({ text: 'Pause', cls: 'mm-btn-label' });
    pauseBtn.addEventListener('click', () => this.onPauseClick());

    const stopBtn = btnRow.createEl('button', {
      cls: 'mm-btn mm-btn-stop',
    });
    stopBtn.createSpan({ cls: 'mm-icon mm-icon-stop' }).innerHTML =
      this.stopSvg();
    stopBtn.createSpan({ text: 'Stop', cls: 'mm-btn-label' });
    stopBtn.addEventListener('click', () => this.onStopClick());

    // Notes area during recording
    this.renderInlineNotes(container);
  }

  // ─── Paused state ───

  private renderPaused() {
    const state = this.state as { status: 'paused'; elapsed: number };
    const container = this.wrapperEl.createDiv({
      cls: 'mm-paused-container',
    });

    const topRow = container.createDiv({ cls: 'mm-top-row' });

    const indicator = topRow.createDiv({ cls: 'mm-rec-indicator mm-paused' });
    indicator.createSpan({ cls: 'mm-rec-dot mm-paused' });
    indicator.createSpan({ text: 'Paused', cls: 'mm-rec-label' });

    const waveform = topRow.createDiv({ cls: 'mm-waveform mm-frozen' });
    for (let i = 0; i < 12; i++) {
      waveform.createDiv({ cls: 'mm-waveform-bar' });
    }

    topRow.createSpan({
      text: this.formatTime(state.elapsed),
      cls: 'mm-elapsed',
    });

    const btnRow = container.createDiv({ cls: 'mm-btn-row' });

    const resumeBtn = btnRow.createEl('button', {
      cls: 'mm-btn mm-btn-resume',
    });
    resumeBtn.createSpan({ cls: 'mm-icon mm-icon-play' }).innerHTML =
      this.playSvg();
    resumeBtn.createSpan({ text: 'Resume', cls: 'mm-btn-label' });
    resumeBtn.addEventListener('click', () => this.onResumeClick());

    const stopBtn = btnRow.createEl('button', {
      cls: 'mm-btn mm-btn-stop',
    });
    stopBtn.createSpan({ cls: 'mm-icon mm-icon-stop' }).innerHTML =
      this.stopSvg();
    stopBtn.createSpan({ text: 'Stop', cls: 'mm-btn-label' });
    stopBtn.addEventListener('click', () => this.onStopClick());

    // Notes area during paused
    this.renderInlineNotes(container);
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

  // ─── Done state — tabs: Summary / Notes / Transcript ───

  private renderDone() {
    const container = this.wrapperEl.createDiv({ cls: 'mm-done-container' });
    this.renderTabs(container);
  }

  private renderTabs(container: HTMLElement) {
    const hasAudio = this.results.some((r) => r.audioFilePath);

    // Tab bar with icons
    const tabBar = container.createDiv({ cls: 'mm-tab-bar' });

    const tabsLeft: { id: typeof this.activeTab; label: string; icon: string }[] = [
      { id: 'summary', label: 'Summary', icon: this.summarySvg() },
      { id: 'notes', label: 'Notes', icon: this.notesSvg() },
      { id: 'transcript', label: 'Transcript', icon: this.transcriptSvg() },
    ];
    if (hasAudio) {
      tabsLeft.push({ id: 'audio', label: 'Audio', icon: this.audioSvg() });
    }

    for (const tab of tabsLeft) {
      const tabEl = tabBar.createEl('button', {
        cls: `mm-tab ${this.activeTab === tab.id ? 'mm-tab-active' : ''}`,
      });
      const iconSpan = tabEl.createSpan({ cls: 'mm-tab-icon' });
      iconSpan.innerHTML = tab.icon;
      tabEl.createSpan({ text: tab.label, cls: 'mm-tab-label' });
      tabEl.addEventListener('click', () => {
        this.activeTab = tab.id;
        this.render();
      });
    }

    // "Record" button on the right side of tab bar (in done state)
    if (this.state.status === 'done' || this.state.status === 'idle') {
      const recordBtn = tabBar.createEl('button', {
        cls: 'mm-btn mm-btn-start mm-tab-record',
      });
      const micIcon = recordBtn.createSpan({ cls: 'mm-icon mm-icon-mic' });
      micIcon.innerHTML = this.micSvg();
      recordBtn.createSpan({ text: 'Record', cls: 'mm-btn-label' });
      recordBtn.addEventListener('click', () => this.onStartClick());
    }

    // Tab content
    const tabContent = container.createDiv({ cls: 'mm-tab-content' });

    const allSummaries = this.results.map((r) => r.summary).join('\n\n---\n\n');

    switch (this.activeTab) {
      case 'summary': {
        const summaryPanel = tabContent.createDiv({ cls: 'mm-tab-panel mm-summary-panel' });

        // Rendered preview
        const previewDiv = summaryPanel.createDiv({ cls: 'mm-summary-preview' });
        previewDiv.innerHTML = this.markdownToHtml(allSummaries);

        // Footnote click handler — switch to transcript and scroll
        previewDiv.addEventListener('click', (e) => {
          const badge = (e.target as HTMLElement).closest('.mm-footnote-badge');
          if (!badge) return;
          const segId = badge.getAttribute('data-segment-id');
          if (!segId) return;
          this.activeTab = 'transcript';
          this.pendingScrollToSegment = parseInt(segId, 10);
          this.render();
        });

        // Edit button
        const editBtn = summaryPanel.createEl('button', {
          cls: 'mm-btn mm-btn-edit-summary',
        });
        const editIcon = editBtn.createSpan({ cls: 'mm-icon' });
        editIcon.innerHTML = this.editSvg();
        editBtn.createSpan({ text: 'Edit summary', cls: 'mm-btn-label' });
        editBtn.addEventListener('click', () => {
          // Toggle: replace preview with textarea
          previewDiv.style.display = 'none';
          editBtn.style.display = 'none';
          const editArea = summaryPanel.createEl('textarea', {
            cls: 'mm-summary-textarea',
            attr: { rows: '12' },
          });
          editArea.value = allSummaries;

          const saveBtn = summaryPanel.createEl('button', {
            cls: 'mm-btn mm-btn-save-summary',
          });
          saveBtn.createSpan({ text: 'Save', cls: 'mm-btn-label' });
          saveBtn.addEventListener('click', async () => {
            // Update the last result's summary with edited text
            if (this.results.length > 0) {
              this.results[this.results.length - 1].summary = editArea.value;
              MeetingWidget.resultCache.set(this.ctx.sourcePath, [...this.results]);
              await this.saveResultsToFile();
            }
            this.render();
          });

          editArea.focus();
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
        transcriptPanel.innerHTML = this.renderTranscriptContent();

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

  /** Render transcript: with segments (timestamped) or plain fallback */
  private renderTranscriptContent(): string {
    const allSegments = this.results.flatMap((r) => r.segments ?? []);

    if (allSegments.length === 0) {
      // Fallback for legacy results without segments
      const allTranscripts = this.results
        .map((r) => r.transcript)
        .join('\n\n---\n\n');
      return this.markdownToHtml(allTranscripts);
    }

    // Render segments with timestamps and anchor IDs
    return allSegments.map((seg) => {
      const escaped = seg.text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const timestamp = this.formatTimestamp(seg.start);
      return `<div class="mm-segment" data-segment-id="${seg.id}">` +
        `<span class="mm-segment-time">${timestamp}</span>` +
        `<span class="mm-segment-text">${escaped}</span>` +
        `</div>`;
    }).join('');
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

      const audio = item.createEl('audio', {
        cls: 'mm-audio-player',
        attr: { controls: '' },
      });

      const resourcePath = this.plugin.app.vault.getResourcePath(file);
      audio.src = resourcePath;
    }
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

  // ─── Event handlers ───

  private async onStartClick() {
    try {
      this.setState({ status: 'recording', elapsed: 0 });
      await this.plugin.startMeetingRecording(this.selectedAssistant);
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

  private async onRetryClick(audioFilePath: string) {
    try {
      this.setState({ status: 'processing', message: 'Повторная расшифровка...' });

      const result = await this.plugin.retryFromAudioFile(audioFilePath);

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

  // ─── Timer ───

  startTimerInterval() {
    this.stopTimerInterval();
    this.timerInterval = setInterval(() => {
      if (this.plugin.audioRecorderPublic) {
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
}
