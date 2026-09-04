# Contributing to django-mcp

Thanks for your interest. This is a small, focused project, so the bar is
simple: changes should make the server more accurate, cheaper in tokens, or
easier to run.

## Getting set up

```bash
git clone https://github.com/ajaymahato431/django-mcp.git
cd django-mcp
npm install
```

Run the server directly to check it starts:

```bash
node index.js --help
```

## Tests

```bash
npm test              # offline unit tests — must always pass
npm run test:integration   # hits the live documentation site
npm run test:all
```

`npm test` is offline and gates CI. Integration tests talk to the real
documentation site, so they can fail because of an upstream outage rather than
because of your change — CI runs them non-blocking for that reason.

Please add a test with any behaviour change. Bug fixes should come with a test
that fails before the fix.

## The shared `src/core/` directory

`src/core/` and `test/helpers/client.mjs` are **vendored copies** shared
byte-for-byte with the two sibling servers:

- [django-mcp](https://github.com/ajaymahato431/django-mcp)
- [filament-mcp](https://github.com/ajaymahato431/filament-mcp)
- [livewire-mcp](https://github.com/ajaymahato431/livewire-mcp)

If you change a file in `src/core/`, apply the identical change to all three
repositories. Keeping them identical is deliberate: each server stays
independently installable, with no shared release to coordinate.

## Token cost is a feature

These servers exist to give an agent accurate context without wasting its
context window. Two rules follow from that:

1. **A tool description must state its real cost.** If you change what a tool
   returns, re-measure and update the description. There is a regression test
   asserting the default listing stays small; do not raise its threshold to make
   a change pass.
2. **Prefer returning less.** New options should let a caller ask for a smaller
   slice, not a larger one.

## Style

- ES modules, Node 20+, no build step.
- Match the surrounding code; there is no linter to argue with.
- Comments should explain *why*, not restate the code.

## Commits and pull requests

- Conventional-commit style prefixes (`feat:`, `fix:`, `docs:`, `chore:`).
- Describe the user-visible effect in the PR body.
- Update `CHANGELOG.md` under `Unreleased`.

## Releasing

Maintainers: see [RELEASING.md](RELEASING.md) for the publish checklist,
token setup, and troubleshooting.

## Reporting bugs

Open an issue with the tool name, the arguments you passed, and the server's
stderr output. Never paste API tokens.
