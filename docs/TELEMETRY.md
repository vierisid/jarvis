# Telemetry & Privacy

JARVIS collects **anonymous** usage metrics so the project can answer two
questions: how many people have run it at least once (the unique user base),
and whether they keep using it over time (retention). That is the whole goal -
there is no per-user analytics, no feature tracking, and no content of any
kind.

This document is the source of truth for what is collected. If the code and
this file ever disagree, treat it as a bug.

## What is sent

Each ping is a small JSON object with exactly these fields:

| Field            | Example            | Why                                  |
| ---------------- | ------------------ | ------------------------------------ |
| `anon_id`        | `9f86d081884c7d65` | Count unique machines + retention    |
| `app_version`    | `0.5.0`            | Adoption of releases                 |
| `install_method` | `docker`           | Which install paths people use       |
| `os`             | `linux/x64`        | Platform/arch support priorities     |

The collector adds a server-side `inserted_at` timestamp on receipt. That is
everything stored.

### The anonymous id

`anon_id` is `sha256("jarvis-telemetry-v1:" + hostname + ":" + username)`,
truncated to 128 bits of hex. It is:

- **Stable** - the same machine produces the same id across restarts,
  reinstalls, and database wipes, so unique-user and retention counts are
  meaningful.
- **Non-reversible** - we only ever transmit the digest. The raw hostname and
  username never leave your machine.

It is anonymous, not secret: hostname+username is low-entropy, so someone who
already knows a specific machine's values could confirm a match. We consider
that acceptable for aggregate metrics, since we never store or send the inputs
and cannot recover them from the hash.

### What is **never** sent

No hostname, username, IP address (we never put one in the payload), config
values, API keys, file paths, prompts, conversations, screen contents, or any
feature-usage data.

## When pings are sent

- Once at daemon startup.
- Then once every 4 hours while the process runs.

The 4-hour heartbeat exists because JARVIS is a long-running server daemon:
without it, a machine that starts once and stays up for weeks would look like a
single brief session. Every send is fire-and-forget with a 5-second timeout; a
failed or blocked request never affects the daemon.

## How to opt out

Any one of these disables telemetry completely:

- **Config flag** - set in `~/.jarvis/config.yaml`:
  ```yaml
  telemetry:
    enabled: false
  ```
- **Env var** - `JARVIS_TELEMETRY=0` (also accepts `false`/`no`/`off`).
- **`DO_NOT_TRACK=1`** - the cross-tool community standard
  (<https://consoledonottrack.com>) is honored.

Precedence: `DO_NOT_TRACK` > `JARVIS_TELEMETRY` > config flag > default (on).

On the first run a one-time notice is printed explaining all of the above; on
later runs a single concise line reminds you telemetry is on and how to turn it
off.

## Verifying it works (for maintainers)

Pings are fire-and-forget and failures are silent by design, so a broken
collector would otherwise look identical to "no users." To make sends
observable, set `JARVIS_TELEMETRY_DEBUG=1`:

```bash
JARVIS_TELEMETRY_DEBUG=1 jarvis start
```

Every ping then logs its outcome, e.g. `ping ok (HTTP 201)` or
`ping failed (http: HTTP 401)`. This is the intended way to confirm telemetry
reaches the collector after changing the endpoint, key, or RLS policy. Leave
it unset in normal operation. It only affects logging - it never changes what
is sent or whether telemetry runs.

## Where data goes

Pings are POSTed directly to a Supabase (PostgREST) table using the project's
**public anon key**, which is scoped by an INSERT-only Row Level Security
policy - clients can write but never read. The endpoint is set in
`src/telemetry/constants.ts`. If the endpoint is unconfigured, the client
simply does nothing.
