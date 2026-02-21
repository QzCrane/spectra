// goal: centralized message type definitions and helpers for injector-content communication
// rule: all SPECTRA_* messages must use these constants (DRY)

export const MSG = {
  // Injector → Content
  RATE: 'SPECTRA_RATE',
  FULLSCREEN_ENTERED: 'SPECTRA_FULLSCREEN_ENTERED',
  PAUSE_FOR_FULLSCREEN: 'SPECTRA_PAUSE_FOR_FULLSCREEN',
  
  // Content → Injector
  PAUSE_CONFIRMED: 'SPECTRA_PAUSE_CONFIRMED',
  VOLUME_UPDATE: 'SPECTRA_VOLUME_UPDATE',
  CAPTURE_STATE: 'SPECTRA_CAPTURE_STATE',
  WEBAUDIO_STATE: 'SPECTRA_WEBAUDIO_STATE',
  
  // YouTube sync
  YT_SPEED: 'SPECTRA_YT_SPEED',
  YT_SPEED_OK: 'SPECTRA_YT_SPEED_OK',
  YT_VOLUME: 'SPECTRA_YT_VOLUME',
  YT_VOLUME_OK: 'SPECTRA_YT_VOLUME_OK',
  YT_FAIL: 'SPECTRA_YT_FAIL',
} as const;

export type MessageType = typeof MSG[keyof typeof MSG];

// eff: type-safe postMessage wrapper
export function postToWindow<T extends Record<string, unknown>>(type: MessageType, data?: T): void {
  window.postMessage({ type, ...data }, '*');
}

// eff: type-safe message listener
export function onWindowMessage<T extends Record<string, unknown>>(
  type: MessageType,
  handler: (data: T & { type: MessageType }) => void
): () => void {
  const listener = (e: MessageEvent) => {
    if (e.data?.type === type) {
      handler(e.data);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
