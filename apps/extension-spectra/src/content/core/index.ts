// goal: orchestrates content script initialization, core module bootstrapping, and lifecycle loops
// eff: injects E2E test markers, initializes functional managers, and starts observer loops

import { createMessenger, DEFAULT_AUDIO_CONFIG } from '@nexus/kernel';
import { PolicyEngine, WebAudioController } from '@nexus/audio-engine';

import { isExtensionContextValid, safeSend } from './context-guard';
import { createSettingsManager } from './settings-manager';
import { createCaptureManager } from '../audio/capture-manager';
import { createPolicyExecutor, type PolicyExecutorState } from '../logic/policy-executor';
import { createMessageHandler } from '../logic/message-handler';
import { logger } from '../../shared/logger';

import {
  createMediaObserver,
  createStateReapplyInterval,
  createMediaReportInterval,
  reportMediaState,
  setupUserGestureListeners,
  setupPopupConnectionListener,
  setupFullscreenHandler,
  createNavigationObserver,
  cleanupIntervals,
} from './lifecycle';
import { initHotkeyListener, setConfigGetter, setConfigUpdater } from '../input/hotkey-listener';
import { initYouTubeAdapter } from '../adapters/youtube-adapter';

const log = logger.content;

// rule: prevent duplicate script execution on dynamic pages or manifest re-injections
if (
  (window as unknown as { __SPECTRA_INJECTED__?: boolean }).__SPECTRA_INJECTED__
) {
  log.debug('Already injected, skipping.');
} else {
  (
    window as unknown as { __SPECTRA_INJECTED__?: boolean }
  ).__SPECTRA_INJECTED__ = true;
  // note: data-spectra-injected attribute is used by E2E test suites to verify content script status
  document.documentElement.setAttribute('data-spectra-injected', 'true');
  initSpectra();
}

// goal: bootstraps the extension logic within the host page context
async function initSpectra(): Promise<void> {
  log.info('SPECTRA Initializing... v24.0.1');

  const messenger = createMessenger('content');
  const policyEngine = new PolicyEngine();
  const audioController = new WebAudioController();

  log.info('Core components created:', {
    hasMessenger: !!messenger,
    hasPolicyEngine: !!policyEngine,
    calculateModeType: typeof policyEngine.calculateMode,
    hasAudioController: !!audioController
  });

  const settingsManager = createSettingsManager(messenger);
  const captureManager = createCaptureManager(messenger);

  const state: PolicyExecutorState = {
    config: { ...DEFAULT_AUDIO_CONFIG },
    activeMode: null,
    hasGesture: false,
    userHasInteracted: false,
    isPopupOpen: false,
  };

  // post: policyExecutor is fully initialized with the domain's CORS status pre-fetched
  const policyExecutor = await createPolicyExecutor(
    { messenger, policyEngine, audioController, captureManager, settingsManager },
    state
  );

  // note: popup connection listener is set up after policyExecutor to enable immediate UI sync on popup open
  setupPopupConnectionListener(state, () => {
    // eff: when popup opens, trigger UI sync to display current volume state
    policyExecutor.updateBadge();
  });

  const messageHandler = createMessageHandler({
    state,
    policyExecutor,
    captureManager,
    settingsManager,
    getVisualizerData: () => audioController.getVisualizerData(),
  });
  chrome.runtime.onMessage.addListener(messageHandler);

  let cleanupObserver: (() => void) | null = null;
  let cleanupFullscreen: (() => void) | null = null;
  let cleanupNavigation: (() => void) | null = null;
  let cleanupHotkeys: (() => void) | null = null;
  const intervals: { stateReapply?: ReturnType<typeof setInterval>; mediaReport?: ReturnType<typeof setInterval> } = {};

  // goal: ensures consistent resource cleanup when the extension is updated or disabled
  const handleContextInvalid = () => {
    cleanupIntervals(intervals);
    cleanupObserver?.();
    cleanupFullscreen?.();
    cleanupNavigation?.();
    cleanupHotkeys?.();
    log.debug('Extension context invalidated, cleanup complete.');
  };

  cleanupObserver = createMediaObserver(state, audioController, policyExecutor);

  intervals.stateReapply = createStateReapplyInterval(state, policyExecutor, handleContextInvalid);
  intervals.mediaReport = createMediaReportInterval(messenger, handleContextInvalid);

  setupUserGestureListeners(state, audioController, policyExecutor);

  // note: fullscreen transitions require pause ONLY for CAPTURE mode (Chrome tabCapture + fullscreen conflict)
  cleanupFullscreen = setupFullscreenHandler(state, policyExecutor, captureManager);

  // rule: re-evaluate CORS policy on SPA navigation (URL path changes) to handle cross-origin routing
  cleanupNavigation = createNavigationObserver({
    policyExecutor,
    onNavigate: () => policyExecutor.applyState(),
  });

  // CRITICAL: set config callbacks BEFORE hotkey listener to ensure they're available when hotkeys fire
  setConfigGetter(() => state.config);
  setConfigUpdater((changes, options) => policyExecutor.updateConfig(changes, options));

  // eff: listen for playbackRate changes from injector (universal player support)
  setupPlaybackRateListener(state, policyExecutor);

  // eff: initialize YouTube adapter to listen for injector responses
  initYouTubeAdapter();

  initHotkeyListener().then(cleanup => { cleanupHotkeys = cleanup; });

  loadConfigAndApply(messenger, state, settingsManager, policyExecutor);

  log.info('Content Script initialized.');
}

// eff: retrieves initial configuration from storage and executes the first state application
async function loadConfigAndApply(
  messenger: ReturnType<typeof createMessenger>,
  state: PolicyExecutorState,
  settingsManager: ReturnType<typeof createSettingsManager>,
  policyExecutor: import('../logic/policy-executor').PolicyExecutor
): Promise<void> {
  if (!isExtensionContextValid()) {
    log.debug('Extension context invalidated, skipping config load.');
    return;
  }

  try {
    const status = await safeSend(() => messenger.send('AUDIO_GET_STATUS'));
    if (status?.config) {
      state.config = status.config;
    }

    await settingsManager.load();

    reportMediaState(messenger);

    policyExecutor.applyState();
  } catch {
    // note: failure indicates background worker is likely offline or restarting
  }
}

// eff: listen for playbackRate changes from injector (universal player support)
// note: this enables bidirectional sync with custom players (YouTube, Netflix, etc.)
function setupPlaybackRateListener(
  state: PolicyExecutorState,
  policyExecutor: import('../logic/policy-executor').PolicyExecutor
): void {
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'SPECTRA_RATE') {
      const newSpeed = event.data.speed;

      // Avoid trivial updates
      if (Math.abs((state.config.speed || 1) - newSpeed) < 0.05) return;

      log.debug(`[Universal] External speed change: ${newSpeed}x`);

      // Update config as native sync (don't trigger re-application)
      policyExecutor.updateConfig({ speed: newSpeed }, { isNativeSync: true });
    }
  });
}
