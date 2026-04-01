# tool-install

Install a new tool into the guild from a local directory, npm package, or tarball.

## Usage

```
tool-install <source> [--name <name>] [--roles <roles>] [--link]
```

## Arguments

- `<source>` — Local directory path, npm package specifier (e.g. `foo@1.0`, `@scope/tool`), or tarball path (`.tgz`)
- `--name <name>` — Override the tool name (defaults to package name or directory basename)
- `--roles <roles>` — Comma-separated roles for tool access gating
- `--link` — Symlink a local directory instead of copying (for active development)

## Source types

The source is automatically classified:

- **Local directory with `package.json`** — installed via `npm install` into the guild's `node_modules`. Dependencies are resolved automatically.
- **Local directory without `package.json`** — copied directly to the guild. No dependency resolution.
- **npm specifier** (e.g. `my-tool@1.0`, `@scope/tool`) — installed from the npm registry.
- **Tarball** (`.tgz`/`.tar.gz`) — installed via npm from a local archive.

## Examples

Install a locally-built tool:
```
tool-install ./path/to/my-tool --roles artificer
```

Install from npm registry:
```
tool-install some-published-tool@1.2.0 --roles artificer
```

Link a tool for active development (changes are live):
```
tool-install ~/projects/my-tool --link --roles artificer
```

The tool will detect the descriptor type (tool, engine, curriculum, or temperament), install it to the correct location, and register it in guild.json.
