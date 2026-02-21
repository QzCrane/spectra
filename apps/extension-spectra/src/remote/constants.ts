// goal: centralizes remote control service configuration constants

export const REMOTE_HOST = 'https://nexus-remote.pages.dev';

export function getRemoteUrl(sessionId: string): string {
	return `${REMOTE_HOST}?s=${sessionId}`;
}
