// goal: safe chrome storage wrapper with timeout and retry
// eff: prevents hang when chrome.storage is unresponsive
// note: thin wrapper around @nexus/kernel safe-storage for backward compat

export { safeStorageGet, safeStorageSet, safeStorageRemove } from '@nexus/kernel';
export type { StorageArea } from '@nexus/kernel';
