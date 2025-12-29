// goal: manages multi-session PeerJS connectivity within an offscreen document for remote control
// rule: each browser tab maintains an isolated session identified by its tabId to allow concurrent remote control

import Peer, { DataConnection } from 'peerjs';

type RemoteCommand =
	| 'volume_up' | 'volume_down' | 'volume_max' | 'volume_100'
	| 'mute' | 'play_pause'
	| 'seek_forward' | 'seek_backward' | 'seek_forward_30' | 'seek_backward_30'
	| 'speed_up' | 'speed_down' | 'speed_reset'
	| 'fullscreen' | 'pip';

interface RemoteSession {
	sessionId: string;
	peerId: string;
	connected: boolean;
	tabId: number;
	peer: Peer;
	connection: DataConnection | null;
}

// sessions: tabId -> RemoteSession; high-volatile cache for active WebRTC pairings
const sessions = new Map<number, RemoteSession>();

const LOG = '[SPECTRA Remote Offscreen]';

function generateSessionId(): string {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let id = '';
	for (let i = 0; i < 6; i++) {
		id += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return id;
}

// post: returns an existing session for the tabId or creates a new PeerJS instance
async function createSession(tabId: number): Promise<RemoteSession> {
	const existing = sessions.get(tabId);
	if (existing) {
		return existing;
	}

	const sessionId = generateSessionId();
	const peerId = `spectra-${sessionId}`;

	return new Promise((resolve, reject) => {
		const peer = new Peer(peerId, { debug: 1 });

		const session: RemoteSession = {
			sessionId,
			peerId,
			connected: false,
			tabId,
			peer,
			connection: null,
		};

		peer.on('open', () => {
			console.log(LOG, `[Tab ${tabId}] Peer ready:`, peerId);
			sessions.set(tabId, session);
			resolve(session);
		});

		peer.on('connection', (conn) => {
			console.log(LOG, `[Tab ${tabId}] Connection from:`, conn.peer);
			session.connection = conn;

			conn.on('open', () => {
				console.log(LOG, `[Tab ${tabId}] DataChannel open`);
				session.connected = true;
				conn.send({ type: 'connected' });
				// eff: notify background to trigger UI updates and immediate state broadcast
				chrome.runtime.sendMessage({ type: 'REMOTE_STATUS_CHANGE', tabId, connected: true });
				chrome.runtime.sendMessage({ type: 'REMOTE_REQUEST_SYNC', tabId });
			});

			conn.on('data', (data) => handleData(data, tabId));

			conn.on('close', () => {
				console.log(LOG, `[Tab ${tabId}] Connection closed`);
				session.connected = false;
				session.connection = null;
				chrome.runtime.sendMessage({ type: 'REMOTE_STATUS_CHANGE', tabId, connected: false });
			});
		});

		peer.on('error', (err) => {
			// note: network disconnects are expected, downgrade to warn
			console.warn(LOG, `[Tab ${tabId}] Peer error:`, err.type, err.message);
			reject(err);
		});

		setTimeout(() => {
			if (!peer?.open) reject(new Error('Peer connection timeout'));
		}, 10000);
	});
}

function handleData(data: unknown, tabId: number): void {
	if (!data || typeof data !== 'object') return;
	const msg = data as { type: string; command?: RemoteCommand };
	if (msg.type === 'command' && msg.command) {
		console.log(LOG, `[Tab ${tabId}] Command:`, msg.command);
		// eff: tunnels remote commands to the background router for execution
		chrome.runtime.sendMessage({
			type: 'REMOTE_EXECUTE_COMMAND',
			command: msg.command,
			tabId,
		});
	}
}

// eff: destroys the PeerJS instance and closes associated DataChannels to release network resources
async function closeSession(tabId: number): Promise<void> {
	const session = sessions.get(tabId);
	if (!session) return;

	session.connection?.close();
	session.peer?.destroy();
	sessions.delete(tabId);
	console.log(LOG, `[Tab ${tabId}] Session closed`);
}

function getStatus(tabId?: number) {
	if (!tabId) {
		// Fallback: return first session if no tabId
		const first = sessions.values().next().value;
		return first
			? { session: { sessionId: first.sessionId, tabId: first.tabId }, connected: first.connected }
			: { session: null, connected: false };
	}

	const session = sessions.get(tabId);
	if (!session) {
		return { session: null, connected: false };
	}
	return {
		session: { sessionId: session.sessionId, tabId: session.tabId },
		connected: session.connection?.open === true,
	};
}

// eff: serializes the current tab state and sends it over the WebRTC DataChannel to the mobile remote
function sendStateToMobile(tabId: number, state: unknown): void {
	const session = sessions.get(tabId);
	if (session?.connection?.open) {
		session.connection.send({ type: 'state', ...state as object });
	}
}

// eff: listens for messages from the extension's background script to manage PeerJS sessions
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message.type === 'REMOTE_OFFSCREEN_CREATE') {
		createSession(message.tabId)
			.then((s) => sendResponse({ success: true, session: { sessionId: s.sessionId, tabId: s.tabId } }))
			.catch((e) => sendResponse({ success: false, error: e.message }));
		return true;
	}

	if (message.type === 'REMOTE_OFFSCREEN_GET_STATUS') {
		sendResponse(getStatus(message.tabId));
		return false;
	}

	if (message.type === 'REMOTE_OFFSCREEN_CLOSE') {
		const tabId = message.tabId;
		if (tabId) {
			closeSession(tabId).then(() => sendResponse({ success: true }));
		} else {
			// Close all
			Promise.all([...sessions.keys()].map(closeSession)).then(() => sendResponse({ success: true }));
		}
		return true;
	}

	if (message.type === 'REMOTE_OFFSCREEN_SEND_STATE') {
		if (message.tabId) {
			sendStateToMobile(message.tabId, message.state);
		}
		return false;
	}

	return false;
});

console.log(LOG, 'Offscreen ready (multi-session)');
