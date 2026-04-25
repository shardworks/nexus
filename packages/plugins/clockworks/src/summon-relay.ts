/**
 * `summon-relay` — the stdlib bridge between event dispatch and anima
 * sessions.
 *
 * Wired into the apparatus's `supportKit.relays` so every guild that
 * installs Clockworks can author standing orders of the shape:
 *
 *   { on: '<event>', run: 'summon-relay',
 *     with: { role: '<role>', prompt: '<template>', maxSessions?: <n>, ... } }
 *
 * On dispatch the handler:
 *
 *   1. Validates the standing order's `with:` block (D17, D20, D21).
 *   2. Lazily resolves the Loom and Animator (D5) — both are declared
 *      `recommends`, never `requires`, so a guild can install Clockworks
 *      for non-anima relays without dragging the session-launch stack.
 *      A clear error fires here when either apparatus is absent.
 *   3. Confirms the requested `role` exists via `loom.listRoles()` (D3).
 *   4. Binds to a writ (D6): if `event.payload.writId` is a string, the
 *      writ is fetched from the Clerk; otherwise an in-memory synthetic
 *      writ is composed from the event payload and never persisted (D7).
 *   5. Hydrates the prompt template with `{{path}}` substitution (D8, D9)
 *      across three namespaces — `writ.*`, `event.*`, `params.*`.
 *      Undefined paths throw (D18); empty/absent prompts throw (D21).
 *   6. For real writs only (D13): reads
 *      `writ.status?.clockworks?.sessionAttempts` and trips the breaker
 *      when the count reaches `params.maxSessions ?? 10` (D10–D12, D20).
 *      A tripped breaker transitions the writ to `'failed'` via
 *      `clerk.transition` and returns cleanly (D19); a non-tripped
 *      counter is incremented before the session launches so a crashed
 *      dispatcher cannot bypass the count (D11).
 *   7. Calls `animator.summon` with `cwd: guild().home` (D15) and the
 *      agreed metadata (D16), then awaits `AnimateHandle.result` so the
 *      dispatcher's `event_dispatches` row reflects real session runtime
 *      (D14).
 *
 * Source-file layout follows D2 / D23: this file lives alongside
 * `dispatcher.ts` and `relay.ts`; the test sits next to it as
 * `summon-relay.test.ts`. No `src/relays/` directory.
 *
 * See: docs/architecture/clockworks.md
 */

import { guild } from '@shardworks/nexus-core';

import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { relay, type GuildEvent, type RelayDefinition } from './relay.ts';

// ── Structural Animator / Loom contract ─────────────────────────────
//
// The relay only exercises the narrow slice of the Animator and Loom
// APIs documented in their architecture specs (`summon` for the former;
// `listRoles` for the latter). Defining structural types locally keeps
// Clockworks's own typecheck independent of those packages' build state
// — dragging the full surface in would couple our type-checking to
// every transitive import the Animator's source touches. The lazy
// runtime resolution still hits the live apparatus instances; only the
// compile-time shape is intentionally minimal.

/**
 * Minimal `RoleInfo` shape consumed from `LoomApi.listRoles()`. The
 * relay only reads `name`; additional fields the production Loom
 * returns (permissions, source, strict) are accepted via the index
 * signature without being referenced.
 */
interface LoomRoleInfo {
  name: string;
}

/**
 * Minimal `LoomApi` shape — only the entry points the relay calls.
 * `weave` is intentionally absent from this slice; the relay never
 * weaves directly (the Animator's `summon` does that internally).
 */
interface LoomApiShape {
  listRoles(): readonly LoomRoleInfo[];
}

/**
 * Minimal `AnimateHandle` shape — only the field the relay awaits on.
 * The full handle exposes a chunks iterable and a session id; this
 * relay does not stream and the dispatcher already records the
 * triggering event id, so neither is needed here.
 */
interface AnimateHandleShape {
  result: Promise<unknown>;
}

/**
 * Minimal `SummonRequest` shape — exactly the fields the relay
 * populates (D14, D15, D16). `metadata` is left as `unknown`-shaped so
 * the Animator's typed schema stays the source of truth at the call
 * site; the relay does not introspect what it stamped.
 */
interface SummonRequestShape {
  prompt: string;
  role?: string;
  cwd: string;
  metadata?: Record<string, unknown>;
}

/**
 * Minimal `AnimatorApi` shape — only `summon`. `animate`, `cancel`,
 * `subscribeToSession`, and friends are not used by this relay.
 */
interface AnimatorApiShape {
  summon(request: SummonRequestShape): AnimateHandleShape;
}

// ── Tunables ────────────────────────────────────────────────────────

/**
 * Default circuit-breaker cap when a standing order does not specify
 * `maxSessions`. Operators override per-order via `with: { maxSessions }`.
 * `0` disables the breaker entirely (D20); negative values throw (D17).
 */
const DEFAULT_MAX_SESSIONS = 10;

/** Plugin id used for the Clerk's status-slot writes (D10). */
const STATUS_OWNER = 'clockworks';

/** Relay-managed `with:` keys excluded from the `params.*` namespace (D9). */
const RESERVED_PARAM_KEYS = new Set(['role', 'prompt', 'maxSessions']);

// ── Status-slot shape ───────────────────────────────────────────────

/**
 * The Clockworks-owned sub-slot on a writ's `status` map. Matches the
 * `status[pluginId]` convention exemplified by Spider's `SpiderWritStatus`.
 * Today it carries one field; the shape is open so future Clockworks
 * commissions can extend it without a migration.
 */
interface ClockworksWritStatus {
  /** Total successful launches the breaker has counted against this writ. */
  sessionAttempts?: number;
  [key: string]: unknown;
}

// ── Param shape (validated, not declared) ───────────────────────────

interface SummonRelayParams {
  role: string;
  prompt: string;
  maxSessions: number;
  rest: Record<string, unknown>;
}

// ── Relay factory ───────────────────────────────────────────────────

/**
 * Build the stdlib `summon-relay` `RelayDefinition`. Exported so the
 * apparatus boot path can wire it into `supportKit.relays` and so unit
 * tests can drive it directly.
 */
export function createSummonRelay(): RelayDefinition {
  return relay({
    name: 'summon-relay',
    description: 'Summon an anima session in response to an event.',
    handler: async (event, context) => {
      // D17: every invariant is checked at the top of the handler so we
      // throw before any I/O. Each violation names the offending param.
      const params = validateParams(context.params);

      const g = guild();

      // D5: lazy resolve. The Animator and Loom are `recommends`, not
      // `requires`. Their absence is a runtime concern of this relay
      // alone — apparatus `start()` must succeed without them.
      const loom = resolveApparatus<LoomApiShape>(g, 'loom');
      const animator = resolveApparatus<AnimatorApiShape>(g, 'animator');

      // D3: brief requires this throw. The Animator's `summon()` does not
      // validate roles, so the relay is the gate.
      assertRoleExists(loom, params.role);

      // D6: writId-keyed binding. A non-string payload (or missing
      // `writId`) lands on the synthetic path with no Clerk read.
      const writBinding = await resolveWritBinding(g, event);

      // D22: the `writ` namespace is always populated, real or synthetic,
      // so templates never see an undefined `writ`.
      const templateContext = buildTemplateContext({
        writ: writBinding.writ,
        event,
        params,
      });

      // D8, D9, D18: hydrate before the breaker so a malformed template
      // surfaces before any writ-status mutation.
      const hydratedPrompt = renderTemplate(params.prompt, templateContext);

      // D10–D13: breaker is a writ-bound construct; bypass for synthetic
      // writs entirely (their counter would have nowhere to live).
      if (writBinding.kind === 'real') {
        const tripped = await maybeTripBreaker({
          clerk: g.apparatus<ClerkApi>('clerk'),
          writ: writBinding.writ,
          maxSessions: params.maxSessions,
        });
        if (tripped) {
          // D19: breaker tripping is policy-correct behavior, not a relay
          // error. Return cleanly — the writ's resolution string is the
          // audit trail.
          return;
        }
      }

      // D14, D15, D16: launch and await. Stamp metadata that distinguishes
      // this dispatch path from the operator-driven `summon` CLI tool.
      const handle = animator.summon({
        role: params.role,
        prompt: hydratedPrompt,
        cwd: g.home,
        metadata: {
          trigger: 'summon-relay',
          role: params.role,
          writId: writBinding.writ.id,
          eventId: event?.id ?? null,
          eventName: event?.name ?? null,
        },
      });

      await handle.result;
    },
  });
}

// ── Param validation (D17, D20, D21) ────────────────────────────────

function validateParams(raw: Record<string, unknown>): SummonRelayParams {
  const role = raw.role;
  if (typeof role !== 'string' || role.length === 0) {
    throw new Error(
      'summon-relay: "role" is required and must be a non-empty string.',
    );
  }

  const prompt = raw.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error(
      'summon-relay: "prompt" is required and must be a non-empty string.',
    );
  }

  let maxSessions: number = DEFAULT_MAX_SESSIONS;
  if (raw.maxSessions !== undefined) {
    if (
      typeof raw.maxSessions !== 'number' ||
      !Number.isFinite(raw.maxSessions) ||
      raw.maxSessions < 0
    ) {
      throw new Error(
        'summon-relay: "maxSessions" must be a non-negative finite number.',
      );
    }
    maxSessions = raw.maxSessions;
  }

  // Pass-through keys for the `params.*` template namespace. Relay-managed
  // keys are excluded so a template author sees only their own params.
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!RESERVED_PARAM_KEYS.has(key)) rest[key] = value;
  }

  return { role, prompt, maxSessions, rest };
}

// ── Apparatus resolution (D5) ───────────────────────────────────────

interface GuildLike {
  apparatus<T>(name: string): T;
}

function resolveApparatus<T>(g: GuildLike, name: string): T {
  try {
    return g.apparatus<T>(name);
  } catch {
    throw new Error(
      `summon-relay: required apparatus "${name}" is not installed. ` +
        `Install the apparatus or remove the summon-relay standing order.`,
    );
  }
}

// ── Role existence check (D3) ───────────────────────────────────────

function assertRoleExists(loom: LoomApiShape, role: string): void {
  const known = loom.listRoles();
  if (!known.some((entry) => entry.name === role)) {
    throw new Error(
      `summon-relay: role "${role}" is not registered with the Loom. ` +
        `Declare it under loom.roles in guild.json or via a kit role contribution.`,
    );
  }
}

// ── Writ binding (D6, D7) ───────────────────────────────────────────

type WritBinding =
  | { kind: 'real'; writ: WritDoc }
  | { kind: 'synthetic'; writ: WritDoc };

async function resolveWritBinding(
  g: GuildLike,
  event: GuildEvent | null,
): Promise<WritBinding> {
  const writId = readWritId(event);
  if (writId !== null) {
    const clerk = g.apparatus<ClerkApi>('clerk');
    const writ = await clerk.show(writId);
    return { kind: 'real', writ };
  }
  return { kind: 'synthetic', writ: synthesizeWrit(event) };
}

function readWritId(event: GuildEvent | null): string | null {
  if (!event) return null;
  const payload = event.payload;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const candidate = (payload as Record<string, unknown>).writId;
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  return candidate;
}

function synthesizeWrit(event: GuildEvent | null): WritDoc {
  // D7: synthetic writs are in-memory only — never persisted. The shape
  // matches `WritDoc` so templates can address `{{writ.*}}` uniformly.
  const eventId = event?.id ?? 'unknown';
  const eventName = event?.name ?? 'unknown';
  const now = new Date().toISOString();

  let body: string;
  try {
    body = JSON.stringify(event?.payload ?? null);
  } catch {
    body = String(event?.payload ?? '');
  }

  return {
    id: `syn-${eventId}`,
    type: 'synthetic',
    phase: 'synthetic',
    title: `Synthetic writ for ${eventName}`,
    body,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Template rendering (D8, D9, D18) ────────────────────────────────

interface TemplateContext {
  writ: WritDoc;
  event: GuildEvent | null;
  params: Record<string, unknown>;
}

function buildTemplateContext(args: {
  writ: WritDoc;
  event: GuildEvent | null;
  params: SummonRelayParams;
}): TemplateContext {
  return {
    writ: args.writ,
    event: args.event,
    params: args.params.rest,
  };
}

/**
 * Mustache-style `{{path.with.dots}}` interpolator. Three top-level
 * namespaces are recognized — `writ`, `event`, `params`. Anything else
 * is treated as an unresolved path and throws (D18). Likewise, any path
 * whose dot-walk ends at `undefined` throws — silent empty-string
 * substitution would hide operator drift.
 */
function renderTemplate(template: string, context: TemplateContext): string {
  // Match `{{ … }}` with optional surrounding whitespace inside the braces.
  // Capture the inner expression so we can resolve it.
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, expr: string) => {
    const path = expr.trim();
    if (path.length === 0) {
      throw new Error(
        'summon-relay: prompt template contains an empty `{{}}` placeholder.',
      );
    }

    const value = resolvePath(context, path);
    if (value === undefined) {
      throw new Error(
        `summon-relay: prompt template references "${path}" but the resolved value is undefined.`,
      );
    }
    return formatTemplateValue(value);
  });
}

function resolvePath(context: TemplateContext, path: string): unknown {
  const segments = path.split('.');
  const head = segments[0];

  let current: unknown;
  switch (head) {
    case 'writ':
      current = context.writ;
      break;
    case 'event':
      // The `event.*` namespace is the GuildEvent shape sans the
      // bookkeeping `processed` flag (it never reaches the relay).
      current = context.event === null ? null : exposeEvent(context.event);
      break;
    case 'params':
      current = context.params;
      break;
    default:
      // Unknown root segment — treat as undefined so the caller throws
      // a clear "references … undefined" error.
      return undefined;
  }

  for (let i = 1; i < segments.length; i += 1) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segments[i]];
  }
  return current;
}

function exposeEvent(event: GuildEvent): Record<string, unknown> {
  // D9: the event namespace exposes id/name/payload/emitter/firedAt.
  // Returning a fresh object avoids leaking the bookkeeping fields the
  // relay package's `GuildEvent` already strips.
  return {
    id: event.id,
    name: event.name,
    payload: event.payload,
    emitter: event.emitter,
    firedAt: event.firedAt,
  };
}

function formatTemplateValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // Objects/arrays: serialize so the template gets a useful rendering
  // rather than `[object Object]`.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ── Circuit breaker (D10–D13, D20) ──────────────────────────────────

interface BreakerInputs {
  clerk: ClerkApi;
  writ: WritDoc;
  maxSessions: number;
}

/**
 * If the breaker would trip, transition the writ to `'failed'` and
 * return `true`. Otherwise increment the per-writ session-attempt
 * counter and return `false` so the caller proceeds to launch.
 *
 * The increment lands before the await on `animator.summon` so a
 * crashed dispatcher cannot bypass the count — the on-disk counter
 * always reflects "one session has been spent on this writ" once we've
 * decided to launch.
 */
async function maybeTripBreaker(inputs: BreakerInputs): Promise<boolean> {
  const { clerk, writ, maxSessions } = inputs;

  // D20: `0` disables the breaker entirely.
  if (maxSessions === 0) return false;

  const prev =
    (writ.status?.[STATUS_OWNER] as ClockworksWritStatus | undefined) ?? {};
  const prevAttempts = typeof prev.sessionAttempts === 'number'
    ? prev.sessionAttempts
    : 0;

  if (prevAttempts >= maxSessions) {
    // D11, D12: hardcoded `'failed'` terminal — non-mandate writ types
    // throw informatively from `clerk.transition`. The resolution string
    // names the relay, attempt count, and configured cap.
    const resolution =
      `summon-relay: circuit breaker tripped after ${prevAttempts} of ${maxSessions} ` +
      `permitted session attempts. The relay declined to launch a further session.`;
    await clerk.transition(writ.id, 'failed', { resolution });
    return true;
  }

  // D11: increment before the launch. Read-modify-write goes through
  // setWritStatus so sibling sub-slots are preserved (the Clerk API's
  // sole sanctioned slot-write path).
  const next: ClockworksWritStatus = {
    ...prev,
    sessionAttempts: prevAttempts + 1,
  };
  await clerk.setWritStatus(writ.id, STATUS_OWNER, next);
  return false;
}
