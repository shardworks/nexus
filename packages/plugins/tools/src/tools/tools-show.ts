/**
 * tools-show — show full details for a single tool.
 *
 * Returns name, description, plugin, permission, callableBy, parameter
 * schema, and instructions for the named tool. Returns null if not found.
 *
 * Requires `tools:read` permission.
 */

import { z } from 'zod';

import { tool } from '../tool.ts';
import type { InstrumentariumApi } from '../instrumentarium.ts';

/** Parameter info derived from the Zod schema. */
export interface ParamInfo {
  type: string;
  description: string | null;
  optional: boolean;
}

/** Full detail returned for a single tool. */
export interface ToolDetail {
  name: string;
  description: string;
  pluginId: string;
  permission: string | null;
  callableBy: string[] | null;
  params: Record<string, ParamInfo>;
  instructions: string | null;
}

/**
 * Extract parameter info from a Zod object schema.
 *
 * Walks the shape, unwraps ZodOptional/ZodDefault wrappers, and
 * derives the JSON Schema type name from the inner Zod type.
 */
function extractParams(schema: z.ZodObject<z.ZodRawShape>): Record<string, ParamInfo> {
  const shape = schema.shape;
  const result: Record<string, ParamInfo> = {};

  for (const [key, zodType] of Object.entries(shape)) {
    result[key] = extractSingleParam(zodType as z.ZodType);
  }

  return result;
}

/** Extract info for a single Zod parameter. */
function extractSingleParam(zodType: z.ZodType): ParamInfo {
  let isOptional = false;
  let inner: z.ZodType = zodType;

  // Unwrap ZodOptional
  if (inner instanceof z.ZodOptional) {
    isOptional = true;
    inner = inner.unwrap() as z.ZodType;
  }

  // Unwrap ZodDefault
  if (inner instanceof z.ZodDefault) {
    isOptional = true;
    inner = inner.unwrap() as z.ZodType;
  }

  return {
    type: zodTypeToJsonType(inner),
    description: inner.description ?? null,
    optional: isOptional,
  };
}

/** Map a Zod type to a JSON Schema type string. */
function zodTypeToJsonType(zodType: z.ZodType): string {
  if (zodType instanceof z.ZodString) return 'string';
  if (zodType instanceof z.ZodNumber) return 'number';
  if (zodType instanceof z.ZodBoolean) return 'boolean';
  if (zodType instanceof z.ZodArray) return 'array';
  if (zodType instanceof z.ZodObject) return 'object';
  if (zodType instanceof z.ZodEnum) return 'string';
  if (zodType instanceof z.ZodLiteral) return typeof zodType._def.values[0];
  if (zodType instanceof z.ZodUnion) return 'union';
  if (zodType instanceof z.ZodNullable) return zodTypeToJsonType(zodType.unwrap() as z.ZodType);
  return 'unknown';
}

export function createToolsShow(getApi: () => InstrumentariumApi) {
  return tool({
    name: 'tools-show',
    description:
      'Show details for a tool by name, including parameter schema and instructions.',
    permission: 'read',
    params: {
      name: z.string().describe('Tool name to look up.'),
    },
    handler: async ({ name }) => {
      const api = getApi();
      const resolved = api.find(name);

      if (!resolved) return null;

      const { definition, pluginId } = resolved;

      const detail: ToolDetail = {
        name: definition.name,
        description: definition.description,
        pluginId,
        permission: definition.permission ?? null,
        callableBy: definition.callableBy ?? null,
        params: extractParams(definition.params),
        instructions: definition.instructions ?? null,
      };

      return detail;
    },
  });
}
