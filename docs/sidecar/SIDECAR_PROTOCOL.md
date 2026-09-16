# Sidecar Communication Protocol

## Overview

The brain and sidecars communicate over a single WebSocket connection using an asynchronous, event-oriented protocol. There is no request-response coupling at the transport level — the WebSocket is a bidirectional pipe of typed messages.

- **Brain → Sidecar:** RPC requests (brain triggers execution on sidecar)
- **Sidecar → Brain:** Events (notifications of any kind, including RPC results)

All events from all sidecars flow into a central **event scheduler** on the brain for ordered processing.

## Message Format

All messages are JSON with a common envelope:

### Brain → Sidecar: RPC Request

```json
{
  "type": "rpc_request",
  "id": "rpc-uuid-123",
  "method": "run_command",
  "params": {
    "command": "ls -la",
    "cwd": "/home/user"
  }
}
```

| Field        | Type   | Description                                    |
|--------------|--------|------------------------------------------------|
| `type`       | string | Always `"rpc_request"`                         |
| `id`         | string | Unique RPC ID for correlation                  |
| `method`     | string | Capability method to invoke                    |
| `params`     | object | Method-specific parameters                     |

Note: Timeouts (`initial_timeout`, `max_timeout`) are managed brain-side only and are not sent to the sidecar. The sidecar simply executes and reports back — it doesn't need to know the brain's scheduling strategy.

### Sidecar → Brain: Event

```json
{
  "type": "event",
  "event_type": "rpc_result",
  "timestamp": 1709740800000,
  "payload": { ... }
}
```

| Field        | Type   | Description                                         |
|--------------|--------|-----------------------------------------------------|
| `type`       | string | Always `"event"`                                    |
| `event_type` | string | Event classification (see Event Types below)        |
| `timestamp`  | number | Unix ms when the event was created on the sidecar   |
| `payload`    | object | Event-type-specific data                            |

Note: `sidecar_id` is **not** included in the message. The brain derives it from the authenticated WebSocket connection. See [Payload Security](#payload-security).

## Binary Data

Some RPC results contain binary data (screenshots, file contents, etc.). The protocol uses a **hybrid approach** based on size:

### Small binary (<256KB): Inline base64

Encoded directly in the JSON payload. Simple, no extra coordination.

```json
{
  "payload": {
    "rpc_id": "rpc-uuid-123",
    "success": true,
    "result": {
      "type": "inline",
      "mime": "image/png",
      "size": 48000,
      "data": "iVBORw0KGgo..."
    }
  }
}
```

### Large binary (>=256KB): Binary reference

The JSON event contains a reference, followed immediately by a binary WebSocket frame.

**Step 1 — JSON event with reference:**

```json
{
  "payload": {
    "rpc_id": "rpc-uuid-123",
    "success": true,
    "result": {
      "type": "binary_ref",
      "ref_id": "blob-uuid-456",
      "mime": "image/png",
      "size": 2048000
    }
  }
}
```

**Step 2 — Binary WS frame:**

```
[36 bytes: ref_id as UTF-8 UUID][rest: raw binary data]
```

The brain holds the JSON event until the matching binary frame arrives (5s timeout). If the binary frame doesn't arrive, the event is rejected.

### Size threshold

The 256KB threshold balances simplicity (base64 for most use cases) with efficiency (binary frames for screenshots, large file reads). The sidecar decides which format to use based on the data size.

## Payload Security

### Sidecar identity is connection-bound

The `sidecar_id` on every event is **set by the brain based on the authenticated WebSocket connection**, never read from the JSON payload. A sidecar cannot spoof another sidecar's identity.

### Schema validation

Every event is validated against a known schema before entering the scheduler:

- `event_type` must be a recognized type (`rpc_result`, `rpc_progress`, `sidecar_event`)
- Required fields are checked per event type (e.g., `rpc_result` must have `rpc_id`, `success`)
- Field types are verified (strings are strings, numbers are numbers)
- Unknown fields are **stripped** — only whitelisted fields pass through
- Validation failure → event is rejected and logged, not queued

### Size limits

| Limit | Value | Purpose |
|-------|-------|---------|
| Max JSON message | 1MB | Prevents memory exhaustion from oversized payloads |
| Max binary frame | 50MB | Caps screenshot/file transfer size |
| Max payload fields | 100 | Prevents deeply nested or wide objects |
| Max string field length | 1MB | Prevents single-field DoS |

Messages exceeding limits are rejected at the WebSocket receive layer, before parsing.

### Prototype pollution prevention

JSON payloads are parsed with `JSON.parse()` (safe by default in V8/Bun) and validated through the schema layer. Fields like `__proto__`, `constructor`, and `prototype` are explicitly stripped during validation.

### No dynamic execution

Payload data is treated as **pure data** — never evaluated, interpolated into shell commands without sanitization, or used as code. RPC results are strings/numbers/objects returned to the AI as tool output.

### SQL injection prevention

Any event data stored in the vault uses parameterized queries (existing pattern in the codebase). Payload strings are never concatenated into SQL.

## Event Types

### `rpc_result` — RPC completion

Sent when a sidecar finishes executing an RPC request.

```json
{
  "type": "event",
  "event_type": "rpc_result",
  "timestamp": 1709740801000,
  "payload": {
    "rpc_id": "rpc-uuid-123",
    "success": true,
    "result": { "stdout": "file1.txt\nfile2.txt", "exit_code": 0 },
    "duration_ms": 150
  }
}
```

Error case:

```json
{
  "payload": {
    "rpc_id": "rpc-uuid-123",
    "success": false,
    "error": "Command not found: foobar",
    "duration_ms": 12
  }
}
```

### `rpc_progress` — RPC intermediate progress

Sent for long-running RPCs that want to report progress (e.g., streaming command output).

```json
{
  "payload": {
    "rpc_id": "rpc-uuid-123",
    "chunk": "Downloading... 45%"
  }
}
```

### `sidecar_event` — Spontaneous sidecar events

Events not tied to an RPC — the sidecar observed something noteworthy.

```json
{
  "event_type": "sidecar_event",
  "payload": {
    "kind": "clipboard_changed",
    "data": { "text": "copied content" }
  }
}
```

Common `kind` values:
- `clipboard_changed` — clipboard content changed
- `user_interaction` — user interacted with a tracked application
- `window_changed` — active window changed
- `file_changed` — watched file/directory changed
- `error` — sidecar encountered an internal error

## Surface Limits

Two of the structural-surface RPCs do not cover the same ground everywhere.
Neither is a bug, and neither reports an error: in both cases the call succeeds
and simply returns less than the caller expected, which is why the symptom
reads as something else. Callers that depend on the missing part have to
recognise it themselves.

### `get_window_tree`: the `semantic` flag is Windows-only

`semantic: true` asks the desktop provider for durable element addresses, the
`sig` / `path` / `ordinal` triple that `src/structural/` resolves refs against.
Only the Windows handler implements it: `handleGetWindowTree` in
`sidecar/desktop_windows.go` reads `params["semantic"]` and threads it into the
UIA walk. The darwin handler (JXA over System Events) and the linux handler
(AT-SPI2) never read the parameter, so passing it there is a no-op and every
element comes back without refs.

Nothing fails, because from the handler's side nothing went wrong: the tree is
returned, it just has no refs in it. So a ref-less tree is ambiguous, and which
explanation is right depends on the sidecar's OS:

| Sidecar `os` | A tree with no `sig` means |
|---|---|
| `windows` | the build predates semantic refs, or a stale sidecar reconnected |
| `darwin`, `linux` | the surface was never implemented; no build satisfies it |

`bench/control/acceptance.ts` reads the connected sidecar's reported `os`
before it names a cause, so its desktop suite skips off Windows with the
platform reason instead of sending the operator to rebuild something that
cannot change.

Implementing it elsewhere means deriving the same sig inputs from each
provider's own vocabulary (AX roles on macOS, AT-SPI roles on Linux). The sig
format is deliberately provider-independent and the helpers in
`sidecar/semantic.go` are shared, so the work is in the walk, not in the
addressing.

### `browser_ax_snapshot`: no traversal into out-of-process iframes

The sidecar attaches one flat-mode CDP session to a single page target
(`attachToPage` in `sidecar/browser.go`) and tags every page-scoped command
with it. `browser_ax_snapshot` issues one `Accessibility.getFullAXTree` on that
session, which returns the page's tree plus any frame rendered in the same
renderer process. A frame in its own process (an OOPIF, which under Chrome's
default site isolation is every cross-origin frame) is a separate target with
its own session, and its nodes are absent from the reply. No error, just a
smaller tree.

The older `browser_snapshot` has a different blind spot rather than none. Its
injected script walks frames itself (`collectFrames` in
`sidecar/browser_snapshot.go`, capped at depth 3 and 10 frames) and reaches
each one through `iframe.contentDocument`, which the same-origin policy blocks
for a cross-origin frame whether or not it is out of process.

So the two providers are gated on different things, and can disagree in both
directions:

| Frame | `browser_snapshot` | `browser_ax_snapshot` |
|---|---|---|
| same-origin, within the caps | yes | yes |
| same-origin, nested past depth 3 or frame 10 | no | yes |
| cross-origin, same process | no (`contentDocument` throws) | yes |
| cross-origin, out of process | no | no |

With site isolation on, the last row is the common case and both miss the same
content; the middle rows are what makes an element visible to one provider and
absent from the other. Refs do not bridge the gap either: `browser_ax_click`
and `browser_ax_set_value` act on a `backend_node_id`, and those ids are minted
per session.

Closing it needs per-target traversal, not a bigger tree: discover the iframe
targets (`attachToPage` only ever looks for `type == "page"`), attach a session
to each, call `getFullAXTree` per session, and merge -- keeping the session
alongside each `backend_node_id` so actions dispatch on the right one, and
offsetting each frame's coordinates the way the DOM snapshot already does. That
is deferred until the AX provider becomes the default path.

## RPC Lifecycle on the Brain

Every RPC uses a **two-timeout mechanism**: an initial timeout (blocking phase) followed by a max timeout (detached phase). This provides a unified model — the difference between "fast" and "slow" RPCs is just the timeout values.

### Two-Timeout Model

```
Brain sends RPC
  │
  ├── Blocking phase (initial_timeout) ──────────────────────┐
  │   Brain waits synchronously for the result.              │
  │                                                          │
  │   ├─ Result arrives → done, return result immediately    │
  │   ├─ Error arrives  → done, return error immediately     │
  │   └─ initial_timeout expires → transition to detached    │
  │                                                          │
  ├── Detached phase (max_timeout) ──────────────────────────┤
  │   Brain moves on to other work. RPC stays in PENDING.    │
  │                                                          │
  │   ├─ Result event arrives → scheduler delivers it        │
  │   │   → brain processes result, clears max timer         │
  │   │                                                      │
  │   └─ max_timeout expires, no event received              │
  │       → brain invokes timeout callback                   │
  │       → can check status, retry, or abandon              │
  └──────────────────────────────────────────────────────────┘
```

### Timeout Defaults by Tool Nature

The caller (AI or tool definition) sets the two timeouts. Sensible defaults based on expected execution time:

| Scenario             | `initial_timeout` | `max_timeout` | Rationale                                      |
|----------------------|-------------------|---------------|-------------------------------------------------|
| Fast command (curl)  | 10s               | 30s           | Usually completes in blocking phase             |
| Build (gcc, cargo)   | 5s                | 300s          | Catch immediate errors, then detach             |
| Screenshot           | 3s                | 10s           | Quick but depends on sidecar responsiveness     |
| File read/write      | 5s                | 15s           | Typically fast, short max for safety            |
| Browser navigation   | 5s                | 60s           | Pages can be slow to load                       |
| Desktop interaction  | 3s                | 15s           | UI automation is usually fast                   |

Default values when not specified: `initial_timeout = 5s`, `max_timeout = 30s`.

### Why Both Timeouts?

The initial blocking phase catches **immediate failures** (command not found, permission denied, sidecar crashed) without the overhead of detaching and re-routing through the scheduler. This is important because:

- Most errors happen within the first second
- For fast operations, blocking is cheaper than context-switching
- The AI gets synchronous results for simple calls (no async complexity in the tool loop)

The detached phase prevents the brain from stalling on slow operations while still guaranteeing eventual follow-up.

### RPC States

```
PENDING     → brain is in blocking phase, waiting for result
DETACHED    → initial_timeout expired, brain moved on
COMPLETED   → result received (success)
FAILED      → error received from sidecar
TIMED_OUT   → max_timeout expired with no response
CANCELLED   → brain decided to cancel the RPC
```

## Event Scheduler

All events from all sidecars flow into one central scheduler on the brain.

### Design

- **Single inbound queue** — events are enqueued as they arrive from any sidecar
- **Round-robin processing** — events are processed fairly across sidecars (no single sidecar can starve others)
- **Priority-ready interface** — the scheduler accepts a priority with each event, defaulting to `normal`. Priority-based ordering can be implemented later without changing the event producers
- **Non-blocking** — event processing does not block the WebSocket receive loop. Events are enqueued immediately and processed asynchronously

### Processing Flow

```
Sidecar WS message
  → Parse event
  → Enqueue in scheduler (sidecar_id, priority, event)
  → Scheduler picks next event (round-robin across sidecars)
  → Route to handler:
      - rpc_result → resolve pending RPC handle
      - rpc_progress → forward to RPC progress callback
      - sidecar_event → dispatch to registered event listeners
```

### Scheduler Interface

```typescript
interface EventScheduler {
  /** Enqueue an event for processing */
  enqueue(sidecarId: string, event: SidecarEvent, priority?: EventPriority): void;

  /** Register a handler for a specific event type */
  on(eventType: string, handler: (event: SidecarEvent) => void | Promise<void>): void;

  /** Start processing events */
  start(): void;

  /** Stop processing (drain or discard) */
  stop(): Promise<void>;
}
```

### Priority Levels (reserved for future use)

```typescript
type EventPriority = 'critical' | 'high' | 'normal' | 'low';
```

Currently all events are enqueued as `normal` and processed round-robin. When priority is implemented, `critical`/`high` events will be processed before `normal`/`low` within the same round-robin cycle.

## Connection Lifecycle

### Sidecar connects

1. WebSocket handshake with JWT token
2. Brain validates JWT, looks up sidecar in registry
3. Sidecar sends `register` event with capabilities
4. Brain's SidecarManager registers the connection
5. Scheduler starts accepting events from this sidecar

### Sidecar disconnects

1. WebSocket closes (clean or network failure)
2. Brain's SidecarManager removes the connection
3. All pending RPCs for this sidecar transition to `FAILED` with "sidecar disconnected"
4. Scheduler drains remaining queued events from this sidecar (processes them, then removes the sidecar from rotation)

### Heartbeat

- Brain sends `ping` frames every 30 seconds
- Sidecar responds with `pong`
- If 3 consecutive pongs are missed, brain considers the sidecar disconnected
