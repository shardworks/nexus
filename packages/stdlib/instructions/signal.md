# signal

Signal a guild event. The event is recorded in the Clockworks event queue and will be processed by the Clockworks runner when `nsg clock tick` or `nsg clock run` is invoked.

## Usage

- The event name **must** be declared in `guild.json` under `clockworks.events`.
- You **cannot** signal framework events (`anima.*`, `commission.*`, `mandate.*`, `tool.*`, `migration.*`, `guild.*`, `standing-order.*`, `session.*`) — those are emitted automatically by the framework.
- The optional payload is a JSON object with event-specific data.

## Recovery use: `force`

Set `force: true` to bypass event validation entirely. This allows signalling framework-namespace events (e.g. `mandate.ready`) for manual recovery when a writ or commission is stuck. Use sparingly — bypassing validation is a steward-level operation.

## When to use

Signal an event when something meaningful has happened that other parts of the guild should know about. Standing orders in `guild.json` determine what happens in response.
