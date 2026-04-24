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
  AnimatorStatusDoc,
  SummonRequest,
  SessionResult,
  SessionChunk,
  SessionCost,
  SessionDoc,
  TranscriptDoc,
  TranscriptMessage,
  AnimatorSessionProvider,
  SessionProviderConfig,
  SessionProviderResult,
  GuildStateDoc,
} from './types.ts';

import { sessionList, sessionShow, summon as summonTool, sessionCancel, sessionRunning, sessionRecord, sessionHeartbeat, animatorStatus } from './tools/index.ts';
import { animatorRoutes } from './oculus-routes.ts';
import { drainDlq, recoverOrphans } from './startup.ts';
import {
  DISPATCH_STATUS_DOC_ID,
  buildPrecheckRejectionResult,
  createBackoffMachine,
  createResumeProbeTracker,
  freshStatusDoc,
  isDispatchable,
  validateBackoffConfig,
  type BackoffMachine,
} from './rate-limit-backoff.ts';
import { setBackoffMachine } from './session-record-handler.ts';

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
  sessionId: string,
): SessionProviderConfig {
  // Prepend cwd preamble to the initial prompt so the agent knows where
  // it is. Skip for resumed conversations — the preamble was already
  // delivered in the original session's first message.
  const prompt = request.conversationId
    ? request.prompt
    : cwdPreamble(request.cwd) + (request.prompt ?? '');

  return {
    sessionId,
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
    ...(providerResult.terminationTag ? { terminationTag: providerResult.terminationTag } : {}),
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
    ...(result.terminationTag ? { terminationTag: result.terminationTag } : {}),
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
  cancelHandle?: Record<string, unknown>,
): Promise<void> {
  try {
    // Merge with any pre-existing doc (e.g. `pending` pre-written by
    // launchDetached, or `running` already written by the babysitter via
    // the session-running tool). Preserve authorizedTools and other
    // fields the caller may not have passed.
    const existing = await sessions.get(id);
    const merged: SessionDoc = {
      ...(existing ?? {}),
      id,
      status: 'running',
      startedAt: existing?.startedAt ?? startedAt,
      provider: existing?.provider ?? providerName,
    };
    if (request.conversationId !== undefined) {
      merged.conversationId = request.conversationId;
    } else if (existing?.conversationId !== undefined) {
      merged.conversationId = existing.conversationId;
    }
    if (request.metadata !== undefined || existing?.metadata !== undefined) {
      merged.metadata = { ...(existing?.metadata ?? {}), ...(request.metadata ?? {}) };
    }
    if (cancelHandle !== undefined) {
      merged.cancelHandle = { ...(existing?.cancelHandle ?? {}), ...cancelHandle };
    }
    await sessions.put(merged);
  } catch (err) {
    console.warn(
      `[animator] Failed to write initial session record ${id}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Terminal status values — any of these means the session is done. */
const TERMINAL_STATUSES: ReadonlySet<SessionDoc['status']> = new Set([
  'completed',
  'failed',
  'timeout',
  'cancelled',
  'rate-limited',
]);

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
  // Two narrowed references to the shared `animator/state` book. One
  // holds the back-off dispatch-status doc, the other holds the guild
  // self-heartbeat doc. Same underlying book, different doc ids.
  let dispatchStatusBook: Book<AnimatorStatusDoc>;
  let backoff: BackoffMachine;

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

    async getStatus(): Promise<AnimatorStatusDoc> {
      // The back-off machine owns the `'dispatch-status'` doc in the
      // shared `animator/state` book. A fresh install (never
      // rate-limited) returns the default running shape rather than
      // `undefined` — consumers can branch on `state`/`pausedUntil`
      // without a null check.
      return backoff ? backoff.read() : freshStatusDoc();
    },

    async getSessionCosts(sessionIds: string[]): Promise<Map<string, SessionCost>> {
      const result = new Map<string, SessionCost>();
      if (sessionIds.length === 0) return result;

      // Single bulk query against the sessions book — avoids the per-id
      // round-trip pattern that the previous rig-view path used. Sessions
      // not present in the book are silently omitted (D6): `find` simply
      // returns fewer rows than were requested.
      const docs = await sessions.find({
        where: [['id', 'IN', sessionIds]],
      });

      for (const doc of docs) {
        const entry: SessionCost = { costUsd: doc.costUsd ?? 0 };
        if (doc.tokenUsage?.inputTokens !== undefined) {
          entry.inputTokens = doc.tokenUsage.inputTokens;
        }
        if (doc.tokenUsage?.outputTokens !== undefined) {
          entry.outputTokens = doc.tokenUsage.outputTokens;
        }
        result.set(doc.id, entry);
      }

      return result;
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

      // Step 3: If cancelHandle available, delegate to provider
      if (doc.cancelHandle) {
        try {
          const prov = resolveProvider(config);
          if (prov.cancel) {
            await prov.cancel(doc.cancelHandle);
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

      // Step 0: rate-limit pre-check (D13 — top of animate(), before id
      // generation or SessionDoc write). Uses the back-off machine's
      // synchronous cached doc so the returned handle keeps its
      // happy-path sync contract (no await before activeSessions is
      // populated, so immediate subscribeToSession() calls resolve).
      // When paused AND the current window has not yet elapsed, we
      // synthesize a rate-limited SessionResult and resolve without
      // dispatching; no SessionDoc is written for the rejected call.
      if (backoff) {
        const statusDoc = backoff.peek();
        if (!isDispatchable(statusDoc)) {
          const rejectionId = request.sessionId ?? generateId('ses', 4);
          const startedAt = new Date().toISOString();
          const rejection = buildPrecheckRejectionResult({
            sessionId: rejectionId,
            startedAt,
            provider: provider.name,
            pausedUntil: statusDoc.pausedUntil ?? new Date().toISOString(),
            pauseReason: statusDoc.pauseReason ?? 'rate-limit',
            metadata: request.metadata,
            conversationId: request.conversationId,
          });
          const emptyChunks: AsyncIterable<SessionChunk> = {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  return { value: undefined as unknown as SessionChunk, done: true };
                },
              };
            },
          };
          return {
            sessionId: rejectionId,
            chunks: emptyChunks,
            result: Promise.resolve(rejection),
          };
        }
        // Gate open — record the dispatch attempt so the next rate-limit
        // terminal increments back-off rather than coalescing (D8).
        backoff.noteDispatch();
      }

      return dispatchAnimate(request, request.sessionId ?? generateId('ses', 4));
    },
  };

  /**
   * The pre-check-free dispatch path. Extracted so animate() can call it
   * after the pause gate has been cleared. Always writes a SessionDoc
   * and drives the provider.launch lifecycle.
   */
  function dispatchAnimate(request: AnimateRequest, id: string): AnimateHandle {
    const provider = resolveProvider(config);
    const model = resolveModel();
    const startedAt = new Date().toISOString();
    const providerConfig = buildProviderConfig(request, model, id);

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
      // Await processInfo so cancelHandle is persisted with the running record.
      const initPromise = (async () => {
        let cancelHandle: Record<string, unknown> | undefined;
        if (processInfoPromise) {
          try {
            cancelHandle = await processInfoPromise;
          } catch (err) {
            console.warn(`[animator] Failed to get processInfo for ${id}: ${err instanceof Error ? err.message : err}`);
          }
        }
        await recordRunning(sessions, id, startedAt, provider.name, request, cancelHandle);
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
  }

  return {
    apparatus: {
      requires: ['stacks'],
      recommends: ['loom', 'oculus'],

      supportKit: {
        books: {
          sessions: {
            indexes: ['startedAt', 'status', 'conversationId', 'provider'],
          },
          transcripts: {
            indexes: ['sessionId'],
          },
          // Shared operational-state book. Holds two well-known
          // documents: `'guild-heartbeat'` (written by the heartbeat
          // timer) and `'dispatch-status'` (owned by the rate-limit
          // back-off machine). The Laboratory's CDC ingestion of this
          // book is the historical record of pause / resume transitions;
          // no separate events table is maintained.
          state: {},
        },
        tools: [sessionList, sessionShow, summonTool, sessionCancel, sessionRunning, sessionRecord, sessionHeartbeat, animatorStatus],
        pages: [
          { id: 'animator', title: 'Animator', dir: 'src/static' },
        ],
        routes: animatorRoutes,
      },

      provides: api,

      start(_ctx: StartupContext): void {
        const g = guild();
        config = g.guildConfig().animator ?? {};

        // Fail-loud validation of the rate-limit back-off block (D10
        // patron override). The default shape is applied silently when
        // the block is absent; malformed values throw at startup so we
        // don't silently drift from the configured window.
        validateBackoffConfig(config.rateLimitBackoff);

        const stacks = g.apparatus<StacksApi>('stacks');
        sessions = stacks.book<SessionDoc>('animator', 'sessions');
        transcripts = stacks.book<TranscriptDoc>('animator', 'transcripts');
        // Two narrowed references off the shared `animator/state`
        // book — one per well-known doc shape. Underlying rows live in
        // the same table; the narrowed types keep writer ergonomics
        // clean without inventing a union.
        dispatchStatusBook = stacks.book<AnimatorStatusDoc>('animator', 'state');

        // Build the back-off machine. The config read is deferred per
        // transition so a live-reloaded guild config takes effect on
        // the next transition without restarting the Animator.
        backoff = createBackoffMachine({
          statusBook: dispatchStatusBook,
          config: {
            get: () => validateBackoffConfig(guild().guildConfig().animator?.rateLimitBackoff),
          },
          probe: createResumeProbeTracker(),
        });
        setBackoffMachine({ observeTerminal: backoff.observeTerminal });

        // Warm the back-off cache so the first animate() call's
        // synchronous pre-check reflects the persisted state rather
        // than the default running shape. D24's "passive reconciliation"
        // intentionally leaves any persisted paused doc alone — the
        // first dispatch after `pausedUntil` elapses naturally flips it.
        void backoff.read().catch((err) => {
          console.warn(
            `[animator] Failed to read initial rate-limit status: ${err instanceof Error ? err.message : err}`,
          );
        });

        const GUILD_HEARTBEAT_INTERVAL_MS = 30_000;
        const GUILD_HEARTBEAT_DOC_ID = 'guild-heartbeat';
        const RECONCILER_INTERVAL_MS = 30_000;

        const state = stacks.book<GuildStateDoc>('animator', 'state');

        // IMPORTANT: DLQ drain MUST complete before orphan recovery.
        // DLQ files contain real terminal results from babysitters that couldn't
        // reach the guild. If the reconciler runs first, it sees those sessions as
        // stale (no recent heartbeat) and marks them failed — losing the real result.
        // drainDlq() applies the correct terminal status; recoverOrphans() then
        // correctly skips them as already-terminal.
        (async () => {
          try {
            await drainDlq(g.home);
          } catch (err) {
            console.warn(
              `[animator] DLQ drain failed: ${err instanceof Error ? err.message : err}`,
            );
          }

          // Compute downtime credit from the gap between previous guild_alive_at and now.
          let downtimeCredit = 0;
          try {
            const prev = await state.get(GUILD_HEARTBEAT_DOC_ID);
            if (prev?.guildAliveAt) {
              const gap = Date.now() - new Date(prev.guildAliveAt).getTime();
              downtimeCredit = Math.max(0, gap - GUILD_HEARTBEAT_INTERVAL_MS);
            }
          } catch { /* fresh install — no credit */ }

          // Write the initial guild_alive_at.
          try {
            await state.put({ id: GUILD_HEARTBEAT_DOC_ID, guildAliveAt: new Date().toISOString() });
          } catch (err) {
            console.warn(
              `[animator] Failed to write initial guild_alive_at: ${err instanceof Error ? err.message : err}`,
            );
          }

          // Run initial reconciler with downtime credit.
          try {
            await recoverOrphans(sessions, downtimeCredit);
          } catch (err) {
            console.warn(
              `[animator] Orphan recovery failed: ${err instanceof Error ? err.message : err}`,
            );
          }
        })();

        // Guild self-heartbeat timer — updates guild_alive_at every 30s.
        const guildHeartbeatTimer = setInterval(async () => {
          try {
            await state.put({ id: GUILD_HEARTBEAT_DOC_ID, guildAliveAt: new Date().toISOString() });
          } catch (err) {
            console.warn(`[animator] Failed to update guild_alive_at: ${err instanceof Error ? err.message : err}`);
          }
        }, GUILD_HEARTBEAT_INTERVAL_MS);
        guildHeartbeatTimer.unref();

        // Periodic reconciler — runs every 30s with no downtime credit.
        let reconciling = false;
        const reconcilerTimer = setInterval(async () => {
          if (reconciling) return;
          reconciling = true;
          try {
            await recoverOrphans(sessions, 0);
          } catch (err) {
            console.warn(`[animator] Periodic reconciler failed: ${err instanceof Error ? err.message : err}`);
          } finally {
            reconciling = false;
          }
        }, RECONCILER_INTERVAL_MS);
        reconcilerTimer.unref();
      },
    },
  };
}
