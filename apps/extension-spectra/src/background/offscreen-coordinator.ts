// goal: own the single MV3 offscreen document shared by audio capture and remote control

import {
	isOffscreenHostRequest,
	isOffscreenHostResponse,
	type OffscreenHostRequest,
	type OffscreenHostResponse,
	type OffscreenHostSnapshot,
} from '@nexus/contracts';
import { swLog } from '../shared/logger';

export type OffscreenLeaseKey = `audio:${number}` | `remote:${string}`;

const OFFSCREEN_URL = 'offscreen.html';
const LEGACY_OFFSCREEN_URL = 'offscreen-remote.html';
const IDLE_CLOSE_MS = 30_000;
const IDLE_CLOSE_ALARM = 'spectra-offscreen-idle-close';
const RECONCILE_RETRY_DELAYS_MS = [25, 75] as const;
// Local leases represent work initiated by this service-worker instance. Recovered
// leases are the processors/sessions reported by an already-running offscreen host.
// Keeping the sources separate prevents a failed duplicate acquire from deleting a
// real lease recovered after a service-worker restart.
const localLeases = new Set<OffscreenLeaseKey>();
const recoveredLeases = new Set<OffscreenLeaseKey>();
// A live document whose HELLO failed may still own processors or remote secrets.
// Unknown state is a bounded reconciliation quarantine, not durable ownership:
// known leases retain the host, while an unowned host receives an idle grace
// period and one final authoritative HELLO before stale-document reclamation.
let hostStateUnknown = false;

let closeTimer: ReturnType<typeof setTimeout> | null = null;
let lifecycleTail: Promise<void> = Promise.resolve();
let alarmListenerRegistered = false;

function hasKnownLease(): boolean {
	return localLeases.size > 0 || recoveredLeases.size > 0;
}

function hasAnyLease(): boolean {
	return hasKnownLease() || hostStateUnknown;
}

function withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
	const run = lifecycleTail.then(operation, operation);
	lifecycleTail = run.then(() => undefined, () => undefined);
	return run;
}

async function cancelIdleClose(): Promise<void> {
	if (closeTimer) {
		clearTimeout(closeTimer);
		closeTimer = null;
	}
	if (chrome.alarms?.clear) await chrome.alarms.clear(IDLE_CLOSE_ALARM);
}

async function getOffscreenContexts(documentUrl: string): Promise<unknown[] | null> {
	const runtime = chrome.runtime as typeof chrome.runtime & {
		getContexts?: (filter: {
			contextTypes: string[];
			documentUrls: string[];
		}) => Promise<unknown[]>;
	};
	if (!runtime.getContexts) return null;
	return runtime.getContexts({
		contextTypes: ['OFFSCREEN_DOCUMENT'],
		documentUrls: [chrome.runtime.getURL(documentUrl)],
	});
}

async function hasOffscreenDocument(): Promise<boolean> {
	const contexts = await getOffscreenContexts(OFFSCREEN_URL);
	if (contexts !== null) return contexts.length > 0;
	return typeof chrome.offscreen.hasDocument === 'function'
		? chrome.offscreen.hasDocument()
		: false;
}

async function retireLegacyOffscreenDocumentUnlocked(): Promise<boolean> {
	const legacyContexts = await getOffscreenContexts(LEGACY_OFFSCREEN_URL);
	if (!legacyContexts || legacyContexts.length === 0) return false;
	// A current host must never be sacrificed to a delayed update event. Chrome
	// normally permits only one offscreen document, but this check makes ownership explicit.
	const currentContexts = await getOffscreenContexts(OFFSCREEN_URL);
	if (currentContexts && currentContexts.length > 0) return false;
	await chrome.offscreen.closeDocument();
	recoveredLeases.clear();
	hostStateUnknown = false;
	await cancelIdleClose();
	swLog.info('Retired legacy six-character remote session host during protocol v2 upgrade');
	return true;
}

// This is the only upgrade path allowed to terminate the legacy offscreen page;
// direct closeDocument ownership remains inside this coordinator.
export function retireLegacyOffscreenDocument(): Promise<boolean> {
	return withLifecycleLock(retireLegacyOffscreenDocumentUnlocked);
}

async function ensureOffscreenDocument(): Promise<void> {
	return withLifecycleLock(async () => {
		await cancelIdleClose();
		await retireLegacyOffscreenDocumentUnlocked();
		// Re-check inside the mutex: another caller may have completed while this one waited.
		if (await hasOffscreenDocument()) return;
		if (!hasAnyLease()) {
			throw new Error('An offscreen lease is required before creating the host');
		}
		await chrome.offscreen.createDocument({
			url: OFFSCREEN_URL,
			reasons: ['USER_MEDIA', 'WEB_RTC'] as chrome.offscreen.Reason[],
			justification: 'Audio processing and authenticated WebRTC remote control',
		});
		swLog.debug('Unified offscreen host created');
	});
}

async function closeIfIdle(): Promise<void> {
	closeTimer = null;
	await withLifecycleLock(async () => {
		if (hasAnyLease() || !(await hasOffscreenDocument()) || hasAnyLease()) return;
		try {
			const snapshot = await dispatchOffscreenMessage({ type: 'OFFSCREEN_HOST_HELLO' });
			replaceRecoveredLeases(snapshot);
			hostStateUnknown = false;
			if (hasKnownLease()) {
				swLog.info('Idle close retained resources recovered by the final offscreen HELLO');
				return;
			}
		} catch (error) {
			if (hasKnownLease()) {
				hostStateUnknown = true;
				swLog.warn('Final offscreen HELLO failed while known leases remain; retaining host', error);
				return;
			}
			swLog.warn('Final offscreen HELLO failed without known leases; reclaiming stale host', error);
		}
		// A lease can be acquired while the final HELLO is in flight, before its
		// owner enters the lifecycle mutex. Never close across that ownership edge.
		if (hasAnyLease()) return;
		try {
			await chrome.offscreen.closeDocument();
			recoveredLeases.clear();
			hostStateUnknown = false;
			swLog.debug('Unified offscreen host closed after idle grace period');
		} catch (error) {
			swLog.warn('Unable to close idle offscreen host', error);
		}
	});
}

function scheduleIdleClose(): void {
	if (hasKnownLease()) return;
	// Reconciliation uncertainty must converge once no explicit owner remains.
	// The grace alarm and close-time HELLO preserve a final recovery opportunity.
	hostStateUnknown = false;
	if (closeTimer) return;
	if (chrome.alarms?.create) {
		chrome.alarms.create(IDLE_CLOSE_ALARM, { delayInMinutes: IDLE_CLOSE_MS / 60_000 });
		return;
	}
	closeTimer = setTimeout(() => {
		void closeIfIdle();
	}, IDLE_CLOSE_MS);
}

export function initializeOffscreenCoordinator(): void {
	if (alarmListenerRegistered || !chrome.alarms?.onAlarm) return;
	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === IDLE_CLOSE_ALARM) void closeIfIdle();
	});
	alarmListenerRegistered = true;
}

export async function acquireOffscreenLease(key: OffscreenLeaseKey): Promise<boolean> {
	initializeOffscreenCoordinator();
	const acquired = !localLeases.has(key);
	localLeases.add(key);
	try {
		await ensureOffscreenDocument();
		return acquired;
	} catch (error) {
		if (acquired) localLeases.delete(key);
		scheduleIdleClose();
		throw error;
	}
}

export function releaseOffscreenLease(key: OffscreenLeaseKey): void {
	localLeases.delete(key);
	recoveredLeases.delete(key);
	scheduleIdleClose();
}

// post: rolls back only ownership added by the matching acquire call; a lease
// recovered from the live host remains authoritative until that resource stops.
export function rollbackOffscreenLeaseAcquisition(key: OffscreenLeaseKey, acquired: boolean): void {
	if (acquired) localLeases.delete(key);
	scheduleIdleClose();
}

async function dispatchOffscreenMessage<TRequest extends OffscreenHostRequest>(
	message: TRequest,
): Promise<OffscreenHostResponse<TRequest['type']>> {
	const wireMessage: unknown = { ...message, target: 'offscreen' };
	if (!isOffscreenHostRequest(wireMessage)) {
		throw new Error(`Invalid offscreen host request: ${message.type}`);
	}
	const response: unknown = await chrome.runtime.sendMessage(wireMessage);
	if (!isOffscreenHostResponse(message.type, response)) {
		throw new Error(`Invalid offscreen host response: ${message.type}`);
	}
	return response;
}

export async function sendOffscreenMessage<TRequest extends OffscreenHostRequest>(
	message: TRequest,
): Promise<OffscreenHostResponse<TRequest['type']>> {
	if (!hasAnyLease()) throw new Error('Cannot message the offscreen host without an active lease');
	await ensureOffscreenDocument();
	return dispatchOffscreenMessage(message);
}

// post: never creates the offscreen document; read/cleanup paths remain side-effect free
export async function sendOffscreenMessageIfPresent<TRequest extends OffscreenHostRequest>(
	message: TRequest,
): Promise<OffscreenHostResponse<TRequest['type']> | undefined> {
	return withLifecycleLock(async () => {
		if (!(await hasOffscreenDocument())) return undefined;
		return dispatchOffscreenMessage(message);
	});
}

function replaceRecoveredLeases(snapshot: OffscreenHostSnapshot): void {
	const hostLeases = new Set<OffscreenLeaseKey>();
	for (const audio of snapshot.audioTabs) hostLeases.add(`audio:${audio.tabId}`);
	for (const remote of snapshot.remoteTabs) hostLeases.add(`remote:${remote.sessionId}`);
	recoveredLeases.clear();
	for (const key of hostLeases) recoveredLeases.add(key);
}

export function reconcileOffscreenHost(): Promise<OffscreenHostSnapshot> {
	initializeOffscreenCoordinator();
	return withLifecycleLock(async () => {
		await retireLegacyOffscreenDocumentUnlocked();
		let lastError: unknown;
		for (let attempt = 0; attempt <= RECONCILE_RETRY_DELAYS_MS.length; attempt += 1) {
			if (!(await hasOffscreenDocument())) {
				// An absent document is the only case where an empty host can be inferred
				// without a HELLO response.
				recoveredLeases.clear();
				hostStateUnknown = false;
				scheduleIdleClose();
				return { audioTabs: [], remoteTabs: [] };
			}
			hostStateUnknown = true;
			await cancelIdleClose();

			try {
				const snapshot = await dispatchOffscreenMessage({ type: 'OFFSCREEN_HOST_HELLO' });
				replaceRecoveredLeases(snapshot);
				hostStateUnknown = false;
				if (hasAnyLease()) await cancelIdleClose();
				else scheduleIdleClose();
				return snapshot;
			} catch (error) {
				lastError = error;
				// The host may have disappeared while HELLO was in flight. Re-checking
				// distinguishes confirmed teardown from a live host whose state is unknown.
				if (!(await hasOffscreenDocument())) {
					recoveredLeases.clear();
					hostStateUnknown = false;
					scheduleIdleClose();
					return { audioTabs: [], remoteTabs: [] };
				}
				const retryDelay = RECONCILE_RETRY_DELAYS_MS[attempt];
				if (retryDelay !== undefined) await delay(retryDelay);
			}
		}

		if (!hasKnownLease()) scheduleIdleClose();
		const detail = lastError instanceof Error ? lastError.message : String(lastError);
		throw new Error(`Unable to reconcile the live offscreen host: ${detail}`, { cause: lastError });
	});
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function getOffscreenLeaseCount(): number {
	const keys = new Set<OffscreenLeaseKey>(localLeases);
	for (const key of recoveredLeases) keys.add(key);
	return keys.size;
}

export function isOffscreenHostStateUnknown(): boolean {
	return hostStateUnknown;
}

// Lifecycle/test barrier: callers that are about to tear down their execution
// environment can wait until a timer/alarm-triggered close has left the mutex.
export async function flushOffscreenCoordinatorLifecycle(): Promise<void> {
	await lifecycleTail;
}
