// goal: backward compatibility layer for message protocol definitions
// note: @deprecated: all protocol types migrated to @nexus/contracts; use that for new code

export type {
  AudioConfig,
  AudioState,
  AudioMode,

  NexusMessages,
  NexusAction,
  NexusRequest,
  NexusResponse,

  GlobalSettings,
  SupportedLanguage,
} from '@nexus/contracts';

import { DEFAULT_AUDIO_CONFIG, DEFAULT_GLOBAL_SETTINGS } from './defaults.js';
export { DEFAULT_AUDIO_CONFIG, DEFAULT_GLOBAL_SETTINGS };
