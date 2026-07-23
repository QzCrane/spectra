// goal: aggregation point for Nexus protocol, runtime defaults, and messaging infrastructure

export * from './protocol.js';
export { DEFAULT_AUDIO_CONFIG, DEFAULT_GLOBAL_SETTINGS } from './defaults.js';

// Messenger factory for client-side (Popup/Content)
export { createMessenger } from './client.js';
export type { NexusMessenger } from './client.js';

// Router factory for server-side (Background/ServiceWorker)
export {
	createRouter,
	isNexusAction,
	isValidNexusRequestPayload,
	parseNexusMessage,
} from './router.js';
export type { NexusMessageEnvelope, NexusRouter } from './router.js';
