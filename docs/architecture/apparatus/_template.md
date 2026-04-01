# The {Name} — API Contract

Status: **Draft**

Package: `@shardworks/{package-name}` · Plugin id: `{plugin-id}`

> **⚠️ MVP scope.** {One-paragraph summary of what's included in MVP and what's deferred. Remove this callout if the spec covers the full design.}

---

## Purpose

{What this apparatus does in 2-3 sentences. What problem it solves, where it sits in the guild's operational fabric, and what it deliberately does NOT do (i.e. what belongs to adjacent apparatus).}

---

## Dependencies

```
requires: [{list apparatus this depends on}]
consumes: [{list kit contribution types this scans for, if any}]
```

- **{Dependency Name}** — {one-line explanation of what this apparatus needs from the dependency.}

---

## Kit Interface

{What new contribution type this apparatus adds to the kit vocabulary. When this apparatus is installed, kits gain the ability to declare a new field in their kit export — e.g. Stacks adds `books`, the Instrumentarium adds `tools`, Clockworks adds `relays`. Document the contribution schema that kit authors use. Omit this section if the apparatus does not consume kit contributions.}

```typescript
// Example: what a kit's export looks like when using this contribution type
export default {
  kit: {
    requires: ['{plugin-id}'],
    {contributionType}: {
      // ...
    },
  },
} satisfies Plugin
```

---

## Support Kit

{What this apparatus itself contributes back to the guild via its `supportKit` — its own books, tools, relays, etc. treated identically to standalone kit contributions. Omit this section if the apparatus has no supportKit.}

```typescript
supportKit: {
  // e.g. books, tools, relays
},
```

---

## `{Name}Api` Interface (`provides`)

{The runtime API this apparatus exposes to other plugins via `ctx.apparatus<{Name}Api>('{plugin-id}')`. Full TypeScript interface with JSDoc on each method. Include all supporting types (request/response interfaces, enums, etc.) inline or immediately after.}

```typescript
interface {Name}Api {
  // ...
}
```

---

## Configuration

{Plugin configuration in `guild.json`, if any. Show the JSON structure and explain each field. Omit this section if the apparatus reads no configuration.}

```json
{
  "{plugin-id}": {
    // ...
  }
}
```

---

## {Behavioral Sections}

{One or more sections covering how the apparatus actually works. The heading and content are apparatus-specific. Examples from existing docs:

- **Session Lifecycle** (Animator) — step-by-step flow diagram
- **Session Providers** (Animator) — pluggable backend interface
- **Change Data Capture** (Stacks) — CDC phases, coalescing rules
- **Role-Gating Resolution** (Instrumentarium) — resolution algorithm
- **What The Loom does NOT do** (Loom) — explicit scope boundaries

Use whatever structure best explains this apparatus's behavior. Prefer concrete flow diagrams (`├─ 1. Step...`) over abstract descriptions. If the apparatus has a multi-step lifecycle, show it as a numbered flow.}

---

## Open Questions

{Unresolved design decisions. Each as a bullet with a bold question and current thinking. Remove this section when the spec is finalized.}

- **{Question}.** {Current thinking or "no answer yet."}

---

## Future: {Evolution Title}

{Planned evolution beyond MVP. Show how the API surface, dependencies, or behavior will change. Include updated TypeScript interfaces where the shape changes. Omit this section if the spec already covers the full design.}

---

## Implementation Notes

{Practical notes for the implementing agent — migration concerns, known gotchas, temporary workarounds, things that need to move between packages. Omit this section if there's nothing to flag.}
