export { default as workshopPrepare } from './engines/workshop-prepare.ts';
export { default as workshopMerge } from './engines/workshop-merge.ts';

import workshopPrepare from './engines/workshop-prepare.ts';
import workshopMerge from './engines/workshop-merge.ts';

export default [workshopPrepare, workshopMerge];
