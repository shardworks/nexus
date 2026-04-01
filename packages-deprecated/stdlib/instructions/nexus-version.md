# nexus-version

Report version information about the guild's Nexus installation.

## Usage

```
nexus-version
```

No arguments required. Returns the framework version and a list of all base tools and engines.

## When to use

- When diagnosing compatibility issues or unexpected behavior
- When reporting bugs or requesting support
- When verifying that a guild upgrade completed successfully
- Before installing a tool that declares a `nexusVersion` requirement

## Output

Returns a JSON object with:
- `nexus` — the framework version
- `implements` — base tool names
- `engines` — base engine names
