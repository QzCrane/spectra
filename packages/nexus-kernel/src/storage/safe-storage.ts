// goal: safe chrome storage wrapper with timeout and retry
// eff: prevents hang when chrome.storage is unresponsive

const DEFAULT_TIMEOUT = 2000;
const MAX_RETRIES = 3;

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export type StorageArea = 'local' | 'sync' | 'session';

interface SafeStorageOptions {
	area?: StorageArea;
	timeout?: number;
	retries?: number;
}

async function withRetry<T>(
	fn: () => Promise<T>,
	fallback: T,
	timeout: number,
	retries: number,
	op: string
): Promise<T> {
	let lastErr: unknown;

	for (let i = 0; i < retries; i++) {
		// rule: capture the timeout timer and clear it in finally — when fn() resolves first,
		// the unhandled timer previously held the MV3 service worker alive for `timeout` ms
		// per call, defeating SW lifecycle reclamation.
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				fn(),
				new Promise<T>((_, reject) => {
					timer = setTimeout(() => reject(new Error('timeout')), timeout);
				})
			]);
		} catch (e) {
			lastErr = e;
			if (i < retries - 1) await wait(500 * (i + 1));
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
	console.warn(`[SafeStorage] ${op} failed after ${retries} attempts:`, lastErr);
	return fallback;
}

export async function safeStorageGet<T extends Record<string, unknown>>(
	keys: string | string[],
	defaults: T,
	options: SafeStorageOptions = {}
): Promise<T> {
	if (typeof chrome === 'undefined' || !chrome.storage) return defaults;
	const { area = 'local', timeout = DEFAULT_TIMEOUT, retries = MAX_RETRIES } = options;
	const storage = area === 'local'
		? chrome.storage.local
		: area === 'session'
			? chrome.storage.session
			: chrome.storage.sync;
	const keyArr = Array.isArray(keys) ? keys : [keys];

	return withRetry(
		() => storage.get(keyArr) as Promise<T>,
		defaults,
		timeout,
		retries,
		`get(${keyArr.join(',')})`
	);
}

export async function safeStorageSet(
	items: Record<string, unknown>,
	options: SafeStorageOptions = {}
): Promise<boolean> {
	if (typeof chrome === 'undefined' || !chrome.storage) return false;
	const { area = 'local', timeout = DEFAULT_TIMEOUT, retries = MAX_RETRIES } = options;
	const storage = area === 'local'
		? chrome.storage.local
		: area === 'session'
			? chrome.storage.session
			: chrome.storage.sync;

	return withRetry(
		async () => { await storage.set(items); return true; },
		false,
		timeout,
		retries,
		'set'
	);
}

export async function safeStorageRemove(
	keys: string | string[],
	options: SafeStorageOptions = {}
): Promise<boolean> {
	if (typeof chrome === 'undefined' || !chrome.storage) return false;
	const { area = 'local', timeout = DEFAULT_TIMEOUT, retries = MAX_RETRIES } = options;
	const storage = area === 'local'
		? chrome.storage.local
		: area === 'session'
			? chrome.storage.session
			: chrome.storage.sync;
	const keyArr = Array.isArray(keys) ? keys : [keys];

	return withRetry(
		async () => { await storage.remove(keyArr); return true; },
		false,
		timeout,
		retries,
		`remove(${keyArr.join(',')})`
	);
}
