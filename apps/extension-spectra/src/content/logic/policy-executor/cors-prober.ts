// goal: manages in-memory caching of confirmed CORS statuses for the current session
// rule: NEVER actively call createMediaElementSource() for probing as it silences the target element indefinitely

import { logger } from '../../../shared/logger';

const log = logger.content;

// confirmedDomains: transient cache (true = RESTRICTED, false = SAFE)
const confirmedDomains = new Map<string, boolean>();

export function isDomainProbed(hostname: string): boolean {
	return confirmedDomains.has(hostname);
}

// post: returns true if restricted, false if safe, or undefined if domain compatibility is still unknown
export function getConfirmedCorsStatus(hostname: string): boolean | undefined {
	return confirmedDomains.get(hostname);
}

// eff: updates the session cache based on WebAudioController detection events
export function markDomainCorsStatus(hostname: string, restricted: boolean): void {
	if (confirmedDomains.has(hostname)) {
		log.debug(`[CORS Status] ${hostname}: Already marked, skipping`);
		return;
	}
	confirmedDomains.set(hostname, restricted);
	log.info(`[CORS Status] ${hostname}: Confirmed as ${restricted ? 'RESTRICTED' : 'SAFE'}`);
}

// note: this function is a NO-OP for backward compatibility; actual probing is managed via controller callbacks
export async function probeWithTempContext(_el: HTMLMediaElement): Promise<boolean | null> {
	return null;
}




