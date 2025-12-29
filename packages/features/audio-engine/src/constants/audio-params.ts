// goal: central definition of audio processing parameters, thresholds, and modes

export const AudioMode = {
	NATIVE_WEBAUDIO: 'NATIVE_WEBAUDIO',
	NATIVE_LITE: 'NATIVE_LITE',
	CAPTURE: 'CAPTURE'
} as const;

export type AudioModeType = typeof AudioMode[keyof typeof AudioMode];

export const AudioParams = {
	EQ_FREQUENCIES: [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const,
	EQ_Q: 1.4,
	BASS_FREQUENCY: 200,
	BASS_GAIN: 10,
	SMOOTH_TIME: 0.1,
	SMOOTH_TIME_FAST: 0.05,
	FFT_SIZE: 256,
	MAX_VOLUME: 800,
	VOLUME_STEP: 10,
	EQ_MIN: -12,
	EQ_MAX: 12,
	EQ_STEP: 0.1
} as const;

// goal: aggressive compression settings to prevent clipping/distortion during high gain
export const CompressorOn = {
	threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25
} as const;

export const CompressorOff = { threshold: 0, ratio: 1 } as const;

// note: used as a bypass state during NATIVE mode cleanup
export const CompressorNativeOff = { threshold: -10, ratio: 1 } as const;
