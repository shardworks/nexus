# anima-create

Create a new anima in the guild — recording its composition (curriculum, temperament, roles) in the Register so it can be manifested for sessions.

## Usage

```
anima-create <name> --roles <roles> [--curriculum <curriculum>] [--temperament <temperament>]
```

## Arguments

- `<name>` — Name for the new anima
- `--roles <roles>` — Comma-separated roles the anima will hold (e.g. artificer, sage)
- `--curriculum <curriculum>` — Curriculum to assign (must be registered in guild.json)
- `--temperament <temperament>` — Temperament to assign (must be registered in guild.json)

## Guidance

- The anima's name should be unique within the guild.
- Roles determine which tools the anima can access (via role gating).
- Curriculum and temperament must already be installed in the guild before they can be assigned.
