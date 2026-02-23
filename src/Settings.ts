import { App, Notice, PluginSettingTab, Setting } from 'obsidian';

import MeetingAIPlugin from './Plugin';
import { Model, models } from './summarizeTranscription';

export interface ISettings {
  openaiApiKey: string;
  transcriptionHint: string;
  assistantModel: Model;
  assistants: { name: string; prompt: string }[];
  saveAudio: boolean;
  linkAudio: boolean;
  outputFolder: string;
  audioFolder: string;
  dateFormat: string;
  /** @deprecated — microphone is now stored in localStorage per-device */
  microphoneDeviceId?: string;
}

const defaultInstructions = `Ты — ассистент для ведения заметок со встреч. Твоя задача — создать краткое и структурированное резюме встречи по транскрипту.

ПРАВИЛА:
- Всегда пиши на русском языке, даже если транскрипт на другом языке
- Используй markdown-форматирование
- Не додумывай ничего — пиши только то, что было сказано
- Будь кратким и конкретным
- Каждая строка транскрипта начинается с номера сегмента [N]. В конце каждого пункта резюме ОБЯЗАТЕЛЬНО укажи номера исходных сегментов в формате {1,2,3}. Это важно для навигации по транскрипту.

ФОРМАТ ОТВЕТА:

## Ключевые тезисы
- Тезис текст {1,2,3}

## Решения
- Решение текст {4,5}

## Задачи
- Задача — ответственный — срок {6,7}

Если какой-то раздел пустой (например, не было решений или задач) — пропусти его полностью. Не пиши пустые разделы.

Ниже транскрипт встречи:`
  .replace(/\n/g, ' ')
  .trim();

export const DEFAULT_SETTINGS: ISettings = {
  openaiApiKey: '',
  transcriptionHint: '',
  assistantModel: 'gpt-4o',
  assistants: [{ name: 'Default', prompt: defaultInstructions }],
  saveAudio: true,
  linkAudio: true,
  outputFolder: 'Records',
  audioFolder: 'Records/Audio',
  dateFormat: 'DD.MM.YY',
};

const MIC_STORAGE_KEY = 'meetings-ai-microphone-device-id';

/** Get microphone deviceId from localStorage (per-device, not synced) */
export function getLocalMicrophoneDeviceId(): string {
  try {
    return localStorage.getItem(MIC_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

/** Save microphone deviceId to localStorage (per-device, not synced) */
export function setLocalMicrophoneDeviceId(deviceId: string): void {
  try {
    localStorage.setItem(MIC_STORAGE_KEY, deviceId);
  } catch {
    // localStorage unavailable on some platforms
  }
}

export default class Settings extends PluginSettingTab {
  plugin: MeetingAIPlugin;

  constructor(app: App, plugin: MeetingAIPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName('Notes folder')
      .setDesc(
        'Folder where meeting notes are saved. ' +
          'Leave empty to use the vault default location.',
      )
      .addText((text) =>
        text
          .setPlaceholder('e.g. Records')
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Audio folder')
      .setDesc(
        'Folder where audio recordings are saved. ' +
          'Leave empty to use the vault default location.',
      )
      .addText((text) =>
        text
          .setPlaceholder('e.g. Records/Audio')
          .setValue(this.plugin.settings.audioFolder)
          .onChange(async (value) => {
            this.plugin.settings.audioFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // ── Microphone selector ──
    const micSetting = new Setting(containerEl)
      .setName('Microphone')
      .setDesc('Select the microphone to use for recording meetings.');

    const micDropdownContainer = micSetting.controlEl.createDiv({
      cls: 'mm-mic-control',
    });
    const micSelect = micDropdownContainer.createEl('select', {
      cls: 'dropdown',
    });
    // Default option
    micSelect.createEl('option', {
      text: 'System default',
      value: '',
    });

    micSelect.addEventListener('change', async () => {
      setLocalMicrophoneDeviceId(micSelect.value);
    });

    // Refresh button
    const refreshBtn = micDropdownContainer.createEl('button', {
      cls: 'mm-mic-refresh-btn',
      attr: { 'aria-label': 'Refresh microphone list' },
    });
    refreshBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>`;

    const loadMicrophones = async () => {
      try {
        // Request permission first (needed to get device labels)
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tempStream.getTracks().forEach((t) => t.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === 'audioinput');

        // Clear existing options except "System default"
        while (micSelect.options.length > 1) {
          micSelect.remove(1);
        }

        const savedDeviceId = getLocalMicrophoneDeviceId();
        for (const device of audioInputs) {
          const label = device.label || `Microphone ${micSelect.options.length}`;
          const opt = micSelect.createEl('option', {
            text: label,
            value: device.deviceId,
          });
          if (device.deviceId === savedDeviceId) {
            opt.selected = true;
          }
        }

        // If saved device is still "System default"
        if (!savedDeviceId) {
          micSelect.value = '';
        }
      } catch (err) {
        console.error('Meetings Ai: failed to enumerate microphones', err);
        new Notice('Failed to access microphone. Check browser permissions.');
      }
    };

    refreshBtn.addEventListener('click', () => loadMicrophones());

    // Load on display
    loadMicrophones();

    const buildPreview = (fmt: string) => {
      const datePart = window.moment().format(fmt || 'DD.MM.YY').replace(/:/g, '.');
      const timePart = window.moment().format('HH-mm');
      return `Meeting @ ${timePart} ${datePart}`;
    };

    const dateFormatSetting = new Setting(containerEl)
      .setName('Date format')
      .setDesc(
        'Date part of file names (moment.js tokens). ' +
          'Time (HH-mm) is always added automatically.',
      )
      .addText((text) => {
        text
          .setPlaceholder('DD.MM.YY')
          .setValue(this.plugin.settings.dateFormat)
          .onChange(async (value) => {
            this.plugin.settings.dateFormat = value.trim();
            const preview = dateFormatSetting.descEl.querySelector(
              '.mm-date-preview',
            );
            if (preview) {
              preview.textContent = buildPreview(value.trim());
            }
            await this.plugin.saveSettings();
          });
        return text;
      });

    // Preset buttons
    const presets: { label: string; format: string }[] = [
      { label: 'DD.MM.YY', format: 'DD.MM.YY' },
      { label: 'DD.MM.YYYY', format: 'DD.MM.YYYY' },
      { label: 'YYYY-MM-DD', format: 'YYYY-MM-DD' },
      { label: 'DD MMM YYYY', format: 'DD MMM YYYY' },
      { label: 'MMM DD, YYYY', format: 'MMM DD, YYYY' },
    ];

    const presetsRow = dateFormatSetting.descEl.createDiv({
      cls: 'mm-presets-row',
    });
    for (const preset of presets) {
      const btn = presetsRow.createEl('button', {
        text: preset.label,
        cls: 'mm-preset-btn',
      });
      btn.addEventListener('click', async () => {
        this.plugin.settings.dateFormat = preset.format;
        await this.plugin.saveSettings();
        this.display();
      });
    }

    // Live preview
    dateFormatSetting.descEl.createDiv({
      cls: 'mm-date-preview',
      text: buildPreview(this.plugin.settings.dateFormat),
    });

    new Setting(containerEl)
      .setName('Save audio')
      .setDesc(
        'Save audio files in your vault after transcription.',
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.saveAudio)
          .onChange(async (value) => {
            this.plugin.settings.saveAudio = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Link audio')
      .setDesc(
        'Add a link to the audio file in the meeting note.',
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.linkAudio)
          .onChange(async (value) => {
            this.plugin.settings.linkAudio = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setHeading().setName('AI configuration');

    new Setting(containerEl).setName('OpenAI API key').addText((text) =>
      text
        .setPlaceholder('ApiKey')
        .setValue(this.plugin.settings.openaiApiKey)
        .onChange(async (value) => {
          this.plugin.settings.openaiApiKey = value;
          await this.plugin.saveSettings();
        }),
    );
    new Setting(containerEl)
      .setName('Speech to text hints')
      .setDesc(
        'Hint the transcription with words, acronyms, or names that are ' +
          'likely to appear in your audio, or with stylized text you want ' +
          'the transcript to match. Note that this is different from ' +
          "summary instructions - see OpenAI's documentation for more. For " +
          'longer transcriptions that require more than one API call, the ' +
          'prompt will be prepended to the final tokens of the previous ' +
          'response to improve consistency across segments.',
      )
      .addTextArea((text) =>
        text
          .setPlaceholder(
            'Avi, Bryan, and Kristy discussed the latest work on BART, MTS, and the T.',
          )
          .setValue(this.plugin.settings.transcriptionHint)
          .onChange(async (value) => {
            this.plugin.settings.transcriptionHint = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Summary assistant model')
      .setDesc('Choose an OpenAI chat model to power your summary assistants.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(Object.fromEntries(models.map((m) => [m, m])))
          .setValue(this.plugin.settings.assistantModel)
          .onChange(async (value: Model) => {
            this.plugin.settings.assistantModel = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setHeading()
      .setName('Summary assistants')
      .setDesc(
        'Summary assistants turn your transcribed memos into useful notes. ' +
          'Provide a name and a prompt for each. Add multiple assistants for ' +
          'different purposes, and choose between them when you run Meetings Ai.',
      );

    for (const [
      index,
      { name: key, prompt: value },
    ] of this.plugin.settings.assistants.entries()) {
      new Setting(containerEl)
        .setName(`${index + 1}.`)
        .addText((text) => {
          text
            .setPlaceholder('Assistant name')
            .setValue(key)
            .onChange(async (newValue) => {
              this.plugin.settings.assistants[index].name = newValue;
              await this.plugin.saveSettings();
            });
        })
        .addTextArea((text) =>
          text
            .setPlaceholder('Instructions')
            .setValue(value)
            .onChange(async (newValue) => {
              this.plugin.settings.assistants[index].prompt = newValue;
              await this.plugin.saveSettings();
            }),
        )
        .addExtraButton((button) => {
          button
            .setIcon('x')
            .setTooltip('Delete this prompt')
            .onClick(async () => {
              this.plugin.settings.assistants.splice(index, 1);
              await this.plugin.saveSettings();
              this.display();
            });
        });
    }

    new Setting(containerEl).addButton((button) => {
      button
        .setIcon('plus')
        .setButtonText('+ Add an assistant')
        .onClick(() => {
          this.plugin.settings.assistants.push({
            name: '',
            prompt: defaultInstructions,
          });
          this.display();
        });
    });
  }
}
