const chromeVersion = Number.parseInt(
	/(?:Chrome|Chromium)\/(\d+)/u.exec(globalThis.navigator?.userAgent ?? '')?.[1] ?? '120',
	10,
);

export const browserDetails = Object.freeze({
	browser: 'chrome',
	version: Number.isFinite(chromeVersion) ? chromeVersion : 120,
});

export default Object.freeze({ browserDetails });
