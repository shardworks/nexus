# `@shardworks/lattice-discord-kit`

A Lattice channel kit that delivers pulses to a Discord channel via an
incoming webhook. Contributes one `latticeChannels` factory (`type:
'discord-webhook'`) which the Lattice materializes from `lattice.channels`
at startup.

See also: [`docs/architecture/apparatus/lattice.md`](../../../docs/architecture/apparatus/lattice.md).

---

## Installation

```sh
pnpm add @shardworks/lattice-discord-kit
```

Register the kit in `guild.json` alongside the Lattice, and point a
channel entry at the factory:

```json
{
  "plugins": [
    "@shardworks/lattice-apparatus",
    "@shardworks/lattice-discord-kit"
  ],
  "lattice": {
    "channels": [
      { "type": "discord-webhook", "webhookUrlEnvVar": "DISCORD_WEBHOOK_URL" }
    ]
  }
}
```

Set the named environment variable to the full webhook URL:

```sh
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/XXX/YYY"
```

The URL is never written to `guild.json`; the kit reads it from
`process.env` at send time.

---

## Kit Contributions

The kit's default export is a plugin shaped as:

```typescript
{
  kit: {
    requires: ['lattice'],
    latticeChannels: [discordWebhookFactory],
  },
}
```

### `discord-webhook` factory

| Instance config field | Required | Description |
|---|---|---|
| `type` | yes | Must be `"discord-webhook"`. |
| `webhookUrlEnvVar` | no | Name of the env var holding the URL. Default `DISCORD_WEBHOOK_URL`. |
| `username` | no | Override the displayed username on posts. |

### Payload shape

Each pulse is posted as a single Discord embed:

```json
{
  "embeds": [
    {
      "title": "<pulse.title>",
      "description": "<pulse.summary>",
      "color": "<per-triggerType>",
      "timestamp": "<pulse.createdAt>",
      "fields": [
        { "name": "Trigger", "value": "<pulse.triggerType>", "inline": true }
        // …trigger-specific fields
      ]
    }
  ]
}
```

Colors are distinct per trigger type:

| Trigger | Color | Notes |
|---|---|---|
| `reckoner.writ-stuck` | orange | Includes `Type`, `Cause`, `Retryable`, `Detail` fields when present. |
| `reckoner.writ-failed` | red | Includes `Type`, `Resolution`, `Child failures` fields. When the pulse's context carries an `engineFailure` block (engine retry-budget exhaustion), the embed also surfaces `Engine` (engine id), `Engine design` (`engineDesignId`), `Attempts` (`attemptCount`), and `Last error` fields. Pulses without `engineFailure` render as before. |
| `reckoner.queue-drained` | green | Includes `Drained at`, `Last terminal` fields. |
| other | Discord blurple (neutral fallback) | Unknown trigger types render raw context keys generically. |

### Delivery policy

- 2xx response → `{ ok: true }`.
- Non-2xx response → `{ ok: false, error: "Discord webhook returned NNN: …" }`.
- Network error or thrown exception → `{ ok: false, error: "network error: …" }`.
- Env var unset → `{ ok: false, error: "environment variable X is not set" }`
  without hitting the network.

Failures are surfaced on the pulse's `deliveryState` / `deliveryError` and
stay visible via `nsg pulse list` / `nsg pulse show`. There are no
automatic retries (per the Lattice's best-effort one-shot policy).

---

## Exports

- `.` — default export is the plugin descriptor. Named exports include
  the factory (`createDiscordWebhookFactory`) and pure helpers
  (`buildPayload`, `embedColorForTrigger`, `contextFields`) for
  programmatic callers and tests.
