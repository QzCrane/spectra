// goal: orchestrates content script initialization, core module bootstrapping, and lifecycle loops
document.documentElement.setAttribute('data-spectra-content-loaded', 'true');

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
import { Registry } from '../../shared/registry';
import { createSnapshot, mountStub, consumeStub } from './sentinel';
import { getSiteBridge } from '../logic/site-bridge/registry';
// note: YouTube specialization is now handled by SiteBridge architecture automagically

const log = logger.content;

// task: handle legacy versions that don't have the teardown listener
// note: pre-PHS versions don't know how to clean up, so we manually scan and kill them
function cleanupLegacyTransitions() {
  const media = document.querySelectorAll('video, audio');
  log.debug(`[Transition] Scanning ${media.length} media elements for legacy traces...`);

  media.forEach(el => {
    const m = el as any;
    // rule: if an old _vm exists, try to disconnect it to release the media element
    if (m._vm) {
      try {
        if (m._vm.source) m._vm.source.disconnect();
        if (m._vm.context && m._vm.context.close) m._vm.context.close();
      } catch (e) { }
      delete m._vm;
    }
    // rule: clear dataset flags that would prevent new version from attaching
    delete m.dataset.vmAttached;
    delete m.dataset.vmProbed;
  });
}

window.addEventListener('SPECTRA_TERMINATED_OLD_VERSION', () => {
  if ((window as any).__SPECTRA_TEARDOWN__) {
    (window as any).__SPECTRA_TEARDOWN__();
    delete (window as any).__SPECTRA_TEARDOWN__;
  }
});

// task: always ensure a clean slate, especially after extension reloads where isolated variables are lost
cleanupLegacyTransitions();

// eff: force re-initialization on every injection (static + dynamic coexist safely)
(window as any).__SPECTRA_INJECTED__ = true;
(window as any).__SPECTRA_VERSION__ = chrome.runtime.getManifest().version;
(window as any).__SPECTRA_LISTENERS_READY__ = false;

initSpectra();

// goal: bootstraps the extension logic within the host page context
async function initSpectra(): Promise<void> {
  const registry = new Registry();
  log.info(`SPECTRA Initializing... ${chrome.runtime.getManifest().version}`);

  const messenger = createMessenger('content');
  const policyEngine = new PolicyEngine();
  const audioController = new WebAudioController();

  // task: attempt to inherit state from previous version (hot update)
  const recoveredState = consumeStub();

  // task: if no stub, fetch persisted config from background (tabSession > domain preset > default)
  let initialConfig = recoveredState?.config;
  if (!initialConfig) {
    try {
      const bgStatus = await messenger.send('AUDIO_GET_STATUS');
      if (bgStatus?.config) initialConfig = bgStatus.config;
    } catch { /* background unreachable on first load race */ }
  }

  const settingsManager = createSettingsManager(messenger);
  const captureManager = createCaptureManager(messenger);

  const state: PolicyExecutorState = {
    config: initialConfig ?? { ...DEFAULT_AUDIO_CONFIG },
    activeMode: null,
    hasGesture: false,
    userHasInteracted: !!recoveredState,
    isPopupOpen: false,
  };

  const deps: any = { messenger, policyEngine, audioController, captureManager, settingsManager, state };
  const messageHandler = createMessageHandler(deps);

  chrome.runtime.onMessage.addListener(messageHandler);

  registry.track(() => chrome.runtime.onMessage.removeListener(messageHandler));

  const policyExecutor = await createPolicyExecutor(
    { messenger, policyEngine, audioController, captureManager, settingsManager },
    state
  );
  deps.policyExecutor = policyExecutor;

  // task: track audio context for destruction on next update
  registry.track(() => {
    log.debug('[Registry] Tearing down AudioContext...');
    audioController.destroyContext().catch(() => { });
  });

  registry.track(() => {
    // eff: mount current state into stub before tearing down to allow next version to inherit
    const snapshot = createSnapshot(state);
    mountStub(snapshot);
  });

  // eff: route all cleanup to the registry for atomic disposal
  (window as any).__SPECTRA_TEARDOWN__ = () => {
    registry.dispose();
    log.info('SPECTRA Version Transition: Old logic dismantled.');
  };

  setupPopupConnectionListener(state, () => {
    policyExecutor.updateBadge();
  });



  registry.track(createMediaObserver(state, audioController, policyExecutor));

  const stateReapplyId = createStateReapplyInterval(state, policyExecutor);
  registry.track(() => clearInterval(stateReapplyId));

  const mediaReportId = createMediaReportInterval(messenger, state);
  registry.track(() => clearInterval(mediaReportId));

  // task: handle user gestures correctly with registry tracking
  const gestureCleanup = setupUserGestureListeners(state, audioController, policyExecutor);
  registry.track(gestureCleanup);

  registry.track(setupFullscreenHandler(state, policyExecutor, captureManager));

  registry.track(createNavigationObserver({
    policyExecutor,
    onNavigate: () => policyExecutor.applyState(),
  }));

  setConfigGetter(() => state.config);
  setConfigUpdater((changes, options) => policyExecutor.updateConfig(changes, options));

  registry.addEventListener(window, 'message', ((event: MessageEvent) => {
    if (event.data?.type === 'SPECTRA_RATE') {
      // fix: on YouTube, speed sync is handled exclusively by the YouTubeBridge
      // SPECTRA_RATE from playback-rate.ts hijack would bypass bridge's cooldown/guard
      // and poison the config to speed=1 during video transitions
      const bridge = getSiteBridge();
      if (bridge.shouldInhibitDomSync()) return;

      const newSpeed = event.data.speed;
      policyExecutor.updateConfig({ speed: newSpeed }, { isNativeSync: true });
    }
  }) as any);

  initHotkeyListener().then(cleanup => { registry.track(cleanup); });

  try {
    // task: recover from stub OR load from background with retry
    if (recoveredState) {
      log.info('[Handoff] State recovered from stub.');
      policyExecutor.applyState();
    } else {
      // rule: if no stub, it's either a fresh page load or an extension hard-reload
      // we must ensure we get the latest config before applying state
      await loadConfigAndApply(messenger, state, settingsManager, policyExecutor);
    }

    reportMediaState(messenger, state);
  } catch (e) {
    log.error('Initialization failed:', e);
  }

  (window as any).__SPECTRA_LISTENERS_READY__ = true;
  log.info('Content Script ready.');
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
      const readyState = event.data.readyState ?? 4;

      // Avoid trivial updates
      if (Math.abs((state.config.speed || 1) - newSpeed) < 0.05) return;

      // rule: GENERIC SOLUTION for implicit defaults overriding configs during SPA navigation/loading
      // Natively, setting the video src initiates a media swap, during which scripts reset playbackRate to 1.0 (readyState < 2 HAVE_CURRENT_DATA)
      // A genuine user interaction (via browser UI config to 1x) would only practically occur when video is buffering/playing (readyState >= 2)
      if (newSpeed === 1 && readyState < 2) {
        log.debug(`[Universal] Ignored programmatic script reset to 1x during media context swap`);
        return;
      }

      log.debug(`[Universal] External speed change: ${newSpeed}x`);

      // Update config as native sync (don't trigger re-application)
      policyExecutor.updateConfig({ speed: newSpeed }, { isNativeSync: true });
    }
  });
}
