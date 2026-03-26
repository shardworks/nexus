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
 * import { tool } from '@shardworks/nexus-core';
 * import { z } from 'zod';
 *
 * export default tool({
 *   name: 'lookup',
 *   description: 'Look up an anima by name',
 *   instructionsFile: './instructions.md',
 *   params: {
 *     name: z.string().describe('Anima name'),
 *   },
 *   handler: async ({ name }, { home }) => {
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
 * Framework-provided context injected into every tool handler call.
 * The tool author doesn't construct this — the framework (MCP engine, CLI,
 * or calling engine) provides it.
 */
export interface ToolContext {
  /** Absolute path to the guild root. */
  home: string;
}

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
  readonly params: z.ZodObject<TShape>;
  readonly handler: (
    params: z.infer<z.ZodObject<TShape>>,
    context: ToolContext,
  ) => unknown | Promise<unknown>;
}

/** Input to `tool()` — instructions are either inline text or a file path, not both. */
type ToolInput<TShape extends ZodShape> = {
  name: string;
  description: string;
  params: TShape;
  handler: (
    params: z.infer<z.ZodObject<TShape>>,
    context: ToolContext,
  ) => unknown | Promise<unknown>;
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
 * The handler receives two arguments:
 * - `params` — the validated input, typed from your Zod schemas
 * - `context` — framework-injected context (guild root path, etc.)
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
    params: z.object(def.params),
    handler: def.handler,
  };
}

/**
 * Resolve a single ToolDefinition from a module's default export.
 *
 * Handles both single-tool and array-of-tools exports:
 * - Single tool: `export default tool({...})` → returned directly
 * - Array: `export default [tool({...}), tool({...})]` → find by name
 *
 * @param moduleDefault - The module's default export
 * @param toolName - The tool name to find (required for array exports)
 * @returns The matching ToolDefinition, or null if not found
 */
export function resolveToolFromExport(
  moduleDefault: unknown,
  toolName?: string,
): ToolDefinition | null {
  // Single tool export
  if (isToolDefinition(moduleDefault)) {
    if (!toolName || moduleDefault.name === toolName) return moduleDefault;
    return null;
  }

  // Array of tools — find by name
  if (Array.isArray(moduleDefault)) {
    for (const item of moduleDefault) {
      if (!isToolDefinition(item)) continue;
      if (item.name === toolName) return item;
    }
    // If no name match but array has exactly one tool, return it
    const tools = moduleDefault.filter(isToolDefinition);
    if (tools.length === 1 && !toolName) return tools[0]!;
    return null;
  }

  return null;
}

/**
 * Resolve all ToolDefinitions from a module's default export.
 *
 * Handles both single-tool and array-of-tools exports.
 * Returns an array in either case.
 */
export function resolveAllToolsFromExport(
  moduleDefault: unknown,
): ToolDefinition[] {
  if (isToolDefinition(moduleDefault)) {
    return [moduleDefault];
  }

  if (Array.isArray(moduleDefault)) {
    return moduleDefault.filter(isToolDefinition);
  }

  return [];
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
