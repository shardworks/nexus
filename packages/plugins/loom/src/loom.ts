/**
 * The Loom — session context composition apparatus.
 *
 * The Loom owns system prompt assembly. Given a role name, it produces
 * an AnimaWeave — the composed identity context that The Animator uses
 * to launch a session. The work prompt (what the anima should do) is
 * not the Loom's concern; it bypasses the Loom and goes directly to
 * the Animator.
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
  /**
   * The role to weave context for (e.g. 'artificer', 'scribe').
   *
   * MVP: accepted but not used — no role resolution yet.
   * Future: The Loom reads role instructions, resolves curriculum +
   * temperament, and composes the system prompt from identity layers.
   */
  role?: string;
}

/**
 * The output of The Loom's weave() — the composed anima identity context.
 *
 * Contains the system prompt (produced by the Loom from the anima's
 * identity layers) and metadata about how it was composed. The work
 * prompt is not part of the weave — it goes directly to the Animator.
 */
export interface AnimaWeave {
  /** The system prompt for the AI process. Undefined until composition is implemented. */
  systemPrompt?: string;
}

/** The Loom's public API, exposed via `provides`. */
export interface LoomApi {
  /**
   * Weave an anima's session context.
   *
   * Given a role name, produces an AnimaWeave containing the composed
   * system prompt. MVP: returns undefined for systemPrompt — composition
   * logic (charter, curricula, temperament, role instructions) is future work.
   */
  weave(request: WeaveRequest): Promise<AnimaWeave>;
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
    async weave(_request: WeaveRequest): Promise<AnimaWeave> {
      // MVP: no composition logic. Return an empty weave.
      // Future: resolve role → read instructions file → compose system
      // prompt from charter + curriculum + temperament + role instructions.
      return {};
    },
  };

  return {
    apparatus: {
      requires: [],
      provides: api,

      start() {
        // MVP: no startup work needed.
        // Future: will read guild config for charter, role definitions, etc.
      },
    },
  };
}
