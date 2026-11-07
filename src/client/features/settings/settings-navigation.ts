export const SETTINGS_SECTIONS = {
  llm: "settings.llmConnection.title",
  engine: "settings.translationEngine.title",
  corrections: "settings.corrections.title",
  sources: "settings.sources.title",
  stt: "settings.transcription.title",
  youtube: "settings.youtube.title",
  iface: "settings.interface.title",
} as const;

export type SettingsSectionKey = keyof typeof SETTINGS_SECTIONS;

export const SETTINGS_SECTION_KEYS = Object.keys(SETTINGS_SECTIONS) as SettingsSectionKey[];

export function settingsSection(value: string | null): SettingsSectionKey {
  return SETTINGS_SECTION_KEYS.find((key) => key === value) ?? "llm";
}
