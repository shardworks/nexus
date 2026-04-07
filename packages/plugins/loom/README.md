# `@shardworks/loom-apparatus`

The Loom — the guild's session context composer. This apparatus owns system prompt assembly: given a role name, it weaves charter, tool instructions, and role instructions into an `AnimaWeave` that The Animator consumes to launch AI sessions. The work prompt (what the anima should do) bypasses The Loom — it is not a composition concern.

```
caller (Animator.summon)         → weave({ role })
@shardworks/loom-apparatus       → AnimaWeave { systemPrompt?, tools?, environment? }
The Animator                     → launches session with weave + work prompt
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
   * Weave an anima's session context.
   *
   * Given a role name, produces an AnimaWeave with a composed system prompt,
   * resolved tool set, and git identity environment variables.
   */
  weave(request: WeaveRequest): Promise<AnimaWeave>;

  /**
   * List all registered roles with their metadata.
   *
   * Returns both guild-configured roles (source: 'guild') and kit-contributed
   * roles (source: pluginId). Guild roles appear first.
   */
  listRoles(): RoleInfo[];
}
```

### `WeaveRequest`

```typescript
interface WeaveRequest {
  /**
   * The role to weave context for (e.g. 'artificer', 'scribe').
   * Determines tool resolution and role instructions. When omitted,
   * only charter content is included in the system prompt.
   */
  role?: string;
}
```

### `AnimaWeave`

```typescript
interface AnimaWeave {
  /**
   * The system prompt for the AI process. Composed from guild charter,
   * tool instructions, and role instructions. Undefined when no
   * composition layers produce content.
   */
  systemPrompt?: string;
  /** The resolved tool set for this role. Undefined when no role is specified or no tools match. */
  tools?: ResolvedTool[];
  /**
   * Environment variables for the session process.
   * Default: git identity derived from role name.
   * The Animator merges these with any per-request overrides.
   */
  environment?: Record<string, string>;
}
```

### `RoleInfo`

Returned by `listRoles()`:

```typescript
interface RoleInfo {
  /** Role name — the value you pass to weave({ role }). Qualified for kit roles (e.g. 'animator.scribe'). */
  name: string;
  /** Permission grants in plugin:level format. */
  permissions: string[];
  /** When true, permissionless tools are excluded unless the role grants plugin:* or *:*. */
  strict?: boolean;
  /** Source of the role definition: 'guild' for guild.json roles, or the plugin ID for kit-contributed roles. */
  source: string;
}
```

### Usage Examples

**Weave a context for a role:**

```typescript
const loom = guild().apparatus<LoomApi>('loom');

const weave = await loom.weave({ role: 'artificer' });
// → {
//     systemPrompt: '...charter...\n\n## Tool: ...\n\n...role instructions...',
//     tools: [...],
//     environment: {
//       GIT_AUTHOR_NAME: 'Artificer',
//       GIT_AUTHOR_EMAIL: 'artificer@nexus.local',
//     }
//   }
```

**Via The Animator (typical path):**

```typescript
const animator = guild().apparatus<AnimatorApi>('animator');

// summon() calls loom.weave() internally — you don't need to call it directly
const result = await animator.summon({
  role: 'artificer',
  prompt: 'Build the frobnicator module with tests',
  cwd: '/path/to/workdir',
});
```

---

## Configuration

The Loom reads role definitions from `guild.json["loom"]["roles"]`. See the [architecture spec](../../docs/architecture/apparatus/loom.md) for role configuration format.

Role configuration is used for tool resolution (permissions), environment variables (git identity), and role instruction file lookup (`roles/{role}.md`). Future: curricula and temperament composition.

---

## Dashboard Page

When The Oculus is installed, the Loom contributes a **Roles** page (`/pages/loom/`) to the Oculus dashboard. The page:

- Lists all registered roles (guild and kit) with their permission count, strict flag, and source.
- On row click, shows a detail panel with: resolved tools (Name, Permission, Plugin), environment variables, and the composed system prompt.

The page also exposes two patron-callable REST endpoints (auto-mapped by Oculus):

| Endpoint | Description |
|---|---|
| `GET /api/loom/roles` | Returns `RoleInfo[]` — all registered roles. |
| `GET /api/loom/weave?role=<name>` | Returns the weave preview for a role (tools, environment, systemPrompt). |

---

## Exports

```typescript
// Loom API types
import {
  type LoomApi,
  type WeaveRequest,
  type AnimaWeave,
  type RoleInfo,
  createLoom,
} from '@shardworks/loom-apparatus';
```

The default export is the apparatus plugin instance, ready for use in `guild.json`:

```typescript
import loom from '@shardworks/loom-apparatus';
// → Plugin with apparatus.provides = LoomApi
```
