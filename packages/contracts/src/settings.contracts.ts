// goal: defines contracts for persistent settings and the storage abstraction layer

export type ThemeMode = 'light' | 'dark' | 'system';

export interface GlobalSettings {
  // osdEnabled: UI feedback overlay on volume/speed change
  osdEnabled: boolean;
  visualizerEnabled: boolean;
  lang: SupportedLanguage;
  themeMode: ThemeMode;
  // pauseRetentionSeconds: how long a paused tab stays in the UI list, 0=persistent
  pauseRetentionSeconds: number;
}

export type SupportedLanguage =
  | 'en-US'
  | 'zh-CN'
  | 'zh-TW'
  | 'ja-JP'
  | 'ko-KR'
  | 'ru-RU'
  | 'de-DE'
  | 'fr-FR';

export const DEFAULT_GLOBAL_SETTINGS: Readonly<GlobalSettings> = {
  osdEnabled: true,
  visualizerEnabled: true,
  lang: 'en-US',
  themeMode: 'system',
  pauseRetentionSeconds: 60
} as const;

// goal: abstraction for chrome.storage to provide type-safe persistence
export interface IStorageRepository {
  getAudioConfig(domain: string): Promise<import('./audio.contracts.js').AudioConfig>;

  setAudioConfig(domain: string, config: Partial<import('./audio.contracts.js').AudioConfig>): Promise<void>;

  getGlobalSettings(): Promise<GlobalSettings>;

  setGlobalSettings(settings: Partial<GlobalSettings>): Promise<void>;

  // eff: subscribes to storage changes, returns unsubscribe function
  onChanged(callback: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void): () => void;

  clear(): Promise<void>;
}
