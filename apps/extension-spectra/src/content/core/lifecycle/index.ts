// goal: re-exports event-driven lifecycle components

export { createMediaObserver, hasMediaElements } from './media-observer';
export {
	createMediaStateReporter,
	reportMediaState
} from './media-state-reporter';
export {
	setupUserGestureListeners,
	setupPopupConnectionListener
} from './user-interaction';
export { createNavigationObserver } from './navigation-observer';

