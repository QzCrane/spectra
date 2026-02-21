/**
 * SPECTRA Remote - QR Generator
 */

import QRCode from 'qrcode';
import { REMOTE_HOST, getRemoteUrl } from './constants.js';

export async function generateRemoteQR(sessionId: string, baseUrl?: string): Promise<string> {
	const url = baseUrl ? `${baseUrl}?s=${sessionId}` : getRemoteUrl(sessionId);

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
	return QRCode.toString(getRemoteUrl(sessionId), { type: 'terminal', small: true });
}
