// goal: bridge messages between content script and injector modules
// theory: centralize message handling to avoid scattered event listeners

import { updateVolume } from './webaudio-hijack';
import { updateCaptureState, updateWebAudioState } from './fullscreen';

export function initMessageBridge(): void {
	window.addEventListener('message', (event) => {
		if (!event.data) return;
		const { type, volume, active } = event.data;

		switch (type) {
			case 'SPECTRA_VOLUME_UPDATE':
				updateVolume(volume);
				break;
			case 'SPECTRA_CAPTURE_STATE':
				updateCaptureState(!!active);
				break;
			case 'SPECTRA_WEBAUDIO_STATE':
				updateWebAudioState(!!active);
				break;
		}
	});
}
