// SPECTRA remote protocol v2. Keep this module free of Chrome/DOM dependencies so
// every extension context can validate the same wire format.

import {
	isRemoteCommand,
	type RemoteCommand,
	type RemoteState,
} from '@nexus/contracts';

export { REMOTE_COMMANDS, isRemoteCommand } from '@nexus/contracts';
export type { RemoteCommand, RemoteState } from '@nexus/contracts';

export const REMOTE_PROTOCOL_VERSION = 2 as const;
export const REMOTE_PAIRING_TTL_MS = 5 * 60 * 1000;
export const REMOTE_RECONNECT_TTL_MS = 2 * 60 * 1000;
export const REMOTE_AUTH_TIMEOUT_MS = 10 * 1000;

const BASE64URL_128_RE = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL_NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_HMAC_RE = /^[A-Za-z0-9_-]{43}$/;
const PEER_ID_RE = /^spectra-[a-f0-9]{32}$/;

export interface RemotePairing {
	protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
	sessionId: string;
	peerId: string;
	secret: string;
	createdAt: number;
	pairingExpiresAt: number;
}

export type { RemotePublicSession } from '@nexus/contracts';

export interface RemoteChallengeMessage {
	type: 'spectra.remote.challenge';
	protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
	sessionId: string;
	nonce: string;
	pairingExpiresAt: number;
}

export interface RemoteAuthenticateMessage {
	type: 'spectra.remote.authenticate';
	protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
	sessionId: string;
	proof: string;
}

export interface RemoteAuthResultMessage {
	type: 'spectra.remote.auth-result';
	protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
	sessionId: string;
	ok: boolean;
	error?: 'AUTH_FAILED' | 'EXPIRED' | 'ALREADY_CONNECTED' | 'INVALID_MESSAGE';
	reconnectUntil?: number;
}

export interface RemoteCommandMessage {
	type: 'spectra.remote.command';
	protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
	sessionId: string;
	sequence: number;
	generation: number;
	command: RemoteCommand;
}

export interface RemoteStateMessage extends RemoteState {
	type: 'spectra.remote.state';
	protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
	sessionId: string;
}

export interface RemoteClosedMessage {
	type: 'spectra.remote.closed';
	protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
	sessionId: string;
	reason: 'manual' | 'tab-closed' | 'pairing-expired' | 'reconnect-expired' | 'host-destroyed';
}

export type RemoteWireMessage =
	| RemoteChallengeMessage
	| RemoteAuthenticateMessage
	| RemoteAuthResultMessage
	| RemoteCommandMessage
	| RemoteStateMessage
	| RemoteClosedMessage;

export function isRemoteAuthenticateMessage(value: unknown): value is RemoteAuthenticateMessage {
	if (!isRecord(value)) return false;
	return value.type === 'spectra.remote.authenticate'
		&& value.protocolVersion === REMOTE_PROTOCOL_VERSION
		&& isSessionId(value.sessionId)
		&& typeof value.proof === 'string'
		&& BASE64URL_HMAC_RE.test(value.proof);
}

export function isRemoteCommandMessage(value: unknown): value is RemoteCommandMessage {
	if (!isRecord(value)) return false;
	return value.type === 'spectra.remote.command'
		&& value.protocolVersion === REMOTE_PROTOCOL_VERSION
		&& isSessionId(value.sessionId)
		&& Number.isSafeInteger(value.sequence)
		&& (value.sequence as number) > 0
		&& Number.isSafeInteger(value.generation)
		&& (value.generation as number) >= 0
		&& isRemoteCommand(value.command);
}

export function isRemotePairing(value: unknown): value is RemotePairing {
	if (!isRecord(value)) return false;
	return value.protocolVersion === REMOTE_PROTOCOL_VERSION
		&& isSessionId(value.sessionId)
		&& typeof value.peerId === 'string'
		&& PEER_ID_RE.test(value.peerId)
		&& typeof value.secret === 'string'
		&& BASE64URL_128_RE.test(value.secret)
		&& Number.isFinite(value.createdAt)
		&& Number.isFinite(value.pairingExpiresAt)
		&& (value.pairingExpiresAt as number) > (value.createdAt as number);
}

export function isSessionId(value: unknown): value is string {
	return typeof value === 'string' && BASE64URL_128_RE.test(value);
}

export function isNonce(value: unknown): value is string {
	return typeof value === 'string' && BASE64URL_NONCE_RE.test(value);
}

export function encodeBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

export function decodeBase64Url(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function generateRandomToken(byteLength = 16): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return encodeBase64Url(bytes);
}

function generatePeerId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let token = '';
	for (const byte of bytes) token += byte.toString(16).padStart(2, '0');
	return `spectra-${token}`;
}

export function createRemotePairing(now = Date.now()): RemotePairing {
	return {
		protocolVersion: REMOTE_PROTOCOL_VERSION,
		sessionId: generateRandomToken(16),
		// PeerJS accepts separators only between alphanumeric groups, so a raw
		// Base64URL token can fail randomly on consecutive or trailing '-'/'_'.
		peerId: generatePeerId(),
		secret: generateRandomToken(16),
		createdAt: now,
		pairingExpiresAt: now + REMOTE_PAIRING_TTL_MS,
	};
}

export function remoteChallengePayload(sessionId: string, nonce: string): Uint8Array {
	return new TextEncoder().encode(`spectra-remote-v2\n${sessionId}\n${nonce}\n${REMOTE_PROTOCOL_VERSION}`);
}

export async function createRemoteProof(secret: string, sessionId: string, nonce: string): Promise<string> {
	if (!BASE64URL_128_RE.test(secret) || !isSessionId(sessionId) || !isNonce(nonce)) {
		throw new Error('Invalid remote authentication input');
	}
	const key = await crypto.subtle.importKey(
		'raw',
		toArrayBuffer(decodeBase64Url(secret)),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const proof = await crypto.subtle.sign('HMAC', key, toArrayBuffer(remoteChallengePayload(sessionId, nonce)));
	return encodeBase64Url(new Uint8Array(proof));
}

export async function verifyRemoteProof(
	secret: string,
	sessionId: string,
	nonce: string,
	proof: string,
): Promise<boolean> {
	if (!BASE64URL_128_RE.test(secret) || !isSessionId(sessionId) || !isNonce(nonce) || !BASE64URL_HMAC_RE.test(proof)) {
		return false;
	}
	try {
		const key = await crypto.subtle.importKey(
			'raw',
			toArrayBuffer(decodeBase64Url(secret)),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['verify'],
		);
		return crypto.subtle.verify(
			'HMAC',
			key,
			toArrayBuffer(decodeBase64Url(proof)),
			toArrayBuffer(remoteChallengePayload(sessionId, nonce)),
		);
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}
