/**
 * Spider's plugin-default rig template (`default`).
 *
 * This is the canonical draft → implement → review → revise → seal
 * pipeline that every guild used to declare inline under
 * `spider.rigTemplates.default` in its `guild.json`. It is now
 * contributed as a plugin default so mandate dispatch works out of the
 * box with zero guild configuration — an operator only needs to declare
 * `spider.variables` for the role and build/test commands.
 *
 * Guilds may still override this template by declaring their own
 * `spider.rigTemplates.default` in guild.json; config entries win over
 * plugin-contributed defaults via the RigTemplateRegistry's precedence
 * rules.
 *
 * Per D7 in the plan-and-ship commission, this template has no fallback
 * defaults for `${vars.role}`, `${vars.buildCommand}`, or
 * `${vars.testCommand}` — a missing variable raises at dispatch time so
 * misconfiguration is surfaced loudly rather than masked.
 */

import type { RigTemplate } from './types.ts';

export const defaultRigTemplate: RigTemplate = {
  engines: [
    {
      id: 'draft',
      designId: 'draft',
      givens: { writ: '${writ}' },
    },
    {
      id: 'implement',
      designId: 'implement',
      upstream: ['draft'],
      givens: { writ: '${writ}', role: '${vars.role}' },
    },
    {
      id: 'review',
      designId: 'review',
      upstream: ['implement'],
      givens: {
        writ: '${writ}',
        role: 'reviewer',
        buildCommand: '${vars.buildCommand}',
        testCommand: '${vars.testCommand}',
      },
    },
    {
      id: 'revise',
      designId: 'revise',
      upstream: ['review'],
      givens: { writ: '${writ}', role: '${vars.role}' },
    },
    {
      id: 'seal',
      designId: 'seal',
      upstream: ['revise'],
      givens: {},
    },
  ],
  resolutionEngine: 'seal',
};
