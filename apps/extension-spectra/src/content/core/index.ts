// goal: orchestrates content script initialization, core module bootstrapping, and lifecycle loops
document.documentElement.setAttribute('data-spectra-content-loaded', 'true');

import { createMessenger, DEFAULT_AUDIO_CONFIG } from '@nexus/kernel';
import { PolicyEngine, WebAudioController } from '@nexus/audio-engine';

import { isExtensionContextValid, safeSend } from './context-guard';
import { createSettingsManager } from './settings-manager';
import { createCaptureManager } from '../audio/capture-manager';
import type { CaptureManager } from '../audio/capture-manager';
import { createPolicyExecutor } from '../logic/policy-executor';
import { createMessageHandler, flushPendingQueue } from '../logic/message-handler';
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
} from './lifecycle';
import { initHotkeyListener, setConfigGetter, setConfigUpdater } from '../input/hotkey-listener';
import { Registry } from '../../shared/registry';
import { createSnapshot, mountStub, consumeStub } from './sentinel';
import { getSiteBridge } from '../logic/site-bridge/registry';
import type { ContentDeps, PolicyExecutorState } from '../types';
import type { PolicyExecutor } from '../logic/policy-executor';
import type { SettingsManager } from './settings-manager';

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

interface InitContext {
  registry: Registry;
  messenger: ReturnType<typeof createMessenger>;
  policyEngine: PolicyEngine;
  audioController: WebAudioController;
  settingsManager: SettingsManager;
  captureManager: CaptureManager;
  state: PolicyExecutorState;
  deps: ContentDeps;
}

// eff: tries to inherit state from a zero-refresh stub, or falls back to background fetch
async function createInitialState(messenger: ReturnType<typeof createMessenger>): Promise<PolicyExecutorState> {
  const recoveredState = consumeStub();

  let initialConfig = recoveredState?.config;
  if (!initialConfig) {
    try {
      const bgStatus = await messenger.send('AUDIO_GET_STATUS');
      if (bgStatus?.config) initialConfig = bgStatus.config;
    } catch { /* background unreachable on first load race */ }
  }

  return {
    config: initialConfig ?? { ...DEFAULT_AUDIO_CONFIG },
    activeMode: null,
    hasGesture: false,
    userHasInteracted: !!recoveredState,
    isPopupOpen: false,
  };
}

// eff: sets up core messaging infrastructure (onMessage listener + policy executor)
function bootstrapMessaging(ctx: InitContext): void {
  ctx.deps.state = ctx.state;
  const messageHandler = createMessageHandler(ctx.deps);

  chrome.runtime.onMessage.addListener(messageHandler);
  ctx.registry.track(() => chrome.runtime.onMessage.removeListener(messageHandler));
}

// eff: registers teardown cleanup hooks into the registry
function bootstrapTeardown(ctx: InitContext): void {
  ctx.registry.track(() => {
    log.debug('[Registry] Tearing down AudioContext...');
    ctx.audioController.destroyContext().catch(() => { });
  });

  ctx.registry.track(() => {
    const snapshot = createSnapshot(ctx.state);
    mountStub(snapshot);
  });

  (window as any).__SPECTRA_TEARDOWN__ = () => {
    ctx.registry.dispose();
    log.info('SPECTRA Version Transition: Old logic dismantled.');
  };
}

// eff: registers all lifecycle listeners (popup, media, gestures, fullscreen, navigation, hotkeys, rate sync)
function bootstrapLifecycle(ctx: InitContext): void {
  const { state, messenger, audioController, captureManager, registry, deps } = ctx;
  const policyExecutor = deps.policyExecutor!;

  setupPopupConnectionListener(state, () => policyExecutor.updateBadge());

  registry.track(createMediaObserver(state, audioController, policyExecutor));

  const stateReapplyId = createStateReapplyInterval(state, policyExecutor);
  registry.track(() => clearInterval(stateReapplyId));

  const mediaReportId = createMediaReportInterval(messenger, state);
  registry.track(() => clearInterval(mediaReportId));

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
      const bridge = getSiteBridge();
      if (bridge.shouldInhibitDomSync()) return;

      const newSpeed = event.data.speed;
      policyExecutor.updateConfig({ speed: newSpeed }, { isNativeSync: true });
    }
  }) as any);

  initHotkeyListener().then(cleanup => { registry.track(cleanup); });
}

// eff: applies the initial state -- either from a hot swap stub or a fresh background load
async function applyInitialState(ctx: InitContext): Promise<void> {
  const { state, messenger, settingsManager, deps } = ctx;
  const policyExecutor = deps.policyExecutor!;
  const hasRecovered = stdhubConsumed();

  try {
    if (hasRecovered) {
      log.info('[Handoff] State recovered from stub.');
      policyExecutor.applyState();
    } else {
      await loadConfigAndApply(messenger, state, settingsManager, policyExecutor);
    }
    reportMediaState(messenger, state);
  } catch (e) {
    log.error('Initialization failed:', e);
  }
}

// eff: wrapper around consumeStub() that returns true if a build was recovered
function stdhubConsumed(): boolean {
  return consumeStub() !== undefined;
}

// goal: bootstraps the extension logic within the host page context
async function initSpectra(): Promise<void> {
  const registry = new Registry();
  log.info(`SPECTRA Initializing... ${chrome.runtime.getManifest().version}`);

  const messenger = createMessenger('content');
  const policyEngine = new PolicyEngine();
  const audioController = new WebAudioController();
  const settingsManager = createSettingsManager(messenger);
  const captureManager = createCaptureManager(messenger);
  const state = await createInitialState(messenger);

  const deps: ContentDeps = { messenger, policyEngine, audioController, captureManager, settingsManager, state, getVisualizerData: () => audioController.getVisualizerData() };

  bootstrapMessaging({ registry, messenger, policyEngine, audioController, settingsManager, captureManager, state, deps });

  const policyExecutor = await createPolicyExecutor(
    { messenger, policyEngine, audioController, captureManager, settingsManager },
    state
  );
  deps.policyExecutor = policyExecutor;
  flushPendingQueue();

  bootstrapTeardown({ registry, messenger, policyEngine, audioController, settingsManager, captureManager, state, deps });
  bootstrapLifecycle({ registry, messenger, policyEngine, audioController, settingsManager, captureManager, state, deps });

  await applyInitialState({ registry, messenger, policyEngine, audioController, settingsManager, captureManager, state, deps });

  (window as any).__SPECTRA_LISTENERS_READY__ = true;
  log.info('Content Script ready.');
}

// eff: retrieves initial configuration from storage and executes the first state application
async function loadConfigAndApply(
  messenger: ReturnType<typeof createMessenger>,
  state: PolicyExecutorState,
  settingsManager: SettingsManager,
  policyExecutor: PolicyExecutor
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


