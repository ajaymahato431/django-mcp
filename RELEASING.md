# Releasing django-mcp

Maintainer notes. Nothing here is needed to *use* the server — see
[README.md](README.md) for that.

This file is not shipped to npm; the `files` field in `package.json` excludes it.

> **Never put a token in this repository.** Tokens belong in your user-level
> `~/.npmrc` (Windows: `C:\Users\<you>\.npmrc`) or in GitHub repository secrets.
> A token committed to git must be revoked, not just deleted — removing the
> commit does not un-leak it.

---

## One-time setup

### 1. Create an npm token

npmjs.com → avatar → **Access Tokens** → **Generate New Token** → **Granular Access Token**

- **Permissions:** Read and write
- **Packages and scopes:** the three `*-mcp` packages (before the first publish
  they do not exist yet, so you must select *All packages* and narrow it later)
- **Enable "bypass two-factor authentication"** — required for CI, which cannot
  type a one-time code, and for local publishing if your account enforces 2FA on
  writes

### 2. Store it — pick the path you will actually use

**Publishing from your machine:**

```bash
npm config set //registry.npmjs.org/:_authToken=npm_xxxxxxxxxxxx
npm whoami        # should print your npm username
```

That writes to your **user-level** `.npmrc`, outside every repository.

> Never add `--location=project` to that command. It creates an `.npmrc` *inside
> the repo* containing the token in plaintext.

**Publishing from CI** (see [Releasing via CI](#releasing-via-ci)):

Add the token as a repository secret named `NPM_TOKEN` at
`https://github.com/ajaymahato431/django-mcp/settings/secrets/actions/new`.

---

## Releasing from your machine

### 1. Pre-flight

```bash
npm ci                    # clean install from the lockfile
npm test                  # offline unit tests — must pass
npm run test:integration  # live docs; a failure here may be an upstream outage
npm pack --dry-run        # confirm only intended files ship
node index.js --version
```

### 2. Bump the version

```bash
npm version patch     # 2.0.0 -> 2.0.1   bug fixes
npm version minor     # 2.0.0 -> 2.1.0   new tools or arguments
npm version major     # 2.0.0 -> 3.0.0   breaking changes to tool behaviour
```

This edits `package.json`, commits, and creates a `vX.Y.Z` tag.

**Then bump `src/settings.js` by hand to the same number.** The `VERSION`
constant there is what the server reports over MCP and on `--version`, and
`npm version` does not touch it. `npm test` asserts the two agree
("package version and server version must match"); a mismatch fails the suite
and `prepublishOnly` aborts the publish.

```js
export const VERSION = "2.0.1";   // keep in sync with package.json
```

Update `CHANGELOG.md` under a new heading **before** running it, and remember
that a change to what a tool *returns* is a breaking change for the agents
calling it.

### 3. Publish

```bash
npm publish --access public
```

`prepublishOnly` runs the test suite first and aborts the publish if it fails.

If your account enforces 2FA on writes and your token does not bypass it:

```bash
npm publish --access public --otp=123456
```

Codes rotate about every 30 seconds — read a fresh one rather than reusing.

### 4. Push and verify

```bash
git push && git push --tags

npx -y django-mcp@latest --version    # expect the version you just published
npm view django-mcp version
```

Publishing all three servers? Do one, verify `npx` works, then do the rest — if
the packaging is wrong you burn one version number instead of three.

---

## Releasing via CI

Preferred once `NPM_TOKEN` is configured, because it publishes with
[provenance](https://docs.npmjs.com/generating-provenance-statements) — the
verified-source badge on npm, which a local publish cannot produce.

```bash
# Update CHANGELOG.md first, then:
npm version minor
git push && git push --tags
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which installs from
the lockfile, runs the tests, verifies the tag matches `package.json`, and
publishes with `--provenance`.

Watch it at `https://github.com/ajaymahato431/django-mcp/actions`.

---

## After the first successful publish

- Regenerate the npm token scoped to just these packages instead of *All
  packages*, and revoke the broad one.
- Check the package page renders correctly:
  `https://www.npmjs.com/package/django-mcp`

---

## Troubleshooting

**`E403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required`**

Your account requires 2FA for writes. Either pass `--otp=123456`, or create a
granular token with the 2FA-bypass option and store it as above. Nothing is
published when this error appears.

**`E403 ... You do not have permission to publish`**

The name is taken by someone else, or your token lacks write access to it.

**`E402 Payment Required`**

You omitted `--access public` on a scoped package.

**`ENEEDAUTH`**

No valid token. Run `npm whoami`; if it fails, set the token again.

**`npm error Provenance generation ... not supported`**

`--provenance` only works in CI with OIDC. Drop the flag for a local publish;
the release workflow supplies it.

**Cannot publish over an existing version**

npm versions are immutable. Bump and publish again. Unpublishing works only
within 72 hours, and the version number stays permanently spent.

**`env: node\r: No such file or directory` reported by a Linux or macOS user**

The published `index.js` shebang has CRLF line endings. `.gitattributes` pins
LF, and `npm test` asserts it, so this should be impossible — but if it happens,
check that `.gitattributes` survived and republish a patch version.
