/**
 * Tool SDK — the primary authoring interface for module-based tools.
 *
 * Use `tool()` to define a typed tool with Zod parameter schemas.
 * The returned definition is what the MCP engine imports and registers as a tool,
 * what the CLI uses to auto-generate subcommands, and what engines import directly.
 *
 * A package can export a single tool or an array of tools:
 *
 * @example Single tool
 * ```typescript
 * import { tool } from '@shardworks/tools-apparatus';
 * import { z } from 'zod';
 *
 * export default tool({
 *   name: 'lookup',
 *   description: 'Look up an anima by name',
 *   instructionsFile: './instructions.md',
 *   params: {
 *     name: z.string().describe('Anima name'),
 *   },
 *   handler: async ({ name }) => {
 *     const { home } = guild();
 *     return { found: true, status: 'active' };
 *   },
 * });
 * ```
 *
 * @example Tool collection
 * ```typescript
 * export default [
 *   tool({ name: 'commission', description: '...', params: {...}, handler: ... }),
 *   tool({ name: 'signal', description: '...', params: {...}, handler: ... }),
 * ];
 * ```
 */
import { z } from 'zod';

// Zod shape type — a record of string keys to Zod schemas.
// Using a local alias keeps our public API stable across Zod versions.
type ZodShape = Record<string, z.ZodType>;

/**
 * The caller types a tool can be invoked by.
 * - `'patron'` — accessible via `nsg` commands (human-facing)
 * - `'anima'` — accessible via MCP server (anima-facing, in sessions)
 * - `'library'` — accessible programmatically via direct import
 *
 * Defaults to all caller types if `callableBy` is unspecified.
 */
export type ToolCaller = 'patron' | 'anima' | 'library';

/**
 * A fully-defined tool — the return type of `tool()`.
 *
 * The MCP engine uses `.params.shape` to register the tool's input schema,
 * `.description` for the tool description, and `.handler` to execute calls.
 * The CLI uses `.params` to auto-generate Commander options.
 * Engines call `.handler` directly.
 */
export interface ToolDefinition<TShape extends ZodShape = ZodShape> {
  /** Tool name — used for resolution when a package exports multiple tools. */
  readonly name: string;
  readonly description: string;
  /** Per-tool instructions injected into the anima's session context (inline text). */
  readonly instructions?: string;
  /**
   * Path to an instructions file, relative to the package root.
   * Resolved by the manifest engine at session time.
   * Mutually exclusive with `instructions`.
   */
  readonly instructionsFile?: string;
  /**
   * Caller types this tool is available to.
   * Always a normalized array. Absent means available to all callers.
   */
  readonly callableBy?: ToolCaller[];
  /**
   * Permission level required to invoke this tool. Matched against role grants.
   *
   * Format: a freeform string chosen by the tool author. Conventional names:
   * - `'read'` — query/inspect operations
   * - `'write'` — create/update operations
   * - `'delete'` — destructive operations
   * - `'admin'` — configuration and lifecycle operations
   *
   * Plugins are free to define their own levels.
   * If omitted, the tool is permissionless — included by default in non-strict
   * mode, excluded in strict mode unless the role grants `plugin:*` or `*:*`.
   */
  readonly permission?: string;
  readonly params: z.ZodObject<TShape>;
  readonly handler: (
    params: z.infer<z.ZodObject<TShape>>,
  ) => unknown | Promise<unknown>;
}

/** Input to `tool()` — instructions are either inline text or a file path, not both. */
type ToolInput<TShape extends ZodShape> = {
  name: string;
  description: string;
  params: TShape;
  handler: (
    params: z.infer<z.ZodObject<TShape>>,
  ) => unknown | Promise<unknown>;
  /**
   * Caller types this tool is available to.
   * Accepts a single caller or an array. Normalized to an array in the returned definition.
   */
  callableBy?: ToolCaller | ToolCaller[];
  /**
   * Permission level required to invoke this tool.
   * See ToolDefinition.permission for details.
   */
  permission?: string;
} & (
  | { instructions?: string; instructionsFile?: never }
  | { instructions?: never; instructionsFile?: string }
);

/**
 * Define a Nexus tool.
 *
 * This is the primary SDK entry point for module-based tools. Pass a
 * name, description, a params object of Zod schemas, and a handler function.
 * The framework handles the rest — MCP registration, CLI generation, validation.
 *
 * The handler receives one argument:
 * - `params` — the validated input, typed from your Zod schemas
 *
 * To access guild infrastructure (apparatus, config, home path), import
 * `guild` from `@shardworks/nexus-core` and call `guild()` inside the handler.
 *
 * Return any JSON-serializable value. The MCP engine wraps it as tool output;
 * the CLI prints it; engines use it directly.
 *
 * Instructions can be provided inline or as a file path:
 * - `instructions: 'Use this tool when...'` — inline text
 * - `instructionsFile: './instructions.md'` — resolved at manifest time
 */
export function tool<TShape extends ZodShape>(def: ToolInput<TShape>): ToolDefinition<TShape> {
  return {
    name: def.name,
    description: def.description,
    ...(def.instructions ? { instructions: def.instructions } : {}),
    ...(def.instructionsFile ? { instructionsFile: def.instructionsFile } : {}),
    ...(def.callableBy !== undefined
      ? { callableBy: Array.isArray(def.callableBy) ? def.callableBy : [def.callableBy] }
      : {}),
    ...(def.permission !== undefined ? { permission: def.permission } : {}),
    params: z.object(def.params),
    handler: def.handler,
  };
}

/** Type guard: is this value a ToolDefinition? */
export function isToolDefinition(obj: unknown): obj is ToolDefinition {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'name' in obj &&
    'description' in obj &&
    'params' in obj &&
    'handler' in obj &&
    typeof (obj as ToolDefinition).name === 'string' &&
    typeof (obj as ToolDefinition).description === 'string' &&
    typeof (obj as ToolDefinition).handler === 'function'
  );
}
