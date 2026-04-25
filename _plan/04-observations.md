# Observations

## obs-1: Refresh `docs/reference/event-catalog.md` reserved-namespace list and Clockworks events table

`docs/reference/event-catalog.md` lines 64–69 list only `standing-order.failed` in the Clockworks framework events table; lines 73–83 list seven reserved namespaces. Adding `schedule.fired` and `schedule.` (decision D19) is in scope for this commission, but the doc has other drift worth a separate cleanup pass:

- Line 9 talks about reserved namespaces but only names three (`commission.`, `session.`, `standing-order.`) inline—it should match the canonical list at lines 73–83.
- The 'Standing Order Wiring' section (lines 139–159) shows examples using the dropped sugar form `{ on: 'commission.posted', summon: 'artificer' }`. This contradicts the shipped validator that rejects `summon:`. Sibling commission `w-modf69vg` covers `clockworks.md` but explicitly out-of-scopes other reference docs.

The sweep should: align line 9 with the canonical list, rewrite the Standing Order Wiring examples to the canonical `{ on, run, with? }` shape, and verify all other code snippets match the shipped reality.

## obs-2: Refresh `docs/reference/core-api.md` `isFrameworkEvent` and Clockworks Schema sections

`docs/reference/core-api.md` line 59 names the reserved namespaces inline; this commission adds `schedule.` (decision D19). But the Clockworks Schema section (lines 299–312, referenced from `clockworks.md`) describes the `event_dispatches` table with `handler_type` of 'relay' or 'anima', a `notice_type` of 'summon' or null, and a `target_role` field. The shipped types in `packages/plugins/clockworks/src/types.ts` (lines 136–183) match this shape, but the Stacks book layer doesn't enforce the FK constraint shown in the schema. The doc should either drop the SQL DDL (it's misleading—Stacks owns the schema) or call out that the SQL is illustrative of the conceptual shape, not the actual table definition.

## obs-3: Add a `clock list` filter for `schedule.fired` events when scheduled orders are heavily used

Once scheduled standing orders are in production, `nsg clock list` (in `packages/framework/cli/src/commands/clock.ts`) will show many `schedule.fired` rows mixed in with operator-relevant events. Today the only filter is `--include-processed`. A small follow-up could add `--name <pattern>` or `--exclude <pattern>` to suppress (or include only) `schedule.fired` rows. Out of scope for the cron commission itself — but worth tracking now that the noise pattern is foreseeable.

## obs-4: Hot-edit support for scheduled standing orders

The Clockworks event-trigger dispatcher re-reads `g.guildConfig().clockworks?.standingOrders` every sweep so operators can hot-edit `guild.json` without restart (clockworks.ts line 213, dispatcher commission decision D15). Per decision D11 of this plan, scheduled orders use a build-once-on-startup model and do NOT support hot-edit. This is a divergence operators may be surprised by; once cron usage matures and operators are editing schedules in production, lack of hot-edit will be friction. A follow-up could add reconciliation: per-tick re-read of standingOrders, identifying adds/removes/changes by orderIndex+expression while preserving nextFireTime for unchanged entries. Tracked here so the divergence doesn't get lost.

## obs-5: Move scheduled-standing-orders 'Deferred' bullet update from sibling commission to this one if sequencing matters

Sibling commission `w-modf69vg` (Refresh Clockworks architecture doc) is responsible for removing the 'Scheduled standing orders — deferred' bullet (line 381 of `docs/architecture/clockworks.md`) and adding the new Scheduled Standing Orders section. If `w-modf69vg` lands AFTER this one, there will be a brief window where the code ships the feature but the architecture doc still lists it as deferred. The two should be sequenced in the same release, or this commission could pull in just that one bullet update. Surface as a release-coordination concern.

## obs-6: Daemon tick interval interaction with `@every` sub-second scheduling

Default daemon `intervalMs` is 2000ms (`packages/plugins/clockworks/src/daemon.ts` line 118). Per decision D20, `@every 1s` schedules will not fire reliably under the default tick — we accept this and document it. A follow-up could add a startup warning when scheduled orders' shortest `@every` duration is less than 2x the daemon's `--interval`, alerting operators at boot. This is observability sugar, not a correctness concern, and out of scope for MVP-1.

## obs-7: Cron-parser dependency adds a new third-party library to the Clockworks apparatus

Per decision D6, this commission introduces `cron-parser` as a runtime dependency of `@shardworks/clockworks-apparatus`. The package currently has only workspace dependencies (clerk, stacks, tools) plus zod. The licensing (MIT) and zero-runtime-dep nature of `cron-parser` make it low-risk, but a sibling concern arises: should sage-curated checks (`pnpm audit`, dependency review) be triggered for this new dep at PR-review time? The repo's existing dep-review process (if any) should be followed; flag here so the implementer doesn't bypass it inadvertently.

## obs-8: Standing-order validator drops the unknown-key error message for `schedule:` once it lands

`packages/plugins/clockworks/src/standing-order-validator.ts` line 30 includes a comment noting `schedule` as a future-reserved key being explicitly rejected. Once this commission lands, that comment becomes stale (schedule is wired) and the future-reserved test (`standing-order-validator.test.ts:218`) flips from negative-assertion to positive. The validator's docstring (lines 29–32) lists `schedule` alongside other not-yet-wired keys (`id`, `enabled`, `description`); after this commission, those remain genuinely future-reserved. Worth a short cleanup pass to keep the comment accurate — not load-bearing but easy to miss.
