/**
 * Legacy tool SDK — kept as a self-contained copy for backward compatibility.
 *
 * The canonical source is now @shardworks/tools-apparatus.
 * New code should import from there instead.
 */
import { z } from 'zod';

type ZodShape = Record<string, z.ZodType>;

export type ToolCaller = 'cli' | 'mcp';

export interface ToolDefinition<TShape extends ZodShape = ZodShape> {
  readonly name: string;
  readonly description: string;
  readonly instructions?: string;
  readonly instructionsFile?: string;
  readonly callableFrom?: ToolCaller[];
  readonly permission?: string;
  readonly params: z.ZodObject<TShape>;
  readonly handler: (
    params: z.infer<z.ZodObject<TShape>>,
  ) => unknown | Promise<unknown>;
}

/** @deprecated Removed — handlers now use guild() singleton. Kept for type compatibility. */
export type ToolContext = Record<string, never>;

type ToolInput<TShape extends ZodShape> = {
  name: string;
  description: string;
  params: TShape;
  handler: (
    params: z.infer<z.ZodObject<TShape>>,
  ) => unknown | Promise<unknown>;
  callableFrom?: ToolCaller | ToolCaller[];
  permission?: string;
} & (
  | { instructions?: string; instructionsFile?: never }
  | { instructions?: never; instructionsFile?: string }
);

export function tool<TShape extends ZodShape>(def: ToolInput<TShape>): ToolDefinition<TShape> {
  return {
    name: def.name,
    description: def.description,
    ...(def.instructions ? { instructions: def.instructions } : {}),
    ...(def.instructionsFile ? { instructionsFile: def.instructionsFile } : {}),
    ...(def.callableFrom !== undefined
      ? { callableFrom: Array.isArray(def.callableFrom) ? def.callableFrom : [def.callableFrom] }
      : {}),
    ...(def.permission !== undefined ? { permission: def.permission } : {}),
    params: z.object(def.params),
    handler: def.handler,
  };
}

export function resolveToolFromExport(
  moduleDefault: unknown,
  toolName?: string,
): ToolDefinition | null {
  if (isToolDefinition(moduleDefault)) {
    if (!toolName || moduleDefault.name === toolName) return moduleDefault;
    return null;
  }

  if (Array.isArray(moduleDefault)) {
    for (const item of moduleDefault) {
      if (!isToolDefinition(item)) continue;
      if (item.name === toolName) return item;
    }
    const tools = moduleDefault.filter(isToolDefinition);
    if (tools.length === 1 && !toolName) return tools[0]!;
    return null;
  }

  return null;
}

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
