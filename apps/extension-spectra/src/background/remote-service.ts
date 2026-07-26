// Background boundary for authenticated remote-control sessions. Offscreen
// lifecycle belongs exclusively to offscreen-coordinator.

import {
	Actions,
	SPECTRA_PROTOCOL_VERSION,
	isOffscreenHostEvent,
	isSpectraRequestEnvelope,
	rpcFailure,
	rpcSuccess,
	type RemoteHostEvent,
	type RemoteHostSession,
	type RemoteState,
	type SpectraEventEnvelope,
} from '@nexus/contracts';
import {
	acquireOffscreenLease,
	reconcileOffscreenHost,
	releaseOffscreenLease,
	sendOffscreenMessage,
	sendOffscreenMessageIfPresent,
} from './offscreen-coordinator';
import { executeCommand, setStateCallback, syncState } from './remote-commands';
import {
	ensureContentRuntime,
	releaseContentRuntimeLease,
} from './runtime-loader';
import {
	isSessionId,
	type RemotePublicSession,
} from '../remote/protocol';

const LOG = '[SPECTRA Remote BG]';

type HostSession = RemoteHostSession;

interface SessionAuthorization {
	session: HostSession;
	lastSequence: number;
	generation: number;
}

const authorizations = new Map<number, SessionAuthorization>();
const remoteObservationLeases = new Map<number, {
	documentId: string;
	capability: string;
}>();
const sessionCreations = new Map<number, Promise<{ success: boolean; session?: RemotePublicSession; error?: string }>>();
const closingTabs = new Set<number>();
let restorePromise: Promise<void> | null = null;
let restoreComplete = false;

function isAttemptedRemoteV2Message(message: unknown): boolean {
	if (!isRecord(message)) return false;
	return message.protocolVersion === SPECTRA_PROTOCOL_VERSION
		&& (message.type === 'spectra.remote.session.get'
			|| message.type === 'spectra.remote.session.create'
			|| message.type === 'spectra.remote.session.close');
}

function publishRemoteChanged(tabId: number, sessionId: string, connected: boolean): void {
	const event: SpectraEventEnvelope<'spectra.remote.session.changed'> = {
		protocolVersion: SPECTRA_PROTOCOL_VERSION,
		type: 'spectra.remote.session.changed',
		tabId,
		payload: { tabId, sessionId, connected },
	};
	void chrome.runtime.sendMessage(event).catch(() => undefined);
}

function publishRemoteClosed(tabId: number, sessionId: string): void {
	const event: SpectraEventEnvelope<'spectra.remote.session.closed'> = {
		protocolVersion: SPECTRA_PROTOCOL_VERSION,
		type: 'spectra.remote.session.closed',
		tabId,
		payload: { tabId, sessionId },
	};
	void chrome.runtime.sendMessage(event).catch(() => undefined);
}

function sessionLeaseKey(sessionId: string): `remote:${string}` {
	return `remote:${sessionId}`;
}

function pendingLeaseKey(tabId: number): `remote:${string}` {
	return `remote:pending:${tabId}`;
}

function rememberSession(session: HostSession): void {
	if (closingTabs.has(session.tabId)) {
		releaseOffscreenLease(sessionLeaseKey(session.sessionId));
		return;
	}
	const existing = authorizations.get(session.tabId);
	if (existing && existing.session.sessionId !== session.sessionId) {
		releaseOffscreenLease(sessionLeaseKey(existing.session.sessionId));
		releaseRemoteObservation(session.tabId);
	}
	authorizations.set(session.tabId, {
		session,
		lastSequence: existing?.session.sessionId === session.sessionId ? existing.lastSequence : 0,
		generation: existing?.session.sessionId === session.sessionId
			? Math.max(existing.generation, session.generation)
			: session.generation,
	});
}

function releaseRemoteObservation(tabId: number): void {
	const lease = remoteObservationLeases.get(tabId);
	if (!lease) return;
	remoteObservationLeases.delete(tabId);
	releaseContentRuntimeLease(tabId, lease.documentId, 'remote', lease.capability);
}

async function acquireRemoteObservation(session: HostSession): Promise<void> {
	const capability = `session:${session.sessionId}`;
	const ready = await ensureContentRuntime(session.tabId, undefined, 'remote', capability);
	const previous = remoteObservationLeases.get(session.tabId);
	if (previous && (previous.documentId !== ready.documentId
		|| previous.capability !== capability)) {
		releaseContentRuntimeLease(session.tabId, previous.documentId, 'remote', previous.capability);
	}
	remoteObservationLeases.set(session.tabId, {
		documentId: ready.documentId,
		capability,
	});
}

function forgetSession(tabId: number): void {
	const known = authorizations.get(tabId);
	authorizations.delete(tabId);
	if (known) releaseOffscreenLease(sessionLeaseKey(known.session.sessionId));
	releaseOffscreenLease(pendingLeaseKey(tabId));
	releaseRemoteObservation(tabId);
}

function toPublicSession(session: HostSession): RemotePublicSession {
	const {
		capability: _capability,
		reconnectUntil: _reconnectUntil,
		generation: _generation,
		...publicSession
	} = session;
	return publicSession;
}

async function restoreSessions(): Promise<void> {
	const snapshot = await reconcileOffscreenHost();
	await Promise.all(snapshot.remoteTabs.map(async ({ tabId, sessionId }) => {
		// reconcileOffscreenHost already installed the recovered remote lease. A
		// transient status failure must reject the restore without deleting that
		// lease, otherwise an unrelated audio release could close the live host.
		const response = await sendOffscreenMessage({
			type: 'REMOTE_HOST_GET_STATUS',
			tabId,
		});
		if (!response.session
			|| response.session.tabId !== tabId
			|| response.session.sessionId !== sessionId) {
			throw new Error('Remote host status does not match its HELLO snapshot');
		}
		rememberSession(response.session);
		// Seed the offscreen session with a side-effect-free actual projection even
		// when no controller is connected yet. The host stores it without sending
		// anything before HMAC authentication, then can deliver the first state in
		// the same authenticated handshake instead of depending on a later worker
		// event racing the remote page's initial render.
		await syncState(tabId);
		if (response.session.connected) await acquireRemoteObservation(response.session);
	}));
}

// A failed restore is never converted into an empty-session success. The next
// UI operation or authenticated host event retries the authoritative handshake.
export function ensureRemoteSessionsRestored(): Promise<void> {
	if (restoreComplete) return Promise.resolve();
	if (restorePromise) return restorePromise;

	const attempt = restoreSessions().then(() => {
		restoreComplete = true;
	});
	restorePromise = attempt;
	void attempt.finally(() => {
		if (restorePromise === attempt) restorePromise = null;
	}).catch(() => undefined);
	return attempt;
}

function createSession(tabId: number): Promise<{ success: boolean; session?: RemotePublicSession; error?: string }> {
	const pending = sessionCreations.get(tabId);
	if (pending) return pending;
	const creation = createSessionOnce(tabId);
	sessionCreations.set(tabId, creation);
	void creation.finally(() => {
		if (sessionCreations.get(tabId) === creation) sessionCreations.delete(tabId);
	}).catch(() => undefined);
	return creation;
}

async function createSessionOnce(tabId: number): Promise<{ success: boolean; session?: RemotePublicSession; error?: string }> {
	await ensureRemoteSessionsRestored();
	const existing = authorizations.get(tabId);
	if (existing) {
		await syncState(tabId);
		if (existing.session.connected) {
			await acquireRemoteObservation(existing.session).catch(() => undefined);
		}
		return { success: true, session: toPublicSession(existing.session) };
	}

	await assertControllableTab(tabId);
	// Chrome can eventually reuse a numeric tab id. A successful controllability
	// check proves this is a new live tab, not the closed tab represented by the tombstone.
	closingTabs.delete(tabId);
	await acquireOffscreenLease(pendingLeaseKey(tabId));
	try {
		const response = await sendOffscreenMessage({
			type: 'REMOTE_HOST_CREATE_SESSION',
			tabId,
		});
		if (!response.success || !response.session) {
			forgetSession(tabId);
			return { success: false, error: response.error ?? 'CREATE_FAILED' };
		}
		await acquireOffscreenLease(sessionLeaseKey(response.session.sessionId));
		releaseOffscreenLease(pendingLeaseKey(tabId));
		rememberSession(response.session);
		await syncState(tabId);
		return { success: true, session: toPublicSession(response.session) };
	} catch (error) {
		forgetSession(tabId);
		return { success: false, error: error instanceof Error ? error.message : 'CREATE_FAILED' };
	}
}

async function getSession(tabId: number): Promise<{ session: RemotePublicSession | null; connected: boolean }> {
	await ensureRemoteSessionsRestored();
	const known = authorizations.get(tabId);
	if (!known) return { session: null, connected: false };
	try {
		const response = await sendOffscreenMessage({
			type: 'REMOTE_HOST_GET_STATUS',
			tabId,
		});
		if (!response.session || response.session.sessionId !== known.session.sessionId) {
			forgetSession(tabId);
			return { session: null, connected: false };
		}
		rememberSession(response.session);
		if (response.session.connected) await acquireRemoteObservation(response.session);
		return { session: toPublicSession(response.session), connected: response.session.connected };
	} catch {
		return { session: toPublicSession(known.session), connected: known.session.connected };
	}
}

async function closeSession(tabId: number, sessionId: string): Promise<{ success: boolean; error?: string }> {
	await ensureRemoteSessionsRestored();
	const known = authorizations.get(tabId);
	if (!known || known.session.sessionId !== sessionId) return { success: false, error: 'SESSION_MISMATCH' };
	try {
		const response = await sendOffscreenMessage({
			type: 'REMOTE_HOST_CLOSE_SESSION',
			tabId,
			sessionId,
		});
		if (!response.success && response.error !== 'SESSION_MISMATCH') return response;
		forgetSession(tabId);
		return { success: true };
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : 'CLOSE_FAILED' };
	}
}

function sendStateToOffscreen(tabId: number, state: RemoteState): void {
	const authorization = authorizations.get(tabId);
	if (!authorization) return;
	authorization.generation = state.generation;
	void sendOffscreenMessage({
		type: 'REMOTE_HOST_SEND_STATE',
		tabId,
		sessionId: authorization.session.sessionId,
		state,
	}).catch(() => undefined);
}

type AuthorizedRemoteHostEvent = Extract<RemoteHostEvent, { capability: string }>;

async function authorizeHostEvent(message: AuthorizedRemoteHostEvent): Promise<SessionAuthorization | null> {
	const { tabId, sessionId, capability } = message;
	try {
		await ensureRemoteSessionsRestored();
	} catch {
		return null;
	}

	let authorization = authorizations.get(tabId);
	if (!authorization) {
		try {
			const response = await sendOffscreenMessage({ type: 'REMOTE_HOST_GET_STATUS', tabId });
			if (!response.session) return null;
			rememberSession(response.session);
			authorization = authorizations.get(tabId);
		} catch {
			return null;
		}
	}
	if (!authorization
		|| authorization.session.sessionId !== sessionId
		|| authorization.session.capability !== capability) return null;
	return authorization;
}

async function handleHostCommand(
	message: Extract<RemoteHostEvent, { type: 'REMOTE_HOST_EXECUTE_COMMAND' }>,
): Promise<void> {
	const authorization = await authorizeHostEvent(message);
	if (!authorization) return;
	await acquireRemoteObservation(authorization.session).catch(() => undefined);
	if (message.sequence <= authorization.lastSequence
		|| message.generation !== authorization.generation) {
		await syncState(authorization.session.tabId);
		return;
	}
	authorization.lastSequence = message.sequence;
	try {
		await executeCommand(message.command, authorization.session.tabId);
	} catch {
		await syncState(authorization.session.tabId);
	}
}

async function handleHostSync(
	message: Extract<RemoteHostEvent, { type: 'REMOTE_HOST_REQUEST_SYNC' }>,
): Promise<void> {
	const authorization = await authorizeHostEvent(message);
	if (authorization) {
		await acquireRemoteObservation(authorization.session).catch(() => undefined);
		await syncState(authorization.session.tabId);
	}
}

async function handleHostStatusChange(
	message: Extract<RemoteHostEvent, { type: 'REMOTE_HOST_STATUS_CHANGE' }>,
): Promise<void> {
	const authorization = await authorizeHostEvent(message);
	if (!authorization) return;
	authorization.session.connected = message.connected;
	if (message.connected) {
		await acquireRemoteObservation(authorization.session);
		await syncState(authorization.session.tabId);
	} else {
		releaseRemoteObservation(authorization.session.tabId);
	}
	publishRemoteChanged(
		authorization.session.tabId,
		authorization.session.sessionId,
		message.connected,
	);
}

function keepHostEventAlive(
	operation: Promise<void>,
	sendResponse: (response: unknown) => void,
): true {
	void operation.then(
		() => sendResponse({ settled: true }),
		(error: unknown) => {
			console.warn(LOG, 'Host event failed', error);
			sendResponse({ settled: false });
		},
	);
	// A response channel is the MV3 lifetime owner for work which must survive
	// the async restore/authentication boundary after a service-worker restart.
	return true;
}

async function closeTabSession(tabId: number): Promise<void> {
	closingTabs.add(tabId);
	let lastError: unknown;
	try {
		// Never wait for HELLO and never create a document on teardown. CLOSE_TAB is
		// deliberately capability-free so a restarted worker can destroy an unknown
		// pending or authenticated session directly in the already-existing host.
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				await sendOffscreenMessageIfPresent({
					type: 'REMOTE_HOST_CLOSE_TAB',
					tabId,
				});
				return;
			} catch (error) {
				lastError = error;
				const backoff = Math.min(1000 * 2 ** attempt, 4000);
				await new Promise((r) => setTimeout(r, backoff));
			}
		}
	} finally {
		forgetSession(tabId);
	}
	const detail = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`Unable to destroy remote session for closed tab ${tabId}: ${detail}`, {
		cause: lastError,
	});
}

export function initRemoteService(): void {
	setStateCallback(sendStateToOffscreen);
	void ensureRemoteSessionsRestored().catch((error) => console.warn(LOG, 'Session restore failed', error));

	chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
		if (isAttemptedRemoteV2Message(rawMessage)) {
			if (!isTrustedExtensionUi(sender)) {
				sendResponse(rpcFailure('forbidden', 'Remote session RPC is extension-UI only'));
				return false;
			}
			if (!isSpectraRequestEnvelope(rawMessage)) {
				sendResponse(rpcFailure('invalid_request', 'Malformed SPECTRA v2 remote request'));
				return false;
			}
			const operation = async () => {
				if (rawMessage.type === 'spectra.remote.session.get') {
					return rpcSuccess(await getSession(rawMessage.payload.tabId));
				}
				if (rawMessage.type === 'spectra.remote.session.create') {
					const result = await createSession(rawMessage.payload.tabId);
					return result.success && result.session
						? rpcSuccess(result.session)
						: rpcFailure('remote_create_failed', result.error ?? 'Unable to create remote session', true);
				}
				if (rawMessage.type === 'spectra.remote.session.close') {
					const result = await closeSession(rawMessage.payload.tabId, rawMessage.payload.sessionId);
					return result.success
						? rpcSuccess({ closed: true as const })
						: rpcFailure('remote_close_failed', result.error ?? 'Unable to close remote session');
				}
				return rpcFailure('unsupported_request', 'No remote handler for this request');
			};
			void operation().then(sendResponse).catch((error: unknown) => {
				sendResponse(rpcFailure(
					'remote_unavailable',
					error instanceof Error ? error.message : String(error),
					true,
				));
			});
			return true;
		}
		if (!isRecord(rawMessage)) return false;
		const message = rawMessage;

		if (message.action === Actions.REMOTE_CREATE_SESSION) {
			if (!isTrustedExtensionUi(sender) || !isTabId(message.tabId)) {
				sendResponse({ success: false, error: 'INVALID_REQUEST' });
				return false;
			}
			void createSession(message.tabId).then(sendResponse);
			return true;
		}

		if (message.action === Actions.REMOTE_GET_SESSION) {
			if (!isTrustedExtensionUi(sender) || !isTabId(message.tabId)) {
				sendResponse({ session: null, connected: false, error: 'INVALID_REQUEST' });
				return false;
			}
			void getSession(message.tabId).then(sendResponse);
			return true;
		}

		if (message.action === Actions.REMOTE_CLOSE_SESSION) {
			if (!isTrustedExtensionUi(sender) || !isTabId(message.tabId) || !isSessionId(message.sessionId)) {
				sendResponse({ success: false, error: 'INVALID_REQUEST' });
				return false;
			}
			void closeSession(message.tabId, message.sessionId).then(sendResponse);
			return true;
		}

		if (!isTrustedOffscreenSender(sender)) return false;
		if (!isOffscreenHostEvent(message)) return false;

		if (message.type === 'REMOTE_HOST_EXECUTE_COMMAND') {
			return keepHostEventAlive(handleHostCommand(message), sendResponse);
		}
		if (message.type === 'REMOTE_HOST_REQUEST_SYNC') {
			return keepHostEventAlive(handleHostSync(message), sendResponse);
		}
		if (message.type === 'REMOTE_HOST_STATUS_CHANGE') {
			return keepHostEventAlive(handleHostStatusChange(message), sendResponse);
		}
		if (message.type === 'REMOTE_HOST_SESSION_CLOSED') {
			const known = authorizations.get(message.tabId);
			if (known?.session.sessionId === message.sessionId) {
				forgetSession(message.tabId);
				publishRemoteClosed(message.tabId, message.sessionId);
			}
			return false;
		}

		return false;
	});

	chrome.tabs.onRemoved.addListener((tabId) => {
		void closeTabSession(tabId).catch((error) => console.warn(LOG, 'Tab session close deferred', error));
	});
}

async function assertControllableTab(tabId: number): Promise<void> {
	const tab = await chrome.tabs.get(tabId);
	if (!tab.url) throw new Error('TAB_UNAVAILABLE');
	let protocol: string;
	try {
		protocol = new URL(tab.url).protocol;
	} catch {
		throw new Error('TAB_UNAVAILABLE');
	}
	if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'file:') throw new Error('TAB_NOT_CONTROLLABLE');
}

function isTrustedExtensionUi(sender: chrome.runtime.MessageSender): boolean {
	if (sender.id && sender.id !== chrome.runtime.id) return false;
	if (sender.tab) return false;
	return !sender.url || sender.url.startsWith(chrome.runtime.getURL(''));
}

function isTrustedOffscreenSender(sender: chrome.runtime.MessageSender): boolean {
	return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('offscreen.html');
}

function isTabId(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
