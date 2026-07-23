// goal: central message dispatcher for Background Service Worker

import {
  HOTKEY_ACTIONS,
  NEXUS_ACTIONS,
  isAudioConfig,
  isAudioConfigPatch,
  type NexusAction,
  type NexusRequest,
  type NexusResponse,
} from '@nexus/contracts';

type MessageHandler<A extends NexusAction> = (
  request: NexusRequest<A>,
  sender: chrome.runtime.MessageSender
) => Promise<NexusResponse<A>> | NexusResponse<A>;

interface RoutingFields {
  tabId?: number;
  source?: 'popup' | 'content' | 'background' | 'offscreen' | 'sidepanel';
  target?: 'offscreen';
}

export type NexusMessageEnvelope<A extends NexusAction = NexusAction> = {
  [K in A]: RoutingFields & { action: K; payload: NexusRequest<K> };
}[A];

const NEXUS_ACTION_SET = new Set<string>(NEXUS_ACTIONS);
const HOTKEY_ACTION_SET = new Set<string>(HOTKEY_ACTIONS);
const AUDIO_PHASES = new Set(['idle', 'starting', 'active', 'stopping', 'error']);
const SOURCES = new Set(['popup', 'content', 'background', 'offscreen', 'sidepanel']);
const VOID_ACTIONS = new Set<NexusAction>([
  'AUDIO_GET_STATUS',
  'AUDIO_GET_VISUALIZER',
  'SETTINGS_GET',
  'MEDIA_TOGGLE_PLAY',
  'MEDIA_TOGGLE_PIP',
  'MEDIA_GET_STATE',
  'VIDEO_ROTATE',
  'VIDEO_MIRROR',
  'VIDEO_SCREENSHOT',
  'VIDEO_FULLSCREEN',
  'VIDEO_CROP',
  'VIDEO_RESET_FILTER',
  'VIDEO_AB_SET_A',
  'VIDEO_AB_SET_B',
  'VIDEO_AB_CLEAR',
  'VIDEO_AB_GET_STATE',
  'VIDEO_MARKER_LIST',
  'TAB_GET_VISIBLE_TABS',
  'TAB_PIN',
  'TAB_MUTE',
  'OPEN_OPTIONS',
  'OPEN_POPUP',
  'HALO_GET_STATUS',
  'HALO_RULER_START',
  'HALO_RULER_CANCEL',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || isPositiveInteger(value);
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isNonEmptyString(value: unknown, maximumLength = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isEmptyPayload(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.keys(value).length === 0);
}

function isAudioConfigIntent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { volumeDelta, toggleMute, isNativeSync, ...config } = value;
  return isAudioConfigPatch(config)
    && (volumeDelta === undefined || isFiniteNumber(volumeDelta))
    && isOptionalBoolean(toggleMute)
    && isOptionalBoolean(isNativeSync);
}

function isVideoFilterPayload(value: Record<string, unknown>): boolean {
  return (value.brightness === undefined || isFiniteNumber(value.brightness))
    && (value.contrast === undefined || isFiniteNumber(value.contrast))
    && (value.saturate === undefined || isFiniteNumber(value.saturate))
    && isOptionalBoolean(value.grayscale)
    && isOptionalBoolean(value.invert);
}

export function isNexusAction(value: unknown): value is NexusAction {
  return typeof value === 'string' && NEXUS_ACTION_SET.has(value);
}

// post: applies the minimum v1 wire checks required before a typed handler sees a payload
export function isValidNexusRequestPayload<A extends NexusAction>(
  action: A,
  payload: unknown,
): payload is NexusRequest<A> {
  if (VOID_ACTIONS.has(action)) return isEmptyPayload(payload);
  if (!isRecord(payload)) return false;

  switch (action) {
    case 'AUDIO_SET_CONFIG':
      return isAudioConfigIntent(payload.config);
    case 'CAPTURE_TOGGLE':
      return typeof payload.enabled === 'boolean'
        && (payload.config === undefined || isAudioConfig(payload.config))
        && isOptionalPositiveInteger(payload.tabId)
        && isOptionalNonNegativeInteger(payload.generation);
    case 'CAPTURE_GET_STATE':
      return isOptionalPositiveInteger(payload.tabId);
    case 'CAPTURE_UPDATE_CONFIG':
      return isAudioConfig(payload.config)
        && isOptionalPositiveInteger(payload.tabId)
        && isOptionalNonNegativeInteger(payload.generation);
    case 'CAPTURE_STATE_CHANGE':
      return typeof payload.enabled === 'boolean'
        && isOptionalPositiveInteger(payload.tabId)
        && isOptionalNonNegativeInteger(payload.generation)
        && (payload.phase === undefined || (typeof payload.phase === 'string' && AUDIO_PHASES.has(payload.phase)))
        && (payload.error === undefined || typeof payload.error === 'string');
    case 'SETTINGS_UPDATE':
    case 'GLOBAL_SETTINGS_UPDATE':
      return isRecord(payload.settings);
    case 'BADGE_UPDATE':
      return isFiniteNumber(payload.volume)
        && typeof payload.muted === 'boolean'
        && typeof payload.isCapture === 'boolean'
        && isOptionalPositiveInteger(payload.tabId)
        && isOptionalBoolean(payload.enabled)
        && isOptionalBoolean(payload.userInteracted);
    case 'BADGE_CLEAR':
      return isOptionalPositiveInteger(payload.tabId);
    case 'UI_SYNC':
      return isAudioConfig(payload.config)
        && isOptionalNonNegativeInteger(payload.generation)
        && (payload.phase === undefined || (typeof payload.phase === 'string' && AUDIO_PHASES.has(payload.phase)))
        && (payload.lastError === undefined || typeof payload.lastError === 'string')
        && isOptionalBoolean(payload.isCaptureActive)
        && isOptionalBoolean(payload.isRestricted);
    case 'SHORTCUT_TRIGGER':
      return typeof payload.command === 'string'
        && HOTKEY_ACTION_SET.has(payload.command)
        && (payload.config === undefined || isAudioConfig(payload.config));
    case 'REGISTRY_ADD_DOMAIN':
    case 'REGISTRY_REMOVE_DOMAIN':
    case 'REGISTRY_QUERY_DOMAIN':
      return isNonEmptyString(payload.domain, 2048);
    case 'REGISTRY_MARK_PROBED':
      return isNonEmptyString(payload.domain, 2048) && typeof payload.restricted === 'boolean';
    case 'MEDIA_SET_SPEED':
      return (isFiniteNumber(payload.speed) || isFiniteNumber(payload.delta))
        && (payload.speed === undefined || (isFiniteNumber(payload.speed) && payload.speed >= 0.1 && payload.speed <= 16))
        && (payload.delta === undefined || isFiniteNumber(payload.delta))
        && isOptionalBoolean(payload.preservePitch);
    case 'VIDEO_SEEK':
      return isFiniteNumber(payload.delta);
    case 'VIDEO_SET_FILTER':
      return isVideoFilterPayload(payload);
    case 'VIDEO_DIM_BACKGROUND':
      return isOptionalBoolean(payload.enabled)
        && (payload.opacity === undefined || isFiniteNumber(payload.opacity));
    case 'VIDEO_MARKER_ADD':
      return payload.label === undefined || typeof payload.label === 'string';
    case 'VIDEO_MARKER_REMOVE':
    case 'VIDEO_MARKER_JUMP':
      return isNonEmptyString(payload.id, 128);
    case 'TAB_REPORT_MEDIA':
      return typeof payload.hasMediaElement === 'boolean' && isOptionalBoolean(payload.userInteracted);
    case 'REMOTE_GET_SESSION':
    case 'REMOTE_CREATE_SESSION':
    case 'INJECT_CONTENT_SCRIPT':
      return isPositiveInteger(payload.tabId);
    case 'REMOTE_CLOSE_SESSION':
      return isPositiveInteger(payload.tabId) && isNonEmptyString(payload.sessionId, 128);
    case 'USER_SCRIPT_EXECUTE':
      return isNonEmptyString(payload.script, 100_000);
    case 'HALO_TOOL_ACTIVATE':
    case 'HALO_TOOL_DEACTIVATE':
      return isNonEmptyString(payload.toolId, 128);
    case 'HALO_RULER_RESULT':
      return Object.hasOwn(payload, 'data');
    case 'HALO_SCROLL_TO_HEADING':
      return typeof payload.index === 'number' && Number.isInteger(payload.index) && payload.index >= 0;
    case 'HALO_CLIPBOARD_ADD':
      return typeof payload.text === 'string'
        && (payload.sourceUrl === undefined || typeof payload.sourceUrl === 'string')
        && (payload.sourceTitle === undefined || typeof payload.sourceTitle === 'string');
    default:
      return false;
  }
}

// post: returns a normalized discriminated envelope; legacy void `{}` payloads become undefined
export function parseNexusMessage(value: unknown): NexusMessageEnvelope | null {
  if (!isRecord(value) || !isNexusAction(value.action)) return null;
  if (value.tabId !== undefined && !isPositiveInteger(value.tabId)) return null;
  if (value.source !== undefined && (typeof value.source !== 'string' || !SOURCES.has(value.source))) return null;
  if (value.target !== undefined && value.target !== 'offscreen') return null;
  if (!isValidNexusRequestPayload(value.action, value.payload)) return null;

  const payload = VOID_ACTIONS.has(value.action) ? undefined : value.payload;
  return {
    action: value.action,
    payload,
    ...(value.tabId === undefined ? {} : { tabId: value.tabId }),
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.target === undefined ? {} : { target: value.target }),
  } as NexusMessageEnvelope;
}

// goal: factory for INexusRouter instances
export function createRouter() {
  const handlers = new Map<NexusAction, MessageHandler<NexusAction>>();
  let isListening = false;

  return {
    on<A extends NexusAction>(action: A, handler: MessageHandler<A>): void {
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
      chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
        const message = parseNexusMessage(rawMessage);
        if (!message) return false;
        if (message.target === 'offscreen') return false;

        const handler = handlers.get(message.action);
        if (!handler) return false;

        // rule: defer handler invocation so a synchronous throw is caught by .catch().
        // The previous `Promise.resolve(handler(...))` evaluated `handler(...)` as the
        // argument to Promise.resolve — a sync throw escaped into chrome.runtime.onMessage
        // before the .catch was attached, and the sender got an unstructured
        // chrome.runtime.lastError instead of the intended `{ error: messageText }`.
        Promise.resolve()
          .then(() => handler(message.payload, sender))
          .then(sendResponse)
          .catch((error: unknown) => {
            const messageText = error instanceof Error ? error.message : String(error);
            sendResponse({ error: messageText });
          });
        return true;
      });
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
    },
  };
}

export type NexusRouter = ReturnType<typeof createRouter>;
