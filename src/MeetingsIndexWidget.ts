import {
  MarkdownRenderChild,
  TFile,
  TFolder,
  normalizePath,
  moment,
} from 'obsidian';
import type MeetingAIPlugin from './Plugin';

interface MeetingEntry {
  name: string;      // basename without .md
  path: string;      // full vault path
  ctime: number;     // creation timestamp
}

interface MeetingGroup {
  label: string;
  open: boolean;
  items: MeetingEntry[];
}

export default class MeetingsIndexWidget extends MarkdownRenderChild {
  private plugin: MeetingAIPlugin;

  constructor(containerEl: HTMLElement, plugin: MeetingAIPlugin) {
    super(containerEl);
    this.plugin = plugin;
  }

  onload() {
    this.render();
  }

  private render() {
    const container = this.containerEl;
    container.empty();
    container.addClass('mi-index');

    const meetings = this.collectMeetings();
    const groups = this.groupMeetings(meetings);

    // Title row with "New" button
    const header = container.createDiv({ cls: 'mi-header' });
    const titleRow = header.createDiv({ cls: 'mi-title-row' });

    const titleLeft = titleRow.createDiv({ cls: 'mi-title-left' });
    const icon = titleLeft.createSpan({ cls: 'mi-title-icon' });
    icon.innerHTML = this.calendarSvg();
    titleLeft.createSpan({ text: 'AI meeting notes', cls: 'mi-title-text' });

    const newBtn = titleRow.createEl('button', { cls: 'mi-new-btn' });
    const plusIcon = newBtn.createSpan({ cls: 'mi-new-icon' });
    plusIcon.innerHTML = this.plusSvg();
    newBtn.createSpan({ text: 'New', cls: 'mi-new-label' });
    newBtn.addEventListener('click', () => {
      this.plugin.createMeetingNote();
    });

    // Groups
    for (const group of groups) {
      const section = container.createDiv({ cls: 'mi-section' });

      const sectionHeader = section.createDiv({ cls: 'mi-section-header' });
      const toggle = sectionHeader.createSpan({ cls: 'mi-toggle' });
      toggle.innerHTML = this.chevronSvg();
      sectionHeader.createSpan({
        text: `${group.label}`,
        cls: 'mi-section-label',
      });
      sectionHeader.createSpan({
        text: `${group.items.length}`,
        cls: 'mi-section-count',
      });

      const list = section.createDiv({ cls: 'mi-list' });

      if (!group.open) {
        section.addClass('mi-collapsed');
      }

      sectionHeader.addEventListener('click', () => {
        section.toggleClass('mi-collapsed', !section.hasClass('mi-collapsed'));
      });

      for (const m of group.items) {
        const row = list.createDiv({ cls: 'mi-row' });

        // Entire row is clickable
        row.addEventListener('click', () => {
          this.plugin.app.workspace.openLinkText(m.path, '', false);
        });

        const left = row.createDiv({ cls: 'mi-row-left' });
        const docIcon = left.createSpan({ cls: 'mi-doc-icon' });
        docIcon.innerHTML = this.docSvg();
        left.createSpan({ text: m.name, cls: 'mi-link' });

        const dateStr = moment(m.ctime).format('MMM D');
        row.createSpan({ text: dateStr, cls: 'mi-date' });
      }
    }

    if (groups.length === 0) {
      container.createDiv({ text: 'No meetings yet.', cls: 'mi-empty' });
    }
  }

  private collectMeetings(): MeetingEntry[] {
    const outputFolder = this.plugin.settings.outputFolder;
    if (!outputFolder) return [];

    const folder = this.plugin.app.vault.getAbstractFileByPath(
      normalizePath(outputFolder),
    );
    if (!folder || !(folder instanceof TFolder)) return [];

    const INDEX_NAME = 'Meetings.md';
    const SKIP_FOLDERS = new Set(['audio', 'records']);
    const meetings: MeetingEntry[] = [];

    const scanFolder = (f: TFolder) => {
      for (const child of f.children) {
        if (child instanceof TFile) {
          if (child.extension !== 'md') continue;
          if (child.name === INDEX_NAME) continue;
          meetings.push({
            name: child.basename,
            path: child.path,
            ctime: child.stat.ctime,
          });
        } else if (child instanceof TFolder) {
          const folderName = child.name.toLowerCase();
          if (SKIP_FOLDERS.has(folderName)) continue;
          if (/^\d{4}-\d{2}$/.test(child.name)) {
            scanFolder(child);
          }
        }
      }
    };
    scanFolder(folder);

    // Sort newest first
    meetings.sort((a, b) => b.ctime - a.ctime);
    return meetings;
  }

  private groupMeetings(meetings: MeetingEntry[]): MeetingGroup[] {
    const now = moment().local();
    const todayStart = now.clone().startOf('day');
    const yesterdayStart = todayStart.clone().subtract(1, 'day');
    const weekStart = todayStart.clone().subtract(6, 'days');
    const monthStart = todayStart.clone().subtract(29, 'days');

    const today: MeetingEntry[] = [];
    const yesterday: MeetingEntry[] = [];
    const last7: MeetingEntry[] = [];
    const last30: MeetingEntry[] = [];
    const older = new Map<string, MeetingEntry[]>();

    for (const m of meetings) {
      const d = moment(m.ctime);
      if (d.isSameOrAfter(todayStart)) {
        today.push(m);
      } else if (d.isSameOrAfter(yesterdayStart)) {
        yesterday.push(m);
      } else if (d.isSameOrAfter(weekStart)) {
        last7.push(m);
      } else if (d.isSameOrAfter(monthStart)) {
        last30.push(m);
      } else {
        const key = d.format('MMM YYYY');
        if (!older.has(key)) older.set(key, []);
        older.get(key)!.push(m);
      }
    }

    const groups: MeetingGroup[] = [];
    if (today.length) groups.push({ label: 'Today', open: true, items: today });
    if (yesterday.length) groups.push({ label: 'Yesterday', open: true, items: yesterday });
    if (last7.length) groups.push({ label: 'Last 7 days', open: false, items: last7 });
    if (last30.length) groups.push({ label: 'Last 30 days', open: false, items: last30 });
    for (const [label, items] of older) {
      groups.push({ label, open: false, items });
    }

    return groups;
  }

  // ── SVG Icons ──

  private calendarSvg(): string {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>';
  }

  private chevronSvg(): string {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
  }

  private plusSvg(): string {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
  }

  private docSvg(): string {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>';
  }
}
