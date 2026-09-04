# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 2.x     | Yes       |
| 1.x     | No        |

## Reporting a vulnerability

Please report security issues privately, **not** as a public issue:

- Open a [private security advisory](https://github.com/ajaymahato431/django-mcp/security/advisories/new), or
- Contact the maintainer through their [GitHub profile](https://github.com/ajaymahato431).

Please include what you found, how to reproduce it, and what an attacker could
achieve. You can expect an initial response within seven days.

## Security model

Understanding what this server does makes it easier to judge a finding:

- It runs **locally**, as a subprocess of your MCP client, communicating over
  stdio. It opens no listening port.
- It makes **outbound HTTPS requests only**, to the public documentation sites
  named in the README.
- It is **read-only**. It writes nothing to disk and executes no code from the
  documents it fetches.
- It requires **no credentials**. `GITHUB_TOKEN`, where supported, is optional
  and used solely to raise a public rate limit.

## Dependency advisories

`npm audit` currently reports advisories against packages pulled in indirectly by
`@modelcontextprotocol/sdk`. None are reachable from this server, and the reason
is worth stating precisely rather than asserting.

The SDK ships several transports. This server uses **only stdio**, so the HTTP
transport stack is never imported. You can confirm that yourself:

```bash
node -e '(async()=>{
  await import("@modelcontextprotocol/sdk/server/mcp.js");
  await import("@modelcontextprotocol/sdk/server/stdio.js");
  const g=Object.keys(require.cache).join("|");
  for (const m of ["hono","@hono/node-server","express","body-parser","qs","ip-address","ajv","fast-uri"])
    console.log(m, g.includes("node_modules/"+m)||g.includes("node_modules\\"+m) ? "LOADED" : "not loaded");
})()'
```

At the time of writing that prints `not loaded` for `hono`, `@hono/node-server`,
`express`, `body-parser`, `qs` and `ip-address` — the packages carrying the
reported path-traversal, CORS, SSRF and denial-of-service issues. They are on
disk but never executed.

`ajv` and its `fast-uri` dependency **do** load: they validate tool arguments
against the JSON Schema generated from this server's Zod definitions. The
`fast-uri` advisories concern host confusion and SSRF when parsing untrusted
URIs to make a trust decision. This server neither declares `uri`-format fields
nor resolves remote `$ref`s, so no URI from any caller reaches that code.

Dependabot is enabled and will open pull requests as the SDK picks up patched
versions. If you find a way to actually reach any of these code paths, that is a
genuine finding — please report it using the process above.

## Things worth reporting

- A path or parameter that escapes the configured documentation origin.
- Any way for fetched content to influence the process beyond being returned as text.
- A dependency vulnerability that is reachable from this code.
- Anything causing a credential to be logged, cached to disk, or sent to a third party.

## Handling your own secrets

`.env` is git-ignored; only `.env.example` is committed, and it contains
placeholders. If you ever commit a real token, revoke it immediately — removing
the commit is not sufficient.
