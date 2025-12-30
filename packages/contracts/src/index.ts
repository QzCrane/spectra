// goal: pure contract layer with zero logic for cross-package type sharing and AI context efficiency

// Common types
export type {
  Result,
  Maybe,
  TabId,
  VolumeLevel,
  DomainName,
  EventHandler,
  Unsubscribe
} from './common.types.js';

// Audio contracts
export type {
  AudioConfig,
  AudioMode,
  AudioState,
  IAudioService,
  IPolicyEngine,
  PolicyContext,
  UrlInfo,
  SiteRule
} from './audio.contracts.js';

export { DEFAULT_AUDIO_CONFIG } from './audio.contracts.js';

// Messaging contracts
export type {
  NexusMessages,
  NexusAction,
  NexusRequest,
  NexusResponse,
  INexusMessenger,
  INexusRouter
} from './messages.contracts.js';

// Settings contracts
export type {
  GlobalSettings,
  SupportedLanguage,
  IStorageRepository,
  ThemeMode
} from './settings.contracts.js';

export { DEFAULT_GLOBAL_SETTINGS } from './settings.contracts.js';

// Registry contracts
export type {
  DomainSource,
  DomainEntry,
  RegistryStorage,
  RegistryResult
} from './registry.contracts.js';

// Hotkey contracts
export type {
  HotkeyAction,
  KeyModifiers,
  KeyCombo,
  HotkeyBinding,
  HotkeyParams,
  HotkeyConditions,
  HotkeySettings,
  SlotMapping,
  SiteHotkeyConfig
} from './hotkeys.contracts.js';

export {
  HOTKEY_ACTIONS,
  DEFAULT_MODIFIERS,
  DEFAULT_HOTKEY_SETTINGS,
  DEFAULT_SLOTS,
  PRESET_BINDINGS
} from './hotkeys.contracts.js';

// Message Action constants
export { Actions, OffscreenActions, NEXUS_ACTIONS, OFFSCREEN_ACTIONS } from './actions.js';
export type { NexusActionName, OffscreenActionName } from './actions.js';
