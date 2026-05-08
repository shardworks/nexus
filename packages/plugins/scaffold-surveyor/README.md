# `@shardworks/scaffold-surveyor`

**First-light scaffold surveyor.** Minimal LLM-driven decomposition for vision/charge/piece cartograph layers. This package is explicitly designed to be replaced once you observe real cascade behavior and want to iterate on prompt quality, model selection, or decomposition heuristics.

---

## What it does

Registers one `SurveyorDescriptor` with the `@shardworks/surveyor-apparatus` substrate, contributing three rig templates — one per cartograph layer. Each rig template launches a single anima session using the `scaffold-surveyor.summon` engine:

- **`survey-vision` rig** — Reads the vision writ, creates charges via `surveyor-create-charges`.
- **`survey-charge` rig** — Reads the charge writ, creates pieces via `surveyor-create-pieces`.
- **`survey-piece` rig** — Reads the piece writ, creates mandates via `surveyor-create-mandates`.

The cascade: **1 vision → N charges → N×M pieces → leaf mandates.**

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/scaffold-surveyor": "workspace:*"
  }
}
```

Add `scaffold-surveyor` to `guild.json`'s `plugins` array, after `surveyor`:

```json
{
  "plugins": [
    "surveyor",
    "scaffold-surveyor"
  ]
}
```

No additional configuration is required. The `scaffold-surveyor.summon` engine resolves `cwd` from `guild.home` when not explicitly given — no operator boilerplate.

---

## Custom engine: `scaffold-surveyor.summon`

A thin wrapper around `animator.summon()` that mirrors the `anima-session` engine with one difference: when `givens.cwd` is absent or empty, it falls back to `guild().home` instead of throwing. This means surveyor rigs need no worktree configuration by default.

---

## Role files

Three role markdown files ship in `loom-roles/` and are picked up by Loom at registration time:

| Role (qualified) | File | Permission grants |
|---|---|---|
| `scaffold-surveyor.survey-vision` | `loom-roles/survey-vision.md` | `surveyor:create-charge`, `clerk:read` |
| `scaffold-surveyor.survey-charge` | `loom-roles/survey-charge.md` | `surveyor:create-piece`, `clerk:read` |
| `scaffold-surveyor.survey-piece`  | `loom-roles/survey-piece.md`  | `surveyor:create-mandate`, `clerk:read` |

All roles use `model: 'sonnet'` and `strict: true`. Override a role in `guild.json` under its qualified name (`scaffold-surveyor.survey-vision` etc.) to change any of these.

---

## Replacing this surveyor

This package is the canonical first-light implementation. To replace it:

1. Create a new kit plugin with `surveyors: [{ id: 'my-surveyor', ... }]`.
2. Remove `scaffold-surveyor` from `guild.json` `plugins`.
3. Add your new plugin instead.

Only one surveyor may be registered at a time; the `@shardworks/surveyor-apparatus` substrate enforces this at startup.
