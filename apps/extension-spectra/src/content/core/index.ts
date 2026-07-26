// goal: orchestrates content script initialization, core module bootstrapping, and lifecycle loops

import { PolicyEngine, WebAudioController } from '@nexus/audio-engine';
import {
	SPECTRA_CONTENT_RUNTIME_REVISION,
} from '@nexus/contracts';

import { createSettingsManager } from './settings-manager';
import { createCaptureManager } from '../audio/capture-manager';
import type { CaptureManager } from '../audio/capture-manager';
import { createPolicyExecutor } from '../logic/policy-executor';
import { createMessageHandler } from '../logic/message-handler';
import { logger } from '../../shared/logger';

import {
  createMediaObserver,
  createMediaStateReporter,
  reportMediaState,
  setupUserGestureListeners,
  setupPopupConnectionListener,
  createNavigationObserver,
} from './lifecycle';
import {
  initHotkeyListener,
} from '../input/hotkey-listener';
import { Registry } from '../../shared/registry';
import { createSnapshot, mountStub, consumeStub } from './sentinel';
import { sendSpectraRequest } from '../../shared/spectra-client';
import {
	setContentRuntimeDisposer,
	setContentRuntimeOwnershipProvider,
	setContentRuntimeReady,
} from '../../shared/content-runtime';
import {
	assembleInitialState,
	shouldApplyInitialPolicy,
	type InitialStateSource,
} from './initial-state';
import type { ContentDeps, PolicyExecutorState } from '../types';
import type { SettingsManager } from './settings-manager';
import {
	NativeMediaExecutor,
	registerNativeMediaExecutor,
} from '../logic/native-media-executor';
import { createAudioRuntimeControlDelegate } from '../logic/audio-runtime-control-delegate';
import { registerControlOperationExecutor } from '../logic/control-operation-executor';
import { MediaRegistry, setActiveMediaRegistry } from './media-registry';
import { disposeABLoops, listABOwnership, observeABLoopSources } from '../video/ab-loop';
import { disposeMarkers, listMarkerOwnership, observeMarkerSources } from '../video/time-marker';
import { registerTrustedActivationBridge } from '../input/trusted-activation-bridge';
import { createFullscreenAudioHandoff } from './fullscreen-audio-handoff';

const log = logger.content;

interface SpectraContentWindow extends Window {
  __SPECTRA_TEARDOWN__?: () => void | Promise<void>;
  __SPECTRA_INJECTED__?: boolean;
  __SPECTRA_VERSION__?: string;
  __SPECTRA_LISTENERS_READY__?: boolean;
  __SPECTRA_AUDIO_CONTROLLER_V2__?: WebAudioController;
  __SPECTRA_CONTENT_RUNTIME__?: ContentRuntime;
}

const spectraWindow = window as SpectraContentWindow;

interface ContentRuntime {
  readonly revision: string;
  readonly registry: Registry;
  disposed: boolean;
  state?: PolicyExecutorState;
  release?: () => Promise<void>;
  disposing?: Promise<void>;
  dispose(handoff?: boolean): Promise<void>;
}

function createContentRuntime(): ContentRuntime {
  const registry = new Registry();
  const runtime: ContentRuntime = {
		revision: SPECTRA_CONTENT_RUNTIME_REVISION,
    registry,
    disposed: false,
    dispose(handoff = false) {
      if (runtime.disposing) return runtime.disposing;
			runtime.disposed = true;
			runtime.disposing = (async () => {
				if (!handoff) await runtime.release?.();
				registry.dispose();
				if (runtime.state) mountStub(createSnapshot(runtime.state));
				if (spectraWindow.__SPECTRA_CONTENT_RUNTIME__ === runtime) {
					setContentRuntimeReady(null);
					setContentRuntimeDisposer(null);
					spectraWindow.__SPECTRA_LISTENERS_READY__ = false;
				}
			})();
			return runtime.disposing;
    },
  };
  return runtime;
}

function isCurrentRuntime(runtime: ContentRuntime): boolean {
  return !runtime.disposed && spectraWindow.__SPECTRA_CONTENT_RUNTIME__ === runtime;
}

// A dynamic reinjection disposes listeners and UI state immediately. The audio
// controller/graphs remain page-owned because MediaElementSourceNode bindings
// cannot be recreated safely after their AudioContext is closed.
void spectraWindow.__SPECTRA_CONTENT_RUNTIME__?.dispose(true);
void spectraWindow.__SPECTRA_TEARDOWN__?.();

const contentRuntime = createContentRuntime();
spectraWindow.__SPECTRA_CONTENT_RUNTIME__ = contentRuntime;
spectraWindow.__SPECTRA_TEARDOWN__ = () => contentRuntime.dispose(true);
setContentRuntimeDisposer(() => contentRuntime.dispose(false));
spectraWindow.__SPECTRA_INJECTED__ = true;
spectraWindow.__SPECTRA_VERSION__ = chrome.runtime.getManifest().version;
spectraWindow.__SPECTRA_LISTENERS_READY__ = false;

contentRuntime.registry.addEventListener(window, 'SPECTRA_TERMINATED_OLD_VERSION', () => {
  void contentRuntime.dispose();
});

void initSpectra(contentRuntime);

interface InitContext {
  registry: Registry;
  policyEngine: PolicyEngine;
  audioController: WebAudioController;
  settingsManager: SettingsManager;
  captureManager: CaptureManager;
  state: PolicyExecutorState;
  deps: ContentDeps;
}

// eff: assembles state from a same-document handoff, sender-bound session, or fresh config
async function createInitialState(): Promise<{ state: PolicyExecutorState; source: InitialStateSource }> {
  const recoveredState = consumeStub();
  const sessionRequest = sendSpectraRequest('spectra.audio.session.current', {})
    .then((result) => result.ok ? result.data : null)
    .catch(() => null);
  const configRequest = recoveredState?.config
    ? Promise.resolve(null)
    : sendSpectraRequest('spectra.audio.config.get', {})
      .then((result) => result.ok ? result.data : null)
      .catch(() => null);
  const [session, config] = await Promise.all([sessionRequest, configRequest]);

  return assembleInitialState({ handoff: recoveredState, session, config });
}

// eff: sets up core messaging infrastructure (onMessage listener + policy executor)
function bootstrapMessaging(ctx: InitContext): void {
  ctx.deps.state = ctx.state;
  const messageHandler = createMessageHandler(ctx.deps);

  chrome.runtime.onMessage.addListener(messageHandler);
  ctx.registry.track(() => chrome.runtime.onMessage.removeListener(messageHandler));
}

// eff: registers all lifecycle listeners (popup, media, gestures, fullscreen, navigation, hotkeys)
function bootstrapLifecycle(ctx: InitContext, runtime: ContentRuntime): void {
  const { state, audioController, registry, deps } = ctx;
  const policyExecutor = deps.policyExecutor!;

  registry.track(setupPopupConnectionListener(state));

  registry.track(createMediaObserver(state, audioController, policyExecutor));

  registry.track(createMediaStateReporter(state));

  registry.addEventListener(window, 'pagehide', () => {
	void sendSpectraRequest('spectra.audio.session.flush', {}).catch(() => undefined);
  });

  const gestureCleanup = setupUserGestureListeners(state, audioController, policyExecutor);
  registry.track(gestureCleanup);

  registry.track(createNavigationObserver({
    onNavigate: () => policyExecutor.applyState({ navigation: true }),
  }));

  void initHotkeyListener(ctx.settingsManager, state).then((cleanup) => {
    if (isCurrentRuntime(runtime)) registry.track(cleanup);
    else cleanup();
  });
}

// eff: hydrates restored ownership or applies one authoritative policy before READY
async function applyInitialState(
	ctx: InitContext,
	source: InitialStateSource,
	runtime: ContentRuntime,
): Promise<void> {
	if (!isCurrentRuntime(runtime)) return;
	const { state, deps } = ctx;
	const policyExecutor = deps.policyExecutor!;
	try {
		if (source !== 'fresh') {
			log.info(`[Hydration] Runtime state restored from ${source}.`);
		}
		// createInitialState already resolved the authoritative audio session/config.
		// A same-document handoff preserves every page-owned mode; a session snapshot
		// preserves an acknowledged Capture owner. Those paths hydrate before READY,
		// while a fresh load or non-Capture session applies policy exactly once.
		if (shouldApplyInitialPolicy(state, source)) await policyExecutor.applyState();
		if (!isCurrentRuntime(runtime)) return;
		reportMediaState(state);
  } catch (e) {
    log.error('Initialization failed:', e);
  }
}

// goal: bootstraps the extension logic within the host page context
async function initSpectra(runtime: ContentRuntime): Promise<void> {
  const { registry } = runtime;
  log.info(`SPECTRA Initializing... ${chrome.runtime.getManifest().version}`);

  const policyEngine = new PolicyEngine();
  const audioController = spectraWindow.__SPECTRA_AUDIO_CONTROLLER_V2__ ?? new WebAudioController();
  spectraWindow.__SPECTRA_AUDIO_CONTROLLER_V2__ = audioController;
  const settingsManager = createSettingsManager();
  const captureManager = createCaptureManager();
  const initial = await createInitialState();
  if (!isCurrentRuntime(runtime)) return;
	const state = initial.state;
	runtime.state = state;
	runtime.release = async () => {
		// Capture is owned by the background/offscreen lifecycle and survives the
		// short-lived Popup observation runtime. Navigation and tab removal perform
		// the authoritative teardown; stopping here lets a closing Popup race a
		// freshly acknowledged Capture and overwrite it with bypass/idle.
		await audioController.cleanup();
	};

	if (initial.source !== 'fresh') {
		// actualMode owns the processor. An error/stopping phase may still retain
		// the offscreen graph and lease, so hydration must not claim it is inactive
		// and allow a duplicate START or an unowned transition.
		const captureActive = state.actualMode === 'capture';
		captureManager.restoreState({
			active: captureActive,
			phase: state.phase,
			generation: state.generation,
			error: state.lastError,
			actualConfig: captureActive ? state.appliedConfig : undefined,
		});
	}

	const deps: ContentDeps = {
		policyEngine,
		audioController,
		captureManager,
		settingsManager,
		state,
		getVisualizerData: () => audioController.getVisualizerData(),
		setVisualizerSubscribed: async (subscribed) => {
			state.visualizerSubscribed = subscribed;
			// A visualizer lease is an observational tap only. It may attach to an
			// already-owned Media WebAudio graph, but it never runs policy or creates
			// Media WebAudio/Capture on an otherwise native page.
			audioController.setVisualizerSubscribed(subscribed);
			return subscribed;
		},
	};
	const mediaRegistry = new MediaRegistry();
	registry.track(mediaRegistry);
	registry.track(setActiveMediaRegistry(mediaRegistry));
	registry.track(setContentRuntimeOwnershipProvider(() => {
		const ownership = new Map<string, {
			target: import('@nexus/contracts').MediaTarget;
			markerCount: number;
			abActive: boolean;
		}>();
		for (const marker of listMarkerOwnership()) {
			ownership.set(
				`${marker.target.documentId}:${marker.target.mediaId}:${marker.target.sourceRevision}`,
				{ target: marker.target, markerCount: marker.markerCount, abActive: false },
			);
		}
		for (const ab of listABOwnership()) {
			const key = `${ab.target.documentId}:${ab.target.mediaId}:${ab.target.sourceRevision}`;
			const current = ownership.get(key);
			ownership.set(key, {
				target: ab.target,
				markerCount: current?.markerCount ?? 0,
				abActive: ab.active,
			});
		}
		return [...ownership.values()];
	}));
	registry.track(mediaRegistry.subscribe((target, event) => {
		if (event !== 'removed') return;
		void sendSpectraRequest(
			'spectra.content.source.released',
			{ target },
			{ documentId: target.documentId },
		).catch(() => undefined);
	}));
	registry.track(observeABLoopSources(mediaRegistry, (target) => {
		void sendSpectraRequest('spectra.control.operation.submit', {
			source: 'restore',
			target,
			operation: 'ab-clear',
			payload: {},
		}).catch(() => undefined);
	}));
	registry.track(observeMarkerSources(mediaRegistry));
	registry.track(disposeABLoops);
	registry.track(disposeMarkers);
	const nativeExecutor = new NativeMediaExecutor(mediaRegistry);
	registry.track(nativeExecutor);
	registry.track(registerNativeMediaExecutor(nativeExecutor));
	registry.track(registerControlOperationExecutor(nativeExecutor));
	registry.track(registerTrustedActivationBridge());
	bootstrapMessaging({ registry, policyEngine, audioController, settingsManager, captureManager, state, deps });

  const policyExecutor = await createPolicyExecutor(
    { policyEngine, audioController, captureManager, settingsManager },
    state,
    () => isCurrentRuntime(runtime),
  );
  if (!policyExecutor || !isCurrentRuntime(runtime)) return;
	deps.policyExecutor = policyExecutor;
  registry.track(policyExecutor);
	const fullscreenHandoff = createFullscreenAudioHandoff({
		state,
		policyExecutor,
		audioController,
		captureManager,
	});
	registry.track(fullscreenHandoff);
	nativeExecutor.setAudioRuntimeDelegate(createAudioRuntimeControlDelegate(
		policyExecutor,
		state,
		fullscreenHandoff,
	));
	registry.track(() => nativeExecutor.setAudioRuntimeDelegate(null));

	bootstrapLifecycle(
		{ registry, policyEngine, audioController, settingsManager, captureManager, state, deps },
		runtime,
	);

	await applyInitialState(
		{ registry, policyEngine, audioController, settingsManager, captureManager, state, deps },
		initial.source,
		runtime,
	);

	// READY is a transaction boundary: executor registration and the initial
	// audio state are both complete. Presentation-only Content settings can load
	// afterward because they cannot overwrite control state.
	if (!isCurrentRuntime(runtime)) return;
	spectraWindow.__SPECTRA_LISTENERS_READY__ = true;
	setContentRuntimeReady(runtime.revision);
	void sendSpectraRequest('spectra.content.runtime.ready', {
		runtimeRevision: runtime.revision,
	}).catch(() => undefined);
	void settingsManager.load().catch((error) => {
		log.warn('Content presentation settings load failed:', error);
	});

	if (!isCurrentRuntime(runtime)) return;
	log.info('Content Script ready.');
}

