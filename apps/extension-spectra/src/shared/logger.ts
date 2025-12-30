// goal: provides specialized logging utilities with [SPECTRA] identification and domain-specific categories

import { createLogger as kernelCreateLogger, createPlainLogger, LOG_COLORS } from '@nexus/kernel';

export { createPlainLogger, LOG_COLORS } from '@nexus/kernel';

// post: returns a logger instance with injected [SPECTRA] prefixes and specialized capture/mode tracking methods
export function createLogger(tag: string) {
	const base = kernelCreateLogger(tag, 'SPECTRA');
	const fullPrefix = `[SPECTRA] [${tag}]`;

	return {
		...base,
		// capture: specialized log for troubleshooting Web Audio / Tab Capture stream transitions
		capture(...args: unknown[]) {
			console.log(`%c${fullPrefix} [CAPTURE]`, LOG_COLORS.capture, ...args);
		},
		// mode: provides clear visual tracking of AudioMode transitions (NATIVE <-> CAPTURE)
		mode(from: string | null, to: string) {
			console.log(`%c${fullPrefix} Mode: ${from || 'null'} -> ${to}`, LOG_COLORS.info);
		},
	};
}

export const logger = {
	content: createLogger('Content'),
	background: createLogger('Background'),
	popup: createLogger('Popup'),
	offscreen: createLogger('Offscreen'),
};

export const swLog = createPlainLogger('Background');

