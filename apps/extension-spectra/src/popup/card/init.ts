// goal: main entry point for initializing a tab control card, aggregating status probing, DOM setup, and event binding

import { predictCapture } from '@nexus/audio-engine';
import { getAudioConfig, type GlobalSettings } from '@nexus/kernel';
import { Actions } from '@nexus/contracts';
import type { I18NDict, ContentStatusResponse } from '../types';
import { getDomain, sendToTab, sendToBackground } from '../utils/dom';
import { cardRenderCallbacks } from '../views/settings';
import { getCardUIElements } from './ui-elements';
import { cleanConfig, type CardInternalState, type InitCardParams } from './types';
import { createGetCapturing, createUpdateFn } from './state';
import { createRenderFn } from './render';
import { bindCardEvents } from './events';
import { setupCardMessaging } from './messaging';
import { prepareCardDom } from './dom-init';
import { bindCardIconClick, registerCard } from '../side-panel';

// post: returns true if card was successfully initialized and appended to the container; false if the tab is non-responsive or should be skipped
export async function initCard(params: InitCardParams): Promise<boolean> {
  const { container, template, tab, dict, registryEntries, getGlobalSettings, createEqCurveDrawer } = params;

  if (!tab.id) return false;
  const tabId = tab.id;

  // note: probe the content script to verify connectivity and retrieve the current playback/paused state
  const status = await sendToTab<ContentStatusResponse>(tabId, 'AUDIO_GET_STATUS', {});
  if (!status) {
    // rule: abort card creation if the content script is dead or unreachable (e.g. extension updated but page not refreshed)
    return false;
  }

  const isCaptureActive = await sendToBackground<boolean>('CAPTURE_GET_STATE', { tabId });

  let isRemoteActive = false;
  try {
    const remoteStatus = await chrome.runtime.sendMessage({
      action: Actions.REMOTE_GET_SESSION,
      tabId,
    });
    isRemoteActive = remoteStatus?.connected === true;
  } catch { /* silent fail */ }

  const hasActiveMedia = tab.audible || isCaptureActive || (status?.isPlaying);

  // rule: retention logic ensures a card stays visible for a grace period after audio stops, allowing the user to resume control
  if (!hasActiveMedia && !isRemoteActive) {
    const pauseRetentionSeconds = getGlobalSettings().pauseRetentionSeconds ?? 60;
    if (pauseRetentionSeconds > 0 && status.pausedAt) {
      const pausedSeconds = (Date.now() - status.pausedAt) / 1000;
      if (pausedSeconds > pauseRetentionSeconds) {
        return false;
      }
    }
  }

  const domain = getDomain(tab.url || '');

  const isRestrictedSite = registryEntries.some(e =>
    e.restricted !== false && domain.includes(e.domain)
  );

  // note: priority is Content Script runtime state > Saved Profile; cleanConfig ensures schema compliance
  // rule: status.config reflects current session state (may differ from saved preset)
  const runtimeConfig = status?.config;
  const savedConfig = runtimeConfig ?? await getAudioConfig(domain);
  const config = cleanConfig(savedConfig);

  const settings = getGlobalSettings();
  const predictedCapture = predictCapture({
    config,
    isRestricted: isRestrictedSite,
    visualizerEnabled: settings.visualizerEnabled,
  });

  const effectiveCaptureState = isCaptureActive || predictedCapture;

  const state: CardInternalState = {
    config,
    isCaptureActive: effectiveCaptureState,
    userInteracted: status?.userInteracted ?? false,
    isRestrictedSite,
    actualMode: status?.mode ?? null,
    isDragging: false,
  };

  const { ui, cardEl } = prepareCardDom({ template, container, tab, dict });

  if (params.isBackground && ui.btnGotoTab) {
    ui.btnGotoTab.classList.remove('hidden');
  }

  const getCapturing = createGetCapturing(state);

  const sliderRow = cardEl.querySelector('.eq-sliders-row') as HTMLElement;
  const eqCanvas = cardEl.querySelector('.eq-curve-canvas') as HTMLCanvasElement;
  const eqDrawer = createEqCurveDrawer?.(eqCanvas, sliderRow, () => state.config.eqValues);
  const drawEqCurve = (color: string) => eqDrawer?.draw(color);
  const updateMetrics = eqDrawer?.updateMetrics ?? (() => { });

  const render = createRenderFn({
    ui,
    state,
    getCapturing,
    drawEqCurve,
    getVizEnabled: () => getGlobalSettings().visualizerEnabled !== false,
    getGlobalSettings,
  });

  const update = createUpdateFn(state, tabId, getCapturing, render, getGlobalSettings);

  if (ui.vizIsland) {
    ui.vizIsland.classList.toggle('hidden', getGlobalSettings().visualizerEnabled === false);
  }

  bindCardEvents({
    ui,
    state,
    tabId,
    tabUrl: tab.url || '',
    update,
    getCapturing,
    onMetricsUpdate: updateMetrics,
    render,
  });

  if (ui.icon) {
    bindCardIconClick(ui.icon, tabId, tab.title || '', tab.favIconUrl || '');
  }

  // note: register the update handle globally so settings can trigger re-renders from the Settings view
  registerCard(tabId, state.config, update, () => state.config);

  const cleanupMessaging = setupCardMessaging({ tabId, state, render });
  window.addEventListener('unload', cleanupMessaging);

  cardRenderCallbacks.push(() => {
    render();
  });

  render();

  // goal: dynamically import the visualizer loop to optimize initial popup load time
  if (ui.canvas) {
    const { createVizLoop } = await import('../visualizer/loop');
    const startViz = createVizLoop({
      canvas: ui.canvas,
      tabId,
      getConfig: () => state.config,
      getCapturing,
      getGlobalSettings,
      initialPredictedCapture: state.isRestrictedSite && getGlobalSettings().visualizerEnabled !== false,
      isCaptureActive: state.isCaptureActive,
    });
    startViz();
  }

  return true;
}
