// goal: main entry point for the SPECTRA popup; orchestrates UI initialization and tab-specific card rendering

import { $, isRestrictedUrl } from './utils';
import { initNavigation } from './views/navigation';
import { initSettings, type SettingsState } from './views/settings';
import { initCard } from './card';
import { isSpectraUiEventEnvelope } from '@nexus/contracts/ui-runtime';
import { enableSmoothScroll } from '../shared/smooth-scroll';
import { sendSpectraRequest } from '../shared/ui-spectra-client';
import type { EqCurveDrawerFactory } from './card/types';

// eff: bootstraps the popup UI by identifying active tabs, loading settings, and rendering control cards
async function main(): Promise<void> {
  enableSmoothScroll();

  let activeTab: chrome.tabs.Tab | null = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0] || null;
  } catch {
    // note: failure to query tabs usually indicates the popup was opened in a non-browser context (e.g. devtools)
  }

  try {
    initNavigation();
  } catch (error) {
    console.error('[SPECTRA Popup] initNavigation failed:', error);
  }

  let settings: SettingsState;
  try {
    settings = await initSettings();
  } catch (error) {
    console.error('[SPECTRA Popup] initSettings failed:', error);
    return;
  }
  const { gSettings, registryEntries, dict } = settings;

  // eff: lazy load side panel only when needed
  try {
    const { initSidePanel } = await import('./side-panel');
    initSidePanel();
  } catch (error) {
    console.error('[SPECTRA Popup] initSidePanel failed:', error);
  }

  if (activeTab?.id) {
    try {
      const { bindRemoteUI } = await import('../remote');
      const disposeRemoteUI = bindRemoteUI(activeTab.id, dict);
      window.addEventListener('pagehide', disposeRemoteUI, { once: true });
    } catch (error) {
      console.error('[SPECTRA Popup] bindRemoteUI failed:', error);
    }
  }

  let currentSettings = gSettings;
  const getGlobalSettings = () => currentSettings;

  // goal: consume only the repository's normalized, revisioned settings view
  const onSettingsChanged = (message: unknown): false => {
    if (isSpectraUiEventEnvelope(message) && message.type === 'spectra.settings.changed') {
      currentSettings = message.payload.globalSettings;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(onSettingsChanged);
  window.addEventListener('pagehide', () => {
    chrome.runtime.onMessage.removeListener(onSettingsChanged);
  }, { once: true });

  const mainStage = $<HTMLElement>('main-stage');
  const bgStack = $<HTMLElement>('bg-stack');
  const bgHeader = $<HTMLElement>('bg-header');
  const bgBadge = $<HTMLElement>('bg-badge');
  const template = $<HTMLTemplateElement>('tmpl-card');
  const emptyState = $<HTMLElement>('empty-state');

  if (!mainStage || !bgStack || !template || !emptyState) {
    console.error('[SPECTRA Popup] DOM Elements missing');
    return;
  }

  // rule: main-stage is reserved for the current active tab only
  if (activeTab && !isRestrictedUrl(activeTab.url)) {
    try {
      // eff: establish a persistent port to the active tab's content script to keep the session alive
      const port = chrome.tabs.connect(activeTab.id!, { name: 'popup-connection' });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
      });
    } catch {
      // note: fail silently if the content script is not yet injected or compatible
    }

    // eff: lazy load visualizer only when needed
    const { createEqCurveDrawer } = await import('./visualizer');

    const mainCardSuccess = await initCard({
      container: mainStage,
      template,
      tab: activeTab,
      dict,
      registryEntries,
      getGlobalSettings,
      createEqCurveDrawer,
    });

    if (mainCardSuccess) {
      emptyState.classList.add('hidden');
    }
  }

  let hasBgAudio = false;

  // eff: lazy load visualizer for background cards
  let bgEqDrawer: EqCurveDrawerFactory | undefined;

  try {
    // goal: render cards for other tabs that were recently audibly active to allow multi-tab management
    const result = await sendSpectraRequest('spectra.tab.visible.list', {});
    if (!result.ok) throw new Error(result.error.message);
    const visibleTabIds = result.data.tabs;
    const allTabs = await chrome.tabs.query({});
    const tabMap = new Map(allTabs.map(t => [t.id, t]));

    for (const tabId of visibleTabIds) {
      if (activeTab && tabId === activeTab.id) continue;

      const tab = tabMap.get(tabId);
      if (!tab || isRestrictedUrl(tab.url)) continue;

      if (!bgEqDrawer) {
        const { createEqCurveDrawer } = await import('./visualizer');
        bgEqDrawer = createEqCurveDrawer;
      }

      const success = await initCard({
        container: bgStack,
        template,
        tab,
        dict,
        registryEntries,
        getGlobalSettings,
        createEqCurveDrawer: bgEqDrawer,
        isBackground: true,
      });

      if (success) {
        bgHeader?.classList.remove('hidden');
        hasBgAudio = true;
      }
    }
  } catch (error) {
    console.warn('[SPECTRA Popup] Visible tab list unavailable.', error);
  }

  if (bgBadge) {
    bgBadge.innerText = String(bgStack.children.length);
  }

  const hasMainCard = mainStage.children.length > 0;
  const hasAnyCard = hasMainCard || hasBgAudio;

  // post: toggle empty state UI if no manageable media tabs were discovered
  if (!hasAnyCard) {
    emptyState.classList.remove('hidden');
  } else {
    emptyState.classList.add('hidden');
  }

  const { updateCardsI18n } = await import('./views/i18n-apply');
  updateCardsI18n(dict, gSettings.visualizerEnabled);
}

document.addEventListener('DOMContentLoaded', main);
