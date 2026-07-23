// goal: unified logging infrastructure with configurable product prefix for multi-extension support

export type NexusProduct = 'SPECTRA' | 'HALO' | 'CORTEX' | 'NEXUS';

export interface Logger {
	log: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	debug: (...args: unknown[]) => void;
	capture: (...args: unknown[]) => void;
}

export const LOG_COLORS = {
	log: 'color: #3b82f6; font-weight: bold;',
	info: 'color: #10b981; font-weight: bold;',
	warn: 'color: #f59e0b; font-weight: bold;',
	error: 'color: #ef4444; font-weight: bold;',
	debug: 'color: #6b7280; font-weight: bold;',
	capture: 'color: #8b5cf6; font-weight: bold;',
	cors: 'color: #4CAF50; font-weight: bold;',
};

// eff: creates a colored logger for browser contexts (Popup/Content)
export function createLogger(tag: string, product: NexusProduct = 'NEXUS'): Logger {
	const p = `[${product}] [${tag}]`;
	const f = (m: string, c: string, ...a: unknown[]) => {
		console.log(`%c${p}${m ? ` ${m}` : ''}`, c, ...a);
	};

	return {
		log: (...a) => { console.log(`%c${p}`, LOG_COLORS.log, ...a); },
		info: (...a) => { console.info(`%c${p}`, LOG_COLORS.info, ...a); },
		warn: (...a) => { console.warn(`%c${p}`, LOG_COLORS.warn, ...a); },
		error: (...a) => { console.error(`%c${p}`, LOG_COLORS.error, ...a); },
		debug: (...a) => { console.debug(`%c${p}`, LOG_COLORS.debug, ...a); },
		capture: (...a) => { f('[CAPTURE]', LOG_COLORS.capture, ...a); },
	};
}

// eff: creates a plain logger for Service Worker (limited colors support)
export function createPlainLogger(tag: string, product: NexusProduct = 'NEXUS'): Logger {
	const fullPrefix = `[${product}] [${tag}]`;

	return {
		log: (...args: unknown[]) => { console.log(fullPrefix, ...args); },
		info: (...args: unknown[]) => { console.info(fullPrefix, ...args); },
		warn: (...args: unknown[]) => { console.warn(fullPrefix, ...args); },
		error: (...args: unknown[]) => { console.error(fullPrefix, ...args); },
		debug: (...args: unknown[]) => { console.debug(fullPrefix, ...args); },
		capture: (...args: unknown[]) => { console.log(`${fullPrefix} [CAPTURE]`, ...args); },
	};
}

const CORS_PREFIX = `%c[SPECTRA] [CORS]`;

// corsLogger: specialized logger for CORS detection logic
export const corsLogger = {
	log: (msg: string) => { console.log(CORS_PREFIX, LOG_COLORS.cors, msg); },
	check: (count: number, max: number, sum: number, hasData: boolean) => {
		console.log(CORS_PREFIX, LOG_COLORS.cors, `Detection #${count}/${max}: sum=${sum}, hasData=${hasData}`);
	},
	safe: () => { console.log(CORS_PREFIX, LOG_COLORS.cors, '✅ Result: SAFE'); },
	restricted: (max: number) => { console.log(CORS_PREFIX, LOG_COLORS.cors, `❌ Result: RESTRICTED (${max} consecutive zero frames)`); },
	waiting: () => { console.log(CORS_PREFIX, LOG_COLORS.cors, '⏸️ Media not playing, waiting for play event...'); },
	resumed: () => { console.log(CORS_PREFIX, LOG_COLORS.cors, '▶️ Play event detected, resetting detection'); },
	start: (hostname: string, el: HTMLMediaElement) => {
		console.log(CORS_PREFIX, LOG_COLORS.cors, `Starting detection for ${hostname}, paused=${el.paused}, muted=${el.muted}, volume=${el.volume}`);
	},
};

