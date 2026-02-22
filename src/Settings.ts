import { App, PluginSettingTab, Setting } from 'obsidian';

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
