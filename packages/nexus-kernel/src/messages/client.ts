// goal: type-safe messaging client for Popup, Content Script, and Side Panel

import type { NexusAction, NexusRequest, NexusResponse } from '@nexus/contracts';

interface MessagePayload<A extends NexusAction = NexusAction> {
  action: A;
  payload: NexusRequest<A>;
  tabId?: number;
  source?: 'popup' | 'content' | 'background' | 'offscreen' | 'sidepanel';
}

// goal: factory for INexusMessenger instances
export function createMessenger(source: MessagePayload['source'] = 'popup') {
  return {
    // eff: sends a message to the Background Service Worker via chrome.runtime.sendMessage
    async send<A extends NexusAction>(
      action: A,
      ...args: NexusRequest<A> extends void ? [] : [NexusRequest<A>]
    ): Promise<NexusResponse<A>> {
      const payload = args[0] as NexusRequest<A>;

      const message: MessagePayload<A> = {
        action,
        payload,
        source
      };

      try {
        const response = await chrome.runtime.sendMessage(message);
        return response as NexusResponse<A>;
      } catch (error) {
        console.error(`[NEXUS] Failed to send message ${action}:`, error);
        throw error;
      }
    },

    // eff: sends a message to a specific tab via chrome.tabs.sendMessage
    async sendToTab<A extends NexusAction>(
      tabId: number,
      action: A,
      ...args: NexusRequest<A> extends void ? [] : [NexusRequest<A>]
    ): Promise<NexusResponse<A>> {
      const payload = args[0] as NexusRequest<A>;

      const message: MessagePayload<A> = {
        action,
        payload,
        tabId,
        source
      };

      try {
        const response = await chrome.tabs.sendMessage(tabId, message);
        return response as NexusResponse<A>;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        // inv: suppress errors if content script is not injected in the target tab
        if (errorMsg.includes('Could not establish connection') || errorMsg.includes('Receiving end does not exist')) {
          console.debug(`[NEXUS] Probing tab ${tabId} failed (expected if not injected): ${action}`);
        } else {
          console.error(`[NEXUS] Failed to send message to tab ${tabId}:`, error);
        }
        throw error;
      }
    }
  };
}

export type NexusMessenger = ReturnType<typeof createMessenger>;
