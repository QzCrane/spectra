/**
 * SPECTRA Remote - QR Generator
 */

import QRCode from 'qrcode';

const DEFAULT_REMOTE_URL = 'https://nexus-remote.pages.dev';

export async function generateRemoteQR(sessionId: string, baseUrl?: string): Promise<string> {
	const base = baseUrl || DEFAULT_REMOTE_URL;
	const url = `${base}?s=${sessionId}`;

	return QRCode.toDataURL(url, {
		width: 200,
		margin: 2,
		color: {
			dark: '#1a1a2e',
			light: '#ffffff',
		},
	});
}

// For debugging
export async function generateRemoteQRText(sessionId: string): Promise<string> {
	const url = `${DEFAULT_REMOTE_URL}?s=${sessionId}`;
	return QRCode.toString(url, { type: 'terminal', small: true });
}
