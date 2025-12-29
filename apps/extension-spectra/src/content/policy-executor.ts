/**
 * Policy Executor - Compatibility Layer
 *
 * ⚠️ Moved to ./policy-executor/ directory
 * This file is kept only for backward compatibility. Please import from the new path.
 *
 * New Path: ./policy-executor/index.ts
 */

// Re-export new module contents
export { createPolicyExecutor } from './policy-executor/index';
export type { PolicyExecutor, PolicyExecutorState, PolicyExecutorDeps } from './policy-executor/index';
