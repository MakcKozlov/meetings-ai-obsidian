import {
  MarkdownRenderChild,
  MarkdownPostProcessorContext,
  Notice,
  debounce,
  TFile,
} from 'obsidian';
import type MeetingAIPlugin from './Plugin';

export type WidgetState =
  | { status: 'idle' }
  | { status: 'recording'; elapsed: number }
  | { status: 'paused'; elapsed: number }
  | { status: 'processing'; message: string }
  | { status: 'done'; summary: string; transcript: string };

interface ResultEntry {
  summary: string;
  transcript: string;
  audioFilePath: string | null;
}

export default class MeetingWidget extends MarkdownRenderChild {
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
  /** Debounced save for notes */
  private saveNotesDebounced = debounce(
    () => this.saveNotesToFile(),
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
    this.loadDataFromFile();
  }

  // ─── Persistence markers ───
  // Data is stored as readable markdown in the .md file so it's
  // accessible to databases and AI tools.

  private static readonly NOTES_START = '%%meeting-ai-notes-start%%';
  private static readonly NOTES_END = '%%meeting-ai-notes-end%%';
  private static readonly SUMMARY_START = '%%meeting-ai-summary-start%%';
  private static readonly SUMMARY_END = '%%meeting-ai-summary-end%%';
  private static readonly TRANSCRIPT_START = '%%meeting-ai-transcript-start%%';
  private static readonly TRANSCRIPT_END = '%%meeting-ai-transcript-end%%';
  private static readonly AUDIO_START = '%%meeting-ai-audio-start%%';
  private static readonly AUDIO_END = '%%meeting-ai-audio-end%%';

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

    // Load summary
    const summary = MeetingWidget.extractBetween(content, MeetingWidget.SUMMARY_START, MeetingWidget.SUMMARY_END);

    // Load transcript
    const transcript = MeetingWidget.extractBetween(content, MeetingWidget.TRANSCRIPT_START, MeetingWidget.TRANSCRIPT_END);

    // Load audio paths
    const audioPaths = MeetingWidget.extractBetween(content, MeetingWidget.AUDIO_START, MeetingWidget.AUDIO_END);

    // If we have summary or transcript, restore the result
    if (summary !== null || transcript !== null) {
      const audioFilePath = audioPaths?.trim() || null;
      this.results = [{
        summary: summary ?? '',
        transcript: transcript ?? '',
        audioFilePath,
      }];
      const last = this.results[this.results.length - 1];
      this.state = {
        status: 'done',
        summary: last.summary,
        transcript: last.transcript,
      };
      this.render();
    }
  }

  // ─── Save all data to file ───

  /**
   * Save results (summary, transcript, audio paths) as readable markdown
   * in the .md file. This ensures the data is available for databases
   * and AI processing.
   */
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

    await this.plugin.app.vault.modify(file, content);
  }

  private async saveNotesToFile() {
    const file = this.getNoteFile();
    if (!file) return;
    let content = await this.plugin.app.vault.read(file);

    content = MeetingWidget.replaceBlock(content, MeetingWidget.NOTES_START, MeetingWidget.NOTES_END, this.notesContent);

    await this.plugin.app.vault.modify(file, content);
  }

  setState(newState: WidgetState) {
    this.state = newState;
    this.render();
  }

  getState(): WidgetState {
    return this.state;
  }

  /** Called by onStopClick after processing completes */
  addResult(summary: string, transcript: string, audioFilePath: string | null) {
    this.results.push({ summary, transcript, audioFilePath });
    this.state = { status: 'done', summary, transcript };
    this.activeTab = 'summary';
    // Persist results as markdown to the .md file
    this.saveResultsToFile();
    this.render();
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

  private render() {
    this.wrapperEl.empty();
    this.wrapperEl.removeClass(
      'mm-state-idle',
      'mm-state-recording',
      'mm-state-paused',
      'mm-state-processing',
      'mm-state-done',
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
    }
  }

  // ─── Idle state ───

  private renderIdle() {
    const container = this.wrapperEl.createDiv({ cls: 'mm-idle-container' });

    // If we have previous results, show them with tabs above the start button
    if (this.results.length > 0) {
      this.renderTabs(container);
    }

    // Start button
    const startBtn = container.createEl('button', {
      cls: 'mm-btn mm-btn-start',
    });
    const micIcon = startBtn.createSpan({ cls: 'mm-icon mm-icon-mic' });
    micIcon.innerHTML = this.micSvg();
    startBtn.createSpan({
      text: this.results.length > 0
        ? 'Record again'
        : 'Start transcribing',
      cls: 'mm-btn-label',
    });
    startBtn.addEventListener('click', () => this.onStartClick());

    // Assistant selector (if more than one)
    if (this.plugin.settings.assistants.length > 1) {
      const selectorRow = container.createDiv({ cls: 'mm-assistant-row' });
      selectorRow.createSpan({
        text: 'Assistant:',
        cls: 'mm-assistant-label',
      });
      const select = selectorRow.createEl('select', {
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

  // ─── Done state — tabs: Summary / Notes / Transcript ───

  private renderDone() {
    const container = this.wrapperEl.createDiv({ cls: 'mm-done-container' });
    this.renderTabs(container);

    const startBtn = container.createEl('button', {
      cls: 'mm-btn mm-btn-start mm-btn-record-again',
    });
    const micIcon = startBtn.createSpan({ cls: 'mm-icon mm-icon-mic' });
    micIcon.innerHTML = this.micSvg();
    startBtn.createSpan({ text: 'Record again', cls: 'mm-btn-label' });
    startBtn.addEventListener('click', () => this.onStartClick());
  }

  private renderTabs(container: HTMLElement) {
    const hasAudio = this.results.some((r) => r.audioFilePath);

    const tabBar = container.createDiv({ cls: 'mm-tab-bar' });
    const tabs: { id: typeof this.activeTab; label: string }[] = [
      { id: 'summary', label: 'Summary' },
      { id: 'notes', label: 'Notes' },
      { id: 'transcript', label: 'Transcript' },
    ];
    if (hasAudio) {
      tabs.push({ id: 'audio', label: 'Audio' });
    }

    for (const tab of tabs) {
      const tabEl = tabBar.createEl('button', {
        cls: `mm-tab ${this.activeTab === tab.id ? 'mm-tab-active' : ''}`,
        text: tab.label,
      });
      tabEl.addEventListener('click', () => {
        this.activeTab = tab.id;
        this.render();
      });
    }

    const tabContent = container.createDiv({ cls: 'mm-tab-content' });

    const allSummaries = this.results.map((r) => r.summary).join('\n\n---\n\n');
    const allTranscripts = this.results
      .map((r) => r.transcript)
      .join('\n\n---\n\n');

    switch (this.activeTab) {
      case 'summary':
        tabContent.createDiv({ cls: 'mm-tab-panel mm-summary-panel' }).innerHTML =
          this.markdownToHtml(allSummaries);
        break;
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
      case 'transcript':
        tabContent.createDiv({
          cls: 'mm-tab-panel mm-transcript-panel',
        }).innerHTML = this.markdownToHtml(allTranscripts);
        break;
      case 'audio':
        this.renderAudioTab(tabContent);
        break;
    }
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

  /** Simple markdown → HTML (basic formatting) */
  private markdownToHtml(md: string): string {
    if (!md) return '<p style="color:var(--text-muted)">No content yet.</p>';
    return md
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^/, '<p>')
      .replace(/$/, '</p>');
  }

  // ─── Event handlers ───

  private async onStartClick() {
    try {
      this.setState({ status: 'recording', elapsed: 0 });
      await this.plugin.startMeetingRecording(this.selectedAssistant);
      this.startTimerInterval();
    } catch (e: any) {
      console.error('Failed to start recording:', e);
      new Notice(`Meeting AI: ${e?.message ?? e}`);
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

      if (result) {
        this.addResult(result.summary, result.transcript, result.audioFilePath);
      } else {
        this.setState({ status: 'idle' });
      }
    } catch (e: any) {
      console.error('Failed to stop recording:', e);
      new Notice(`Meeting AI: ${e?.message ?? e}`);
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
}
