// goal: manages the global settings panel logic, including persistence, theme/language switching, and cross-tab broadcasting

import type { GlobalSettings } from '@nexus/kernel';
import type { ThemeMode, DomainEntry } from '@nexus/contracts';
import { Actions } from '@nexus/contracts';
import type { I18NDict, RenderCallback } from '../types';
import { getSettingsUIElements, $ } from '../utils/dom';
import { applyTheme, THEME_ICONS, getNextThemeMode } from '../utils/theme';
import { migrateRegistry } from '../utils/registry-helpers';
import { TIMING } from '../constants';
import { applyLang, updateCardsI18n } from './i18n-apply';
import { initRegistryUI, updateRegistryI18n } from './registry-ui';
import { initPresetsUI, updatePresetsI18n } from './presets-ui';
import { updateRemoteI18n } from '../../remote';

export interface SettingsState {
  gSettings: GlobalSettings;
  registryEntries: DomainEntry[];
  dict: I18NDict;
}

// cardRenderCallbacks: registry of UI update hooks triggered when global settings (like visualization toggle) change
export const cardRenderCallbacks: RenderCallback[] = [];

const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  osdEnabled: true,
  visualizerEnabled: true,
  lang: 'en-US',
  themeMode: 'system',
  pauseRetentionSeconds: 60,
};

// post: loads settings from local storage, initializes the side-panel UI, and returns the unified state
export async function initSettings(): Promise<SettingsState> {
  const ui = getSettingsUIElements();

  // Load settings: maintains compatibility with both modern 'globalSettings' and legacy individual registry keys
  const storage = await chrome.storage.local.get(['globalSettings', 'restrictedRegistry', 'userRegistry']);
  let gSettings: GlobalSettings = storage.globalSettings || { ...DEFAULT_GLOBAL_SETTINGS };

  let registryEntries: DomainEntry[] = migrateRegistry(storage.restrictedRegistry || storage.userRegistry);

  initUIState(ui, gSettings, registryEntries);

  initTheme(gSettings.themeMode ?? 'system');

  let dict = applyLang(gSettings.lang);

  const saveSettings = () => {
    const selTheme = $<HTMLSelectElement>('set-theme');
    const pauseRetentionInput = $<HTMLInputElement>('set-pause-retention');
    gSettings = {
      osdEnabled: ui.swOsd?.checked ?? true,
      visualizerEnabled: ui.swViz?.checked ?? true,
      lang: (ui.selLang?.value as GlobalSettings['lang']) ?? 'en-US',
      themeMode: (selTheme?.value as ThemeMode) ?? 'system',
      pauseRetentionSeconds: parseInt(pauseRetentionInput?.value || '60', 10),
    };

    applyTheme(gSettings.themeMode);
    const btnTheme = $<HTMLButtonElement>('btn-theme');
    if (btnTheme) btnTheme.textContent = THEME_ICONS[gSettings.themeMode];

    chrome.storage.local.set({ globalSettings: gSettings });
    broadcastSettings(gSettings);

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

  initRegistryUI(registryEntries);
  updateRegistryI18n(dict);

  initPresetsUI();
  updatePresetsI18n(dict);

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
  saveSettings: () => void
): void {
  if (ui.swOsd) ui.swOsd.onchange = saveSettings;
  if (ui.swViz) ui.swViz.onchange = saveSettings;
  if (ui.selLang) ui.selLang.onchange = saveSettings;
  const selTheme = $<HTMLSelectElement>('set-theme');
  if (selTheme) selTheme.onchange = saveSettings;
  const pauseRetentionInput = $<HTMLInputElement>('set-pause-retention');
  if (pauseRetentionInput) pauseRetentionInput.onchange = saveSettings;
}

// goal: providing a quick-flip toggle for theme mode via the header button, synced with the settings dropdown
function bindThemeButtonEvent(
  getSettings: () => GlobalSettings,
  setSettings: (s: GlobalSettings) => void
): void {
  const btnTheme = $<HTMLButtonElement>('btn-theme');
  if (!btnTheme) return;
  btnTheme.onclick = () => {
    const current = getSettings();
    const nextMode = getNextThemeMode(current.themeMode ?? 'system');
    const updated = { ...current, themeMode: nextMode };
    setSettings(updated);
    applyTheme(nextMode);
    btnTheme.textContent = THEME_ICONS[nextMode];
    const selTheme = $<HTMLSelectElement>('set-theme');
    if (selTheme) selTheme.value = nextMode;
    chrome.storage.local.set({ globalSettings: updated });
  };
}

// eff: broadcasts updated settings to all open tabs to allow immediate UI (OSD, visualizer) state synchronization
function broadcastSettings(gSettings: GlobalSettings): void {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((t) => {
      if (t.id) {
        chrome.tabs.sendMessage(t.id, { action: Actions.GLOBAL_SETTINGS_UPDATE, settings: gSettings }).catch(() => { });
      }
    });
  });
}

