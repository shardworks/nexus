import type { RigContext } from '../../rig-context.ts';

/**
 * ToolContext — backward-compatible alias for RigContext.
 *
 * New code should import `RigContext` from `@shardworks/nexus-core` directly.
 * This alias lives in legacy/1 for any code that still imports `ToolContext`.
 */
export type ToolContext = RigContext;

export * from '../../tool.ts';
