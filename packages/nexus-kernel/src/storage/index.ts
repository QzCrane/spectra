// goal: aggregation point for all storage related repositories and utility functions

export { StorageRepository } from './repository.js';
export { getAudioConfig, setAudioConfig, removeAudioConfig } from './audio-config.js';
export { getHotkeySettings, setHotkeySettings, resetHotkeySettings } from './hotkey-settings.js';
export {
	getTabSessionConfig,
	setTabSessionConfig,
	removeTabSessionConfig,
	hasTabSessionConfig,
} from './tab-session.js';
