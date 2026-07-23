// Authenticated PeerJS host for the unified SPECTRA offscreen document.
// The module intentionally does not register a runtime listener by itself: the
// unified offscreen entry owns that listener and delegates REMOTE_HOST_* calls.

import type Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import {
	isRemoteState,
	resolveAudioVolumeState,
	type OffscreenHostResponse,
	type RemoteHostCloseReason,
	type RemoteHostEvent,
	type RemoteHostRequest,
	type RemoteHostRequestType,
	type RemoteHostSession,
} from '@nexus/contracts';
import {
	REMOTE_AUTH_TIMEOUT_MS,
	REMOTE_PROTOCOL_VERSION,
	REMOTE_RECONNECT_TTL_MS,
	createRemotePairing,
	generateRandomToken,
	isRemoteAuthenticateMessage,
	isRemoteCommandMessage,
	type RemotePairing,
	type RemoteState,
	verifyRemoteProof,
} from '../remote/protocol';

const LOG = '[SPECTRA Remote Host]';

export type RemoteHostSessionStatus = RemoteHostSession;

export interface RemoteHostControllerDependencies {
	createPeer?: (peerId: string) => Peer;
	sendRuntimeMessage?: (message: unknown) => unknown;
	now?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => number;
	clearTimer?: (timerId: number) => void;
}

export interface RemoteHostController {
	handleRuntimeMessage(
		message: RemoteHostRequest,
		sendResponse: (response: OffscreenHostResponse<RemoteHostRequestType>) => void,
	): boolean;
	createSession(tabId: number): Promise<RemoteHostSessionStatus>;
	getStatus(tabId: number): RemoteHostSessionStatus | null;
	closeSession(tabId: number, sessionId: string, reason?: RemoteCloseReason): Promise<boolean>;
	closeTab(tabId: number): Promise<boolean>;
	sendState(tabId: number, sessionId: string, state: RemoteState): boolean;
	describeSessions(): RemoteHostSessionStatus[];
	destroy(): Promise<void>;
}

export type RemoteCloseReason = RemoteHostCloseReason;

interface HostSession {
	pairing: RemotePairing;
	capability: string;
	tabId: number;
	peer: Peer;
	connection: DataConnection | null;
	authenticated: boolean;
	everAuthenticated: boolean;
	lastSequence: number;
	lastGeneration: number;
	lastState: RemoteState | null;
	reconnectUntil: number | null;
	expiryTimer: number | null;
}

interface PendingSessionCreation {
	promise: Promise<RemoteHostSessionStatus>;
	peer: Peer;
	pairing: RemotePairing;
	cancel(): void;
}

export function createRemoteHostController(
	dependencies: RemoteHostControllerDependencies = {},
): RemoteHostController {
	const createPeer = dependencies.createPeer ?? ((peerId: string) => {
		const PeerConstructor = (globalThis as typeof globalThis & {
			Peer?: typeof import('peerjs').default;
		}).Peer;
		if (!PeerConstructor) throw new Error('Local PeerJS vendor runtime is unavailable');
		return new PeerConstructor(peerId, {
			debug: 0,
			referrerPolicy: 'no-referrer',
		});
	});
	const sendRuntimeMessage = dependencies.sendRuntimeMessage ?? ((message: unknown) => chrome.runtime.sendMessage(message));
	const now = dependencies.now ?? Date.now;
	const setTimer = dependencies.setTimer ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
	const clearTimer = dependencies.clearTimer ?? ((timerId) => window.clearTimeout(timerId));
	const sessions = new Map<number, HostSession>();
	const pendingCreations = new Map<number, PendingSessionCreation>();

	function emit(message: RemoteHostEvent): void {
		try {
			Promise.resolve(sendRuntimeMessage(message)).catch((error) => console.warn(LOG, 'Runtime message failed', error));
		} catch (error) {
			console.warn(LOG, 'Runtime message failed', error);
		}
	}

	function publicStatus(session: HostSession): RemoteHostSessionStatus {
		return {
			...session.pairing,
			tabId: session.tabId,
			connected: session.authenticated && session.connection?.open === true,
			capability: session.capability,
			reconnectUntil: session.reconnectUntil,
			generation: session.lastGeneration,
		};
	}

	function effectiveAuthDeadline(session: HostSession): number {
		return session.everAuthenticated
			? (session.reconnectUntil ?? now() + REMOTE_RECONNECT_TTL_MS)
			: session.pairing.pairingExpiresAt;
	}

	function canAuthenticate(session: HostSession): boolean {
		return now() <= effectiveAuthDeadline(session);
	}

	function scheduleExpiry(session: HostSession, deadline: number, reason: RemoteCloseReason): void {
		if (session.expiryTimer !== null) clearTimer(session.expiryTimer);
		const delay = Math.max(0, deadline - now());
		session.expiryTimer = setTimer(() => {
			const current = sessions.get(session.tabId);
			if (current !== session || current.authenticated) return;
			void closeSession(session.tabId, session.pairing.sessionId, reason)
				.catch((error) => console.warn(LOG, 'Expiry close failed', error));
		}, delay);
	}

	function rejectConnection(
		connection: DataConnection,
		sessionId: string,
		error: 'AUTH_FAILED' | 'EXPIRED' | 'ALREADY_CONNECTED' | 'INVALID_MESSAGE',
	): void {
		if (connection.open) {
			connection.send({
				type: 'spectra.remote.auth-result',
				protocolVersion: REMOTE_PROTOCOL_VERSION,
				sessionId,
				ok: false,
				error,
			});
		}
		connection.close();
	}

	function acceptConnection(session: HostSession, connection: DataConnection): void {
		if (session.authenticated && session.connection?.open) {
			connection.on('open', () => rejectConnection(connection, session.pairing.sessionId, 'ALREADY_CONNECTED'));
			return;
		}

		const nonce = generateRandomToken(32);
		let authenticated = false;
		let authenticating = false;
		const authTimer = setTimer(() => {
			if (!authenticated) rejectConnection(connection, session.pairing.sessionId, 'AUTH_FAILED');
		}, REMOTE_AUTH_TIMEOUT_MS);

		connection.on('open', () => {
			if (!canAuthenticate(session)) {
				rejectConnection(connection, session.pairing.sessionId, 'EXPIRED');
				return;
			}
			connection.send({
				type: 'spectra.remote.challenge',
				protocolVersion: REMOTE_PROTOCOL_VERSION,
				sessionId: session.pairing.sessionId,
				nonce,
				pairingExpiresAt: effectiveAuthDeadline(session),
			});
		});

		connection.on('data', (data: unknown) => {
			if (!authenticated) {
				if (authenticating) return;
				if (!isRemoteAuthenticateMessage(data) || data.sessionId !== session.pairing.sessionId) {
					rejectConnection(connection, session.pairing.sessionId, 'INVALID_MESSAGE');
					return;
				}
				authenticating = true;
				void verifyRemoteProof(session.pairing.secret, session.pairing.sessionId, nonce, data.proof)
					.then((valid) => {
						if (!valid || !connection.open || !canAuthenticate(session) || sessions.get(session.tabId) !== session) {
							rejectConnection(connection, session.pairing.sessionId, valid ? 'EXPIRED' : 'AUTH_FAILED');
							return;
						}
						if (session.authenticated && session.connection?.open && session.connection !== connection) {
							rejectConnection(connection, session.pairing.sessionId, 'ALREADY_CONNECTED');
							return;
						}

						authenticated = true;
						session.authenticated = true;
						session.everAuthenticated = true;
						session.connection = connection;
						session.lastSequence = 0;
						session.reconnectUntil = null;
						if (session.expiryTimer !== null) {
							clearTimer(session.expiryTimer);
							session.expiryTimer = null;
						}
						clearTimer(authTimer);

						connection.send({
							type: 'spectra.remote.auth-result',
							protocolVersion: REMOTE_PROTOCOL_VERSION,
							sessionId: session.pairing.sessionId,
							ok: true,
							reconnectUntil: now() + REMOTE_RECONNECT_TTL_MS,
						});
						if (session.lastState) sendState(session.tabId, session.pairing.sessionId, session.lastState);
						emit({
							type: 'REMOTE_HOST_STATUS_CHANGE',
							tabId: session.tabId,
							sessionId: session.pairing.sessionId,
							capability: session.capability,
							connected: true,
						});
						emit({
							type: 'REMOTE_HOST_REQUEST_SYNC',
							tabId: session.tabId,
							sessionId: session.pairing.sessionId,
							capability: session.capability,
						});
					})
					.catch(() => rejectConnection(connection, session.pairing.sessionId, 'AUTH_FAILED'));
				return;
			}

			if (!isRemoteCommandMessage(data)
				|| data.sessionId !== session.pairing.sessionId
				|| data.sequence <= session.lastSequence
				|| data.generation !== session.lastGeneration) {
				return;
			}

			session.lastSequence = data.sequence;
			emit({
				type: 'REMOTE_HOST_EXECUTE_COMMAND',
				tabId: session.tabId,
				sessionId: session.pairing.sessionId,
				capability: session.capability,
				sequence: data.sequence,
				generation: data.generation,
				command: data.command,
			});
		});

		connection.on('close', () => {
			clearTimer(authTimer);
			if (!authenticated || session.connection !== connection || sessions.get(session.tabId) !== session) return;
			session.authenticated = false;
			session.connection = null;
			session.reconnectUntil = now() + REMOTE_RECONNECT_TTL_MS;
			scheduleExpiry(session, session.reconnectUntil, 'reconnect-expired');
			emit({
				type: 'REMOTE_HOST_STATUS_CHANGE',
				tabId: session.tabId,
				sessionId: session.pairing.sessionId,
				capability: session.capability,
				connected: false,
				reconnectUntil: session.reconnectUntil,
			});
		});

		connection.on('error', () => {
			if (!connection.open) connection.close();
		});
	}

	function createSession(tabId: number): Promise<RemoteHostSessionStatus> {
		if (!Number.isInteger(tabId) || tabId <= 0) return Promise.reject(new Error('Invalid tabId'));
		const existing = sessions.get(tabId);
		if (existing) return Promise.resolve(publicStatus(existing));
		const pending = pendingCreations.get(tabId);
		if (pending) return pending.promise;

		const pairing = createRemotePairing(now());
		const capability = generateRandomToken(16);
		const peer = createPeer(pairing.peerId);
		const session: HostSession = {
			pairing,
			capability,
			tabId,
			peer,
			connection: null,
			authenticated: false,
			everAuthenticated: false,
			lastSequence: 0,
			lastGeneration: 0,
			lastState: null,
			reconnectUntil: null,
			expiryTimer: null,
		};

		let creation!: PendingSessionCreation;
		const promise = new Promise<RemoteHostSessionStatus>((resolve, reject) => {
			let settled = false;
			const openTimer = setTimer(() => {
				if (settled) return;
				settled = true;
				peer.destroy();
				pairing.secret = '';
				session.capability = '';
				reject(new Error('Peer signaling connection timed out'));
			}, REMOTE_AUTH_TIMEOUT_MS);
			creation = {
				promise: Promise.resolve(null as never),
				peer,
				pairing,
				cancel() {
					if (settled) return;
					settled = true;
					clearTimer(openTimer);
					peer.destroy();
					pairing.secret = '';
					session.capability = '';
					reject(new Error('Remote session creation was cancelled'));
				},
			};

			peer.on('open', () => {
				if (settled || pendingCreations.get(tabId) !== creation) {
					peer.destroy();
					return;
				}
				settled = true;
				clearTimer(openTimer);
				sessions.set(tabId, session);
				scheduleExpiry(session, pairing.pairingExpiresAt, 'pairing-expired');
				resolve(publicStatus(session));
			});
			peer.on('connection', (connection) => acceptConnection(session, connection));
			peer.on('error', (error) => {
				console.warn(LOG, 'Peer error', error.type, error.message);
				if (settled) return;
				settled = true;
				clearTimer(openTimer);
				peer.destroy();
				pairing.secret = '';
				session.capability = '';
				reject(new Error(`Peer signaling failed: ${error.type}`));
			});
		});
		creation.promise = promise;
		pendingCreations.set(tabId, creation);
		void promise.finally(() => {
			if (pendingCreations.get(tabId) === creation) pendingCreations.delete(tabId);
		}).catch(() => undefined);
		return promise;
	}

	function getStatus(tabId: number): RemoteHostSessionStatus | null {
		const session = sessions.get(tabId);
		return session ? publicStatus(session) : null;
	}

	async function closeSession(tabId: number, sessionId: string, reason: RemoteCloseReason = 'manual'): Promise<boolean> {
		const session = sessions.get(tabId);
		if (!session || session.pairing.sessionId !== sessionId) return false;
		if (session.expiryTimer !== null) clearTimer(session.expiryTimer);
		if (session.authenticated && session.connection?.open) {
			session.connection.send({
				type: 'spectra.remote.closed',
				protocolVersion: REMOTE_PROTOCOL_VERSION,
				sessionId,
				reason,
			});
		}
		session.connection?.close();
		session.peer.destroy();
		session.pairing.secret = '';
		session.capability = '';
		sessions.delete(tabId);
		emit({ type: 'REMOTE_HOST_SESSION_CLOSED', tabId, sessionId, reason });
		return true;
	}

	async function closeTab(tabId: number): Promise<boolean> {
		const pending = pendingCreations.get(tabId);
		if (pending) pending.cancel();
		const session = sessions.get(tabId);
		if (session) return closeSession(tabId, session.pairing.sessionId, 'tab-closed');
		return pending !== undefined;
	}

	function sendState(tabId: number, sessionId: string, state: RemoteState): boolean {
		const session = sessions.get(tabId);
		if (!session || session.pairing.sessionId !== sessionId || !isRemoteState(state)) return false;
		const safeState = sanitizeRemoteState(state);
		session.lastState = safeState;
		session.lastGeneration = safeState.generation;
		if (!session.authenticated || !session.connection?.open) return false;
		session.connection.send({
			type: 'spectra.remote.state',
			protocolVersion: REMOTE_PROTOCOL_VERSION,
			sessionId,
			...safeState,
		});
		return true;
	}

	function describeSessions(): RemoteHostSessionStatus[] {
		return [...sessions.values()].map(publicStatus);
	}

	async function destroy(): Promise<void> {
		for (const pending of pendingCreations.values()) pending.cancel();
		await Promise.all([...sessions.values()].map((session) => (
			closeSession(session.tabId, session.pairing.sessionId, 'host-destroyed')
		)));
	}

	function handleRuntimeMessage(
		message: RemoteHostRequest,
		sendResponse: (response: OffscreenHostResponse<RemoteHostRequestType>) => void,
	): boolean {
		if (message.type === 'REMOTE_HOST_CREATE_SESSION') {
			void createSession(message.tabId)
				.then((session) => sendResponse({ success: true, session }))
				.catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : 'CREATE_FAILED' }));
			return true;
		}
		if (message.type === 'REMOTE_HOST_GET_STATUS') {
			sendResponse({ session: getStatus(message.tabId) });
			return false;
		}
		if (message.type === 'REMOTE_HOST_DESCRIBE') {
			sendResponse({ sessions: describeSessions() });
			return false;
		}
		if (message.type === 'REMOTE_HOST_CLOSE_SESSION') {
			void closeSession(message.tabId, message.sessionId)
				.then((closed) => sendResponse({ success: closed, error: closed ? undefined : 'SESSION_MISMATCH' }));
			return true;
		}
		if (message.type === 'REMOTE_HOST_CLOSE_TAB') {
			void closeTab(message.tabId)
				.then((closed) => sendResponse({ success: closed }));
			return true;
		}
		if (message.type === 'REMOTE_HOST_SEND_STATE') {
			sendResponse({ success: sendState(message.tabId, message.sessionId, message.state) });
			return false;
		}
		return false;
	}

	return {
		handleRuntimeMessage,
		createSession,
		getStatus,
		closeSession,
		closeTab,
		sendState,
		describeSessions,
		destroy,
	};
}

function sanitizeRemoteState(state: RemoteState): RemoteState {
	const volumeBase = typeof state.volumeBase === 'number'
		? Math.max(0, Math.min(100, Math.round(state.volumeBase)))
		: Math.max(0, Math.min(100, Math.round(state.volume)));
	const boost = typeof state.boost === 'number'
		? Math.max(1, Math.min(8, Math.round(state.boost * 10) / 10))
		: state.volume > 100 ? Math.max(1, Math.min(8, state.volume / 100)) : 1;
	return {
		generation: state.generation,
		volume: Math.round(Math.max(0, Math.min(800, state.volume)) * 10) / 10,
		volumeBase,
		boost,
		actualMode: state.actualMode,
		phase: state.phase,
		volumeState: state.volumeState ?? resolveAudioVolumeState(state),
		muted: state.muted,
		playing: state.playing,
		speed: Math.max(0.25, Math.min(16, state.speed)),
		tabTitle: state.tabTitle?.slice(0, 512),
		tabDomain: state.tabDomain?.slice(0, 253),
	};
}
