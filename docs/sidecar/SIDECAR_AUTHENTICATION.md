# Sidecar Authentication & Enrollment

## Overview

Sidecars are lightweight processes running on user PCs that expose local capabilities (terminal, filesystem, desktop, browser) to the Jarvis brain (the central server). This document describes how sidecars are enrolled and authenticated.

## Architecture

```
Brain (VPS)                              Sidecar (User PC)
┌────────────────────┐                  ┌──────────────────┐
│ ES256 Key Pair     │                  │                  │
│  - private.pem     │    JWT Token     │  Receives token  │
│  - public.pem      │ ───────────────► │  from user       │
│                    │                  │                  │
│ JWKS Endpoint      │ ◄─────────────── │  Fetches public  │
│  /api/sidecars/    │   GET request    │  key from brain  │
│  .well-known/      │                  │                  │
│  jwks.json         │                  │  Verifies JWT    │
│                    │                  │  signature       │
│ WSS Endpoint       │ ◄─────────────── │                  │
│  /sidecar/connect  │   WebSocket      │  Connects with   │
│                    │   + JWT          │  verified token  │
└────────────────────┘                  └──────────────────┘
```

## Key Management

### ES256 Key Pair

The brain uses a single **ES256 (ECDSA P-256)** key pair for signing all sidecar enrollment tokens.

- **Algorithm:** ES256 (ECDSA with P-256 curve and SHA-256)
- **Purpose:** The private key signs JWTs; the public key allows sidecars to verify token authenticity
- **Storage:** `{data_dir}/sidecar-keys/private.pem` and `{data_dir}/sidecar-keys/public.pem`
- **Generation:** Automatically generated on first daemon boot if files don't exist
- **Rotation:** Delete the key files and restart the daemon. All existing sidecar tokens will become invalid and sidecars must re-enroll.

### Why Asymmetric?

Asymmetric signing (ES256) allows sidecars to **verify** that a token was genuinely issued by the brain without possessing the signing secret. This prevents token tampering — a modified token will fail signature verification.

## Enrollment Flow

### Step 1: User Initiates Enrollment (Dashboard)

On the Jarvis dashboard, the user clicks **"Add Sidecar"** and provides:

- **Sidecar name** — a human-readable identifier (e.g., `home-desktop`, `work-laptop`)

### Step 2: Brain Generates JWT

The brain creates a signed JWT containing:

```json
{
  "sub": "sidecar:<sidecar-id>",
  "jti": "<unique-token-id>",
  "sid": "<sidecar-uuid>",
  "name": "home-desktop",
  "brain": "wss://shiny-panda.domain.com/sidecar/connect",
  "jwks": "https://shiny-panda.domain.com/api/sidecars/.well-known/jwks.json",
  "iat": 1709740800
}
```

| Claim  | Description                                              |
|--------|----------------------------------------------------------|
| `sub`  | Subject identifier: `sidecar:<id>`                       |
| `jti`  | Unique token ID (for revocation tracking)                |
| `sid`  | Sidecar UUID (primary identifier)                        |
| `name` | Human-readable sidecar name                              |
| `brain`| WebSocket URL the sidecar should connect to              |
| `jwks` | URL to fetch the brain's public key for token verification |
| `iat`  | Issued-at timestamp                                      |

**Note:** There is no `exp` (expiration) claim. Tokens are long-lived and revoked explicitly via the dashboard.

### Step 3: User Copies Token to Sidecar

The dashboard displays the JWT as a copyable string. The user pastes it into the sidecar process configuration (e.g., `~/.jarvis-sidecar/config.yaml`).

### Step 4: Sidecar Verifies Token

Before connecting, the sidecar:

1. **Decodes** the JWT payload (without verification) to extract the `brain` domain and `jwks` URL
2. **Fetches** the brain's public key from the JWKS endpoint (`GET {jwks}`)
3. **Verifies** the JWT signature using the fetched public key
4. If verification **fails**, the sidecar refuses to connect and reports an error
5. If verification **succeeds**, the sidecar trusts the token contents

This ensures the token was signed by the real brain and hasn't been tampered with. The JWKS fetch is secured by TLS (HTTPS), which guarantees the domain authenticity.

### Step 5: Sidecar Connects via WebSocket

The sidecar opens a WebSocket connection to the `brain` URL from the JWT, passing the token in the `Authorization` header:

```
GET wss://shiny-panda.domain.com/sidecar/connect
Authorization: Bearer <jwt>
```

### Step 6: Brain Validates Connection

The brain:

1. Extracts the JWT from the `Authorization: Bearer` header
2. Verifies the signature using its private key
3. Checks that the `sid` corresponds to a registered (non-revoked) sidecar
4. Accepts the WebSocket connection and associates it with the sidecar record
5. The sidecar sends a **registration message** with its capabilities:

```json
{
  "type": "register",
  "hostname": "DESKTOP-ABC123",
  "os": "windows",
  "platform": "win32",
  "capabilities": ["terminal", "filesystem", "desktop", "browser", "clipboard", "screenshot"]
}
```

## Token Revocation

Tokens can be revoked from the dashboard by deleting the sidecar. The brain maintains a registry of enrolled sidecars in the database. When a sidecar is deleted:

- Its record is removed from the registry
- Any active WebSocket connection is terminated
- The JWT token becomes invalid (the `sid` is no longer recognized), even though the signature still verifies

## JWKS Endpoint

**URL:** `GET /api/sidecars/.well-known/jwks.json`

**Response:**
```json
{
  "keys": [
    {
      "kty": "EC",
      "crv": "P-256",
      "x": "<base64url-encoded>",
      "y": "<base64url-encoded>",
      "alg": "ES256",
      "use": "sig",
      "kid": "<key-id>"
    }
  ]
}
```

This endpoint requires no authentication — public keys are safe to expose.

## Security Considerations

1. **Token transport:** The JWT is displayed once on the dashboard and must be securely transferred to the sidecar machine by the user. Treat it like a password.
2. **TLS required:** Both the JWKS fetch and the WebSocket connection must use HTTPS/WSS in production.
3. **No expiration:** Tokens don't expire. Revocation is handled by removing the sidecar from the brain's registry.
4. **Single key pair:** One ES256 key pair signs all sidecar tokens. Rotation requires re-enrollment of all sidecars.
5. **Authority gates:** Tool execution on sidecars goes through the same authority engine as local tools — the sidecar connection is just a transport layer.

## Database Schema

Enrolled sidecars are tracked in the `sidecars` table:

```sql
CREATE TABLE IF NOT EXISTS sidecars (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_id TEXT NOT NULL UNIQUE,
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  status TEXT NOT NULL DEFAULT 'enrolled',
  hostname TEXT,
  os TEXT,
  platform TEXT,
  capabilities TEXT
);
```

| Column         | Description                                                         |
|----------------|---------------------------------------------------------------------|
| `id`           | Sidecar UUID (matches `sid` in JWT)                                 |
| `name`         | Human-readable name                                                  |
| `token_id`     | JWT `jti` claim (for revocation tracking)                           |
| `enrolled_at`  | Enrollment timestamp                                                 |
| `last_seen_at` | Last WebSocket connection timestamp                                  |
| `status`       | `enrolled` or `revoked`                                             |
| `hostname`     | Machine hostname (populated on first connection)                     |
| `os`           | Operating system (e.g., `windows`, `linux`, `darwin`)                |
| `platform`     | Platform identifier (e.g., `win32`, `linux`)                         |
| `capabilities` | JSON array of capabilities (e.g., `["terminal","desktop","browser"]`) |
