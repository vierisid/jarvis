# Self-Hosting Guide

How to run the Jarvis brain yourself and connect to it securely. This covers
the three common deployment shapes:

1. [Single machine](#1-single-machine) - brain and browser on the same computer
2. [Home LAN](#2-home-lan) - brain on one machine, accessed from others via IP
3. [VPS with a domain](#3-vps-with-a-domain) - brain on a public server behind a reverse proxy

Read [How connections work](#how-connections-work) first if you want the model
in your head; skip straight to your scenario if you just want it running.

## How connections work

Two facts drive every decision below:

**The brain never terminates TLS itself.** The daemon serves plain HTTP on
`daemon.port` (default 3142), or a unix domain socket if `daemon.listen` is
set. If you want HTTPS - and for anything beyond a single machine you do -
you put a reverse proxy (Caddy, nginx, traefik) in front. The daemon honors
`X-Forwarded-Proto`, so cookies and redirects behave correctly behind a
proxy.

**Access is JWT-only by default.** There is no shared password or token. You
enroll devices:

```
jarvis enroll "my-desktop"
```

This mints a long-lived enrollment token (ES256 JWT) and prints it. The
enrollment token is accepted on exactly two endpoints: `/sidecar/connect`
(the sidecar WebSocket) and `POST /sidecar/token`, which exchanges it for a
short-lived access token (10 minutes). Everything else - dashboard, API,
`/ws` - requires an access token. The desktop sidecar app handles this
automatically: paste the enrollment token into it once, and it connects,
re-mints access tokens as needed, and opens dashboard panels that are already
authenticated.

The only public (unauthenticated) routes are `/health`, `/sidecar/connect`,
the JWKS endpoint (`/api/sidecars/.well-known/jwks.json`), and
`/api/webhooks/*`.

Device management runs without the daemon (the CLIs open the database
directly), so you can manage devices over SSH:

```
jarvis enroll "<name>"            # mint (or re-mint) a device token
jarvis enroll "<name>" --rotate   # re-enroll AND invalidate all previous tokens
jarvis sidecars list [--json]     # list enrolled devices
jarvis revoke <sid>               # revoke a device
```

Revoking takes effect within ~30 seconds on a running daemon (it sweeps and
severs live sessions of revoked devices), and immediately for new
connections and token mints.

### The URL baked into enrollment tokens

`jarvis enroll` embeds the brain's address into the token - that is where the
sidecar will connect. It comes from `daemon.public_url` in `config.yaml`
(environment override: `JARVIS_PUBLIC_URL`). The older `daemon.brain_domain`
and `JARVIS_BRAIN_DOMAIN` names remain supported as aliases. If unset, tokens
point at `localhost:<port>` and only work for sidecars on the same machine;
the CLI warns when this happens.

The scheme rules are secure by default:

- A full URL is respected: `https://jarvis.example.com` gives `wss`,
  `http://192.168.1.10:3142` gives plain `ws`.
- A bare host is assumed **secure** (`wss`/`https`) unless it is a loopback
  address (`localhost`, `127.0.0.1`, `[::1]`).

The consequence: a bare LAN IP like `192.168.1.10:3142` produces a `wss://`
URL, and the sidecar will fail its TLS handshake against the plain-HTTP
daemon. Plaintext to anything that is not loopback must be spelled out with
an explicit `http://` prefix. It is never inferred, so a public brain can't
silently downgrade to sending tokens in the clear.

### First-time setup escape hatch

Enrollment normally happens from the CLI (`jarvis enroll`). If you are
setting up without a sidecar and need the dashboard open before any device
exists, `config.yaml` accepts:

```yaml
auth:
  insecure_open_access: true
```

While this is on, **anyone who can reach the daemon can use your Jarvis** -
the daemon logs a loud warning on every boot. Use it on a machine that is
not exposed (or reachable only via localhost/SSH tunnel), enroll your first
device, then remove the flag and restart. It can only be enabled by editing
the file on the server; nothing in the dashboard or API can turn it on.

## 1. Single machine

The simplest case, and the only one that needs no TLS at all.

```
jarvis start
jarvis enroll "my-desktop"    # paste the token into the desktop sidecar app
```

Browsers treat `localhost` as a secure context, so the dashboard at
`http://localhost:3142` gets microphone access (voice, wake word), clipboard,
and every other gated API without a certificate. Enrollment recognizes
loopback and mints plain `ws://localhost:3142` tokens. Everything works.

## 2. Home LAN

Brain on one machine (say `192.168.1.10`), dashboard and sidecars on others.

Set the brain address so tokens point somewhere reachable, with an explicit
`http://` since there is no TLS on the LAN:

```yaml
daemon:
  public_url: "http://192.168.1.10:3142"
```

Then enroll each device and paste the token into its sidecar. Remember:
without the explicit `http://`, a bare `192.168.1.10:3142` is treated as
secure and the sidecar will try `wss://` and fail to connect.

### What works over plain HTTP on a LAN

Auth works: the login cookie is intentionally not marked `Secure` on plain
HTTP, so the token flow functions. Chat, tools, workflows - all fine.
Sending tokens in cleartext across your own LAN is the accepted tradeoff
here; don't do it on a network you don't trust.

What does NOT work from a `http://192.168.x.x` dashboard is anything the
browser gates behind secure contexts. That is browser policy and cannot be
polyfilled:

- **No microphone**: voice input and wake word are unavailable.
- **Clipboard**: copy buttons fall back to select-and-copy manually.

### Getting the full experience on a LAN

Any of these turns the dashboard into a secure context (and lets enrollment
default to `wss`):

- **SSH tunnel / port-forward**: `ssh -L 3142:localhost:3142 user@192.168.1.10`,
  then browse `http://localhost:3142`. Zero config, since localhost is a
  secure context.
- **Tailscale**: install it on the machines and use `tailscale cert` /
  Tailscale Serve for automatic HTTPS between your own devices.
- **Local CA**: run Caddy with its internal CA (or mkcert) on the brain
  machine and trust the certificate on your client devices.

## 3. VPS with a domain

The production shape: a reverse proxy owns ports 80/443 and TLS, the daemon
listens privately behind it. Set `daemon.public_url` (or the
`JARVIS_PUBLIC_URL` environment variable) to the public HTTPS origin and
restart Jarvis — network configuration is deliberately config-file/env only,
never editable from the dashboard.

`~/.jarvis/config.yaml` on the VPS:

```yaml
daemon:
  port: 3142                                    # bound behind the proxy
  public_url: "https://jarvis.example.com"      # OAuth, webhooks, device tokens
```

Caddy makes the proxy a two-liner (automatic Let's Encrypt certificates,
WebSocket support out of the box):

```
jarvis.example.com {
    reverse_proxy 127.0.0.1:3142
}
```

nginx needs the WebSocket upgrade and forwarded-proto headers spelled out:

```nginx
server {
    listen 443 ssl;
    server_name jarvis.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:3142;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

Jarvis uses `public_url` as the authoritative external origin for OAuth
callbacks, sidecar enrollment, CORS, and generated public links. It is never
inferred from request headers: if it is unset, Jarvis assumes
`localhost:<port>` and warns when requests appear to come through a proxy.

For Google OAuth, register this exact Authorized redirect URI in Google Cloud:

```text
https://jarvis.example.com/api/auth/google/callback
```

Settings → Integrations displays the resolved value reported by the daemon, so
you do not need to translate a localhost example manually.

> **Upgrading with `brain_domain` set?** The dashboard Google flow used to
> always call back to `http://localhost:3142/...`; it now calls back to your
> configured origin. Register the new redirect URI shown in Settings →
> Integrations in Google Cloud, and make sure that origin routes to the
> daemon, or re-connecting Google will fail.

Make sure port 3142 is not directly reachable from the internet (bind
firewall rules accordingly, or use the unix socket below and skip TCP
entirely). If you expose it raw, the failure mode is at least the safe one:
tokens enrolled against the `https://` domain use `wss` and will refuse to
connect over plain HTTP - but the dashboard would be reachable in cleartext,
so don't.

Then, over SSH on the VPS:

```
jarvis enroll "my-laptop"
```

Because `public_url` is an `https://` URL, the token carries
`wss://jarvis.example.com/sidecar/connect`. Paste it into the sidecar on
your laptop and everything - dashboard included - flows through TLS. The
dashboard is a secure context, so voice and all other features work.

### Unix socket instead of a TCP port

If the proxy runs on the same host, you can remove the TCP listener
entirely:

```yaml
daemon:
  listen: "unix:/run/jarvis/jarvis.sock"
```

```
jarvis.example.com {
    reverse_proxy unix//run/jarvis/jarvis.sock
}
```

The daemon binds only the socket (created mode 0660, so put the proxy user
in your group), and nothing on the machine can reach it over TCP.

### Headless servers and the browser

A VPS usually has no display. Set:

```yaml
browser:
  local: false
```

and the brain will never try to launch a local Chromium; browser actions
route to a connected sidecar's browser (your desktop) instead.

### Timezone

A VPS typically runs on UTC. Set your IANA timezone so cron triggers and
morning/evening routines fire at your wall-clock time:

```yaml
timezone: "Europe/Rome"
```

## Quick reference

| | Single machine | LAN via IP | VPS + domain |
|---|---|---|---|
| TLS needed | no | no (with tradeoffs) | yes, via reverse proxy |
| `public_url` | not needed | `http://<ip>:3142` (explicit scheme) | `https://your.domain` |
| Voice / mic in dashboard | yes | no (secure-context gated) | yes |
| Tokens on the wire | loopback only | cleartext on your LAN | encrypted |
| Sidecar URL in tokens | `ws://localhost:3142` | `ws://<ip>:3142` | `wss://your.domain` |

## Health checks

`GET /health` is unauthenticated and safe to point uptime monitors at. It
works over the unix socket too, e.g.
`curl --unix-socket /run/jarvis/jarvis.sock http://localhost/health`.
