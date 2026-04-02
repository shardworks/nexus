# Commission: Assessment Plugin

> **Stub.** Depends on `commission-rig-db.md` shipping first (all three rig commissions).
> This is the first real plugin built under the new model — it proves the stack end to end.

Add a first-class `Assessment` entity so that patrons (and eventually animas and engines) can record evaluations against writs. Separate from writ status, which tracks system lifecycle. Assessments capture judgments about a writ's result.

## Rough Scope

- `Assessment` entity: `{ id, writId, assessorType, assessorId?, assessmentType, value, notes?, assessedAt }`
- Packaged as `nexus-assessments` plugin with `nexus-plugin.json`
- Plugin contributes: `assessments` migration + `assess-writ` tool
- `assess-writ <id> --outcome <value> [--notes <text>]` — creates or updates a patron outcome assessment
- `outcome` values: `success` | `partial` | `wrong` | `abandoned`
- Fires `writ.assessed` event on create/update
- `show-writ` displays assessments if present
- Guild-monitor writ detail shows assessments alongside writ status
- `allowedContexts: ['cli', 'mcp']` — usable from CLI and by animas

## Data Model Decisions

- External entity (not a field on writ)
- Writ-scoped only (`writId` typed reference; no polymorphic targets)
- Uniqueness: one per `(writId, assessorType, assessorId, assessmentType)`; updates overwrite
- No lifecycle — created and updated only
- `assessedAt` is a timestamp (tracks assessment lag)
- Writable on terminal writ states: `completed`, `failed`, `abandoned`

## Key Decisions (to be refined at commission time)

- `assessorType: 'patron'` and `assessmentType: 'outcome'` are the defaults for `assess-writ`
- Entity model supports future assessors (anima, engine) and types (spec_quality, complexity) without schema changes
- `writ.assessed` payload: `{ writId, assessmentId, assessorType, assessmentType, value }`
