// ── Tools (named exports) ──────────────────────────────────────────────
export { default as commissionCreate } from './tools/commission.ts';
export { default as commissionList } from './tools/commission-list.ts';
export { default as commissionShow } from './tools/commission-show.ts';
export { default as commissionUpdate } from './tools/commission-update.ts';
export { default as animaCreate } from './tools/instantiate.ts';
export { default as animaList } from './tools/anima-list.ts';
export { default as animaShow } from './tools/anima-show.ts';
export { default as animaUpdate } from './tools/anima-update.ts';
export { default as animaRemove } from './tools/anima-remove.ts';
export { default as workshopCreate } from './tools/workshop-create.ts';
export { default as workshopRegister } from './tools/workshop-register.ts';
export { default as workshopList } from './tools/workshop-list.ts';
export { default as workshopShow } from './tools/workshop-show.ts';
export { default as workshopRemove } from './tools/workshop-remove.ts';
export { default as toolInstall } from './tools/install.ts';
export { default as toolRemove } from './tools/remove.ts';
export { default as toolList } from './tools/tool-list.ts';
export { default as clockList } from './tools/clock-list.ts';
export { default as clockTick } from './tools/clock-tick.ts';
export { default as clockRun } from './tools/clock-run.ts';
export { default as clockStatus } from './tools/clock-status.ts';
export { default as clockStart } from './tools/clock-start.ts';
export { default as clockStop } from './tools/clock-stop.ts';
export { default as signal } from './tools/signal.ts';
export { default as nexusVersion } from './tools/nexus-version.ts';
export { default as createWrit } from './tools/create-writ.ts';
export { default as listWrits } from './tools/list-writs.ts';
export { default as showWrit } from './tools/show-writ.ts';
export { default as completeSession } from './tools/complete-session.ts';
export { default as failWrit } from './tools/fail-writ.ts';
export { default as conversationList } from './tools/conversation-list.ts';
export { default as conversationShow } from './tools/conversation-show.ts';
export { default as conversationEnd } from './tools/conversation-end.ts';
export { default as convene } from './tools/convene.ts';
export { default as sessionList } from './tools/session-list.ts';
export { default as sessionShow } from './tools/session-show.ts';
export { default as eventList } from './tools/event-list.ts';
export { default as eventShow } from './tools/event-show.ts';
export { default as updateWrit } from './tools/update-writ.ts';

// ── Engines ────────────────────────────────────────────────────────────
export { default as workshopPrepare } from './engines/workshop-prepare.ts';
export { default as workshopMerge } from './engines/workshop-merge.ts';
export { default as summonEngine } from './engines/summon.ts';

// ── Default export: all tools + engines as flat array ──────────────────
import commissionCreate from './tools/commission.ts';
import commissionList from './tools/commission-list.ts';
import commissionShow from './tools/commission-show.ts';
import commissionUpdate from './tools/commission-update.ts';
import animaCreate from './tools/instantiate.ts';
import animaList from './tools/anima-list.ts';
import animaShow from './tools/anima-show.ts';
import animaUpdate from './tools/anima-update.ts';
import animaRemove from './tools/anima-remove.ts';
import workshopCreate from './tools/workshop-create.ts';
import workshopRegister from './tools/workshop-register.ts';
import workshopList from './tools/workshop-list.ts';
import workshopShow from './tools/workshop-show.ts';
import workshopRemove from './tools/workshop-remove.ts';
import toolInstall from './tools/install.ts';
import toolRemove from './tools/remove.ts';
import toolList from './tools/tool-list.ts';
import clockList from './tools/clock-list.ts';
import clockTick from './tools/clock-tick.ts';
import clockRun from './tools/clock-run.ts';
import clockStatus from './tools/clock-status.ts';
import clockStartTool from './tools/clock-start.ts';
import clockStopTool from './tools/clock-stop.ts';
import signal from './tools/signal.ts';
import nexusVersion from './tools/nexus-version.ts';
import createWritTool from './tools/create-writ.ts';
import listWritsTool from './tools/list-writs.ts';
import showWritTool from './tools/show-writ.ts';
import completeSessionTool from './tools/complete-session.ts';
import failWritTool from './tools/fail-writ.ts';
import conversationListTool from './tools/conversation-list.ts';
import conversationShowTool from './tools/conversation-show.ts';
import conversationEndTool from './tools/conversation-end.ts';
import conveneTool from './tools/convene.ts';
import sessionListTool from './tools/session-list.ts';
import sessionShowTool from './tools/session-show.ts';
import eventListTool from './tools/event-list.ts';
import eventShowTool from './tools/event-show.ts';
import updateWritTool from './tools/update-writ.ts';
import workshopPrepare from './engines/workshop-prepare.ts';
import workshopMerge from './engines/workshop-merge.ts';
import summonEngine from './engines/summon.ts';

export default [
  commissionCreate, commissionList, commissionShow, commissionUpdate,
  animaCreate, animaList, animaShow, animaUpdate, animaRemove,
  workshopCreate, workshopRegister, workshopList, workshopShow, workshopRemove,
  toolInstall, toolRemove, toolList,
  clockList, clockTick, clockRun, clockStatus, clockStartTool, clockStopTool,
  signal, nexusVersion,
  createWritTool, listWritsTool, showWritTool, completeSessionTool, failWritTool, updateWritTool,
  conversationListTool, conversationShowTool, conversationEndTool, conveneTool,
  sessionListTool, sessionShowTool, eventListTool, eventShowTool,
  workshopPrepare, workshopMerge, summonEngine,
];
