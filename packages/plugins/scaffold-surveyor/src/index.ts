/**
 * @shardworks/scaffold-surveyor — first-light scaffold surveyor.
 *
 * Default export: the kit plugin. Import this and add it to your guild's
 * `plugins` array. No additional configuration required.
 */

import scaffoldSurveyorPlugin from './scaffold-surveyor.ts';

export default scaffoldSurveyorPlugin;

export {
  summonEngine,
  surveyVisionTemplate,
  surveyChargeTemplate,
  surveyPieceTemplate,
} from './scaffold-surveyor.ts';

export { SUMMON_ENGINE_ID } from './engine.ts';
