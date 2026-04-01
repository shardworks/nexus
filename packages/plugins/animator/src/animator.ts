/**
 * The Animator — session launch and telemetry recording apparatus.
 *
 * Takes a WovenContext (from The Loom), launches an AI process via a
 * session provider, monitors it until exit, and records the result to
 * The Stacks.
 *
 * See: docs/architecture/apparatus/animator.md
 */

import crypto from 'node:crypto';

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';
import type { StacksApi, Book } from '@shardworks/stacks-apparatus';

import type {
  AnimatorApi,
  AnimatorConfig,
  AnimateRequest,
  SessionResult,
  SessionChunk,
  SessionDoc,
  AnimatorSessionProvider,
  SessionProviderConfig,
  SessionProviderResult,
} from './types.ts';

import { sessionList, sessionShow } from './tools/index.ts';

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
 */
function buildProviderConfig(
  request: AnimateRequest,
  model: string,
): SessionProviderConfig {
  return {
    systemPrompt: request.context.systemPrompt,
    initialPrompt: request.context.initialPrompt,
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

  const api: AnimatorApi = {
    async animate(request: AnimateRequest): Promise<SessionResult> {
      const provider = resolveProvider(config);
      const model = resolveModel();
      const providerConfig = buildProviderConfig(request, model);

      const id = generateSessionId();
      const startedAt = new Date().toISOString();

      // Step 2: write initial 'running' record
      await recordRunning(sessions, id, startedAt, provider.name, request);

      // Steps 3–4: launch provider (wrapped in try/finally for error guarantee)
      let result: SessionResult;
      try {
        const providerResult = await provider.launch(providerConfig);
        result = buildSessionResult(id, startedAt, provider.name, providerResult, request);
      } catch (err) {
        result = buildFailedResult(id, startedAt, provider.name, err, request);
        // Step 5: record even on failure
        await recordSession(sessions, result);
        // Re-throw per error handling contract
        throw err;
      }

      // Step 5: record result
      await recordSession(sessions, result);

      // Step 6: return
      return result;
    },

    animateStreaming(request: AnimateRequest): {
      chunks: AsyncIterable<SessionChunk>;
      result: Promise<SessionResult>;
    } {
      const provider = resolveProvider(config);
      const model = resolveModel();
      const providerConfig = buildProviderConfig(request, model);

      const id = generateSessionId();
      const startedAt = new Date().toISOString();

      // If provider doesn't support streaming, fall back to launch()
      if (!provider.launchStreaming) {
        const emptyChunks: AsyncIterable<SessionChunk> = {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                return { value: undefined as unknown as SessionChunk, done: true as const };
              },
            };
          },
        };

        const result = (async () => {
          // Write initial record
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
      }

      // Provider supports streaming
      const { chunks: providerChunks, result: providerResultPromise } =
        provider.launchStreaming(providerConfig);

      // Write initial record (fire and forget — don't block streaming)
      const initPromise = recordRunning(sessions, id, startedAt, provider.name, request);

      // Wrap the result to add recording
      const result = (async () => {
        // Ensure initial record was written before we finish
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
    },
  };

  return {
    apparatus: {
      requires: ['stacks'],

      supportKit: {
        books: {
          sessions: {
            indexes: ['startedAt', 'status', 'conversationId', 'provider'],
          },
        },
        tools: [sessionList, sessionShow],
      },

      provides: api,

      start(_ctx: StartupContext): void {
        const g = guild();
        config = g.config<AnimatorConfig>('animator');

        const stacks = g.apparatus<StacksApi>('stacks');
        sessions = stacks.book<SessionDoc>('animator', 'sessions');
      },
    },
  };
}
