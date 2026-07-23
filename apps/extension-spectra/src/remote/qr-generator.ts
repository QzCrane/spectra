// goal: render the authenticated pairing URL with a small, zero-dependency SVG QR encoder

import { renderSVG } from 'uqr';
import { getRemoteUrl } from './constants.js';
import type { RemotePairing } from './protocol';

export async function generateRemoteQR(pairing: RemotePairing, baseUrl?: string): Promise<string> {
	const url = getRemoteUrl(pairing, baseUrl);
	const svg = renderSVG(url, {
		ecc: 'M',
		border: 2,
		blackColor: '#1a1a2e',
		whiteColor: '#ffffff',
	});
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
