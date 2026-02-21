// goal: main entry point for the SPECTRA popup; orchestrates UI initialization and tab-specific card rendering

import { $, isRestrictedUrl } from './utils';
import { initNavigation } from './views/navigation';
import { initSettings } from './views/settings';
import { initCard } from './card';
import { createMessenger } from '@nexus/kernel';
import { enableSmoothScroll } from '../shared/smooth-scroll';
import type { EqCurveDrawerFactory } from './card/types';

// eff: bootstraps the popup UI by identifying active tabs, loading settings, and rendering control cards
async function main(): Promise<void> {
  enableSmoothScroll();

  const messenger = createMessenger('popup');

  let activeTab: chrome.tabs.Tab | null = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0] || null;
  } catch {
    // note: failure to query tabs usually indicates the popup was opened in a non-browser context (e.g. devtools)
  }

  initNavigation();

  const { gSettings, registryEntries, dict } = await initSettings();

  // eff: lazy load side panel only when needed
  const { initSidePanel } = await import('./side-panel');
  initSidePanel();

  if (activeTab?.id) {
    const { bindRemoteUI } = await import('../remote');
    bindRemoteUI(activeTab.id, dict);
  }

  let currentSettings = gSettings;
  const getGlobalSettings = () => currentSettings;

  // goal: keep local popup state in sync with global setting updates from the background
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.globalSettings?.newValue) {
      currentSettings = changes.globalSettings.newValue;
    }
  });

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
    const result = await messenger.send('TAB_GET_VISIBLE_TABS');
    const visibleTabIds = result?.tabs ?? [];
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
  } catch {
    // rule: if the prioritized list is unavailable, fallback to iterating all tabs (less performant)
    console.debug('[SPECTRA Popup] TAB_GET_VISIBLE_TABS not available, falling back.');
    const allTabs = await chrome.tabs.query({});

    for (const tab of allTabs) {
      if (activeTab && tab.id === activeTab.id) continue;
      if (isRestrictedUrl(tab.url)) continue;

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

