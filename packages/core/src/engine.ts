/**
 * Engine SDK — the authoring interface for clockwork engines.
 *
 * Use `engine()` to define a clockwork engine that responds to guild events.
 * The returned definition is what the Clockworks runner imports and calls.
 * Static engines (manifest, ledger-migrate, etc.) do NOT use this factory —
 * they have bespoke APIs and are called directly by framework code.
 *
 * A package can export a single engine or an array of engines:
 *
 * @example Single engine
 * ```typescript
 * import { engine } from '@shardworks/nexus-core';
 *
 * export default engine({
 *   name: 'my-engine',
 *   handler: async (event, { home }) => {
 *     if (event) {
 *       console.log(`Handling ${event.name}`, event.payload);
 *     }
 *   }
 * });
 * ```
 *
 * @example Engine collection
 * ```typescript
 * export default [
 *   engine({ name: 'workshop-prepare', handler: async (event, { home }) => { ... } }),
 *   engine({ name: 'workshop-merge', handler: async (event, { home }) => { ... } }),
 * ];
 * ```
 */

/** An immutable fact from the event log — the input to clockwork engines. */
export interface GuildEvent {
  id: string;
  name: string;
  payload: unknown;
  emitter: string;
  firedAt: string;
}

/** Framework-provided context injected into every engine handler call. */
export interface EngineContext {
  /** Absolute path to the guild root. */
  home: string;
  /**
   * Parameters extracted from the standing order that triggered this engine.
   * Any key on the standing order that isn't a reserved structural key
   * (`on`, `run`) is passed through here. Empty object when no params.
   */
  params: Record<string, unknown>;
}

/**
 * A fully-defined clockwork engine — the return type of `engine()`.
 *
 * The Clockworks runner calls `.handler(event, { home })` when a standing
 * order fires. The `__clockwork` brand is used at load time to distinguish
 * clockwork engines from static engines.
 */
export interface EngineDefinition {
  /** Engine name — used for resolution when a package exports multiple engines. */
  readonly name: string;
  readonly __clockwork: true;
  readonly handler: (event: GuildEvent | null, ctx: EngineContext) => Promise<void>;
}

/**
 * Define a clockwork engine.
 *
 * This is the SDK entry point for event-driven engines. Pass a name and a
 * handler function that receives a GuildEvent (or null for direct invocation)
 * and an EngineContext.
 */
export function engine(def: {
  name: string;
  handler: (event: GuildEvent | null, ctx: EngineContext) => Promise<void>;
}): EngineDefinition {
  return {
    name: def.name,
    __clockwork: true,
    handler: def.handler,
  };
}

/** Type guard: is this module export a clockwork engine? */
export function isClockworkEngine(obj: unknown): obj is EngineDefinition {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    '__clockwork' in obj &&
    (obj as EngineDefinition).__clockwork === true &&
    typeof (obj as EngineDefinition).handler === 'function'
  );
}

/**
 * Resolve a single EngineDefinition from a module's default export.
 *
 * Handles both single-engine and array-of-engines exports:
 * - Single engine: `export default engine({...})` → returned directly
 * - Array: `export default [engine({...}), engine({...})]` → find by name
 *
 * @param moduleDefault - The module's default export
 * @param engineName - The engine name to find (required for array exports)
 * @returns The matching EngineDefinition, or null if not found
 */
export function resolveEngineFromExport(
  moduleDefault: unknown,
  engineName?: string,
): EngineDefinition | null {
  // Single engine export
  if (isClockworkEngine(moduleDefault)) {
    if (!engineName || moduleDefault.name === engineName) return moduleDefault;
    return null;
  }

  // Array of engines — find by name
  if (Array.isArray(moduleDefault)) {
    for (const item of moduleDefault) {
      if (!isClockworkEngine(item)) continue;
      if (item.name === engineName) return item;
    }
    // If no name match but array has exactly one engine, return it
    const engines = moduleDefault.filter(isClockworkEngine);
    if (engines.length === 1 && !engineName) return engines[0]!;
    return null;
  }

  return null;
}
