# `@shardworks/loom`

The Loom — the guild's session context composer. This apparatus weaves system prompts and initial prompts into a `WovenContext` that The Animator consumes to launch AI sessions. It exists as a separate apparatus so that The Animator never assembles prompts itself — as composition grows more sophisticated (charter, curricula, temperaments, role instructions), The Loom's internals change but its output shape stays the same.

MVP: a pass-through. The caller provides the system prompt and initial prompt directly; The Loom packages them into a structured context. No composition logic, no guild config reads, no file I/O.

```
caller (Animator, clockworks)   → weave(request)
@shardworks/loom                → WovenContext { systemPrompt, initialPrompt? }
The Animator                    → launches session with the woven context
```

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/loom": "workspace:*"
  }
}
```

Plugin id: `loom`

---

## API

The Loom exposes `LoomApi` via `provides`, accessed by other plugins as:

```typescript
import { guild } from '@shardworks/nexus-core';
import type { LoomApi } from '@shardworks/loom';

const loom = guild().apparatus<LoomApi>('loom');
```

### `LoomApi`

```typescript
interface LoomApi {
  /**
   * Weave a session context.
   *
   * MVP: packages the caller-provided system prompt and initial prompt
   * into a WovenContext. No composition logic — the caller is responsible
   * for assembling the prompt content.
   */
  weave(request: WeaveRequest): Promise<WovenContext>;
}
```

### `WeaveRequest`

```typescript
interface WeaveRequest {
  /** The system prompt to deliver to the AI process. */
  systemPrompt: string;
  /** Optional initial user message (e.g. writ description, standing order payload). */
  prompt?: string;
}
```

### `WovenContext`

```typescript
interface WovenContext {
  /** The system prompt for the AI process. */
  systemPrompt: string;
  /** The initial user message, if any. */
  initialPrompt?: string;
}
```

### Usage Examples

**Weave a context for a session (The Animator's use case):**

```typescript
const loom = guild().apparatus<LoomApi>('loom');

const context = await loom.weave({
  systemPrompt: 'You are an artificer in the Shardworks guild...',
  prompt: 'Commission C-042: Implement the Loom apparatus.',
});
// → { systemPrompt: 'You are an artificer...', initialPrompt: 'Commission C-042...' }
```

**Weave a context with no initial prompt (e.g. interactive session):**

```typescript
const context = await loom.weave({
  systemPrompt: 'You are the guild auditor. Review recent session artifacts.',
});
// → { systemPrompt: '...', initialPrompt: undefined }
```

---

## Configuration

MVP: none. The Loom reads no guild configuration.

Future versions will read anima identity records, charter content, and role definitions from guild config and The Stacks.

---

## Exports

```typescript
// Loom API types
import {
  type LoomApi,
  type WeaveRequest,
  type WovenContext,
  createLoom,
} from '@shardworks/loom';
```

The default export is the apparatus plugin instance, ready for use in `guild.json`:

```typescript
import loom from '@shardworks/loom';
// → Plugin with apparatus.provides = LoomApi
```
