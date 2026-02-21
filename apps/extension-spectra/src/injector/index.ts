// SPECTRA INJECTOR: Intercepts native media APIs to enforce CORS and enable WebAudio hijacking.
// Runs in "MAIN" world, sharing execution environment with page's JavaScript.

import { hijackPlaybackRate } from './playback-rate';
import { enforceCORS } from './cors-enforcer';
import { initFullscreenInterceptor } from './fullscreen';
import { initWebAudioHijack } from './webaudio-hijack';
import { initYouTubeAdapter } from './youtube-adapter';
import { initMessageBridge } from './message-bridge';

(function () {
	hijackPlaybackRate();
	enforceCORS();
	initFullscreenInterceptor();
	initWebAudioHijack();
	initYouTubeAdapter();
	initMessageBridge();
})();
