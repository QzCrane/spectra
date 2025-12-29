// goal: defines messaging listeners for the tab card to handle state synchronization between the popup, background, and content scripts

import type { AudioConfig } from '@nexus/kernel';
import { Actions } from '@nexus/contracts';
import type { CardInternalState } from './types';

export interface MessagingParams {
  tabId: number;
  state: CardInternalState;
  render: () => void;
}

// post: returns a cleanup function that removes the chrome.runtime.onMessage listener
export function setupCardMessaging(params: MessagingParams): () => void {
  const { tabId, state, render } = params;

  const onMessageListener = (
    msg: { action: string; payload?: any; config?: AudioConfig; mode?: any; isCaptureActive?: boolean },
    sender: chrome.runtime.MessageSender
  ): boolean | undefined => {
    const action = msg.action;
    const payload = msg.payload || {};

    // rule: UI_SYNC is triggered by the content script or background to refresh the popup's view of a tab's audio configuration
    const isFromTargetTab = (sender.tab?.id === tabId) || (payload.tabId === tabId);
    if (action === Actions.UI_SYNC && isFromTargetTab) {
      const config = payload.config || msg.config;
      if (config) {
        const cleanedConfig = { ...config };
        // note: strip transient command fields to prevent them from being interpreted as persistent state
        delete (cleanedConfig as any).toggleMute;
        delete (cleanedConfig as any).volumeDelta;

        if (state.isDragging) {
          // rule: do not sync volume/mute from external sources while the user is actively dragging, to avoid "slider fighting"
          const { volume, muted, ...otherConfig } = cleanedConfig;
          state.config = { ...state.config, ...otherConfig };
        } else {
          state.config = cleanedConfig;
        }
      }

      if (payload.mode || msg.mode) state.actualMode = (payload.mode || msg.mode);
      if (payload.isCaptureActive !== undefined) state.isCaptureActive = payload.isCaptureActive;
      else if (msg.isCaptureActive !== undefined) state.isCaptureActive = msg.isCaptureActive;

      // note: sync restricted status to ensure UI correctly reflects browser-protected pages (e.g. chrome://)
      if (payload.isRestricted !== undefined) state.isRestrictedSite = payload.isRestricted;

      render();
    }

    // rule: CAPTURE_STATE_CHANGE notification from background indicates the offscreen document has successfully claimed the tab's stream
    if (action === Actions.CAPTURE_STATE_CHANGE) {
      const msgTabId = payload.tabId ?? sender.tab?.id;
      if (msgTabId === tabId) {
        state.isCaptureActive = !!payload.enabled;
        if (state.isCaptureActive) {
          state.actualMode = 'CAPTURE';
        }
        render();
      }
    }
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
