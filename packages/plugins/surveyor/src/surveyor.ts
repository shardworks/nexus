/**
 * The Surveyor — cartograph-decomposition substrate.
 *
 * This apparatus stands up:
 *
 *   1. Three survey writ types (`survey-vision`, `survey-charge`,
 *      `survey-piece`) registered with Clerk using the six-state
 *      mandate-clone shape. No `childrenBehavior` cascade.
 *   2. The `surveyor.supersedes` link kind contributed via `supportKit.linkKinds`.
 *   3. The kit-static surveyor registry (consumed from the `surveyors`
 *      kit-contribution type, validated at startup, sealed at
 *      `phase:started`). D14: descriptor.id must equal the contributing
 *      kit's pluginId. D15: more than one registered surveyor causes
 *      fail-loud at `phase:started`.
 *   4. The `listSurveyors()` / `getActiveSurveyor()` inspection helpers
 *      surfaced on `provides`.
 *   5. Two Phase-2 CDC observers on `(clerk, writs)`:
 *      - Observer #1 (cdc.ts): cartograph node events → transactional survey-writ
 *        emission with Reckoner petition.
 *      - Observer #2 (outcome.ts): survey-writ terminal transitions → status stamp.
 *   6. Six anima tools contributed via `supportKit.tools`.
 *
 * See: docs/architecture/apparatus/surveyor.md
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc, WritTypeConfig } from '@shardworks/clerk-apparatus';
import type { ReckonerApi } from '@shardworks/reckoner-apparatus';

import type { SurveyorApi, SurveyorDescriptor } from './types.ts';
import { SURVEYOR_PLUGIN_ID } from './types.ts';
import { defaultPriority } from './priority.ts';
import { createCartographObserver } from './cdc.ts';
import { createOutcomeObserver } from './outcome.ts';
import {
  surveyorCreateCharge,
  surveyorCreateCharges,
  surveyorCreatePiece,
  surveyorCreatePieces,
  surveyorCreateMandate,
  surveyorCreateMandates,
} from './tools/index.ts';

// ── Suffix-grammar validator (mirrors Reckoner's SOURCE_SUFFIX_RE) ─────

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Writ-type configs (six-state mandate-clone, no childrenBehavior) ───

const SURVEY_VISION_CONFIG: WritTypeConfig = {
  name: 'survey-vision',
  states: [
    { name: 'new',       classification: 'initial',  allowedTransitions: ['open', 'cancelled'] },
    { name: 'open',      classification: 'active',   allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'] },
    { name: 'stuck',     classification: 'active',   attrs: ['stuck'],     allowedTransitions: ['open', 'failed', 'cancelled'] },
    { name: 'completed', classification: 'terminal', attrs: ['success'],   allowedTransitions: [] },
    { name: 'failed',    classification: 'terminal', attrs: ['failure'],   allowedTransitions: [] },
    { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
  ],
};

const SURVEY_CHARGE_CONFIG: WritTypeConfig = {
  name: 'survey-charge',
  states: [
    { name: 'new',       classification: 'initial',  allowedTransitions: ['open', 'cancelled'] },
    { name: 'open',      classification: 'active',   allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'] },
    { name: 'stuck',     classification: 'active',   attrs: ['stuck'],     allowedTransitions: ['open', 'failed', 'cancelled'] },
    { name: 'completed', classification: 'terminal', attrs: ['success'],   allowedTransitions: [] },
    { name: 'failed',    classification: 'terminal', attrs: ['failure'],   allowedTransitions: [] },
    { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
  ],
};

const SURVEY_PIECE_CONFIG: WritTypeConfig = {
  name: 'survey-piece',
  states: [
    { name: 'new',       classification: 'initial',  allowedTransitions: ['open', 'cancelled'] },
    { name: 'open',      classification: 'active',   allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'] },
    { name: 'stuck',     classification: 'active',   attrs: ['stuck'],     allowedTransitions: ['open', 'failed', 'cancelled'] },
    { name: 'completed', classification: 'terminal', attrs: ['success'],   allowedTransitions: [] },
    { name: 'failed',    classification: 'terminal', attrs: ['failure'],   allowedTransitions: [] },
    { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
  ],
};

// ── Internal registry entry ────────────────────────────────────────────

interface RegistryEntry {
  descriptor: SurveyorDescriptor;
  contributingPluginId: string;
}

// ── Test hooks surface ─────────────────────────────────────────────────

export interface SurveyorTestHooks {
  /** Register a `surveyors` kit entry through the same code path the kit-contribution scan uses. */
  registerKitSurveyors(kitEntry: { pluginId: string; value: unknown }): void;
  /** Whether the surveyor registry has sealed. */
  isSealed(): boolean;
  /** Force the registry into sealed state — bypasses `phase:started`. */
  sealRegistry(): void;
  /** Return the active surveyor's id, or undefined if none registered (or not yet sealed). */
  getActiveSurveyorId(): string | undefined;
  /** Return sorted list of all registered surveyor ids. */
  getRegisteredSurveyorIds(): string[];
}

// ── Internal builder ───────────────────────────────────────────────────

function buildSurveyor(): { plugin: Plugin; hooks: SurveyorTestHooks } {
  // These are assigned in start() before any CDC handlers fire.
  let stacks: StacksApi;
  let clerk: ClerkApi;
  let reckoner: ReckonerApi;

  // ── Surveyor registry ──────────────────────────────────────────────
  const surveyorRegistry: Map<string, RegistryEntry> = new Map();
  let registrySealed = false;
  let activeSurveyor: SurveyorDescriptor | undefined;

  /**
   * Validate one `surveyors` kit entry and register it.
   *
   * Mirrors `registerKitSchedulers` from reckoner.ts byte-faithfully.
   * D14: descriptor.id must equal the contributing pluginId.
   */
  function registerKitSurveyors(kitEntry: { pluginId: string; value: unknown }): void {
    if (registrySealed) {
      throw new Error(
        `[surveyor] registerSurveyors: cannot register surveyors from kit "${kitEntry.pluginId}" — the startup registration window has closed. Surveyors must be contributed via the "surveyors" kit array before the framework fires phase:started.`,
      );
    }

    const pluginId = kitEntry.pluginId;
    const raw = kitEntry.value;
    if (!Array.isArray(raw)) {
      throw new Error(
        `[surveyor] Kit "${pluginId}" surveyors: expected an array, got ${typeof raw}.`,
      );
    }

    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(
          `[surveyor] Kit "${pluginId}" surveyors: entry is not an object (got ${entry === null ? 'null' : typeof entry}).`,
        );
      }
      const rec = entry as Record<string, unknown>;
      const id = rec.id;
      const description = rec.description;
      const rigTemplates = rec.rigTemplates;
      const version = rec.version;

      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(
          `[surveyor] Kit "${pluginId}" surveyors: entry is missing a non-empty string "id" field.`,
        );
      }
      if (typeof description !== 'string' || description.length === 0) {
        throw new Error(
          `[surveyor] Kit "${pluginId}" surveyors: entry "${id}" is missing a non-empty string "description" field.`,
        );
      }
      if (typeof rigTemplates !== 'object' || rigTemplates === null) {
        throw new Error(
          `[surveyor] Kit "${pluginId}" surveyors: entry "${id}" "rigTemplates" must be an object; got ${rigTemplates === null ? 'null' : typeof rigTemplates}.`,
        );
      }
      if (version !== undefined && typeof version !== 'string') {
        throw new Error(
          `[surveyor] Kit "${pluginId}" surveyors: entry "${id}" "version" must be a string or omitted; got ${typeof version}.`,
        );
      }

      // D14: bare plugin id — no dot-split grammar in v0.
      if (id !== pluginId) {
        throw new Error(
          `[surveyor] Kit "${pluginId}" surveyors: entry id "${id}" must equal the contributing plugin id "${pluginId}" (D14 — v0 ships exactly one surveyor per plugin).`,
        );
      }

      // Validate kebab-case grammar.
      if (!ID_RE.test(id)) {
        throw new Error(
          `[surveyor] Kit "${pluginId}" surveyors: entry id "${id}" must be kebab-case (lowercase letters, digits, and hyphens, not starting or ending with "-").`,
        );
      }

      const existing = surveyorRegistry.get(id);
      if (existing) {
        throw new Error(
          `[surveyor] Kit "${pluginId}" surveyors: duplicate id "${id}" — already registered by kit "${existing.contributingPluginId}". Two kits cannot contribute a surveyor with the same id.`,
        );
      }

      surveyorRegistry.set(id, {
        descriptor: {
          id,
          description,
          rigTemplates: rigTemplates as Record<string, unknown>,
          ...(typeof version === 'string' ? { version } : {}),
        },
        contributingPluginId: pluginId,
      });
    }
  }

  // ── API ──────────────────────────────────────────────────────────────

  const api: SurveyorApi = {
    listSurveyors(): SurveyorDescriptor[] {
      return Array.from(surveyorRegistry.values()).map((e) => e.descriptor);
    },
    getActiveSurveyor(): SurveyorDescriptor | undefined {
      return activeSurveyor;
    },
  };

  // ── Apparatus plugin ─────────────────────────────────────────────────

  const plugin: Plugin = {
    apparatus: {
      requires: ['stacks', 'clerk', 'cartograph', 'reckoner'],
      recommends: ['spider', 'animator', 'loom', 'clockworks', 'oculus'],
      consumes: ['surveyors'],
      provides: api,

      supportKit: {
        // D18: kit-contribute the surveyor.supersedes link kind.
        linkKinds: [
          {
            id: 'surveyor.supersedes',
            description:
              'Links a new surveyor-created cartograph node to the one it supersedes. ' +
              'Authored by the surveyor anima tools when a supersedes argument is passed.',
          },
        ],

        // T6: six anima tools contributed via supportKit.
        tools: [
          surveyorCreateCharge,
          surveyorCreateCharges,
          surveyorCreatePiece,
          surveyorCreatePieces,
          surveyorCreateMandate,
          surveyorCreateMandates,
        ],
      },

      start(ctx: StartupContext): void {
        stacks = guild().apparatus<StacksApi>('stacks');
        clerk = guild().apparatus<ClerkApi>('clerk');
        reckoner = guild().apparatus<ReckonerApi>('reckoner');

        // ── Register the three survey writ types ──────────────────────
        clerk.registerWritType(SURVEY_VISION_CONFIG);
        clerk.registerWritType(SURVEY_CHARGE_CONFIG);
        clerk.registerWritType(SURVEY_PIECE_CONFIG);

        // ── Build surveyor registry from kit contributions ─────────────
        for (const entry of ctx.kits('surveyors')) {
          registerKitSurveyors(entry);
        }

        // ── Seal registry at phase:started ─────────────────────────────
        ctx.on('phase:started', () => {
          registrySealed = true;

          // D15: fail-loud when more than one surveyor registered.
          if (surveyorRegistry.size > 1) {
            const ids = Array.from(surveyorRegistry.keys()).join('", "');
            throw new Error(
              `[surveyor] Multiple surveyors registered ("${ids}") — only one surveyor is supported in v0. Remove the extra surveyor kit contribution.`,
            );
          }

          // Resolve active surveyor (undefined when zero registered — CDC observer short-circuits).
          activeSurveyor = surveyorRegistry.size === 1
            ? Array.from(surveyorRegistry.values())[0].descriptor
            : undefined;
        });

        // ── CDC observer #1 — cartograph node observer ─────────────────
        const cartographObserver = createCartographObserver({
          getActiveSurveyor: () => activeSurveyor,
          stacks,
          clerk,
          reckoner,
          defaultPriority,
          SURVEYOR_PLUGIN_ID,
        });
        stacks.watch<WritDoc>('clerk', 'writs', cartographObserver, { failOnError: false });

        // ── CDC observer #2 — survey-completion outcome stamping ────────
        const outcomeObserver = createOutcomeObserver({ clerk, stacks, SURVEYOR_PLUGIN_ID });
        stacks.watch<WritDoc>('clerk', 'writs', outcomeObserver, { failOnError: false });
      },
    },
  };

  // ── Test hooks ────────────────────────────────────────────────────────

  const hooks: SurveyorTestHooks = {
    registerKitSurveyors,
    isSealed: () => registrySealed,
    sealRegistry: () => {
      registrySealed = true;
      if (surveyorRegistry.size > 1) {
        const ids = Array.from(surveyorRegistry.keys()).join('", "');
        throw new Error(
          `[surveyor] Multiple surveyors registered ("${ids}") — only one surveyor is supported in v0.`,
        );
      }
      activeSurveyor = surveyorRegistry.size === 1
        ? Array.from(surveyorRegistry.values())[0].descriptor
        : undefined;
    },
    getActiveSurveyorId: () => activeSurveyor?.id,
    getRegisteredSurveyorIds: () => Array.from(surveyorRegistry.keys()).sort(),
  };

  return { plugin, hooks };
}

// ── Public factories ───────────────────────────────────────────────────

export function createSurveyor(): Plugin {
  return buildSurveyor().plugin;
}

export function createSurveyorWithHooks(): { plugin: Plugin; hooks: SurveyorTestHooks } {
  return buildSurveyor();
}
