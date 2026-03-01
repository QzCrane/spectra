// goal: central message dispatcher for Background Service Worker

import type { NexusAction, NexusRequest, NexusResponse } from '@nexus/contracts';

type MessageHandler<A extends NexusAction> = (
  request: NexusRequest<A>,
  sender: chrome.runtime.MessageSender
) => Promise<NexusResponse<A>> | NexusResponse<A>;

interface MessagePayload<A extends NexusAction = NexusAction> {
  action: A;
  payload: NexusRequest<A>;
  tabId?: number;
  source?: string;
  target?: 'offscreen';
}

// goal: factory for INexusRouter instances
export function createRouter() {
  const handlers = new Map<NexusAction, MessageHandler<NexusAction>>();
  let isListening = false;

  return {
    on<A extends NexusAction>(
      action: A,
      handler: MessageHandler<A>
    ): void {
      if (handlers.has(action)) {
        console.warn(`[NEXUS Router] Handler for ${action} already registered, overwriting.`);
      }
      handlers.set(action, handler as unknown as MessageHandler<NexusAction>);
    },

    off<A extends NexusAction>(action: A): void {
      handlers.delete(action);
    },

    // eff: starts the chrome.runtime.onMessage listener
    listen(): void {
      if (isListening) {
        console.warn('[NEXUS Router] Already listening, ignoring duplicate call.');
        return;
      }

      isListening = true;

      chrome.runtime.onMessage.addListener(
        (
          message: MessagePayload,
          sender: chrome.runtime.MessageSender,
          sendResponse: (response: unknown) => void
        ) => {
          console.log('[NEXUS Router] Received message:', message.action, 'from', sender.url?.substring(0, 50));
          
          if (!message || typeof message.action !== 'string') {
            console.log('[NEXUS Router] Invalid message, ignoring');
            return false;
          }

          // inv: Offscreen messages are handled by the Offscreen document directly
          if (message.target === 'offscreen') {
            console.log('[NEXUS Router] Offscreen target, ignoring');
            return false;
          }

          const { action, payload } = message;
          const handler = handlers.get(action);

          if (!handler) {
            console.warn(`[NEXUS Router] No handler for action: ${action}`);
            return false;
          }

          Promise.resolve(handler(payload, sender))
            .then((response) => {
              console.log('[NEXUS Router] Handler response for', action, ':', response);
              sendResponse(response);
            })
            .catch((error) => {
              console.error(`[NEXUS Router] Handler error for ${action}:`, error);
              sendResponse({ error: error.message });
            });

          return true;
        }
      );

      console.log('[NEXUS Router] Message listener started.');
    },

    // eff: broadcasts a message to all active tabs
    async broadcast<A extends NexusAction>(
      action: A,
      ...args: NexusRequest<A> extends void ? [] : [NexusRequest<A>]
    ): Promise<void> {
      const payload = args[0] as NexusRequest<A>;
      const tabs = await chrome.tabs.query({});

      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { action, payload }).catch(() => {
            // ignore: expected if content script is not loaded in specific tab
          });
        }
      }
    }
  };
}

export type NexusRouter = ReturnType<typeof createRouter>;
