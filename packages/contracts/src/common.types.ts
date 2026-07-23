// goal: basic utility types and branded primitives shared across the workspace

// result: container for operation success/failure to avoid try-catch blocks
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type Maybe<T> = T | null | undefined;

// Event handling types
export type EventHandler<T> = (data: T) => void | Promise<void>;
export type Unsubscribe = () => void;
