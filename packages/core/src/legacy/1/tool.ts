import type { HandlerContext } from '../../plugin.ts';

/**
 * ToolContext — backward-compatible alias for HandlerContext.
 *
 * HandlerContext supersedes RigContext (which superseded ToolContext).
 * This alias lives in legacy/1 for any code that still imports ToolContext.
 */
export type ToolContext = HandlerContext;

export * from '../../tool.ts';
