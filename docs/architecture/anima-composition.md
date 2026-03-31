# Anima Composition

An anima is not a monolithic instruction file — it is composed from discrete, versioned, reusable components assembled at instantiation time. This document describes those components: what they are, how they are packaged and installed, how they are assigned to animas, and how the manifest engine assembles them into the instruction set an anima receives when manifested.

For the broader anima model, see [overview.md](overview.md). For how assembly happens at manifest time, see the Manifest Engine section of [overview.md](overview.md).

---

## The Components

An anima's composition has three components:

| Component | What it provides | Mutability |
|-----------|-----------------|------------|
| **Curriculum** | Skills, methodology, craft knowledge. *What you know and how you work.* | Immutable per version |
| **Temperament** | Personality, disposition, communication style. *Who you are.* | Immutable per version |
| **Oaths** *(v2)* | Personal binding commitments. *What you will always or never do.* | Fixed at instantiation |

All three are assigned at instantiation and recorded in the Register. They do not change during an anima's tenure — the composition record is a snapshot of what the anima was given when created. New thinking produces new versions, not edits.

---

## Curricula

### What a curriculum is

A curriculum is a named, versioned, immutable body of training content. It defines what an anima knows and how it approaches work — skills, methodology, craft knowledge, and approach. The curriculum is the answer to "what has this anima been taught?"

Curricula are never edited after creation. When the guild's understanding of good craft changes, a new version is published. The Thomson curriculum v2 is a distinct artifact from v1 — an anima assigned v1 continues with v1 until explicitly re-instantiated with v2.

### Descriptor

Every curriculum has a `nexus-curriculum.json` descriptor at its root:

```json
{
  "content": "curriculum.md",
  "version": "2.0.0",
  "description": "Craft-focused builder — TDD, clean code, iterative delivery"
}
```

Only `content` is required — the path to the markdown file within the package. As with other artifacts, the **directory name is identity** (no `name` field). `version` and `description` fall back to `package.json` if present.

### On-disk layout

```
training/
  curricula/
    artificer-craft/
      nexus-curriculum.json
      curriculum.md
    guild-standards/
      nexus-curriculum.json
      curriculum.md
```

### `guild.json` registration

```json
{
  "curricula": {
    "artificer-craft": {
      "upstream": "@shardworks/curriculum-artificer@2.0.0",
      "installedAt": "2026-03-23T12:00:00Z",
      "bundle": "@shardworks/guild-starter-kit@0.1.0"
    },
    "guild-standards": {
      "upstream": null,
      "installedAt": "2026-03-23T10:00:00Z"
    }
  }
}
```

The registry answers "what curricula are available in this guild." It does *not* assign curricula to roles — that is the wrong layer. A curriculum is assigned to an individual anima at instantiation time, recorded in the Register. The `anima-create` tool picks from the available set.

---

## Temperaments

### What a temperament is

A temperament is a named, versioned, immutable personality template. It governs an anima's disposition, communication style, and character — who they are, as distinct from what they know (curriculum). The same lifecycle applies: immutable per version, new thinking produces a new version.

Two animas from the same curriculum but different temperaments will approach the same problem differently. The curriculum shapes their craft; the temperament shapes their character.

### Descriptor

Every temperament has a `nexus-temperament.json` descriptor at its root:

```json
{
  "content": "temperament.md",
  "version": "1.0.0",
  "description": "Direct, concise, low ceremony — says what needs saying and stops"
}
```

Same schema as curricula: only `content` is required; directory name is identity.

### On-disk layout

```
training/
  temperaments/
    stoic/
      nexus-temperament.json
      temperament.md
    candid/
      nexus-temperament.json
      temperament.md
```

### `guild.json` registration

```json
{
  "temperaments": {
    "stoic": {
      "upstream": null,
      "installedAt": "2026-03-23T10:00:00Z"
    },
    "candid": {
      "upstream": "@shardworks/temperament-candid@1.0.0",
      "installedAt": "2026-03-24T09:00:00Z"
    }
  }
}
```

---

## Oaths *(v2)*

An oath is a binding commitment made by a specific anima at instantiation — identity-level, personal, not institutional. Where the charter is the guild's policy and the curriculum is the guild's teaching, an oath is the anima's own commitment.

Examples: *"I will never modify files outside my commission scope."* *"I will always run tests before sealing my work."* Two animas from the same curriculum and temperament may be given different oaths, making them distinct members even before they have accumulated any history.

Oaths are part of an anima's composition alongside curriculum and temperament. They are assigned at instantiation, recorded in the Register, and injected into the anima's system prompt alongside the curriculum and temperament content. Oaths are immutable after creation — if an oath needs changing, a new anima is instantiated.

Oaths are not packaged artifacts (unlike curricula and temperaments) — they are strings stored directly in the composition record.

---

## Installation

Curricula and temperaments are installed via the same `tool-install` tool and workflow as tools and relays:

```
nsg tool install @shardworks/curriculum-artificer@2.0.0
nsg tool install workshop:forge#curriculum/new-craft@0.1.0
```

The installer detects the artifact type from the descriptor (`nexus-curriculum.json` or `nexus-temperament.json`) and registers it in the appropriate section of `guild.json`. All install types work: registry, workshop, git-url, tarball, link.

---

## Assignment

Curricula and temperaments are assigned to an individual anima at instantiation — not to roles. The `anima-create` tool presents the available set (from `guild.json`) and the operator or sage chooses which combination fits the intended anima.

The Register records which curriculum (name + version) and temperament (name + version) were assigned. The full content of each is snapshotted into the composition record at instantiation time, making the anima's initial identity immutable even if the installed artifact is later updated or removed.

---

## Assembly at manifest time

When an anima is manifested for a session, the manifest engine assembles all composition components — along with guild-level context — into the instruction set delivered to the AI model:

```
SYSTEM PROMPT (identity + environment):
┌─────────────────────────────────────┐
│  1. The Codex                       │  codex/all.md + codex/roles/<role>.md
├─────────────────────────────────────┤
│  2. Curriculum                      │  training/curricula/<name>/curriculum.md
├─────────────────────────────────────┤
│  3. Temperament                     │  training/temperaments/<name>/temperament.md
├─────────────────────────────────────┤
│  4. Oaths (v2)                      │  Stored in Register, injected as text
├─────────────────────────────────────┤
│  5. Active edicts (v2)              │  Current directives from guild leadership
├─────────────────────────────────────┤
│  6. Tool instructions               │  instructions.md for each permitted tool
└─────────────────────────────────────┘

INITIAL PROMPT (task):
┌─────────────────────────────────────┐
│  7. Work context                    │  Writ spec, planning advice, context
└─────────────────────────────────────┘
```

The assembled identity is frozen at manifest time. The anima does not see changes to the guildhall that occur during its session.

---

## Distinction from tools and relays

| | Tools / Engines / Relays | Curricula / Temperaments |
|---|---|---|
| Executed? | Yes — handler (module or script) | No — read as text |
| Access paths? | MCP (animas), CLI (humans), direct (code) | Manifest engine only |
| Role gating? | Yes (tools only) | No — assigned per-anima |
| Descriptor | `nexus-tool.json` or `nexus-engine.json` | `nexus-curriculum.json` or `nexus-temperament.json` |
| Installed by | `tool-install` | `tool-install` (same command) |
| Registered in | `guild.json` tools / engines / relays | `guild.json` curricula / temperaments |
| Assigned to | Roles (tools) or triggered by events (relays) | Individual animas at instantiation |
| Immutable per version? | No (tools can be updated in place) | Yes — fixed at publish time |
