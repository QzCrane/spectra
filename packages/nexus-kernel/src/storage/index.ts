// goal: aggregation point for all storage related repositories and utility functions

export { StorageRepository } from './repository.js';
export {
	audioConfigPatchToControlSessionPatch,
	audioConfigToControlSessionPatch,
	controlSessionPatchToAudioConfig,
	getTabControlSession,
	mergeTabControlSession,
	rebindTabControlSession,
	removeTabControlSession,
	flushTabControlSession,
	hasTabControlSession,
} from './tab-session.js';
export { safeStorageGet, safeStorageSet, safeStorageRemove } from './safe-storage.js';
export type { StorageArea } from './safe-storage.js';
export { createSerializedQueue, createKeyedSerializedQueue } from './serialized-queue.js';
export type { SerializedQueue, KeyedSerializedQueue } from './serialized-queue.js';
