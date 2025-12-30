// goal: defines the schema for internationalization dictionaries shared across SPECTRA components

export interface I18NDict {
	// group: core settings and visualization
	settingsTitle: string;
	osdLabel: string;
	osdSub: string;
	vizLabel: string;
	vizSub: string;
	vizDesc: string;
	langLabel: string;
	noAudio: string;
	bgTitle: string;
	paused: string;
	clickToResume: string;
	comp: string;
	bass: string;
	mono: string;
	eqTitle: string;
	reset: string;
	save: string;
	// group: interactive tooltips
	resetTooltip: string;
	saveTooltip: string;
	captureListLabel: string;
	captureListSub: string;
	grpInterface: string;
	grpGeneral: string;
	grpAdvanced: string;
	tabRestricted: string;
	tabSafe: string;
	filterPlaceholder: string;
	registryHint: string;
	autoAddedToast: (domain: string) => string;
	themeLabel: string;
	themeSub: string;
	themeLight: string;
	themeDark: string;
	themeSystem: string;
	btnThemeTooltip: string;
	btnSettingsTooltip: string;
	btnShortcutsTooltip: string;
	// group: side panel controls (video/audio manipulation)
	spAudio: string;
	spPan: string;
	spDelay: string;
	spSpeed: string;
	spValue: string;
	spVideo: string;
	spRotate: string;
	spMirror: string;
	spCrop: string;
	spScreenshot: string;
	spBrightness: string;
	spContrast: string;
	spHotkey: string;
	spHotkeyThis: string;
	spHotkeyPinned: string;
	spHotkeyLast: string;
	// group: media transport buttons
	btnPause: string;
	btnPip: string;
	btnHotkeyTarget: string;
	btnGotoTab: string;
	// group: background tab management
	pauseRetentionLabel: string;
	pauseRetentionSub: string;
	pauseRetentionUnit: string;
	// group: specific action tooltips
	tipPinPanel: string;
	tipClose: string;
	tipAdvancedSettings: string;
	spResetFx: string;
	spSaveFx: string;
	spResetFxTip: string;
	spSaveFxTip: string;
	// group: video transformation effects
	spFullscreen: string;
	spDim: string;
	spSeek: string;
	spSaturate: string;
	spGrayscale: string;
	spInvert: string;
	// group: preset persistence
	grpPresets: string;
	presetsHint: string;
	btnClearPresets: string;
	// group: remote control bridge strings
	btnRemoteTooltip: string;
	remoteModalTitle: string;
	remoteSessionCode: string;
	remoteConnected: string;
	remoteWaiting: string;
	remoteHint: string;
	remoteDisconnect: string;
	remoteCopied: string;
	remoteOpenLinkTitle: string;
	remoteConnectedTooltip: string;
	// group: empty state placeholders for registry lists
	registryEmptyRestricted: string;
	registryEmptySafe: string;
	// group: content script notifications
	corsAddedSafe: (domain: string) => string;
	corsCorrectedSafe: (domain: string) => string;
}

export type I18NMap = Record<string, I18NDict>;
