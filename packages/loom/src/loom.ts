/**
 * The Loom — session context composition apparatus.
 *
 * MVP: a pass-through that packages caller-provided system prompt and
 * initial prompt into a WovenContext. No composition logic — the caller
 * is responsible for assembling the prompt content.
 *
 * The Loom exists as a separate apparatus so that The Animator never
 * assembles prompts itself. As composition grows more sophisticated,
 * The Loom's internals change but its output shape stays the same.
 *
 * See: docs/architecture/apparatus/loom.md
 */

import type { Plugin } from '@shardworks/nexus-core';

// ── Public types ──────────────────────────────────────────────────────

export interface WeaveRequest {
  /** The system prompt to deliver to the AI process. */
  systemPrompt: string;
  /** Optional initial user message (e.g. writ description, standing order payload). */
  prompt?: string;
}

export interface WovenContext {
  /** The system prompt for the AI process. */
  systemPrompt: string;
  /** The initial user message, if any. */
  initialPrompt?: string;
}

/** The Loom's public API, exposed via `provides`. */
export interface LoomApi {
  /**
   * Weave a session context.
   *
   * MVP: packages the caller-provided system prompt and initial prompt
   * into a WovenContext. No composition logic — the caller is responsible
   * for assembling the prompt content.
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
      const context: WovenContext = {
        systemPrompt: request.systemPrompt,
      };

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
