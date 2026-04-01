/**
 * The Loom — session context composition apparatus.
 *
 * The Loom owns system prompt assembly. Callers provide the user-facing
 * prompt (e.g. writ description, standing order payload); The Loom
 * weaves the system prompt from anima identity, charter, curricula,
 * temperament, and role instructions.
 *
 * MVP: system prompt composition is not yet implemented — weave()
 * returns undefined for systemPrompt. The seam exists so The Animator
 * never assembles prompts itself; as composition is built out, The
 * Loom's internals change but its output shape stays the same.
 *
 * See: docs/specification.md (loom)
 */

import type { Plugin } from '@shardworks/nexus-core';

// ── Public types ──────────────────────────────────────────────────────

export interface WeaveRequest {
  /** Optional initial user message (e.g. writ description, standing order payload). */
  prompt?: string;
}

export interface WovenContext {
  /** The system prompt for the AI process. Undefined until composition is implemented. */
  systemPrompt?: string;
  /** The initial user message, if any. */
  initialPrompt?: string;
}

/** The Loom's public API, exposed via `provides`. */
export interface LoomApi {
  /**
   * Weave a session context.
   *
   * MVP: passes the caller-provided prompt through as initialPrompt.
   * systemPrompt is undefined — composition logic (charter, curricula,
   * temperament, role instructions) is future work.
   */
  weave(request: WeaveRequest): Promise<WovenContext>;
}

// ── Apparatus factory ─────────────────────────────────────────────────

/**
 * Create the Loom apparatus plugin.
 *
 * Returns a Plugin with:
 * - `requires: []` — MVP has no apparatus dependencies
 * - `provides: LoomApi` — the context composition API
 */
export function createLoom(): Plugin {
  const api: LoomApi = {
    async weave(request: WeaveRequest): Promise<WovenContext> {
      const context: WovenContext = {};

      if (request.prompt !== undefined) {
        context.initialPrompt = request.prompt;
      }

      return context;
    },
  };

  return {
    apparatus: {
      requires: [],
      provides: api,

      start() {
        // MVP: no startup work needed.
        // Future: will read guild config for charter, curricula, etc.
      },
    },
  };
}
