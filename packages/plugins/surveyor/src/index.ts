/**
 * @shardworks/surveyor-apparatus — The Surveyor.
 * Cartograph-decomposition substrate: survey writ types, CDC observers, anima tools.
 */

export type {
  SurveyorExt,
  SurveyorWritExt,
  SurveyorStatus,
  SurveyorTerminal,
  SurveyorLayer,
  SurveyorDescriptor,
  SurveyorApi,
} from './types.ts';

export { SURVEYOR_PLUGIN_ID } from './types.ts';

export { createSurveyor } from './surveyor.ts';

import { createSurveyor } from './surveyor.ts';
export default createSurveyor();
