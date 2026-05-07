/**
 * Surveyor public types.
 *
 * Defines the extension shapes stamped onto cartograph writs (`SurveyorExt`,
 * `SurveyorWritExt`), the post-completion status blob (`SurveyorStatus`),
 * enumerated helpers (`SurveyorTerminal`, `SurveyorLayer`), the kit-contribution
 * descriptor (`SurveyorDescriptor`), and the runtime API surface (`SurveyorApi`).
 */

export const SURVEYOR_PLUGIN_ID = 'surveyor';

/**
 * Cartograph-side priority hints on a vision/charge/piece writ.
 * Lives on writ.ext['surveyor'] for cartograph nodes.
 * Written by nsg vision apply (for visions) and by surveyor rigs (for charges/pieces).
 */
export interface SurveyorExt {
  /** Severity hint for the Reckoner petition. */
  severity?: 'moderate' | 'serious' | 'critical';
  /** ISO date deadline. */
  deadline?: string;
  /** Whether time-decay applies. */
  decay?: boolean;
  /** Coarse complexity hint. */
  complexity?: 'mechanical' | 'bounded' | 'exploratory' | 'open-ended';
}

/**
 * Survey-writ provenance on a survey-vision/survey-charge/survey-piece writ.
 * Lives on writ.ext['surveyor'] for survey writs.
 */
export interface SurveyorWritExt {
  /** Id of the registered surveyor that produced this survey writ. */
  surveyorId: string;
  /** Optional semver version of the surveyor rig at queue time. */
  rigVersion?: string;
  /**
   * The parent writ's updatedAt value at the time the survey writ was created.
   * Used for dedupe: if a non-terminal survey writ already exists with the same
   * (parentId, parentUpdatedAt), re-emission is skipped.
   */
  parentUpdatedAt: string;
}

/**
 * Terminal outcome enum echoing the survey writ's terminal-state attrs.
 */
export type SurveyorTerminal = 'success' | 'failure' | 'cancelled';

/**
 * Post-completion observation blob stamped at writ.status['surveyor'] when
 * a survey writ reaches a terminal phase.
 */
export interface SurveyorStatus {
  /** ISO timestamp when the survey completed (writ.resolvedAt). */
  surveyedAt: string;
  /**
   * Count of cartograph writs (vision/charge/piece) whose parentId equals
   * surveyWrit.parentId and whose createdAt is >= surveyWrit.createdAt.
   */
  childCount: number;
  /** Terminal outcome classification. */
  terminal: SurveyorTerminal;
}

/**
 * Surveyor layer — the cartograph type being surveyed.
 */
export type SurveyorLayer = 'vision' | 'charge' | 'piece';

/**
 * Kit-contributed surveyor descriptor. Surveyor implementations contribute
 * an array of these via the 'surveyors' kit-contribution key.
 *
 * descriptor.id must equal the contributing kit's pluginId.
 */
export interface SurveyorDescriptor {
  /** Bare plugin id of the contributing surveyor. */
  id: string;
  /** Human-readable description. */
  description: string;
  /**
   * Rig template names this surveyor handles. Must cover all three survey types
   * to be considered a complete surveyor.
   * Shape: { 'survey-vision': template, 'survey-charge': template, 'survey-piece': template }
   */
  rigTemplates: Record<string, unknown>;
  /** Optional semver version of this surveyor implementation. */
  version?: string;
}

/**
 * Runtime API exposed via guild().apparatus<SurveyorApi>('surveyor').
 */
export interface SurveyorApi {
  /** Return all registered surveyor descriptors. */
  listSurveyors(): SurveyorDescriptor[];
  /** Return the single active surveyor, or undefined if none registered. */
  getActiveSurveyor(): SurveyorDescriptor | undefined;
}
