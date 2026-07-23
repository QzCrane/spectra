// goal: manages the global settings panel logic, including persistence, theme/language switching, and cross-tab broadcasting

import type { GlobalSettings } from '@nexus/kernel';
import type { ThemeMode, DomainEntry } from '@nexus/contracts';
import type { I18NDict, RenderCallback } from '../types';
import { getSettingsUIElements, $ } from '../utils/dom';
import { applyTheme, THEME_ICONS, getNextThemeMode } from '../utils/theme';
import { applyLang, updateCardsI18n } from './i18n-apply';
import { getSettingsSnapshot, patchSettings } from '../../shared/settings-client';
import { getRegistrySnapshot } from '../../shared/registry-client';
import { DEFAULT_GLOBAL_SETTINGS } from '@nexus/kernel';
import { initRegistryUI, updateRegistryI18n } from './registry-ui';
import { initPresetsUI, updatePresetsI18n } from './presets-ui';
import { updateRemoteI18n } from '../../remote';
import { loadLocaleCatalog } from '../../shared/i18n/catalog';

export interface SettingsState {
  gSettings: GlobalSettings;
  registryEntries: DomainEntry[];
  dict: I18NDict;
}

// cardRenderCallbacks: registry of UI update hooks triggered when global settings (like visualization toggle) change
export const cardRenderCallbacks: RenderCallback[] = [];

// post: loads settings from local storage, initializes the side-panel UI, and returns the unified state
export async function initSettings(): Promise<SettingsState> {
  const ui = getSettingsUIElements();

  const [snapshot, registrySnapshot] = await Promise.all([
    getSettingsSnapshot(),
    getRegistrySnapshot(),
  ]);

  let gSettings: GlobalSettings = snapshot.globalSettings || { ...DEFAULT_GLOBAL_SETTINGS };
  const registryEntries: DomainEntry[] = registrySnapshot.entries;

  initUIState(ui, gSettings, registryEntries);

  initTheme(gSettings.themeMode ?? 'system');

  await loadLocaleCatalog(gSettings.lang);
  let dict = applyLang(gSettings.lang);

  const saveSettings = async (changes: Partial<GlobalSettings>) => {
    const updated = await patchSettings({ scope: 'global', changes });
    gSettings = updated.globalSettings;
	await loadLocaleCatalog(gSettings.lang);

    applyTheme(gSettings.themeMode);
    const btnTheme = $<HTMLButtonElement>('btn-theme');
    if (btnTheme) btnTheme.textContent = THEME_ICONS[gSettings.themeMode];

    // eff: cascade i18n updates across all UI components (Cards, Registry, Presets, Remote)
    dict = applyLang(gSettings.lang);
    updateCardsI18n(dict, gSettings.visualizerEnabled);
    updateRegistryI18n(dict);
    updatePresetsI18n(dict);
    updateRemoteI18n(dict);
    cardRenderCallbacks.forEach((cb) => cb());
  };

  bindSettingsEvents(ui, saveSettings);
  bindThemeButtonEvent(() => gSettings, (s) => { gSettings = s; });

  initRegistryUI(registryEntries, dict);

  initPresetsUI(dict);

  updateRemoteI18n(dict);

  return { gSettings, registryEntries, dict };
}

function initUIState(
  ui: ReturnType<typeof getSettingsUIElements>,
  gSettings: GlobalSettings,
  _registryEntries: DomainEntry[]
): void {
  if (ui.swOsd) ui.swOsd.checked = gSettings.osdEnabled;
  if (ui.swViz) ui.swViz.checked = gSettings.visualizerEnabled !== false;
  if (ui.selLang) ui.selLang.value = gSettings.lang;
  const pauseRetentionInput = $<HTMLInputElement>('set-pause-retention');
  if (pauseRetentionInput) pauseRetentionInput.value = String(gSettings.pauseRetentionSeconds ?? 60);
}

function initTheme(themeMode: ThemeMode): void {
  applyTheme(themeMode);
  const selTheme = $<HTMLSelectElement>('set-theme');
  if (selTheme) selTheme.value = themeMode;
  const btnTheme = $<HTMLButtonElement>('btn-theme');
  if (btnTheme) btnTheme.textContent = THEME_ICONS[themeMode];
}

function bindSettingsEvents(
  ui: ReturnType<typeof getSettingsUIElements>,
  saveSettings: (changes: Partial<GlobalSettings>) => Promise<void>
): void {
  if (ui.swOsd) ui.swOsd.onchange = () => {
    void saveSettings({ osdEnabled: ui.swOsd?.checked ?? true });
  };
  if (ui.swViz) ui.swViz.onchange = () => {
    void saveSettings({ visualizerEnabled: ui.swViz?.checked ?? true });
  };
  if (ui.selLang) ui.selLang.onchange = () => {
    void saveSettings({ lang: (ui.selLang?.value as GlobalSettings['lang']) ?? 'en-US' });
  };
  const selTheme = $<HTMLSelectElement>('set-theme');
  if (selTheme) selTheme.onchange = () => {
    void saveSettings({ themeMode: (selTheme.value as ThemeMode) ?? 'system' });
  };
  const pauseRetentionInput = $<HTMLInputElement>('set-pause-retention');
  if (pauseRetentionInput) pauseRetentionInput.onchange = () => {
    void saveSettings({ pauseRetentionSeconds: parseInt(pauseRetentionInput.value || '60', 10) });
  };
}

// goal: providing a quick-flip toggle for theme mode via the header button, synced with the settings dropdown
function bindThemeButtonEvent(
  getSettings: () => GlobalSettings,
  setSettings: (s: GlobalSettings) => void
): void {
  const btnTheme = $<HTMLButtonElement>('btn-theme');
  if (!btnTheme) return;
  btnTheme.onclick = async () => {
    const current = getSettings();
    const nextMode = getNextThemeMode(current.themeMode ?? 'system');
    const updated = (await patchSettings({ scope: 'global', changes: { themeMode: nextMode } })).globalSettings;
    setSettings(updated);
    applyTheme(nextMode);
    btnTheme.textContent = THEME_ICONS[nextMode];
    const selTheme = $<HTMLSelectElement>('set-theme');
    if (selTheme) selTheme.value = nextMode;
  };
}
