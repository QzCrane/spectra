// goal: manages the internal state of a tab control card and orchestrates configuration updates across background and content scripts

import type { AudioConfig, GlobalSettings } from '@nexus/kernel';
import type { CardInternalState } from './types';
import { sendToTab, sendToBackground } from '../utils/dom';
import { createBadgePayload } from '../../shared/badge-logic';

export function createGetCapturing(
  state: CardInternalState,
): () => boolean {
  return () => {
    return !!state.isCaptureActive;
  };
}

// post: returns an async update function that applies changes optimistically and routes commands based on the active capture mode
export function createUpdateFn(
  state: CardInternalState,
  tabId: number,
  _getCapturing: () => boolean,
  render: () => void,
  _getGlobalSettings: () => GlobalSettings
): (changes: Partial<AudioConfig>) => void {
  return async (changes: Partial<AudioConfig>) => {
    // rule: only mark "user interacted" if the change involves an actual audio parameter (not just opening the card)
    const isOperation = Object.keys(changes).some(k => k !== 'enabled');
    if (isOperation) {
      state.userInteracted = true;
    }

    // eff: apply changes immediately to local state for responsive UI feedback
    state.config = { ...state.config, ...changes };
    const config = state.config;

    if (state.isCaptureActive) {
      // mode: Capture -> Update the offscreen document directly and notify content script for UI synchronization
      sendToBackground('CAPTURE_UPDATE_CONFIG', { tabId, config });
      sendToTab(tabId, 'AUDIO_SET_CONFIG', { config }).catch(() => { });

      // note: ensure badge reflects the active capture and volume status immediately
      state.userInteracted = true;
      const payload = createBadgePayload(config, true, state.userInteracted);
      sendToBackground('BADGE_UPDATE', { tabId, ...payload });

      render();
      return;
    }

    // mode: Native -> Delegate processing to the content script; handle potential mode escalation (e.g. forced capture for CORS)
    const response = await sendToTab<{
      success: boolean;
      state: { mode: string; config: AudioConfig };
    }>(tabId, 'AUDIO_SET_CONFIG', { config });

    if (response?.success && response.state) {
      const suggestedMode = response.state.mode;
      const wasCapturing = state.isCaptureActive;
      const needsCapture = suggestedMode === 'CAPTURE';

      // rule: if the content script requests mode escalation, trigger background capture toggle
      if (needsCapture && !wasCapturing) {
        state.isCaptureActive = true;
        state.actualMode = 'CAPTURE';
        sendToBackground('CAPTURE_TOGGLE', { enabled: true, config, tabId });
      } else if (!needsCapture && wasCapturing) {
        state.isCaptureActive = false;
        state.actualMode = suggestedMode as any;
        sendToBackground('CAPTURE_TOGGLE', { enabled: false, config, tabId });
      }

      if (needsCapture) {
        state.userInteracted = true;
      }

      const payload = createBadgePayload(config, needsCapture, state.userInteracted);
      sendToBackground('BADGE_UPDATE', { tabId, ...payload });
    }

    render();
  };
}

