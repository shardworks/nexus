/**
 * The Scriptorium — apparatus implementation.
 *
 * Wires together the ScriptoriumCore (git operations, draft lifecycle)
 * and exposes the ScriptoriumApi as the `provides` object. Tools are
 * contributed via supportKit.
 *
 * See: docs/architecture/apparatus/scriptorium.md
 */

import type {
  Plugin,
  StartupContext,
} from '@shardworks/nexus-core';

import type { ScriptoriumApi } from './types.ts';
import { ScriptoriumCore } from './scriptorium-core.ts';

import {
  codexAdd,
  codexList,
  codexShow,
  codexRemove,
  codexPush,
  draftOpen,
  draftList,
  draftAbandon,
  draftSeal,
} from './tools/index.ts';

// ── Apparatus export ──────────────────────────────────────────────────

export function createScriptorium(): Plugin {
  const core = new ScriptoriumCore();
  let api: ScriptoriumApi;

  return {
    apparatus: {
      requires: [],
      consumes: [],

      get provides() { return api; },

      supportKit: {
        tools: [
          codexAdd,
          codexList,
          codexShow,
          codexRemove,
          codexPush,
          draftOpen,
          draftList,
          draftAbandon,
          draftSeal,
        ],
      },

      start(_ctx: StartupContext): void {
        core.start();
        api = core.createApi();
      },
    },
  };
}
