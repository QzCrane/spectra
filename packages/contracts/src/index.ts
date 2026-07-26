// goal: pure contract layer with zero logic for cross-package type sharing and AI context efficiency

// Common types
export type {
  Result,
  Maybe,
  EventHandler,
  Unsubscribe
} from './common.types.js';

// Audio contracts
export type {
  AudioConfig,
  AudioProcessorConfig,
  ResolvedAudioVolume,
  AudioMode,
  AudioState,
  SpectraAudioMode,
  AudioSessionPhase,
  AudioVolumeState,
  AudioSessionError,
  AudioSessionSnapshot,
  AudioSessionIdentity,
  AudioRuntimeStatus,
  AudioCaptureState,
  TabSessionIdentity,
  IPolicyEngine,
  PolicyContext,
  UrlInfo,
  // @deprecated: moved to dynamic CORS detection; kept for audio-engine PolicyEngine.getRuleForDomain
  SiteRule
} from './audio.contracts.js';

export {
  DEFAULT_AUDIO_CONFIG,
  isAudioConfig,
  isAudioProcessorConfig,
  isAudioConfigPatch,
  isAudioSessionError,
  isAudioSessionSnapshot,
  isAudioRuntimeStatus,
  isAudioCaptureState,
  isDefaultAudioConfig,
  resolveAudioVolume,
  audioSessionMatchesIdentity,
  audioSessionMatchesControlDocument,
  isActiveCaptureLifecycle,
  resolveAudioVolumeState,
  crossesAudioVolumeProcessorBoundary
} from './audio.contracts.js';

// Per-field SPECTRA control contracts
export type {
	ControlStrategy,
	ControlStrategyClass,
	ControlInterceptionKind,
	ControlAdmissionEvidence,
	ControlWriterOwner,
	ControlAudioRuntimeCost,
	ControlStrategyRule,
	ControlRetryableStrategyFailure,
	ControlTerminalStrategyFailure,
	ControlStrategyFailure,
	ControlCoverage,
	ControlRequestedCoverage,
	ControlFieldPhase,
	ControlIntentSource,
	CaptureAdmission,
	MediaKind,
	MediaTarget,
	VideoFilterState,
	ABLoopState,
	ControlValues,
	ControlField,
	ControlDirectField,
	ControlNativeObservationStrategy,
	ControlNativeObservationStrategies,
	ControlOperation,
	ControlMarker,
	ControlScreenshotResult,
	ControlFrameStepResult,
	ControlOperationPayloadMap,
	ControlOperationResultMap,
	ControlOperationPayload,
	ControlOperationResult,
	ControlOperationRequest,
	ControlOperationIntent,
	ControlOperationAck,
	ControlCapability,
	ControlScope,
	ControlAlgorithmKind,
	ControlAcknowledgement,
	ControlActualContext,
	ControlRecurringWork,
	ControlAlgorithmPolicy,
	ControlNativePreference,
	ControlAugmentationAdmission,
	ControlAlgorithmAdjudication,
	ControlPatch,
	ControlSessionField,
	ControlSessionPatch,
	ControlError,
	ControlFieldState,
	ControlFieldStates,
	ControlAudioVolumeProjection,
	ControlIntent,
	ControlSubmitRequest,
	ControlMutationOperation,
	ControlMutation,
	ControlSnapshot,
	ControlApplyAck,
	ControlReadRequest,
	ControlReadResult,
} from './control.contracts.js';
export {
	CONTROL_STRATEGIES,
	CONTROL_STRATEGY_RULES,
	CONTROL_RETRYABLE_STRATEGY_FAILURES,
	CONTROL_TERMINAL_STRATEGY_FAILURES,
	CONTROL_FIELDS,
	CONTROL_DIRECT_FIELDS,
	CONTROL_SESSION_FIELDS,
	CONTROL_BOOTSTRAP_OBSERVATION_GROUPS,
	CONTROL_OPERATIONS,
	CONTROL_CAPABILITIES,
	CONTROL_ALGORITHM_POLICIES,
	CONTROL_ALGORITHM_ADJUDICATIONS,
	compileEffectiveVolume,
	splitEffectiveVolume,
	resolveAcknowledgedProcessorLifecycle,
	resolveAcknowledgedAudioVolumeState,
	resolveControlAudioVolume,
	classifyControlStrategy,
	isControlStrategyAdmittedForCapability,
	isControlStrategyFailure,
	shouldTryNextControlStrategy,
	isControlError,
	isMediaTarget,
	isControlPatch,
	isControlSessionPatch,
	isControlIntent,
	isControlSubmitRequest,
	isControlOperationRequest,
	isControlOperationIntent,
	isControlOperationAck,
	isControlSnapshot,
	isControlApplyAck,
	isControlReadRequest,
	isControlReadResult,
} from './control.contracts.js';

// Messaging contracts
export type {
  NexusMessages,
  NexusAction,
  NexusRequest,
  NexusResponse,
  INexusMessenger,
  INexusRouter
} from './messages/index.js';

// Settings contracts
export type {
  GlobalSettings,
  SupportedLanguage,
  ThemeMode,
  SettingsSnapshot,
  AudioPresetMeta,
  AudioPresetValue,
  HotkeySiteMutation,
  SettingsPatch,
  SettingsPatchRequest
} from './settings.contracts.js';

export {
  DEFAULT_GLOBAL_SETTINGS,
  SPECTRA_SETTINGS_SCHEMA_VERSION,
  isGlobalSettings,
	isHotkeySettings,
  isSettingsPatchRequest,
  isSettingsSnapshot
} from './settings.contracts.js';

// SPECTRA v2 protocol and runtime guards
export type {
	RpcError,
	RpcResult,
	ContentRuntimeLeaseReason,
	ContentRuntimeSourceOwnership,
	ContentRuntimeStatus,
	ContentRuntimeReadyResult,
	VisualizerBatchPayload,
	VisualizerBatchResult,
	AudioSessionPublishPayload,
	AudioConfigSavedResult,
	TabPinnedResult,
	TabMutedResult,
	UiOpenedResult,
	SpectraContentSettings,
	MediaStateResult,
	TimeMarkerResult,
	VideoFilterPayload,
	ScreenshotCapturePayload,
	ScreenshotResult,
	SpectraRequestMap,
	SpectraEventMap,
	SpectraRequestType,
	SpectraEventType,
	SpectraRequestPayload,
	SpectraEventPayload,
	SpectraResponseData,
	SpectraResponse,
	SpectraExchange,
	SpectraRequestEnvelope,
	SpectraEventEnvelope,
} from './spectra.protocol.js';
export {
	SPECTRA_PROTOCOL_VERSION,
	SPECTRA_CONTENT_BOOTSTRAP_REVISION,
	isRpcError,
	isSpectraRequestEnvelope,
	isSpectraEventEnvelope,
	isSpectraResponse,
	rpcSuccess,
	rpcFailure,
} from './spectra.protocol.js';
export {
	SPECTRA_CONTENT_RUNTIME_REVISION,
	SPECTRA_DEFAULT_HOTKEY_ACTION_BY_CODE,
	SPECTRA_DEFAULT_HOTKEY_ACTIONS,
	isSpectraDefaultHotkeyTriggerPayload,
	resolveSpectraDefaultHotkeyAction,
} from './spectra.bootstrap.js';
export type {
	SpectraDefaultHotkeyAction,
	SpectraDefaultHotkeyChord,
	SpectraDefaultHotkeyPhase,
	SpectraDefaultHotkeyTriggerPayload,
} from './spectra.bootstrap.js';

// Canonical domain utilities
export {
	normalizeHostname,
	isIpHostname,
	hostnameMatchesRule,
	findBestHostnameMatch,
} from './domain.contracts.js';

// Registry contracts
export type {
  DomainSource,
  DomainEntry,
	MediaRoute,
	RegistryStorage,
  RegistryResult,
	RegistrySnapshot,
	RegistryAddResult,
	RegistryRemoveResult,
	RegistryQueryResult,
	HotkeyTargetState
} from './registry.contracts.js';
export {
	createSiteRouteFingerprint,
	isDomainEntry,
	isMediaRouteFingerprint,
	isRegistryEntries,
} from './registry.contracts.js';

export {
	REMOTE_COMMANDS,
	REMOTE_COMMAND_DESCRIPTORS,
	isRemoteCommand,
	isRemotePublicSession,
	isRemoteSessionToken,
	isRemoteState,
} from './remote.contracts.js';
export type {
	RemoteCommand,
	RemoteCommandDescriptor,
	RemoteCommandOperation,
	RemotePublicSession,
	RemoteState,
	RemoteSessionStatus,
	RemoteSessionChangedEvent,
	RemoteSessionClosedEvent,
} from './remote.contracts.js';

// Unified background/offscreen host contracts
export type {
	OffscreenHostSnapshot,
	OffscreenAudioResult,
	OffscreenVisualizerFrame,
	OffscreenVisualizerBatch,
	RemoteHostSession,
	RemoteHostCreateResponse,
	RemoteHostStatusResponse,
	RemoteHostDescribeResponse,
	RemoteHostMutationResponse,
	OffscreenHostRequestMap,
	OffscreenHostRequestType,
	OffscreenHostRequest,
	OffscreenHostWireRequest,
	OffscreenHostResponse,
	OffscreenAudioRequestType,
	OffscreenAudioRequest,
	RemoteHostRequestType,
	RemoteHostRequest,
	RemoteHostCloseReason,
	OffscreenHostEventType,
	OffscreenHostEvent,
	OffscreenAudioEvent,
	RemoteHostEventType,
	RemoteHostEvent,
} from './offscreen.contracts.js';
export {
	isOffscreenHostRequest,
	isOffscreenHostResponse,
	isOffscreenHostEvent,
	isOffscreenHostSnapshot,
	isOffscreenAudioResult,
	isRemoteHostSession,
} from './offscreen.contracts.js';

// Hotkey contracts
export type {
  HotkeyAction,
	HotkeyAvailability,
	HotkeyFeedbackOwner,
	HotkeyRepeatPolicy,
	HotkeyParameterKind,
	HotkeyActionDescriptor,
	SpectraHotkeyActualFeedback,
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
	HOTKEY_ACTION_DESCRIPTORS,
	isHotkeyParamsForAction,
	isSpectraDefaultHotkeyKeyCombo,
	isSlotHotkeyAction,
	resolveSpectraHotkeyActualFeedback,
	DEFAULT_MODIFIERS,
  DEFAULT_HOTKEY_SETTINGS
} from './hotkeys.contracts.js';

// Message Action constants
export { Actions, NEXUS_ACTIONS } from './actions.js';
export type { NexusActionName } from './actions.js';
