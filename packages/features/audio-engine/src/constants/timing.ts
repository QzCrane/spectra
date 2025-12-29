// goal: central timing configuration for UI, capture logic, and polling intervals
// note: all values are in milliseconds (ms)

export const Timing = {
	OSD_DURATION: 2000,
	TOAST_DURATION: 3000,
	RECENTLY_PLAYED_THRESHOLD: 60000,
	CAPTURE_LOCK_TIME: 500,
	OBSERVER_DEBOUNCE: 500,
	STATE_REAPPLY_INTERVAL: 2000,
	CAPTURE_INIT_DELAY: 300,
	VIZ_FRAME_INTERVAL: 32,
	MUTEX_POLL_INTERVAL: 50,
	METRICS_INIT_LOOPS: 20,
	EQ_DRAWER_DELAY: 310
} as const;
