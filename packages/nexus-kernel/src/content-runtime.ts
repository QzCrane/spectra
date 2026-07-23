// goal: content-only kernel entry without messages/router and storage repository reachability

export { DEFAULT_AUDIO_CONFIG, DEFAULT_GLOBAL_SETTINGS } from './messages/defaults.js';
export { createLogger, createPlainLogger, LOG_COLORS } from './logger.js';
export {
	safeStorageGet,
	safeStorageRemove,
	safeStorageSet,
} from './storage/safe-storage.js';
