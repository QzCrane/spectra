// goal: defines messaging listeners for the tab card to handle state synchronization between the popup, background, and content scripts

import { isSpectraUiEventEnvelope } from '@nexus/contracts/ui-runtime';
import {
	audioSessionMatchesControlDocument,
	isActiveCaptureLifecycle,
} from '@nexus/contracts';
import type { CardInternalState } from './types';
import { applyLegacyCardMessage } from './legacy-message-adapter';
import { mergeControlSnapshot } from './types';
import { projectAcknowledgedProcessorLifecycle } from './state';

export interface MessagingParams {
  tabId: number;
  state: CardInternalState;
  render: () => void;
}

// post: returns a cleanup function that removes the chrome.runtime.onMessage listener
export function setupCardMessaging(params: MessagingParams): () => void {
  const { tabId, state, render } = params;

  const onMessageListener = (
	rawMessage: unknown,
    sender: chrome.runtime.MessageSender
  ): boolean | undefined => {
	if (isSpectraUiEventEnvelope(rawMessage) && rawMessage.type === 'spectra.control.snapshot.changed') {
		const snapshot = rawMessage.payload;
		if (snapshot.tabId !== tabId) return false;
		if (snapshot.generation < state.controlGeneration
			|| snapshot.generation === state.controlGeneration
				&& snapshot.revision < state.controlRevision) return false;
		state.controlSnapshot = snapshot;
		const lifecycleMatches = state.audioDocumentId === snapshot.documentId
			&& state.audioOrigin === snapshot.origin;
		if (!lifecycleMatches) {
			// Never carry a purple Capture lifecycle across a navigation or a worker
			// identity reset while waiting for the matching session handshake.
			state.actualMode = 'bypass';
			state.desiredMode = 'bypass';
			state.phase = 'idle';
			state.isCaptureActive = false;
			state.audioDocumentId = null;
			state.audioOrigin = null;
			state.audioGeneration = -1;
			state.audioConfigRevision = 0;
		}
		state.stableConfig = mergeControlSnapshot(state.stableConfig, snapshot);
		projectAcknowledgedProcessorLifecycle(state, snapshot.fields);
		const incoming = state.stableConfig;
		if (state.draggingField === 'volume') {
			const {
				volume: _volume,
				volumeBase: _volumeBase,
				boost: _boost,
				muted: _muted,
				...otherConfig
			} = incoming;
			state.config = { ...state.config, ...otherConfig };
		} else {
			state.config = incoming;
		}
		state.controlGeneration = Math.max(state.controlGeneration, snapshot.generation);
		state.controlRevision = Math.max(state.controlRevision, snapshot.revision);
		state.lastError = Object.values(snapshot.fields)
			.find((field) => field?.lastError)?.lastError ?? null;
		render();
		return false;
	}
	if (isSpectraUiEventEnvelope(rawMessage) && rawMessage.type === 'spectra.audio.session.changed') {
		const snapshot = rawMessage.payload;
		const control = state.controlSnapshot;
		const matchesControl = audioSessionMatchesControlDocument(snapshot, control);
		if (snapshot.tabId === tabId
			&& matchesControl
			&& (snapshot.generation > state.audioGeneration
				|| snapshot.generation === state.audioGeneration
					&& snapshot.configRevision >= state.audioConfigRevision)) {
			// ControlSnapshot is the sole per-field actual authority. Session events
			// contribute processor lifecycle only and cannot overwrite a newer
			// page-native volume/speed revision.
			state.actualMode = snapshot.actualMode;
			state.desiredMode = snapshot.desiredMode;
			state.phase = snapshot.phase;
			state.audioDocumentId = snapshot.documentId;
			state.audioOrigin = snapshot.origin;
			state.audioGeneration = snapshot.generation;
			state.audioConfigRevision = snapshot.configRevision;
			state.lastError = snapshot.lastError;
			state.isCaptureActive = isActiveCaptureLifecycle({
				actualMode: snapshot.actualMode,
				phase: snapshot.phase,
			});
			render();
		}
		return false;
	}
	// Capture lifecycle events are compatibility notifications, not authoritative
	// UI state. The preceding session.changed snapshot is the only mode/phase source.
	if (isSpectraUiEventEnvelope(rawMessage) && rawMessage.type === 'spectra.audio.capture.changed') return false;
	applyLegacyCardMessage(rawMessage, sender, params);
    return false;
  };

  chrome.runtime.onMessage.addListener(onMessageListener);

  return () => {
    chrome.runtime.onMessage.removeListener(onMessageListener);
  };
}

// eff: attempts to establish a long-lived port connection to the content script for high-frequency signaling
export function connectToTab(tabId: number): chrome.runtime.Port | null {
  try {
    const port = chrome.tabs.connect(tabId, { name: 'popup-connection' });
    port.onDisconnect.addListener(() => {
      // note: swallow error to avoid console noise if tab is closed during connection
      void chrome.runtime.lastError;
    });
    return port;
  } catch {
    return null;
  }
}
