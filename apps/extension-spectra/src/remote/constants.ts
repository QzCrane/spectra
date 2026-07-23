// Remote-site URL builder. Pairing credentials live exclusively in the URL
// fragment, which browsers do not send to Cloudflare Pages.

import { REMOTE_PROTOCOL_VERSION, type RemotePairing } from './protocol';

export const REMOTE_HOST = 'https://nexus-remote.pages.dev';

export function getRemoteUrl(pairing: RemotePairing, baseUrl = REMOTE_HOST): string {
	const remoteUrl = new URL(baseUrl);
	if ((remoteUrl.protocol !== 'https:' && remoteUrl.protocol !== 'http:')
		|| remoteUrl.username
		|| remoteUrl.password) {
		throw new Error('Remote URL must use HTTP or HTTPS without embedded credentials');
	}
	const fragment = new URLSearchParams({
		v: String(REMOTE_PROTOCOL_VERSION),
		s: pairing.sessionId,
		p: pairing.peerId,
		k: pairing.secret,
		e: String(pairing.pairingExpiresAt),
	});
	remoteUrl.search = '';
	remoteUrl.hash = fragment.toString();
	if (!remoteUrl.pathname.endsWith('/')) remoteUrl.pathname += '/';
	return remoteUrl.href;
}
