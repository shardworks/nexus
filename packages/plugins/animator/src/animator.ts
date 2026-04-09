/**
 * The Animator — session launch and telemetry recording apparatus.
 *
 * Two API levels:
 * - summon() — high-level: composes context via The Loom, then launches.
 * - animate() — low-level: takes a pre-composed AnimaWeave + prompt.
 *
 * See: docs/specification.md (animator)
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild, generateId } from '@shardworks/nexus-core';
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
  TranscriptDoc,
  TranscriptMessage,
  AnimatorSessionProvider,
  SessionProviderConfig,
  SessionProviderResult,
} from './types.ts';

import { sessionList, sessionShow, summon as summonTool, sessionCancel } from './tools/index.ts';

// ── Session broadcast infrastructure ─────────────────────────────────

/**
 * A single subscriber within a session broadcaster.
 * Chunks are queued here until the consumer iterates them.
 */
interface BroadcastSubscriber {
  queue: SessionChunk[];
  notify: (() => void) | null;
  done: boolean;
}

/**
 * An in-process broadcast channel for a single running session.
 *
 * Multiple consumers can subscribe and each receives all chunks from the
 * beginning of the session (history replay) plus any future chunks.
 * When the session ends, all subscriptions complete.
 */
interface SessionBroadcaster {
  push(chunk: SessionChunk): void;
  close(): void;
  subscribe(): AsyncIterable<SessionChunk>;
}

function createSessionBroadcaster(): SessionBroadcaster {
  const history: SessionChunk[] = [];
  const subscribers: BroadcastSubscriber[] = [];
  let closed = false;

  function push(chunk: SessionChunk): void {
    history.push(chunk);
    for (const sub of subscribers) {
      if (!sub.done) {
        sub.queue.push(chunk);
        if (sub.notify) {
          const notify = sub.notify;
          sub.notify = null;
          notify();
        }
      }
    }
  }

  function close(): void {
    closed = true;
    for (const sub of subscribers) {
      sub.done = true;
      if (sub.notify) {
        const notify = sub.notify;
        sub.notify = null;
        notify();
      }
    }
  }

  function subscribe(): AsyncIterable<SessionChunk> {
    // New subscriber starts with full history replay, then receives future chunks.
    const sub: BroadcastSubscriber = {
      queue: [...history],
      notify: null,
      done: closed,
    };
    if (!closed) {
      subscribers.push(sub);
    }
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            while (sub.queue.length === 0 && !sub.done) {
              await new Promise<void>((resolve) => {
                sub.notify = resolve;
              });
            }
            if (sub.queue.length > 0) {
              return { value: sub.queue.shift()!, done: false as const };
            }
            return { value: undefined as unknown as SessionChunk, done: true as const };
          },
        };
      },
    };
  }

  return { push, close, subscribe };
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
 * The streaming flag is passed through for the provider to honor (or ignore).
 */
/**
 * Build a working-directory preamble that tells the agent where it is.
 *
 * Claude Code tools (Glob, Grep) return relative paths; the agent must
 * construct absolute paths for Read/Edit/Write. Without an explicit
 * preamble the agent guesses — and when other checkouts exist on the
 * filesystem (e.g. /workspace/nexus/) it routinely guesses wrong,
 * committing to the persistent clone instead of its worktree.
 */
function cwdPreamble(cwd: string): string {
  return [
    `Your working directory is: ${cwd}`,
    'All file operations (Read, Edit, Write, Glob, Grep) must use paths rooted in this directory.',
    'Do NOT read, write, or explore files outside this directory.',
    '',
  ].join('\n');
}

function buildProviderConfig(
  request: AnimateRequest,
  model: string,
): SessionProviderConfig {
  // Prepend cwd preamble to the initial prompt so the agent knows where
  // it is. Skip for resumed conversations — the preamble was already
  // delivered in the original session's first message.
  const prompt = request.conversationId
    ? request.prompt
    : cwdPreamble(request.cwd) + (request.prompt ?? '');

  return {
    systemPrompt: request.context.systemPrompt,
    initialPrompt: prompt,
    model,
    conversationId: request.conversationId,
    cwd: request.cwd,
    streaming: request.streaming,
    tools: request.context.tools,
    environment: { ...request.context.environment, ...request.environment },
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
    // For the first session in a conversation chain, promote the
    // provider's session id to conversationId so downstream sessions
    // can resume via --resume. When the request already carries a
    // conversationId (resumed session), preserve it as-is.
    conversationId: request.conversationId ?? providerResult.providerSessionId,
    providerSessionId: providerResult.providerSessionId,
    tokenUsage: providerResult.tokenUsage,
    costUsd: providerResult.costUsd,
    metadata: request.metadata,
    output: providerResult.output,
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
    output: result.output,
  };
}

/**
 * Record a session result to The Stacks (sessions + transcripts books).
 *
 * Errors are logged but never propagated — session data loss is
 * preferable to masking the original failure. See § Error Handling Contract.
 */
async function recordSession(
  sessions: Book<SessionDoc>,
  transcripts: Book<TranscriptDoc>,
  result: SessionResult,
  transcript: TranscriptMessage[] | undefined,
): Promise<void> {
  try {
    await sessions.put(toSessionDoc(result));
  } catch (err) {
    console.warn(
      `[animator] Failed to record session ${result.id}: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (transcript && transcript.length > 0) {
    try {
      await transcripts.put({ id: result.id, messages: transcript });
    } catch (err) {
      console.warn(
        `[animator] Failed to record transcript for ${result.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
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
  cancelMetadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await sessions.put({
      id,
      status: 'running',
      startedAt,
      provider: providerName,
      conversationId: request.conversationId,
      metadata: request.metadata,
      ...(cancelMetadata ? { cancelMetadata } : {}),
    });
  } catch (err) {
    console.warn(
      `[animator] Failed to write initial session record ${id}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Terminal status values — any of these means the session is done. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timeout', 'cancelled']);

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
  let transcripts: Book<TranscriptDoc>;

  /**
   * In-memory registry of active session broadcasters.
   * Keyed by session id. Entries are removed ~30 s after the session ends,
   * which gives late SSE subscribers time to drain any buffered chunks.
   */
  const activeSessions = new Map<string, SessionBroadcaster>();

  const api: AnimatorApi = {
    subscribeToSession(sessionId: string): AsyncIterable<SessionChunk> | null {
      const broadcaster = activeSessions.get(sessionId);
      if (!broadcaster) return null;
      return broadcaster.subscribe();
    },

    async cancel(sessionId: string, options?: { reason?: string }): Promise<SessionDoc> {
      // Step 1: Read current SessionDoc
      const doc = await sessions.get(sessionId);
      if (!doc) {
        throw new Error(`Session "${sessionId}" not found.`);
      }

      // Idempotent: if already terminal, return as-is
      if (TERMINAL_STATUSES.has(doc.status)) {
        return doc;
      }

      // Step 2: Patch to cancelled
      const endedAt = new Date().toISOString();
      const durationMs = new Date(endedAt).getTime() - new Date(doc.startedAt).getTime();

      const updated: SessionDoc = {
        ...doc,
        status: 'cancelled',
        endedAt,
        durationMs,
        ...(options?.reason ? { error: options.reason } : {}),
      };

      try {
        await sessions.put(updated);
      } catch (err) {
        console.warn(
          `[animator] Failed to patch session ${sessionId} to cancelled: ${err instanceof Error ? err.message : err}`,
        );
      }

      // Step 3: If cancelMetadata available, delegate to provider
      if (doc.cancelMetadata) {
        try {
          const prov = resolveProvider(config);
          if (prov.cancel) {
            await prov.cancel(doc.cancelMetadata);
          }
        } catch (err) {
          console.warn(
            `[animator] Failed to cancel provider process for ${sessionId}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      return updated;
    },

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

      // Generate session id up front so it's available on the handle
      // immediately — before the Loom weave or session launch resolves.
      const sessionId = generateId('ses', 4);

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

        // Delegate to the standard animate path, threading through the
        // pre-generated session id so animate() uses it instead of
        // generating a new one.
        return this.animate({
          sessionId,
          context,
          prompt: request.prompt,
          cwd: request.cwd,
          conversationId: request.conversationId,
          metadata,
          streaming: request.streaming,
          environment: request.environment,
        });
      })();

      // Pipe chunks through — can't get them until the Loom weave resolves.
      // Works for both streaming and non-streaming: non-streaming providers
      // return empty chunks, so the generator yields nothing and completes.
      async function* pipeChunks(): AsyncIterable<SessionChunk> {
        const handle = await deferred;
        yield* handle.chunks;
      }

      return {
        sessionId,
        chunks: pipeChunks(),
        result: deferred.then((handle) => handle.result),
      };
    },

    animate(request: AnimateRequest): AnimateHandle {
      const provider = resolveProvider(config);
      const model = resolveModel();
      const providerConfig = buildProviderConfig(request, model);

      // Step 1: use pre-generated session id if provided (from summon()),
      // otherwise generate one. Capture startedAt.
      const id = request.sessionId ?? generateId('ses', 4);
      const startedAt = new Date().toISOString();

      // Single path — the provider returns { chunks, result } regardless
      // of whether streaming is enabled. Providers that don't support
      // streaming return empty chunks; the Animator doesn't branch.
      const { chunks: providerChunks, result: providerResultPromise, processInfo: processInfoPromise } = provider.launch(providerConfig);

      // Set up an in-process broadcaster for this session.
      // All chunks are fanned out through the broadcaster so that both the
      // returned handle.chunks and any subscribeToSession() callers receive
      // the full stream with history replay for late subscribers.
      const broadcaster = createSessionBroadcaster();
      activeSessions.set(id, broadcaster);

      // Consume provider chunks in the background and push to the broadcaster.
      // This drives the fan-out to all subscribers (including handle.chunks).
      (async () => {
        try {
          for await (const chunk of providerChunks) {
            broadcaster.push(chunk);
          }
        } catch (err) {
          console.warn(
            `[animator] Error consuming chunks for session ${id}: ${err instanceof Error ? err.message : err}`,
          );
        } finally {
          broadcaster.close();
        }
      })();

      // Write initial record (fire and forget — don't block streaming).
      // Await processInfo so cancelMetadata is persisted with the running record.
      const initPromise = (async () => {
        let cancelMetadata: Record<string, unknown> | undefined;
        if (processInfoPromise) {
          try {
            cancelMetadata = await processInfoPromise;
          } catch (err) {
            console.warn(`[animator] Failed to get processInfo for ${id}: ${err instanceof Error ? err.message : err}`);
          }
        }
        await recordRunning(sessions, id, startedAt, provider.name, request, cancelMetadata);
      })();

      const result = (async () => {
        await initPromise;

        let sessionResult: SessionResult;
        try {
          const providerResult = await providerResultPromise;

          // Check if the session was cancelled (by this process or another)
          // before overwriting the SessionDoc.
          const currentDoc = await sessions.get(id);
          if (currentDoc?.status === 'cancelled') {
            // Session was cancelled — don't overwrite the doc.
            // Write partial transcript if available.
            if (providerResult.transcript && providerResult.transcript.length > 0) {
              try {
                await transcripts.put({ id, messages: providerResult.transcript });
              } catch (err) {
                console.warn(
                  `[animator] Failed to record transcript for cancelled session ${id}: ${err instanceof Error ? err.message : err}`,
                );
              }
            }
            // Resolve with cancelled status, preserving endedAt/durationMs from the doc.
            sessionResult = {
              id,
              status: 'cancelled',
              startedAt,
              endedAt: currentDoc.endedAt ?? new Date().toISOString(),
              durationMs: currentDoc.durationMs ?? (Date.now() - new Date(startedAt).getTime()),
              provider: provider.name,
              exitCode: providerResult.exitCode,
              error: currentDoc.error,
              conversationId: request.conversationId,
              providerSessionId: providerResult.providerSessionId,
              tokenUsage: providerResult.tokenUsage,
              costUsd: providerResult.costUsd,
              metadata: request.metadata,
              output: providerResult.output,
            };
            return sessionResult;
          }

          sessionResult = buildSessionResult(id, startedAt, provider.name, providerResult, request);
          await recordSession(sessions, transcripts, sessionResult, providerResult.transcript);
        } catch (err) {
          // Check if session was cancelled — if so, resolve instead of rejecting.
          const currentDoc = await sessions.get(id);
          if (currentDoc?.status === 'cancelled') {
            sessionResult = {
              id,
              status: 'cancelled',
              startedAt,
              endedAt: currentDoc.endedAt ?? new Date().toISOString(),
              durationMs: currentDoc.durationMs ?? (Date.now() - new Date(startedAt).getTime()),
              provider: provider.name,
              exitCode: 1,
              error: currentDoc.error,
              conversationId: request.conversationId,
              metadata: request.metadata,
            };
            return sessionResult;
          }

          sessionResult = buildFailedResult(id, startedAt, provider.name, err, request);
          await recordSession(sessions, transcripts, sessionResult, undefined);
          throw err;
        } finally {
          // Remove the broadcaster after a short delay so that any late-connecting
          // SSE subscribers can still drain buffered chunks before the entry disappears.
          setTimeout(() => activeSessions.delete(id), 30_000);
        }
        return sessionResult;
      })();

      // The handle's chunks is a broadcaster subscription, providing history
      // replay and real-time delivery for this session's caller.
      return { sessionId: id, chunks: broadcaster.subscribe(), result };
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
          transcripts: {
            indexes: ['sessionId'],
          },
        },
        tools: [sessionList, sessionShow, summonTool, sessionCancel],
      },

      provides: api,

      start(_ctx: StartupContext): void {
        const g = guild();
        config = g.guildConfig().animator ?? {};

        const stacks = g.apparatus<StacksApi>('stacks');
        sessions = stacks.book<SessionDoc>('animator', 'sessions');
        transcripts = stacks.book<TranscriptDoc>('animator', 'transcripts');
      },
    },
  };
}
