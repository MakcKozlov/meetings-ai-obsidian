import {
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  TFile,
  TFolder,
  moment,
  normalizePath,
} from 'obsidian';
import Settings, { type ISettings, DEFAULT_SETTINGS } from './Settings';
import OpenAI from 'openai';
import AudioRecorder from './AudioRecorder';
import transcribeAudio, {
  type TranscriptSegment,
  type TranscriptionResult,
} from './transcribeAudio';
import summarizeTranscription, {
  SummarizationResult,
} from './summarizeTranscription';
import { must } from './utils/must';
import { isAudioFile } from './utils/isAudioFile';
import audioDataToChunkedFiles from './utils/audioDataToChunkedFiles';
import MeetingWidget from './MeetingWidget';

export default class MeetingAI extends Plugin {
  settings: ISettings;

  private _client?: OpenAI;
  private audioRecorder: AudioRecorder;
  private notice?: Notice;

  /** The currently active meeting widget (if any) */
  private activeWidget: MeetingWidget | null = null;
  /** The assistant name chosen for the current meeting recording */
  private meetingAssistantName: string = '';
  /** The note file for the current meeting */
  private meetingNoteFile: TFile | null = null;

  /** Expose audioRecorder for widget timer updates */
  get audioRecorderPublic(): AudioRecorder {
    return this.audioRecorder;
  }

  async onload() {
    this.audioRecorder = new AudioRecorder();

    await this.loadSettings();
    this.addSettingTab(new Settings(this.app, this));
    this.addRibbonIconMenu();
    this.addCommands();
    this.registerMeetingProcessor();
  }

  onunload() {
    this.notice?.hide();
    if (this.audioRecorder.state !== 'inactive') this.audioRecorder.stop();
  }

  // ═══════════════════════════════════════════
  //  Date formatting helper
  // ═══════════════════════════════════════════

  /** Returns formatted date suffix for file names based on settings.
   *  Time (HH-mm) is always prepended to ensure unique names.
   *  Uses dashes for time separator (filesystem-safe, looks like time). */
  private formatDateSuffix(date: moment.Moment): string {
    const dateFmt = this.settings.dateFormat || 'DD.MM.YY';
    const datePart = date.format(dateFmt).replace(/:/g, '.');
    const timePart = date.format('HH-mm');
    return `${timePart} ${datePart}`;
  }

  // ═══════════════════════════════════════════
  //  Meeting Code Block Processor
  // ═══════════════════════════════════════════

  private registerMeetingProcessor() {
    this.registerMarkdownCodeBlockProcessor(
      'meeting-ai',
      (source, el, ctx) => {
        console.log('Meetings Ai: code block processor called');
        const widget = new MeetingWidget(el, this, ctx);
        ctx.addChild(widget);
        this.activeWidget = widget;
      },
    );
  }

  // ═══════════════════════════════════════════
  //  Meeting Flow — called by MeetingWidget
  // ═══════════════════════════════════════════

  async createMeetingNote(): Promise<TFile> {
    // Archive old meetings from previous months before creating a new one
    await this.archiveOldMeetings();

    const now = moment().local();
    const noteName = `Meeting @ ${this.formatDateSuffix(now)}`;

    let folderPath: string;
    if (this.settings.outputFolder) {
      folderPath = this.settings.outputFolder;
      await this.ensureFolderExists(folderPath);
    } else {
      const currentPath = this.app.workspace.getActiveFile()?.path ?? '';
      const noteFolder = this.app.fileManager.getNewFileParent(
        currentPath,
        noteName,
      );
      folderPath = noteFolder.path;
    }

    // Find a unique name — add suffix if file already exists
    let notePath = normalizePath(`${folderPath}/${noteName}.md`);
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(notePath)) {
      notePath = normalizePath(
        `${folderPath}/${noteName} (${counter}).md`,
      );
      counter++;
    }

    const defaultAssistant =
      this.settings.assistants[0]?.name ?? 'Default';

    const noteContent =
      '```meeting-ai\nassistant: ' + defaultAssistant + '\n```\n\n';

    const note = await this.app.vault.create(notePath, noteContent);
    const currentPath = this.app.workspace.getActiveFile()?.path ?? '';
    await this.app.workspace.openLinkText(note.path, currentPath, true);

    // Force switch to Reading mode so the code block widget renders
    // Reading mode always renders code block processors, unlike Source/LP
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      // Small delay to let the view fully initialize
      await new Promise((r) => setTimeout(r, 100));
      // @ts-ignore — setState is available but not fully typed
      await view.setState(
        { ...view.getState(), mode: 'preview' },
        { history: false },
      );
    }

    // Try to set file explorer sort to "modified time, new to old"
    // so the newest meeting always appears on top
    this.ensureNewestFirstSort();

    this.meetingNoteFile = note;
    return note;
  }

  /**
   * Try to set the file explorer's sort order to "byModifiedTime" (reverse)
   * so the newest meeting always appears at the top.
   * Uses Obsidian's internal API — may break with future updates.
   */
  private ensureNewestFirstSort(): void {
    try {
      // Access the file-explorer view and set sort order
      const fileExplorer =
        this.app.workspace.getLeavesOfType('file-explorer')[0];
      if (!fileExplorer) return;

      const view = fileExplorer.view as any;
      if (view && typeof view.setSortOrder === 'function') {
        // 'byModifiedTimeReverse' = newest first (modified time, new to old)
        view.setSortOrder('byModifiedTimeReverse');
      }
    } catch {
      // Silently fail — this is best-effort using internal APIs
    }
  }

  async startMeetingRecording(assistantName: string): Promise<void> {
    this.assertHasOpenAiKey();
    this.meetingAssistantName = assistantName;

    // Reset recorder for a fresh recording
    this.audioRecorder = new AudioRecorder();
    await this.audioRecorder.start();

    // Track the current note file
    this.meetingNoteFile =
      this.app.workspace.getActiveFile() ?? this.meetingNoteFile;
  }

  pauseMeetingRecording(): void {
    if (this.audioRecorder.state !== 'recording') return;
    this.audioRecorder.pause();
  }

  resumeMeetingRecording(): void {
    if (this.audioRecorder.state !== 'paused') return;
    this.audioRecorder.resume();
  }

  async stopMeetingRecording(): Promise<
    | { ok: true; summary: string; transcript: string; segments: TranscriptSegment[]; audioFilePath: string | null }
    | { ok: false; error: string; audioFilePath: string | null }
    | null
  > {
    if (this.audioRecorder.state === 'inactive') return null;

    // Stop recording
    const startedAt = must(this.audioRecorder.startedAt);
    const blob = await this.audioRecorder.stop();
    const buffer = await blob.arrayBuffer();

    // Save audio file first — this is local, won't fail from network
    let audioFile: TFile | undefined;
    if (this.settings.saveAudio) {
      audioFile = await this.app.vault.createBinary(
        await this.resolveAttachmentPath(startedAt),
        buffer,
      );
    }

    // Reset recorder
    this.audioRecorder = new AudioRecorder();

    // Transcribe + Summarize — may fail from network
    try {
      const transcriptionResult = await this.transcribeAudio({ buffer, audioFile });

      const summaryResult = await this.summarizeTranscript({
        transcript: transcriptionResult.text,
        segments: transcriptionResult.segments,
        assistantName: this.meetingAssistantName,
      });

      const summaryText =
        summaryResult.state === 'success'
          ? summaryResult.response
          : summaryResult.state === 'refused'
            ? `Summary refused: ${summaryResult.refusal}`
            : `Summary error: ${summaryResult.error}`;

      return {
        ok: true,
        summary: summaryText,
        transcript: transcriptionResult.text,
        segments: transcriptionResult.segments,
        audioFilePath: audioFile?.path ?? null,
      };
    } catch (e: any) {
      console.error('Meetings Ai: transcription/summarization failed', e);
      return {
        ok: false,
        error: e?.message ?? String(e),
        audioFilePath: audioFile?.path ?? null,
      };
    }
  }

  /** Retry transcription + summarization from a previously saved audio file */
  async retryFromAudioFile(audioFilePath: string): Promise<
    | { ok: true; summary: string; transcript: string; segments: TranscriptSegment[]; audioFilePath: string }
    | { ok: false; error: string }
  > {
    const audioFile = this.app.vault.getAbstractFileByPath(audioFilePath);
    if (!audioFile || !(audioFile instanceof TFile)) {
      return { ok: false, error: `Аудио файл не найден: ${audioFilePath}` };
    }

    try {
      const transcriptionResult = await this.transcribeAudio({ audioFile: audioFile as TFile });

      const summaryResult = await this.summarizeTranscript({
        transcript: transcriptionResult.text,
        segments: transcriptionResult.segments,
        assistantName: this.meetingAssistantName,
      });

      const summaryText =
        summaryResult.state === 'success'
          ? summaryResult.response
          : summaryResult.state === 'refused'
            ? `Summary refused: ${summaryResult.refusal}`
            : `Summary error: ${summaryResult.error}`;

      return {
        ok: true,
        summary: summaryText,
        transcript: transcriptionResult.text,
        segments: transcriptionResult.segments,
        audioFilePath,
      };
    } catch (e: any) {
      console.error('Meetings Ai: retry transcription failed', e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  // ═══════════════════════════════════════════
  //  OpenAI key check
  // ═══════════════════════════════════════════

  get hasOpenAiKey() {
    return this.settings.openaiApiKey && this.settings.openaiApiKey.length;
  }

  missingOpenAiKeyMsg =
    'Meetings Ai: cannot transcribe or summarize without an OpenAI API key; ' +
    'please add one in the plugin settings.';

  assertHasOpenAiKey() {
    if (this.hasOpenAiKey) return;

    new Notice(this.missingOpenAiKeyMsg);
    throw new Error(this.missingOpenAiKeyMsg);
  }

  // ═══════════════════════════════════════════
  //  Settings
  // ═══════════════════════════════════════════

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.hasOpenAiKey) {
      new Notice(this.missingOpenAiKeyMsg, 0);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    await this.loadSettings();
  }

  // ═══════════════════════════════════════════
  //  Ribbon Icon — now creates a meeting note
  // ═══════════════════════════════════════════

  addRibbonIconMenu() {
    this.addRibbonIcon('microphone', 'Meetings Ai', (event) => {
      // If a meeting recording is active, show pause/stop menu
      if (this.audioRecorder.state !== 'inactive') {
        const menu =
          this.audioRecorder.state === 'recording'
            ? this.recordingMenu()
            : this.pausedMenu();
        menu.showAtMouseEvent(event);
        return;
      }

      // Otherwise create a new meeting note
      this.createMeetingNote().catch((err) => {
        console.error('Meetings Ai: failed to create meeting note', err);
        new Notice(`Meetings Ai: ${err}`);
      });
    });
  }

  // ═══════════════════════════════════════════
  //  Commands (backward compatibility)
  // ═══════════════════════════════════════════

  addCommands() {
    this.addCommand({
      id: 'create-meeting-note',
      name: 'Create meeting note',
      icon: 'microphone',
      callback: () => {
        this.createMeetingNote().catch((err) => {
          console.error('Meetings Ai: failed to create meeting note', err);
          new Notice(`Meetings Ai: ${err}`);
        });
      },
    });

    this.addCommand({
      id: 'start-recording',
      name: 'Start recording',
      icon: 'audio-lines',
      checkCallback: (checking) => {
        if (checking) return this.audioRecorder.state === 'inactive';
        this.startRecording();
      },
    });

    this.addCommand({
      id: 'resume-recording',
      name: 'Resume recording',
      icon: 'audio-lines',
      checkCallback: (checking) => {
        if (checking) return this.audioRecorder.state === 'paused';
        this.resumeRecording();
      },
    });

    this.addCommand({
      id: 'pause-recording',
      name: 'Pause recording',
      icon: 'pause',
      checkCallback: (checking) => {
        if (checking) return this.audioRecorder.state === 'recording';
        this.pauseRecording();
      },
    });

    this.settings.assistants.forEach((assistant) =>
      this.addCommand({
        id: 'finish-recording-' + assistant.name,
        name: `Finish recording (${assistant.name})`,
        icon: 'check',
        checkCallback: (checking) => {
          if (checking) return this.audioRecorder.state !== 'inactive';
          this.fromActiveRecording({ assistantName: assistant.name });
        },
      }),
    );

    this.settings.assistants.forEach((assistant) =>
      this.addCommand({
        id: 'transcribe-and-summarize-' + assistant.name,
        name: `Transcribe and summarize (${assistant.name})`,
        icon: 'scroll-text',
        checkCallback: (checking) => {
          const activeFile = this.app.workspace.getActiveFile();
          if (checking) {
            return (
              this.audioRecorder.state === 'inactive' &&
              !!activeFile &&
              isAudioFile(activeFile)
            );
          }
          this.fromAudioFile({
            audioFile: must(activeFile),
            assistantName: assistant.name,
          });
        },
      }),
    );
  }

  // ═══════════════════════════════════════════
  //  Legacy menus (for backward compat)
  // ═══════════════════════════════════════════

  inactiveMenu(): Menu {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('Create meeting note')
        .setIcon('microphone')
        .onClick(() => this.createMeetingNote()),
    );

    // if current file is an audio file, add a menu item to transcribe it
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && isAudioFile(activeFile)) {
      this.settings.assistants.forEach(({ name: assistantName }) =>
        menu.addItem((item) =>
          item
            .setTitle(`Transcribe and summarize (${assistantName})`)
            .setIcon('scroll-text')
            .onClick(() =>
              this.fromAudioFile({ audioFile: activeFile, assistantName }),
            ),
        ),
      );
    }
    return menu;
  }

  addPausedMenuItems(menu: Menu): Menu {
    menu
      .addItem((item) => {
        item
          .setTitle('Resume recording')
          .setIcon('play')
          .onClick(this.resumeRecording.bind(this));
      })
      .addItem((item) => {
        item
          .setTitle('Cancel recording')
          .setIcon('cross')
          .onClick(this.cancelRecording.bind(this));
      })
      .addSeparator();

    this.settings.assistants.forEach(({ name: assistantName }) =>
      menu.addItem((item) =>
        item
          .setTitle(`Finish recording (${assistantName})`)
          .setIcon('stop')
          .onClick(() => this.fromActiveRecording({ assistantName })),
      ),
    );
    return menu;
  }

  pausedMenu(): Menu {
    const menu = new Menu();
    return this.addPausedMenuItems(menu);
  }

  recordingMenu(): Menu {
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle('Pause recording')
        .setIcon('pause')
        .onClick(this.pauseRecording.bind(this));
    });

    return this.addPausedMenuItems(menu);
  }

  // ═══════════════════════════════════════════
  //  OpenAI Client
  // ═══════════════════════════════════════════

  get client(): OpenAI {
    return (
      this._client ??
      (this._client = new OpenAI({
        apiKey: this.settings.openaiApiKey,
        dangerouslyAllowBrowser: true,
      }))
    );
  }

  // ═══════════════════════════════════════════
  //  Notices
  // ═══════════════════════════════════════════

  setNotice(message: string) {
    if (this.notice) {
      this.notice.setMessage(message);
    } else {
      this.notice = new Notice(message, 0);
    }
  }

  clearNotice() {
    this.notice?.hide();
    this.notice = undefined;
  }

  // ═══════════════════════════════════════════
  //  Legacy recording flow (backward compat)
  // ═══════════════════════════════════════════

  startRecording() {
    this.audioRecorder.start();
    this.setNotice('Meetings Ai: recording');
  }

  pauseRecording() {
    this.audioRecorder.pause();
    this.notice?.setMessage('Meetings Ai: paused');
  }

  resumeRecording() {
    this.audioRecorder.resume();
    this.notice?.setMessage('Meetings Ai: recording');
  }

  async cancelRecording() {
    await this.audioRecorder.stop();
    this.notice?.hide();
  }

  async finishRecording() {
    this.notice?.hide();
    this.assertHasOpenAiKey();

    const startedAt = must(this.audioRecorder.startedAt);
    const blob = await this.audioRecorder.stop();
    const buffer = await blob.arrayBuffer();

    const audioFile = this.settings.saveAudio
      ? await this.app.vault.createBinary(
          await this.resolveAttachmentPath(startedAt),
          buffer,
        )
      : undefined;

    this.audioRecorder = new AudioRecorder(); //reset the recorder
    return { buffer, audioFile, startedAt };
  }

  // ═══════════════════════════════════════════
  //  Transcription & Summarization
  // ═══════════════════════════════════════════

  // 25MB limit for audio files, per
  // https://platform.openai.com/docs/guides/speech-to-text
  private MAX_CHUNK_SIZE = 25 * 1024 * 1024;
  // https://platform.openai.com/docs/guides/speech-to-text/introduction
  private SUPPORTED_FILE_EXTENSIONS = [
    'mp3',
    'mp4',
    'mpeg',
    'mpga',
    'm4a',
    'wav',
    'webm',
  ];
  async transcribeAudio({
    buffer,
    audioFile,
  }: {
    audioFile?: TFile;
    buffer?: ArrayBuffer;
  }): Promise<TranscriptionResult> {
    const audioData =
      buffer ?? (audioFile ? await this.app.vault.readBinary(audioFile) : null);

    if (!audioData)
      throw new Error('Must provide either an audio file or a buffer');

    const audioFiles = await audioDataToChunkedFiles(
      audioData,
      this.MAX_CHUNK_SIZE,
    );

    return transcribeAudio(this.client, {
      prompt: this.settings.transcriptionHint,
      audioFiles,
      onChunkStart: (i, total) => {
        let message = 'Meetings Ai: transcribing';
        if (total > 1) message += ` ${i + 1}/${total}`;
        this.setNotice(message);
      },
    });
  }

  async summarizeTranscript({
    transcript,
    segments,
    assistantName,
  }: {
    transcript: string;
    segments?: TranscriptSegment[];
    assistantName: string;
  }): Promise<SummarizationResult> {
    const { assistantModel, assistants } = this.settings;
    const assistant = assistants.find((a) => a.name === assistantName);
    if (!assistant)
      throw new Error(
        `Assistant '${assistantName}' not found; available assistants are ` +
          `${assistants.map((a) => a.name).join(', ')}`,
      );

    this.setNotice(`Meetings Ai: summarizing`);
    const summary = await summarizeTranscription(this.client, {
      completionModel: assistantModel,
      completionInstructions: assistant?.prompt,
      transcript,
      segments,
    });

    if (summary.state === 'refused')
      this.setNotice(`Summary refused: ${summary.refusal}`);
    else if (summary.state === 'error')
      this.setNotice(`Summary error: ${summary.error}`);
    else {
      this.clearNotice();
    }

    return summary;
  }

  // ═══════════════════════════════════════════
  //  File Helpers
  // ═══════════════════════════════════════════

  private async ensureFolderExists(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    if (this.app.vault.getAbstractFileByPath(normalized)) return;

    // Create parent folders recursively if needed
    const parts = normalized.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  // ═══════════════════════════════════════════
  //  Auto-archive: move past-month meetings
  //  into YYYY-MM subfolders
  // ═══════════════════════════════════════════

  /**
   * Scans the outputFolder for meeting notes from previous months.
   * Moves them (and matching audio files) into year-month subfolders
   * e.g. Records/2025-01/, Records/2025-02/ etc.
   */
  async archiveOldMeetings(): Promise<void> {
    const outputFolder = this.settings.outputFolder;
    if (!outputFolder) return; // no folder configured — nothing to archive

    const folder = this.app.vault.getAbstractFileByPath(
      normalizePath(outputFolder),
    );
    if (!folder || !(folder instanceof TFolder)) return;

    const now = moment().local();
    const currentYearMonth = now.format('YYYY-MM');

    // Collect files to move (don't mutate while iterating)
    const filesToMove: { file: TFile; yearMonth: string }[] = [];

    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      if (child.extension !== 'md') continue;

      // Try to determine the month of this meeting file.
      // Use the file's creation time (ctime) to determine the month.
      const fileDate = moment(child.stat.ctime);
      const fileYearMonth = fileDate.format('YYYY-MM');

      // Only archive files from previous months, not the current one
      if (fileYearMonth >= currentYearMonth) continue;

      filesToMove.push({ file: child, yearMonth: fileYearMonth });
    }

    if (filesToMove.length === 0) return;

    // Group by year-month and move
    for (const { file, yearMonth } of filesToMove) {
      const archiveFolder = normalizePath(`${outputFolder}/${yearMonth}`);
      await this.ensureFolderExists(archiveFolder);

      const newPath = normalizePath(`${archiveFolder}/${file.name}`);
      try {
        await this.app.fileManager.renameFile(file, newPath);
      } catch (err) {
        console.warn(`Meetings Ai: failed to archive ${file.path}`, err);
      }
    }

    // Also archive old audio files from the audio folder
    await this.archiveOldAudioFiles();
  }

  /**
   * Moves old audio files from the audio folder into year-month subfolders.
   */
  private async archiveOldAudioFiles(): Promise<void> {
    const audioFolder = this.settings.audioFolder || this.settings.outputFolder;
    if (!audioFolder) return;

    const folder = this.app.vault.getAbstractFileByPath(
      normalizePath(audioFolder),
    );
    if (!folder || !(folder instanceof TFolder)) return;

    const now = moment().local();
    const currentYearMonth = now.format('YYYY-MM');

    const filesToMove: { file: TFile; yearMonth: string }[] = [];

    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      // Only archive audio files
      if (!isAudioFile(child)) continue;

      const fileDate = moment(child.stat.ctime);
      const fileYearMonth = fileDate.format('YYYY-MM');

      if (fileYearMonth >= currentYearMonth) continue;

      filesToMove.push({ file: child, yearMonth: fileYearMonth });
    }

    for (const { file, yearMonth } of filesToMove) {
      const archiveFolder = normalizePath(`${audioFolder}/${yearMonth}`);
      await this.ensureFolderExists(archiveFolder);

      const newPath = normalizePath(`${archiveFolder}/${file.name}`);
      try {
        await this.app.fileManager.renameFile(file, newPath);
      } catch (err) {
        console.warn(`Meetings Ai: failed to archive audio ${file.path}`, err);
      }
    }
  }

  private async resolveAttachmentPath(date: moment.Moment): Promise<string> {
    const ext = this.audioRecorder.fileExtension;
    const baseName = `meeting_${this.formatDateSuffix(date)}`;

    const folder = this.settings.audioFolder || this.settings.outputFolder;
    if (folder) {
      await this.ensureFolderExists(folder);
      let filePath = normalizePath(`${folder}/${baseName}.${ext}`);
      let counter = 1;
      while (this.app.vault.getAbstractFileByPath(filePath)) {
        filePath = normalizePath(
          `${folder}/${baseName} (${counter}).${ext}`,
        );
        counter++;
      }
      return filePath;
    }

    return this.app.fileManager.getAvailablePathForAttachment(
      `${baseName}.${ext}`,
    );
  }

  // ═══════════════════════════════════════════
  //  Legacy write results (for backward compat)
  // ═══════════════════════════════════════════

  async writeResults({
    assistantName,
    audioFile,
    date,
    summary,
    transcript,
  }: {
    assistantName: string;
    audioFile?: TFile;
    date: moment.Moment;
    summary: SummarizationResult;
    transcript: string;
  }): Promise<TFile> {
    const { linkAudio } = this.settings;
    const noteName = `Meeting @ ${this.formatDateSuffix(date)}`;
    const currentPath = this.app.workspace.getActiveFile()?.path ?? '';

    let folderPath: string;
    if (this.settings.outputFolder) {
      folderPath = this.settings.outputFolder;
      await this.ensureFolderExists(folderPath);
    } else {
      const noteFolder = this.app.fileManager.getNewFileParent(
        currentPath,
        noteName,
      );
      folderPath = noteFolder.path;
    }

    const notePath = normalizePath(`${folderPath}/${noteName}.md`);

    let noteContent = '';
    if (audioFile && linkAudio) {
      const linkMd = this.app.fileManager.generateMarkdownLink(
        audioFile,
        notePath,
      );
      noteContent += `${linkMd}\n\n`;
    }

    switch (summary.state) {
      case 'success':
        noteContent += summary.response;
        break;
      case 'refused':
        noteContent += `# Summary refused\n\n${summary.refusal}\n\n`;
        break;
      case 'error':
        noteContent += `# Summary error\n\n${summary.error}\n\n`;
        break;
    }

    const note = await this.app.vault.create(notePath, noteContent);
    await this.app.fileManager.processFrontMatter(note, (frontMatter) => {
      frontMatter.createdBy = 'Meetings Ai';
      frontMatter.assistant = assistantName;
      frontMatter.recordedAt = date.local().format('YYYY-MM-DD HH:mm:ss');
      frontMatter.transcript = transcript;
    });

    await this.app.workspace.openLinkText(note.path, currentPath, true);
    return note;
  }

  async fromAudioFile({
    audioFile,
    assistantName,
  }: {
    audioFile: TFile;
    assistantName: string;
  }): Promise<TFile> {
    this.assertHasOpenAiKey();

    this.setNotice('Meetings Ai: processing');
    const buffer = await this.app.vault.readBinary(audioFile);
    const transcriptionResult = await this.transcribeAudio({ audioFile, buffer });
    const summary = await this.summarizeTranscript({
      transcript: transcriptionResult.text,
      segments: transcriptionResult.segments,
      assistantName,
    });
    return this.writeResults({
      assistantName,
      audioFile,
      date: moment(),
      summary,
      transcript: transcriptionResult.text,
    });
  }

  async fromActiveRecording({
    assistantName,
  }: {
    assistantName: string;
  }): Promise<TFile> {
    this.assertHasOpenAiKey();

    const { buffer, audioFile, startedAt } = await this.finishRecording();
    const transcriptionResult = await this.transcribeAudio({ buffer, audioFile });
    const summary = await this.summarizeTranscript({
      transcript: transcriptionResult.text,
      segments: transcriptionResult.segments,
      assistantName,
    });
    return this.writeResults({
      assistantName,
      audioFile,
      date: startedAt,
      summary,
      transcript: transcriptionResult.text,
    });
  }
}
