/**
 * The Animator — session launch and telemetry recording apparatus.
 *
 * Two API levels:
 * - summon() — high-level: composes context via The Loom, then launches.
 * - animate() — low-level: takes a pre-composed AnimaWeave + prompt.
 *
 * See: docs/specification.md (animator)
 */

import crypto from 'node:crypto';

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';
import type { StacksApi, Book } from '@shardworks/stacks-apparatus';

import type { LoomApi } from '@shardworks/loom-apparatus';

import type {
  AnimatorApi,
  AnimateHandle,
  AnimatorConfig,
  AnimateRequest,
  SummonRequest,
  SessionResult,
  SessionChunk,
  SessionDoc,
  AnimatorSessionProvider,
  SessionProviderConfig,
  SessionProviderResult,
} from './types.ts';

import { sessionList, sessionShow, summon as summonTool } from './tools/index.ts';

// ── ID generation ────────────────────────────────────────────────────

function generateSessionId(): string {
  return `ses-${crypto.randomBytes(4).toString('hex')}`;
}

// ── Core logic ───────────────────────────────────────────────────────

/**
 * Resolve the session provider apparatus.
 *
 * Looks up the provider by plugin id from guild config. The provider is
 * an apparatus whose `provides` implements AnimatorSessionProvider.
 * Arbor throws immediately if the plugin isn't loaded or has no provides.
 */
function resolveProvider(config: AnimatorConfig): AnimatorSessionProvider {
  const pluginId = config.sessionProvider ?? 'claude-code';
  return guild().apparatus<AnimatorSessionProvider>(pluginId);
}

/**
 * Resolve the model from guild settings.
 */
function resolveModel(): string {
  const g = guild();
  const guildConfig = g.guildConfig();
  return guildConfig.settings?.model ?? 'sonnet';
}

/**
 * Build the provider config from an AnimateRequest.
 *
 * The system prompt comes from the AnimaWeave (composed by The Loom).
 * The work prompt comes from the request directly (bypasses The Loom).
 */
function buildProviderConfig(
  request: AnimateRequest,
  model: string,
): SessionProviderConfig {
  return {
    systemPrompt: request.context.systemPrompt,
    initialPrompt: request.prompt,
    model,
    conversationId: request.conversationId,
    cwd: request.cwd,
  };
}

/**
 * Build a SessionResult from provider output and session metadata.
 */
function buildSessionResult(
  id: string,
  startedAt: string,
  providerName: string,
  providerResult: SessionProviderResult,
  request: AnimateRequest,
): SessionResult {
  const endedAt = new Date().toISOString();
  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();

  return {
    id,
    status: providerResult.status,
    startedAt,
    endedAt,
    durationMs,
    provider: providerName,
    exitCode: providerResult.exitCode,
    error: providerResult.error,
    conversationId: request.conversationId,
    providerSessionId: providerResult.providerSessionId,
    tokenUsage: providerResult.tokenUsage,
    costUsd: providerResult.costUsd,
    metadata: request.metadata,
  };
}

/**
 * Build a failed SessionResult when the provider throws.
 */
function buildFailedResult(
  id: string,
  startedAt: string,
  providerName: string,
  error: unknown,
  request: AnimateRequest,
): SessionResult {
  const endedAt = new Date().toISOString();
  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const errorMessage = error instanceof Error ? error.message : String(error);

  return {
    id,
    status: 'failed',
    startedAt,
    endedAt,
    durationMs,
    provider: providerName,
    exitCode: 1,
    error: errorMessage,
    conversationId: request.conversationId,
    metadata: request.metadata,
  };
}

/**
 * Convert a SessionResult to a SessionDoc for Stacks storage.
 */
function toSessionDoc(result: SessionResult): SessionDoc {
  return {
    id: result.id,
    status: result.status,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    durationMs: result.durationMs,
    provider: result.provider,
    exitCode: result.exitCode,
    error: result.error,
    conversationId: result.conversationId,
    providerSessionId: result.providerSessionId,
    tokenUsage: result.tokenUsage,
    costUsd: result.costUsd,
    metadata: result.metadata,
  };
}

/**
 * Record a session result to The Stacks.
 *
 * Errors are logged but never propagated — session data loss is
 * preferable to masking the original failure. See § Error Handling Contract.
 */
async function recordSession(
  sessions: Book<SessionDoc>,
  result: SessionResult,
): Promise<void> {
  try {
    await sessions.put(toSessionDoc(result));
  } catch (err) {
    console.warn(
      `[animator] Failed to record session ${result.id}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Write the initial 'running' session record to The Stacks.
 */
async function recordRunning(
  sessions: Book<SessionDoc>,
  id: string,
  startedAt: string,
  providerName: string,
  request: AnimateRequest,
): Promise<void> {
  try {
    await sessions.put({
      id,
      status: 'running',
      startedAt,
      provider: providerName,
      conversationId: request.conversationId,
      metadata: request.metadata,
    });
  } catch (err) {
    console.warn(
      `[animator] Failed to write initial session record ${id}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ── Apparatus factory ────────────────────────────────────────────────

/**
 * Create the Animator apparatus plugin.
 *
 * Returns a Plugin with:
 * - `requires: ['stacks']` — records session results
 * - `provides: AnimatorApi` — the session launch API
 * - `supportKit` — contributes `sessions` book + inspection tools
 */
export function createAnimator(): Plugin {
  let config: AnimatorConfig = {};
  let sessions: Book<SessionDoc>;

  // ── Shared empty chunks iterable ──────────────────────────────────
  const emptyChunks: AsyncIterable<SessionChunk> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { value: undefined as unknown as SessionChunk, done: true as const };
        },
      };
    },
  };

  const api: AnimatorApi = {
    summon(request: SummonRequest): AnimateHandle {
      // Resolve The Loom at call time — not a startup dependency.
      // This allows the Animator to start without the Loom installed;
      // only summon() requires it.
      let loom: LoomApi;
      try {
        loom = guild().apparatus<LoomApi>('loom');
      } catch {
        throw new Error(
          'summon() requires The Loom apparatus to be installed. ' +
          'Use animate() directly if you want to provide a pre-composed AnimaWeave.',
        );
      }

      // We need to weave context before we can animate, but summon()
      // must return synchronously. Wrap the async Loom call and the
      // animate delegation into a single deferred flow.
      const deferred = (async () => {
        // Compose identity context via The Loom.
        // The Loom owns system prompt composition — it produces the system
        // prompt from the anima's identity layers (role instructions,
        // curriculum, temperament, charter). MVP: returns empty (no
        // systemPrompt); the session runs without one until the Loom
        // gains composition logic. The work prompt bypasses the Loom.
        const context = await loom.weave({
          role: request.role,
        });

        // Merge caller metadata with auto-generated summon metadata
        const metadata: Record<string, unknown> = {
          trigger: 'summon',
          ...(request.role ? { role: request.role } : {}),
          ...request.metadata,
        };

        // Delegate to the standard animate path.
        // The work prompt goes directly on the request — it is not
        // a composition concern.
        return this.animate({
          context,
          prompt: request.prompt,
          cwd: request.cwd,
          conversationId: request.conversationId,
          metadata,
          streaming: request.streaming,
        });
      })();

      // If streaming, we can't get the provider chunks until after the
      // Loom weave resolves. Pipe through an intermediate iterable.
      if (request.streaming) {
        async function* pipeChunks(): AsyncIterable<SessionChunk> {
          const handle = await deferred;
          yield* handle.chunks;
        }

        return {
          chunks: pipeChunks(),
          result: deferred.then((handle) => handle.result),
        };
      }

      // Non-streaming: empty chunks, just unwrap the result
      return {
        chunks: emptyChunks,
        result: deferred.then((handle) => handle.result),
      };
    },

    animate(request: AnimateRequest): AnimateHandle {
      const provider = resolveProvider(config);
      const model = resolveModel();
      const providerConfig = buildProviderConfig(request, model);

      // Step 1: generate session id, capture startedAt
      const id = generateSessionId();
      const startedAt = new Date().toISOString();

      // Streaming path: provider supports streaming AND caller asked for it
      if (request.streaming && provider.launchStreaming) {
        const { chunks: providerChunks, result: providerResultPromise } =
          provider.launchStreaming(providerConfig);

        // Write initial record (fire and forget — don't block streaming)
        const initPromise = recordRunning(sessions, id, startedAt, provider.name, request);

        const result = (async () => {
          await initPromise;

          let sessionResult: SessionResult;
          try {
            const providerResult = await providerResultPromise;
            sessionResult = buildSessionResult(id, startedAt, provider.name, providerResult, request);
          } catch (err) {
            sessionResult = buildFailedResult(id, startedAt, provider.name, err, request);
            await recordSession(sessions, sessionResult);
            throw err;
          }

          await recordSession(sessions, sessionResult);
          return sessionResult;
        })();

        return { chunks: providerChunks, result };
      }

      // Non-streaming path (or provider doesn't support streaming)
      const result = (async () => {
        await recordRunning(sessions, id, startedAt, provider.name, request);

        let sessionResult: SessionResult;
        try {
          const providerResult = await provider.launch(providerConfig);
          sessionResult = buildSessionResult(id, startedAt, provider.name, providerResult, request);
        } catch (err) {
          sessionResult = buildFailedResult(id, startedAt, provider.name, err, request);
          await recordSession(sessions, sessionResult);
          throw err;
        }

        await recordSession(sessions, sessionResult);
        return sessionResult;
      })();

      return { chunks: emptyChunks, result };
    },
  };

  return {
    apparatus: {
      requires: ['stacks'],
      recommends: ['loom'],

      supportKit: {
        books: {
          sessions: {
            indexes: ['startedAt', 'status', 'conversationId', 'provider'],
          },
        },
        tools: [sessionList, sessionShow, summonTool],
      },

      provides: api,

      start(_ctx: StartupContext): void {
        const g = guild();
        config = g.guildConfig().animator ?? {};

        const stacks = g.apparatus<StacksApi>('stacks');
        sessions = stacks.book<SessionDoc>('animator', 'sessions');
      },
    },
  };
}
