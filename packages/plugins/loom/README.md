# `@shardworks/loom-apparatus`

The Loom — the guild's session context composer. This apparatus owns system prompt assembly: it weaves charter, curricula, temperament, and role instructions into a `WovenContext` that The Animator consumes to launch AI sessions. Callers provide the user-facing prompt (writ description, standing order payload); The Loom produces the system prompt. The Animator never assembles prompts itself.

MVP: system prompt composition is not yet implemented — `weave()` returns `undefined` for `systemPrompt`. The caller-provided prompt is passed through as `initialPrompt`. The seam exists now so the contract is stable as composition logic is built out.

```
caller (Animator, clockworks)   → weave({ prompt })
@shardworks/loom-apparatus                → WovenContext { systemPrompt?, initialPrompt? }
The Animator                    → launches session with the woven context
```

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/loom-apparatus": "workspace:*"
  }
}
```

Plugin id: `loom`

---

## API

The Loom exposes `LoomApi` via `provides`, accessed by other plugins as:

```typescript
import { guild } from '@shardworks/nexus-core';
import type { LoomApi } from '@shardworks/loom-apparatus';

const loom = guild().apparatus<LoomApi>('loom');
```

### `LoomApi`

```typescript
interface LoomApi {
  /**
   * Weave a session context.
   *
   * MVP: passes the caller-provided prompt through as initialPrompt.
   * systemPrompt is undefined — composition logic (charter, curricula,
   * temperament, role instructions) is future work.
   */
  weave(request: WeaveRequest): Promise<WovenContext>;
}
```

### `WeaveRequest`

```typescript
interface WeaveRequest {
  /** Optional initial user message (e.g. writ description, standing order payload). */
  prompt?: string;
}
```

### `WovenContext`

```typescript
interface WovenContext {
  /** The system prompt for the AI process. Undefined until composition is implemented. */
  systemPrompt?: string;
  /** The initial user message, if any. */
  initialPrompt?: string;
}
```

### Usage Examples

**Weave a context for a commissioned session:**

```typescript
const loom = guild().apparatus<LoomApi>('loom');

const context = await loom.weave({
  prompt: 'Commission C-042: Implement the Loom apparatus.',
});
// MVP → { systemPrompt: undefined, initialPrompt: 'Commission C-042...' }
// Future → { systemPrompt: '<woven from charter + curricula + ...>', initialPrompt: 'Commission C-042...' }
```

**Weave a context with no initial prompt (e.g. interactive session):**

```typescript
const context = await loom.weave({});
// MVP → { systemPrompt: undefined, initialPrompt: undefined }
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
} from '@shardworks/loom-apparatus';
```

The default export is the apparatus plugin instance, ready for use in `guild.json`:

```typescript
import loom from '@shardworks/loom-apparatus';
// → Plugin with apparatus.provides = LoomApi
```
