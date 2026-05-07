/**
 * vision-apply — on-disk vision authoring.
 *
 * Reads a vision authored on disk at
 * `<guildHome>/vision/<slug>/{vision.md, vision-metadata.yml}` and
 * snapshots it into the cartograph as a vision writ stamped with
 * `ext['cartograph']` and `ext['surveyor']` using a single code path
 * for both first-time bootstrap and Nth re-import. After first apply
 * the sidecar gains a system-managed `visionId` field that binds the
 * on-disk directory to its cartograph writ.
 *
 * The data flow is one-way: file → writ. Edits to the writ are not
 * propagated back to the file.
 *
 * The tool also writes a `SurveyorExt` priority-hint payload into
 * `writ.ext['surveyor']` per the surveying-cascade contract. The slot
 * is owned by `@shardworks/surveyor-apparatus` and is consumed by its
 * CDC observer when emitting survey petitions. The slot is always
 * written (even when the payload is `{}`) — its presence marks the
 * writ as processed by apply.
 */

import { z } from 'zod';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, isMap, type Document } from 'yaml';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
/**
 * Canonical plugin-id for the surveyor apparatus. Inlined here to avoid a
 * circular package dependency (cartograph ← surveyor ← cartograph).
 * The authoritative definition lives in `@shardworks/surveyor-apparatus`.
 */
const SURVEYOR_PLUGIN_ID = 'surveyor';

/**
 * Priority-hint shape owned by the surveyor apparatus and stored at
 * `writ.ext['surveyor']` for vision/charge/piece writs. Inlined here to
 * avoid the circular import; the canonical type lives in
 * `@shardworks/surveyor-apparatus` as `SurveyorExt`.
 */
interface SurveyorExt {
  severity?:   'moderate' | 'serious' | 'critical';
  deadline?:   string;
  decay?:      boolean;
  complexity?: 'mechanical' | 'bounded' | 'exploratory' | 'open-ended';
}
import type { CartographApi, VisionDoc, VisionStage } from '../types.ts';

/**
 * Tight slug regex: lowercase letters/digits/hyphens/underscores, no
 * leading dot, no path separators, no `..`. Validated at the CLI
 * boundary so bad slugs fail loudly with a clear error rather than
 * surface a murkier path-resolution failure later.
 */
const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Stage values accepted in the sidecar. The full VisionStage enum,
 * mirrored at the boundary so unknown stages fail loudly.
 */
const VISION_STAGES = ['draft', 'active', 'sunset', 'cancelled'] as const;

/**
 * The sanctioned sidecar fields. Anything outside this set is logged as
 * a warning and ignored — preserves forward-compatibility while still
 * surfacing typos.
 */
const KNOWN_SIDECAR_KEYS = new Set([
  'title',
  'stage',
  'codex',
  'visionId',
  'severity',
  'deadline',
  'decay',
  'complexity',
  'resolution',
]);

/**
 * Fixed mapping from sidecar `stage` to writ `phase`. Mirrors the
 * mapping cartograph.createVision uses internally for initial creation
 * and is reused on Nth-apply transitions.
 */
const STAGE_TO_PHASE: Record<VisionStage, 'new' | 'open' | 'completed' | 'cancelled'> = {
  draft: 'new',
  active: 'open',
  sunset: 'completed',
  cancelled: 'cancelled',
};

/**
 * Stages that constitute a "stale binding" if the sidecar's bound writ
 * is in any of these phases. Per D5: all terminal phases plus missing.
 */
const TERMINAL_PHASES = new Set(['cancelled', 'completed', 'failed']);

/**
 * Result of parsing the sidecar. Holds both the structured fields and
 * the original yaml `Document` so we can round-trip-write the visionId
 * back without losing comments and key order (D14).
 */
interface ParsedSidecar {
  doc: Document;
  title: string;
  stage: VisionStage;
  codex?: string;
  visionId?: string;
  severity?: string;
  deadline?: string;
  decay?: string;
  complexity?: string;
  resolution?: string;
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`[vision-apply] sidecar field "${key}" must be a string (got ${typeof value}).`);
  }
  return value;
}

function parseSidecar(raw: string, sidecarPath: string): ParsedSidecar {
  let doc: Document;
  try {
    doc = parseDocument(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[vision-apply] failed to parse sidecar "${sidecarPath}": ${msg}`);
  }

  if (!isMap(doc.contents)) {
    throw new Error(
      `[vision-apply] sidecar "${sidecarPath}" must be a YAML map at the top level.`,
    );
  }

  const obj = (doc.toJS() ?? {}) as Record<string, unknown>;
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(
      `[vision-apply] sidecar "${sidecarPath}" must be a YAML map at the top level.`,
    );
  }

  const title = readStringField(obj, 'title');
  if (title === undefined || title === '') {
    throw new Error(
      `[vision-apply] sidecar "${sidecarPath}" is missing the required field "title".`,
    );
  }

  const stage = readStringField(obj, 'stage');
  if (stage === undefined) {
    throw new Error(
      `[vision-apply] sidecar "${sidecarPath}" is missing the required field "stage".`,
    );
  }
  if (!(VISION_STAGES as readonly string[]).includes(stage)) {
    throw new Error(
      `[vision-apply] sidecar "${sidecarPath}" stage "${stage}" is not a valid VisionStage. ` +
        `Allowed: ${VISION_STAGES.join(', ')}.`,
    );
  }

  // Warn-and-ignore unknown keys.
  for (const key of Object.keys(obj)) {
    if (!KNOWN_SIDECAR_KEYS.has(key)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[vision-apply] sidecar "${sidecarPath}" has unknown key "${key}" — ignoring.`,
      );
    }
  }

  return {
    doc,
    title,
    stage: stage as VisionStage,
    codex: readStringField(obj, 'codex'),
    visionId: readStringField(obj, 'visionId'),
    severity: readStringField(obj, 'severity'),
    deadline: readStringField(obj, 'deadline'),
    decay: readStringField(obj, 'decay'),
    complexity: readStringField(obj, 'complexity'),
    resolution: readStringField(obj, 'resolution'),
  };
}

function buildSurveyorPayload(
  sidecar: ParsedSidecar,
  flags: { severity?: string; deadline?: string; decay?: string },
): SurveyorExt {
  // The payload values come from CLI flags and sidecar fields — untyped
  // user input that the substrate stores via setWritExt (which takes
  // unknown). The cast to SurveyorExt is nominal; runtime values are
  // passed through as-is.
  const payload: Record<string, unknown> = {};
  // CLI flags override sidecar values per D10/D11.
  const severity = flags.severity ?? sidecar.severity;
  const deadline = flags.deadline ?? sidecar.deadline;
  const decay = flags.decay ?? sidecar.decay;
  // `complexity` is sidecar-only per D9.
  const complexity = sidecar.complexity;
  if (severity !== undefined) payload.severity = severity;
  if (deadline !== undefined) payload.deadline = deadline;
  if (decay !== undefined) payload.decay = decay;
  if (complexity !== undefined) payload.complexity = complexity;
  return payload as SurveyorExt;
}

/**
 * Atomic-ish sidecar rewrite: write to a temp file in the same
 * directory, then rename over the target. Same-directory rename is
 * atomic on POSIX filesystems; this avoids the partial-write window
 * that would lose the visionId binding on a process crash.
 */
async function writeSidecarAtomically(
  sidecarPath: string,
  contents: string,
): Promise<void> {
  const tmp = `${sidecarPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, sidecarPath);
}

/**
 * Round-trip-write the visionId back into the sidecar Document so
 * comments and key order survive. Re-emits the document via yaml's
 * stringifier, then writes atomically.
 */
async function persistVisionId(
  sidecar: ParsedSidecar,
  sidecarPath: string,
  visionId: string,
): Promise<void> {
  sidecar.doc.set('visionId', visionId);
  const updated = sidecar.doc.toString();
  await writeSidecarAtomically(sidecarPath, updated);
}

export default tool({
  name: 'vision-apply',
  description: 'Apply an on-disk vision (snapshot a directory into a vision writ + VisionDoc)',
  instructions:
    'Reads <guildHome>/vision/<slug>/{vision.md, vision-metadata.yml}, snapshots the ' +
    'vision into the cartograph as a vision writ stamped with ext[cartograph], and ' +
    'writes a priority-hint payload into writ.ext[surveyor]. On first apply, the sidecar gains a ' +
    'visionId field binding the directory to its writ. On subsequent applies, the bound ' +
    'writ is updated in place; missing/cancelled/completed/failed bindings error cleanly. ' +
    'CLI flags --severity, --deadline, and --decay override sidecar values for the ' +
    'priority-hint payload. The data flow is one-way (file → writ).',
  params: {
    slug: z
      .string()
      .regex(
        SLUG_REGEX,
        'slug must be lowercase letters/digits/hyphens/underscores, must not contain path separators, leading dots, or "..".',
      )
      .describe('Vision directory slug under <guildHome>/vision/'),
    severity: z.string().optional().describe('Override the sidecar severity field for the surveyor priority-hint payload'),
    deadline: z.string().optional().describe('Override the sidecar deadline field for the surveyor priority-hint payload'),
    decay: z.string().optional().describe('Override the sidecar decay field for the surveyor priority-hint payload'),
  },
  permission: 'write',
  callableBy: ['patron'],
  handler: async (params) => {
    const { slug } = params;
    // Defensive — Zod regex already enforces, but a structurally-typed
    // caller could bypass at the type boundary.
    if (slug.includes('/') || slug.includes('\\') || slug === '..' || slug.startsWith('.')) {
      throw new Error(
        `[vision-apply] slug "${slug}" is not a valid directory name (no path separators, no leading dots, no "..").`,
      );
    }

    const home = guild().home;
    const visionDir = path.join(home, 'vision', slug);
    const visionMdPath = path.join(visionDir, 'vision.md');
    const sidecarPath = path.join(visionDir, 'vision-metadata.yml');

    // Load both files. Errors are caught and re-thrown with a friendly
    // message so the patron sees "missing sidecar" rather than ENOENT.
    let bodyText: string;
    try {
      bodyText = await readFile(visionMdPath, 'utf8');
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') {
        throw new Error(
          `[vision-apply] vision.md not found at "${visionMdPath}". Create the file or check the slug.`,
        );
      }
      throw err;
    }

    let sidecarRaw: string;
    try {
      sidecarRaw = await readFile(sidecarPath, 'utf8');
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') {
        throw new Error(
          `[vision-apply] vision-metadata.yml not found at "${sidecarPath}". Bootstrap a sidecar with at least "title" and "stage".`,
        );
      }
      throw err;
    }

    const sidecar = parseSidecar(sidecarRaw, sidecarPath);

    // Resolve target phase from sidecar stage.
    const targetPhase = STAGE_TO_PHASE[sidecar.stage];

    const cartograph = guild().apparatus<CartographApi>('cartograph');
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const stacks = guild().apparatus<StacksApi>('stacks');

    const surveyorPayload = buildSurveyorPayload(sidecar, {
      ...(params.severity !== undefined ? { severity: params.severity } : {}),
      ...(params.deadline !== undefined ? { deadline: params.deadline } : {}),
      ...(params.decay !== undefined ? { decay: params.decay } : {}),
    });

    if (sidecar.visionId === undefined) {
      // ── First apply ────────────────────────────────────────────
      //
      // Reject sunset/cancelled initial stages: cartograph.createVision
      // already rejects them, but surface a more specific error here so
      // patrons see "first apply" context.
      if (sidecar.stage === 'sunset' || sidecar.stage === 'cancelled') {
        throw new Error(
          `[vision-apply] cannot create a vision with initial stage "${sidecar.stage}" — ` +
            `a vision cannot be born retired. Author it as draft or active, then transition.`,
        );
      }

      // Wrap createVision + the surveyor stamp in one outer Stacks
      // transaction so every per-apply write to the writs row coalesces
      // into a single CDC event. createVision opens its own
      // `stacks.transaction(...)` internally; under nested-tx semantics
      // it flattens into the outer tx, and the trailing setWritExt
      // (sibling sub-slot) flattens too — so the create event carries
      // the writ fields, `ext['cartograph']`, and `ext['surveyor']` all
      // in one coalesced payload.
      const doc = await stacks.transaction(async () => {
        const created = await cartograph.createVision({
          title: sidecar.title,
          body: bodyText,
          ...(sidecar.codex !== undefined ? { codex: sidecar.codex } : {}),
          phase: targetPhase,
          stage: sidecar.stage,
        });
        // Surveyor slot is always written, even when payload is `{}` —
        // its presence marks the writ as processed by apply (D11).
        await clerk.setWritExt(created.id, SURVEYOR_PLUGIN_ID, surveyorPayload);
        return created;
      });

      // Persist the visionId binding. Round-trips the yaml document so
      // comments and key order survive (D14); writes atomically (D15).
      // The sidecar write is filesystem-side and outside the Stacks tx
      // boundary; on a crash between commit and rename the writ exists
      // un-bound and the next apply re-creates per the sunset/cancelled
      // recovery flow.
      await persistVisionId(sidecar, sidecarPath, doc.id);

      return doc;
    }

    // ── Nth apply ────────────────────────────────────────────────
    //
    // Resolve the bound writ. Stale bindings (missing/cancelled/
    // completed/failed) error out before any writes — D5.
    const boundId = sidecar.visionId;
    let writ;
    try {
      writ = await clerk.show(boundId);
    } catch {
      throw new Error(
        `[vision-apply] sidecar "${sidecarPath}" carries visionId "${boundId}" but no such writ exists. ` +
          `The binding is stale — clear the visionId field to re-create, or restore the writ.`,
      );
    }
    if (writ.type !== 'vision') {
      throw new Error(
        `[vision-apply] writ "${boundId}" is not a vision (type="${writ.type}"). Stale or corrupt binding.`,
      );
    }
    if (TERMINAL_PHASES.has(writ.phase)) {
      throw new Error(
        `[vision-apply] sidecar "${sidecarPath}" is bound to writ "${boundId}" which is in terminal phase "${writ.phase}". ` +
          `Clear the visionId to re-create, or restore the writ to a non-terminal state.`,
      );
    }

    const existingDoc = await cartograph.showVision(boundId);

    // Wrap every per-apply write to the writs row in a single outer
    // transaction. clerk.edit, cartograph.patchVision,
    // cartograph.transitionVision, and clerk.setWritExt(SURVEYOR) all
    // open their own inner transactions — under Stacks' nested-tx
    // semantics they flatten into this outer tx, and CDC sees one
    // coalesced update event per apply with the final state.
    const updatedDoc = await stacks.transaction(async () => {
      // Always re-write the body — D12 (no diff-and-skip).
      await clerk.edit({ id: boundId, title: sidecar.title, body: bodyText });

      // Codex sync: route through clerk.edit so the writ row stays the
      // single source of truth. This bypasses transitionVision's
      // no-self-transition rule (D20).
      if ((sidecar.codex ?? undefined) !== (existingDoc.codex ?? undefined)) {
        await cartograph.patchVision(boundId, {
          ...(sidecar.codex !== undefined ? { codex: sidecar.codex } : { codex: undefined }),
        });
      }

      // Stage/phase sync: only call transitionVision when the target
      // phase actually differs from the writ's current phase. Calling
      // it when the phase is unchanged would trigger
      // transitionVision's self-transition rejection — D20 keeps the
      // no-op at the call site and preserves the VISION_CONFIG
      // invariant.
      let result: VisionDoc;
      if (writ.phase !== targetPhase) {
        result = await cartograph.transitionVision(boundId, {
          phase: targetPhase,
          stage: sidecar.stage,
          ...(sidecar.resolution !== undefined ? { resolution: sidecar.resolution } : {}),
        });
      } else if (existingDoc.stage !== sidecar.stage) {
        // Phase unchanged but stage drifted (rare — phase/stage are
        // normally locked). Stamp the ext slot directly.
        result = await cartograph.patchVision(boundId, { stage: sidecar.stage });
      } else {
        // Re-read so the returned doc reflects every write performed
        // in this tx (including the body edit and any codex patch).
        result = await cartograph.showVision(boundId);
      }

      // Refresh the surveyor slot. Always written, even when payload
      // is `{}` (D11).
      await clerk.setWritExt(boundId, SURVEYOR_PLUGIN_ID, surveyorPayload);
      return result;
    });

    return updatedDoc satisfies VisionDoc;
  },
});
