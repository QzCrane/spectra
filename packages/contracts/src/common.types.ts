// goal: basic utility types and branded primitives shared across the workspace

// result: container for operation success/failure to avoid try-catch blocks
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type Maybe<T> = T | null | undefined;

// Branded types for type-safety and preventing primitive confusion
export type TabId = number & { readonly __brand: 'TabId' };
// inv: 0 to 800
export type VolumeLevel = number & { readonly __brand: 'VolumeLevel' };
export type DomainName = string & { readonly __brand: 'DomainName' };

// Event handling types
export type EventHandler<T> = (data: T) => void | Promise<void>;
export type Unsubscribe = () => void;
