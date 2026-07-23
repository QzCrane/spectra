// goal: main entry point for initializing a tab control card, aggregating status probing, DOM setup, and event binding

import {
	audioSessionMatchesControlDocument,
	isActiveCaptureLifecycle,
  type AudioSessionSnapshot,
} from '@nexus/contracts';
import { sendSpectraRequest, sendSpectraTabRequest } from '../../shared/ui-spectra-client';
import { cardRenderCallbacks } from '../views/settings';
import { VISUALIZER_STATE_CHANGED_EVENT } from '../visualizer/events';
import {
	initialControlConfig,
  mergeAudioConfig,
  type CardInternalState,
  type InitCardParams,
} from './types';
import { createGetCapturing, createUpdateFn } from './state';
import { createRenderFn } from './render';
import { bindCardEvents } from './events';
import { setupCardMessaging } from './messaging';
import { prepareCardDom } from './dom-init';
import { bindCardIconClick, registerCard } from '../side-panel';

interface PopupObservationLease {
  documentId: string;
  runtimeRevision: string;
  capability: string;
}

const observationLeases = new Map<number, PopupObservationLease>();
let popupClosing = false;

async function acquirePopupObservation(tabId: number): Promise<void> {
  if (observationLeases.has(tabId) || popupClosing) return;
  const capability = `popup:${crypto.randomUUID()}`;
  const response = await sendSpectraRequest('spectra.content.runtime.ensure', {
    tabId,
    reason: 'observation',
    capability,
  }).catch(() => null);
  if (!response?.ok) return;
  const lease = {
    documentId: response.data.documentId,
    runtimeRevision: response.data.runtimeRevision,
    capability,
  };
  if (popupClosing) {
    void sendSpectraRequest('spectra.content.runtime.release', {
      runtimeRevision: lease.runtimeRevision,
      tabId,
      documentId: lease.documentId,
      reason: 'observation',
      capability: lease.capability,
    }).catch(() => undefined);
    return;
  }
  observationLeases.set(tabId, lease);
}

function releasePopupObservations(): void {
  popupClosing = true;
  for (const [tabId, lease] of observationLeases) {
    void sendSpectraRequest('spectra.content.runtime.release', {
      runtimeRevision: lease.runtimeRevision,
      tabId,
      documentId: lease.documentId,
      reason: 'observation',
      capability: lease.capability,
    }).catch(() => undefined);
  }
  observationLeases.clear();
}

window.addEventListener('pagehide', releasePopupObservations, { once: true });

// post: returns true if card was successfully initialized and appended to the container; false if the tab is non-responsive or should be skipped
export async function initCard(params: InitCardParams): Promise<boolean> {
  const { container, template, tab, dict, getGlobalSettings, createEqCurveDrawer } = params;

  if (!tab.id) return false;
  const tabId = tab.id;

  // rule: status reads are side-effect free; an unreachable document is omitted
  // until navigation or an explicit user operation installs the content runtime.
  const getRuntimeStatus = async () => {
    try {
      const result = await sendSpectraTabRequest(tabId, 'spectra.audio.runtime.get', {});
      return result.ok ? result.data : null;
    } catch {
      return null;
    }
  };

  const [status, controlSnapshot] = await Promise.all([
    getRuntimeStatus(),
    sendSpectraRequest(
      'spectra.control.snapshot.get',
      { tabId },
      { tabId },
    ).then((response) => response.ok ? response.data : null).catch(() => null),
  ]);

  let acknowledgedSession: AudioSessionSnapshot | null = null;
  try {
    const response = await sendSpectraRequest(
      'spectra.audio.session.get',
      { tabId },
      { tabId },
    );
    if (response.ok) acknowledgedSession = response.data;
  } catch { /* session reads stay side-effect free while the worker restarts */ }

	// Processor color is valid only when lifecycle and field-level actual state
	// identify the same document. A direct runtime read may fill this role only
	// for an acknowledged active Capture returned by the currently routed tab.
	if (!audioSessionMatchesControlDocument(acknowledgedSession, controlSnapshot)) acknowledgedSession = null;
	// An extension-page Capture request can commit before its document identity
	// is projected into ControlSnapshot. The direct content runtime read is still
	// routed to this exact tab and can safely prevent a false-blue Capture card;
	// all non-Capture lifecycle colors continue to require the matched session.
	const runtimeCaptureLifecycle = status?.actualMode === 'capture' && status.phase === 'active'
		? status
		: null;
	const lifecycle = acknowledgedSession ?? runtimeCaptureLifecycle;
	const isCaptureActive = isActiveCaptureLifecycle({
		actualMode: lifecycle?.actualMode,
		phase: lifecycle?.phase ?? 'idle',
	});

  let isRemoteActive = false;
  try {
    const remoteStatus = await sendSpectraRequest(
      'spectra.remote.session.get',
      { tabId },
      { tabId },
    );
    isRemoteActive = remoteStatus.ok && remoteStatus.data.connected;
  } catch { /* silent fail */ }

  const hasActiveMedia = tab.audible || isCaptureActive || status?.isPlaying === true;

  // rule: retention logic ensures a card stays visible for a grace period after audio stops, allowing the user to resume control
  if (params.isBackground && !hasActiveMedia && !isRemoteActive) {
    const pauseRetentionSeconds = getGlobalSettings().pauseRetentionSeconds ?? 60;
    if (pauseRetentionSeconds > 0 && status?.pausedAt) {
      const pausedSeconds = (Date.now() - status.pausedAt) / 1000;
      if (pausedSeconds > pauseRetentionSeconds) {
        return false;
      }
    }
  }

  // Route caches never predict card color. Only the acknowledged active runtime
  // may project the legacy compatibility flag used by the message adapter.
  const isRestrictedSite = isCaptureActive;

	// ControlSnapshot owns every field-level actual. Runtime/session status below
	// contributes lifecycle only and may never overwrite or backfill these fields.
	const config = initialControlConfig(controlSnapshot);

  const state: CardInternalState = {
    config,
    stableConfig: mergeAudioConfig(config, { eqValues: [...config.eqValues] }),
    controlSnapshot,
    isCaptureActive,
    userInteracted: status?.userInteracted ?? (controlSnapshot?.revision ?? 0) > 0,
    isRestrictedSite,
    actualMode: lifecycle?.actualMode ?? 'bypass',
    desiredMode: lifecycle?.desiredMode ?? 'bypass',
    phase: lifecycle?.phase ?? 'idle',
    audioDocumentId: lifecycle ? controlSnapshot?.documentId ?? null : null,
    audioOrigin: lifecycle ? controlSnapshot?.origin ?? null : null,
    audioGeneration: lifecycle?.generation ?? -1,
	    audioConfigRevision: acknowledgedSession?.configRevision ?? 0,
    controlGeneration: controlSnapshot?.generation ?? 0,
    controlRevision: controlSnapshot?.revision ?? 0,
    lastError: acknowledgedSession?.lastError ?? status?.lastError ?? null,
    isDragging: false,
    draggingField: null,
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

  const renderCard = createRenderFn({
    ui,
    state,
    drawEqCurve,
    getVizEnabled: () => getGlobalSettings().visualizerEnabled !== false,
    getGlobalSettings,
  });
  const render = () => {
    renderCard();
    document.dispatchEvent(new Event(VISUALIZER_STATE_CHANGED_EVENT));
  };

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
    bindCardIconClick(ui.icon, tabId, tab.title || '', ui.icon.src);
  }

  // note: register the update handle globally so settings can trigger re-renders from the Settings view
  registerCard(tabId, state.config, update, () => state.config);

  const cleanupMessaging = setupCardMessaging({ tabId, state, render });
  window.addEventListener('unload', cleanupMessaging);

  cardRenderCallbacks.push(() => {
    render();
  });

  render();

  // Snapshot reads stay side-effect free. Once the foreground card is visible,
  // a document-scoped observation lease installs only event listeners/registry
  // state so page-side changes can flow back to Popup. It never admits MAIN,
  // AudioContext or offscreen processing by itself.
  if (!params.isBackground) void acquirePopupObservation(tabId);

  // goal: dynamically import the visualizer loop to optimize initial popup load time
  if (ui.canvas) {
    const { createVizLoop } = await import('../visualizer/loop');
    const startViz = createVizLoop({
      canvas: ui.canvas,
      tabId,
      getConfig: () => state.config,
      getCapturing,
      isProcessorActive: () => state.phase === 'active'
        && (state.actualMode === 'webaudio' || state.actualMode === 'capture'),
      getGlobalSettings,
    });
    startViz();
  }

  return true;
}
