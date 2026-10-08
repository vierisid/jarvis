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
    "result": { "stdout": "file1.txt\nfile2.txt", "exit_code": 0 }
  }
}
```

`payload` is `rpc_id` plus exactly one of `result` / `error`, and nothing else:
`sendResult` (`sidecar/client.go`) writes no `success` and no `duration_ms`. Both
appeared in this example for years and neither is on the wire.

Error case. `error` is an OBJECT, never a bare string: the brain classifies on
the `code` and never by parsing the message (#594's rule), and
`src/sidecar/validator.ts` rejects a frame whose `error` has no string `code`
and `message`.

```json
{
  "payload": {
    "rpc_id": "rpc-uuid-123",
    "error": { "code": "HANDLER_ERROR", "message": "Command not found: foobar" }
  }
}
```

#### The three codes every method can send

Per-method refusals are documented beside their methods (see
`browser_element_point`'s table). These three come from the RPC dispatch itself,
so any `rpc_request` can produce them -- including `pebble.play_pcm`, which the
read loop runs inline to keep audio frames in receive order but still runs
through `runRPCHandler`.

Frames that are not `rpc_request`s are outside this contract, because there is no
pending request to answer. `register_ack` and `register_rejected` are handled
directly on the read loop, and a panic in either is contained under its own
policy (#670), chosen by what the frame decides:

- **`register_rejected` fails closed.** It is an authority verdict (this sidecar
  must not operate), so the verdict is recorded before any handling that can
  fail. A panic in the handling (logging the update command, telling the
  updater) loses the update prompt -- for the rest of the process's life if the
  panic came from the prompt callback, which runs under a `sync.Once` -- but the
  connection still ends and the sidecar still waits out the blocked retry
  interval instead of reconnecting into the same refusal.
- **`register_ack` is contained and the connection carries on.** The brain sends
  it after it has already accepted the registration, so a panic leaves the
  registration known and only the self-update bookkeeping unknown: no update
  offer from that ack, and a pending self-update is not marked proven, until
  the next accepted registration. Reconnecting instead would cost every
  in-flight RPC and, for a deterministic panic, flap forever (the backoff resets
  on every successful dial). A version that panics on every ack still never
  proves a fresh self-update and is rolled back after three starts, as before,
  though that now takes three ordinary restarts rather than a crash loop.

Both cases log the panic with its stack. The goroutines the updater starts from
an ack (`cleanupPrevious`, the registry `check` and its hourly retry) are off the
read loop and recover their own panics (#760). Having no connection to fail into
and no caller to report to, each falls back to a fixed state: a `check` that
panicked before deciding is treated as one that could not reach the registry
(`unavailable` with an error, reported to the brain, retried on the hourly
timer; an offer an earlier check confirmed is kept), a panic in one of the hooks
that announce a decided result (the brain, the tray, the prompt) is contained on
its own so the others still run, and a `cleanupPrevious` that panicked is
not marked done, so the next accepted registration tries again to mark a fresh
self-update proven.

| Code | Meaning | How the brain reads the effect |
|---|---|---|
| `METHOD_NOT_FOUND` | this sidecar has no such method, i.e. it is older than this brain | not started; reported as "sidecar too old" (#605) |
| `HANDLER_ERROR` | the handler returned an error and did not choose a code | **may have occurred** |
| `HANDLER_PANIC` | the handler **crashed** -- see below (#623) | **may have occurred** |

A handler picks its own code by returning a `codedError` (`sidecar/client.go`).
A code the brain lists in `NOT_STARTED_RPC_CODES`
(`src/actions/tools/sidecar-route.ts`) means the request was refused before
anything happened; every other code, listed or not, is classified
`may_have_occurred`. So a NEW code needs no brain change to be reported
honestly -- it needs one only to be reported as *not started*, and that claim
has to be earned.

#### `HANDLER_PANIC`

Handler params arrive over the wire and handlers do a lot of
`params["x"].(string)`-style access. Until #623 the dispatch ran every handler
in a bare goroutine with no `recover()`, so a nil map, an index out of range or
a type assertion on a field the brain sent in an unexpected shape took the whole
sidecar process down -- the read loop cannot recover another goroutine's panic.
The brain saw the connection drop, not a refusal it could map. The dispatch now
recovers and answers the pending request with this code.

Two properties of that reply are deliberate:

- **It is NOT a not-started code.** A recovered panic cannot establish that
  nothing happened: the handler may have clicked, typed or written a file and
  then panicked on the next line. The message tells the model to verify the
  current state rather than to assume a refusal.
- **The panic value is not in the message.** It is logged with its stack on the
  sidecar. Panic text quotes the offending value back (a type-assertion panic
  names the dynamic type, `strconv` panics quote the input), and the brain
  interpolates this message into text a model and a user read -- the same reason
  `refuseLocalContent`'s URL stays out of the brain's log lines.

A `HANDLER_PANIC` is a sidecar bug, not a user error. It is its own code rather
than `HANDLER_ERROR` so that it is distinguishable from an error a handler chose
to return.

One case stays unanswered rather than coded: a panic in the REPLY path itself,
which is what the recover would otherwise use to answer. That is contained and
logged too, and the request then falls to the brain's RPC timeout
(`SIDECAR_TIMEOUT`), which already reports `may_have_occurred` -- the same
conclusion, reached the slow way, and still better than losing the connection
and every other request in flight on it.

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

A third one used to be listed here -- `browser_snapshot` replying with text and
nothing structural, so the brain could not tell which page it was on and
resolved no site playbook for a remote browser. That is closed (#583); the
contract that replaced it is under [Browser Reads](#browser-reads-the-confirmed-page-identity).

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

### `browser_ax_snapshot`: `loader_id` is the surface's identity, `url` and `title` are not

The reply carries three identity-ish fields and they are not interchangeable:

| Field | Who chooses it | What it is for |
|---|---|---|
| `url` | the PAGE (`location.href`) | display; never eligible to select a site playbook (#572, #583) |
| `title` | the PAGE (`document.title`) | display |
| `loader_id` | the BROWSER (frame tree, via `assertSamePage`) | deciding whether this is the same surface as before (#640) |

A consumer asking "is this still the surface I read a moment ago" compares
`loader_id` and nothing else. `history.pushState` rewrites the URL and the title
while the document holds, which is how every single-page app navigates, so a URL
term in that comparison refuses ordinary clicks on Gmail or Linear -- the rule
#603 settled for `confirmSameDocument` and `refuseStaleAXElement`, and the reason
`loader_id` was added here. Both page-authored fields are still bounded by
`axIdentityField` rather than plainly truncated, because a daemon may compare
them where no `loader_id` is available and two cut values compare equal as soon
as their prefixes agree.

A sidecar older than #640 sends no `loader_id`. The daemon's rule for that is to
fall back to the url+title comparison, never to treat two absent identities as
equal -- so the field widens the wire with no version gate, and its absence
degrades to the previous, stricter, SPA-refusing behaviour.

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

## Browser Reads: the confirmed page identity

`browser_navigate` and `browser_snapshot` can return the page's identity beside
the formatted text, so the brain knows WHICH page the text came from. It needs
that for one thing: choosing the site playbook (a webapp template) it hands the
model. Nothing else reads it.

### Why it cannot be read off anything else

The brain used to recover the URL by matching a `URL:` line in the reply text. It
does not any more (#572): the rendering is a page, its first line is the page's
own `document.title`, and a page that printed its own `URL:` line was choosing
which playbook the model got handed.

The URL the caller REQUESTED was considered and rejected (#579). It is
pre-redirect, open redirects are ordinary on exactly the hosts templates are
written for, and a playbook states "You are now on <host>" *outside* the
untrusted block -- so a redirect would put that sentence over a page that is not
that host. Naming the wrong site with authority is worse than naming none.

So only a URL the browser confirms may select a playbook, and the sidecar takes
it from the frame tree it already checked (`assertNotLocalContent` ->
`pageIdentity`, `browser_read_guard.go`), never from `location.href`.

### Request: `page_identity`

```json
{ "method": "browser_snapshot", "params": { "page_identity": true } }
```

Strict boolean, read the way `headless` is: `params["page_identity"].(bool)`, so
a string or a number does not enable it. A brain that does not send it gets the
bare string reply it always got, which is what makes the change additive in both
directions rather than a flag day.

The brain sets the flag itself, in trusted code
(`routeBrowserReadToSidecar`). It is never taken from a tool's own parameters:
nothing a model writes may decide the shape of a reply the brain reads
structurally.

### Reply

Without the flag, `result` is the formatted snapshot string, byte for byte as
before. With it, `result` is an object:

```json
{
  "text": "Page: Inbox\nURL: https://mail.example.com/\n\n--- Page Text ---\n...",
  "page_url": "https://mail.example.com/",
  "loader_id": "3F2A1C9E..."
}
```

| Field | Meaning |
|---|---|
| `text` | the formatted snapshot, identical to the string reply |
| `page_url` | the main frame's URL as the BROWSER reported it, for the document the text came from |
| `loader_id` | that document's loaderId, which changes on every commit |
| `elem_gen` | the generation of the element-id map THIS read filled (#676); an opaque string, compared for equality only |

### `elem_gen`: binding a reviewed element action to its snapshot (#676)

`elem_gen` is `<epoch>.<counter>`: the counter is bumped on every fill and every
drop of the element map, and the epoch is random per browser client, so a
relaunched browser or a restarted sidecar never hands out a generation an older
map already used. It travels independently of the `page_url`/`loader_id` pair:
it names the id map, not the document.

The brain records the newest one per sidecar, copies it onto an approval when a
`browser_click`, `browser_type` or `browser_hover` card is raised, and sends it
back as the action's `elem_gen` param when the approved call runs. The sidecar
compares it in `refuseStaleElement`, under `elemMu`, before anything else, and
refuses a mismatch -- or a present-but-malformed value -- with RPC error code
`BROWSER_SNAPSHOT_SUPERSEDED`, before any CDP command. An absent `elem_gen`
means the call was not reviewed and is not compared.

The generation names the isolated world's element refs as well as the
coordinate map, because the sidecar runs one snapshot at a time per browser,
from its first frame-tree read through the fill, and a reviewed `browser_type`
excludes snapshots from its generation check through its last use of a ref
(#826). Without that, two concurrent snapshots could arm the world's refs in
one order and fill the map in the other, and a snapshot could re-arm the refs
between a type's check and its focus. A snapshot or type that cannot get its
turn within ten seconds refuses rather than queueing.

A sidecar older than this ignores the param, so the brain sends a reviewed
element action only to a sidecar advertising `browser_elem_gen`, and refuses it
otherwise with a message saying the sidecar must be updated.

**`page_url` and `loader_id` travel as a pair, or not at all.** The sidecar omits
both unless `assertSamePage` confirmed the same document after the read, and the
brain refuses a `page_url` that arrives without a `loader_id`, requiring both to
be strings.

An **empty `loaderId` is no longer an omission, it is a refusal.** It used to
mean "the frame tree did not name the document, so send the bare string", which
left it to each caller to remember -- and two of them (screenshot, evaluate)
never did. Emptiness is now a property of `assertSamePage` itself: no usable
document identity means no read, for every caller, rather than a read whose
identity is quietly missing. This costs no legitimate read, because a freshly
launched tab reports a non-empty `loaderId` once it has committed (measured, and
`about:blank` included).
That pair is what carries the guarantee across the wire: the brain cannot redo
the same-document check itself -- that would be another round-trip, at a
different instant, to the machine making the claim -- so it refuses what it
cannot vouch for instead of trusting half an answer.

### Two bounds, and which side owns what

The sidecar drops the identity when `page_url` exceeds 4096 bytes or `loader_id`
exceeds 64. Those are **wire-size guards, not URL policy**: a `data:` document's
frame-tree URL can be megabytes, and one reply past the brain's 2 MB
`MAX_JSON_SIZE` is dropped whole, which would lose the page text as well. An
over-long value is omitted rather than truncated, because a truncated identity is
a different page.

**URL policy belongs to the brain**, in `usablePageUrl`
(`src/actions/tools/webapp-template-injection.ts`): at most 2048 bytes, no
control or line/bidi separator characters, and `http`/`https` only. Deliberately
NOT the same number as the sidecar's, so the two are not read as a pair to keep
in step. The sidecar passes `data:`, `about:blank` and `chrome-error://` through
verbatim and lets the brain refuse them; a second validator in another language
would drift, and it would drift silently.

So: **structural is not trusted.** `page_url` cannot claim another origin,
because it comes from the browser rather than the page -- but it can still be
hostile, and a sidecar asserting one is a sidecar the brain now trusts for
playbook selection, bounded by `usablePageUrl` and by the fact that the URL
itself never reaches the model (only the template's `appName` and instructions
do). Enrollment is the control there.

### What a version pairing does

| Brain | Sidecar | Result |
|---|---|---|
| new | new | identity travels; the playbook is resolved from the confirmed URL |
| new | old | the flag is an unknown param and is ignored; the reply is the bare string, so `pageUrl` is null, no playbook is resolved, and the brain logs one line saying so |
| old | new | the old brain never sends the flag, so it keeps receiving the bare string; nothing JSON-stringifies a snapshot into a model's context |
| new | new, over-long field | the identity is omitted; same as "new + old" |
| new | new, nameless document (empty `loaderId`) | the READ is refused; there is no reply to omit the identity from |

The failure direction is always the same one: no playbook, never a wrong one.

And it is no longer silent. A read that reached a page and still got no playbook
logs one line naming the tool, the target and which of the two reasons applies:
no confirmed URL arrived at all (so the sidecar is older than this surface), or
one arrived and the brain's own policy would not resolve it (a `data:` or
`about:blank` document, over the cap, or carrying a control character). The URL
itself is never logged -- in the refused case it is precisely the value carrying
the characters that must not reach a log line. A call that never reached a page
logs nothing here, because the dispatch already said why, and neither does a
perfectly ordinary page that simply has no template.

## Snapshot element references, and what an action may act on

`browser_snapshot` mints 1-based element ids and keeps, per id, a viewport
coordinate and a live DOM reference. Three rules govern them, and all three
changed in #592.

### The references live in an isolated world

The refs used to be stashed on the page's own `window.__jarvis_elements`, which
is a **page-writable main-world global**. A page that overwrote it had approved
text typed into an element of its own choosing, while the snapshot, the approval
card and the narration all still named the reviewed one -- reaching around
#495's snapshot binding from inside the page.

They now live in a per-document **isolated world** (`Page.createIsolatedWorld`,
`worldName: "jarvis-elements"`), which has its own global object, so the array
has no name the page can reach. The world is keyed on the document's `loaderId`,
because `createIsolatedWorld` mints a fresh V8 context on every call however the
name is reused and nothing disposes them.

If no world can be created, **the snapshot refuses**. It does not fall back to a
main-world evaluate: that would put the vulnerability back within reach of any
page that can make the call fail. A dead context is likewise a refusal and never
a re-mint-and-retry, which would silently re-target whatever document is there
now.

A world also has its own DOM prototypes, so a page that patches
`Element.prototype.getAttribute` can no longer change how the snapshot
*describes* it either. That was not asked for; it falls out.

### Focus is verified, not assumed

An isolated world is **not sufficient on its own**, and this is the part worth
reading before changing any of it. Worlds share the DOM *and its events*, so a
page's own `focus` listener still fires when the sidecar calls `el.focus()` and
can move focus anywhere it likes.

Worse, Chromium **defers** that event while the document itself is unfocused --
the normal state for an automated browser -- so the listener fires late, after
the focus has been checked and during the `Input.insertText` that finally gives
the document focus. Measured: with only an immediate check, a page that stole
focus in its listener received the approved text and the type reported success.

So `browser_type` uses three layers:

1. `Emulation.setFocusEmulationEnabled` when the browser connection is established, so the page behaves as
   though focused and a steal becomes visible at once. Best-effort.
2. In the focus script, in the isolated world: `isConnected`, a refusal for a
   frame (`iframe`/`frame`/`object`/`embed`), then `el.focus()`, then
   **exact** `activeElement` equality in the element's **own** document (for
   anything inside an iframe the top document's `activeElement` is the iframe),
   and a refusal when a shadow root has taken focus. Checked **before** the
   value is cleared, so a refused focus cannot empty the reviewed field either.
3. A re-verify immediately **before** `Input.insertText` and again **after**
   it, which narrows the remaining window to one local round trip. A slip is
   reported as a refusal -- nothing can un-type the text, so the one thing that
   must not happen is reporting success.

Statuses: `not_found`, `gone` (detached), `not_typable` (a frame),
`not_focused` -- all refusals.

**Three of those rules were added because the obvious predicate was wrong**, and
each was measured against a real browser:

- `el.contains(active)` -- "focusing a contenteditable can land on a child" --
  is false. `activeElement` is the focusable *element*, not the caret's node,
  and it equals the element for a plain input, a select, an anchor, a
  contenteditable, and a contenteditable with element children. The allowance
  bought nothing and was an attack: a page that appends its own input inside the
  reviewed element and focuses it from that element's focus listener received
  the approved text while the type reported success.
- A **shadow root** defeats exact equality on its own, because `activeElement`
  is the host when focus is inside its shadow tree.
- A **frame** can enter the snapshot on `[data-testid]`, a role or a tabindex,
  and focusing it sends the text into a document the snapshot never described --
  in the measured case, one on an opaque origin the top page cannot read.

Layer 3 is the weakest of the three and should not be read as a proof: it
samples two instants, so a steal-and-restore only has to be absent at those
samples. Layers 1 and 2 are what refuse a page-chosen destination with no race
at all.

**Scope.** All of the above is about `browser_type`. `browser_ax_set_value` is a
second typing path with its own id space, reached only by `ui_act`. As of #602
it is no longer the exception it was: it resolves its node into an **isolated
world** rather than the page's main world, so a page-replaceable value setter no
longer sees it, and it carries a document guard of its own.

Its focus check cannot copy the DOM path's, and the reason is worth recording:
`document.activeElement` **retargets** to the shadow host, so
`ownerDocument.activeElement === this` is always false for a field inside a
shadow root even when focus landed correctly -- an early version of this guard
refused every shadow-DOM form field. The check asks `getRootNode()` instead and
falls back to the owner document for an ordinary node.

The #592 *reference* defect never existed on this path (`backendNodeId` is
browser-side and fails closed after a navigation), but the #603 *identity*
defect did, and the AX ids have their own answer to it: a `backendNodeId` is
renderer-local and restarts at 1 after a cross-site navigation, so ids from two
documents collide and a stale one resolves cleanly to a different element
(measured). A document check alone could never have made an AX id mean what it
meant.

**The coordinate-click fallback is gone.** Ask when `not_found` was reachable
before: overwhelmingly when a navigation had replaced the document and wiped the
page global, so the fallback then clicked and typed inside a document nobody had
reviewed. That was the sibling bug below, not a recovery from it.

### An action refuses once the document has changed

`elementCoords` was never invalidated on a **page-initiated** navigation: it was
dropped on the next snapshot, on disconnect and on a stale-CDP reconnect, and
nowhere else. So a click after a meta refresh dispatched a trusted mouse event
at the previous document's geometry, while `captureApprovalGuard` -- which binds
the connection and the approval epoch, not the document -- still held. The read
paths have checked their document since #526/#579; the action paths did not.

`browser_click`, `browser_type` and `browser_hover` now all read the frame tree
first and refuse unless the document matches, and `browser_upload_file` already
gated on a `loaderId` and an origin of its own -- it is the model the other
three follow.

`browser_scroll` and `browser_press_key` take no element id, but they are **not**
unchanged: both gained a guard, and both now **retire** the element ids, because
moving the viewport is exactly what makes a coordinate minted against the old
scroll position wrong. A key is classified by whether it scrolls the page
(`scrollsThePage`), and when it does the reply says so in the same sentence every
id-dropping tool uses. The direction of the error is deliberate: a key that might
not have scrolled still retires the ids, which costs a snapshot rather than a
click at the wrong place.

**The comparison is the `loaderId` alone, deliberately without the URL.**
`history.pushState` rewrites `frameTree.frame.url` while the loaderId holds
(measured), and that is how every SPA navigates -- so comparing the URL would
refuse an ordinary click on Gmail, Linear, and the cell-to-cell moves
`webapp-templates/gsheets.yaml` explicitly tells the model to reuse an id
across. A fragment change does not even reach it: CDP reports the fragment
separately as `urlFragment`. `assertSamePage` keeps its URL term, because it
guards a *read* that hands a URL back; `confirmSameDocument` is the use-time
sibling without it.

An element the snapshot took from a same-origin **subframe** carries one more
check, because a child document can commit while the main frame's loaderId never
moves (measured): the snapshot records a digest of every frame's loaderId, and
in-frame ids are refused when it changes. Scoped to in-frame ids so an unrelated
advertising iframe reloading does not refuse a click on a main-document element.

### What did not change

The ids are still 1-based, minted in the same document order, and the daemon and
the sidecar still run the same script and the same checks; the two are required
to stay identical.

The **rendered text is no longer byte-identical to what shipped before #597**,
and the three differences are all cases where the two sides had silently
drifted apart rather than agreed:

- **Both sides count code points** for all four cuts. Go sliced page text by
  bytes and the daemon by UTF-16 units, so a CJK page showed ~666 characters
  remotely against 2000 locally, and either side could cut a character in half.
- **Element text is escaped the same way.** A button labelled `Say "hello"`
  rendered escaped remotely and raw locally, and Go's `%q` also escaped the
  private-use glyphs an icon font uses (Material Icons ligatures are ordinary
  button text) where `JSON.stringify` emits them raw.
- **Control characters are stripped** from every single-line page-controlled
  value, because a page could put a `\n` in its own `document.title` or an
  `aria-label` and forge a `URL:` line or an extra `[2] BUTTON: ...` line inside
  the rendered snapshot.

Caps themselves change nothing under the cap. What keeps the two sides honest is
no longer two independent `toContain` suites -- those are what let the drift
above happen -- but a golden fixture in `sidecar/testdata/`, rendered by Go and
byte-compared by a Bun test.

## `browser_element_point`: where a snapshot element is on the screen

A **read-only** answer to one question: for an element id the last snapshot
minted, where would a click at that id land on the sidecar's screen? It exists
so the pebble can point at the element a browser action is about to take (#591).

### Why an RPC and not a calculation

`browser_click` resolves an element id against a coordinate map that lives in
the sidecar, filled by the snapshot. On a **default install every browser action
goes there**: `CapBrowser` is in the default capability set (`sidecar/config.go`)
and the pebble only exists for a connected sidecar. #585 made the narration read
the click's own input and fail closed -- `(location unknown)`, the pebble does
not move -- when no honest coordinate exists, so with no RPC carrying the
coordinate back the pointer went quiet on most installs and PR #590 was held in
draft. A local-cache hit instead would be a confident pointer into an unrelated
page, which is the bug #585 removed.

### Request

```json
{ "method": "browser_element_point", "params": { "element_id": 5 } }
```

`element_id` and nothing else. A whole number from 1, read strictly
(`params["element_id"].(float64)` then an integral check), so a coerced `"5"` or
a `5.5` is refused rather than rounded into something the click would not accept.

There is **no `target`, no `headless` and no `expression`**. `headless` is
ignored rather than accepted-and-unused, and that is deliberate: `getCDP` tears
a running browser down and relaunches it when an explicit `headless` disagrees
with it, so honouring the flag would let a read-only call kill a browser
mid-session.

### Reply

```json
{ "x": 437, "y": 484, "space": "screen_dip", "loader_id": "3F2A1C9E..." }
```

| Field | Meaning |
|---|---|
| `x`, `y` | the point to hand `pebble.point_at`, absolute on the sidecar's screen |
| `space` | the coordinate space of `x`/`y`. Only `screen_dip` exists; the brain refuses any other value rather than assuming |
| `loader_id` | the loaderId of the document the coordinate belongs to, re-read and re-confirmed by this call |

**All four fields or an RPC error.** #594's rule is that a `page_url` never
travels without a `loader_id`, because the loader id is what makes the URL name
*this* document. Transposed here: **a coordinate never travels without the
loader id of the document it belongs to.** There is no reply shape carrying a
coordinate whose document is unnamed, so the brain has nothing to half-trust.
`loader_id` is bounded by the same 64 bytes #594 uses, and an over-long one is a
refusal rather than a truncation -- a truncated identity is a different
document, and #594's own reason for the bound was that one oversized field
exceeds the brain's 2 MB event cap and drops the whole event, so the RPC never
resolves at all.

**There is deliberately no `page_url`.** Nothing on this path reads a URL: the
pebble needs two numbers, the guard needs a document token, and the brain's log
line must not print a URL anyway. `browser_ax.go` already warns that once
several object-shaped browser replies carry a URL-ish field, a brain-side
decoder keying on "a url in an object reply" hands a page its own choice of site
playbook again (#572). A coords reply cannot select a playbook, because it
carries nothing a playbook could be selected from.

### Refusals, and why they are coded

Every refusal is an RPC **error** with a code, never a partial reply -- a
coordinate field that can be absent is a coordinate field somebody reads as 0.

| Code | Meaning |
|---|---|
| `BROWSER_BAD_ELEMENT_ID` | absent, or not a whole number from 1 |
| `BROWSER_NOT_RUNNING` | no browser is running. **Nothing is launched** |
| `BROWSER_ELEMENT_NOT_IN_SNAPSHOT` | no snapshot has run, or that id is not in the current map |
| `BROWSER_SNAPSHOT_STALE` | the document committed, a subframe the element came from navigated, a new snapshot replaced the map, the frame tree names no document (or names it with an over-long loader id), or the page is showing local content (#526) |
| `BROWSER_GEOMETRY_UNAVAILABLE` | **the browser is running headless or its window is minimized**, the element is **outside the visible viewport**, or the window bounds / viewport metrics were not usable |

Three of those deserve spelling out, because each is a case where a
well-formed-looking number would otherwise have been returned:

- **A headless browser has no position on anyone's screen**, and only the
  sidecar knows it is headless. `--headless=new` still reports ordinary window
  bounds: `--window-position=137,91` comes back as `left: 137, top: 91` with
  `windowState: "normal"` (measured). Without the refusal the pebble would fly
  to that spot on the user's *real* desktop and sit over whatever application
  occupies it, with a confident label and no `(location unknown)`. `headless` is
  a model-settable parameter whose own tool description recommends it for
  staying out of the user's way, so the considerate path was the misplacing one.
- **A minimized window** reports the bounds it would be *restored* to.
- **An element outside the viewport** has no screen position. The snapshot
  filters on `display`, `visibility`, `opacity` and a 5x5 minimum size, but
  *not* on viewport containment, and the coordinates are
  `getBoundingClientRect` centres -- so a button 2500 CSS px below the fold sits
  in the map with `y = 2500` and would have produced a point far below the
  window. The bound is free: `cssLayoutViewport` carries `clientWidth` beside
  `clientHeight`.

The codes exist so the brain can classify **without reading the message**
(#594's rule: classification never parses display text). There is a sharper
reason too: some of these refusals come from `refuseLocalContent`, whose message
embeds the page URL. The brain writes a log line about a skipped coordinate, and
#594 refused to put a URL in one -- a refused URL is precisely the value that
may carry the characters that must not reach a log. So the brain maps codes to
its own strings and never interpolates the sidecar's message.

### Read authority, and how it is enforced

There is one `browser` capability for all 14 browser methods, so "read-only"
cannot be expressed in the capability map. It is enforced in the handler:

- **The handler takes no `SidecarConfig`.** Every other browser handler is given
  one because it may need to find and launch a browser; this one is registered
  as a bare function, so the launch path is not reachable from it. It uses a
  no-launch accessor (`existingCDP`) and refuses when no browser is up.
- **It cannot kill the browser either.** `shutdown()` is reachable only from
  `getCDP`'s headless flip, `browser_close`, `launchCDP`'s own failure paths,
  and `c.fail()`, which `readLoop` calls on a pipe error and `sendOn` never
  does. Even a read that times out cannot take the browser down from here.
- **It sends four commands, three distinct CDP methods, all getters:**
  `Page.getFrameTree` (twice, as the check and the re-check),
  `Browser.getWindowForTarget` and `Page.getLayoutMetrics`. Four on every path
  that answers, including an element taken from a subframe -- the frame digest
  rides along on the re-check's reading rather than costing a read of its own. A
  refusal sends the same number or fewer, **never more**: it stops where it
  refuses, and a read with too little budget left is refused before it is issued
  -- while the last two staleness checks sit after the fourth send, so they
  refuse having sent all four. No `Runtime.*`,
  so no script; no `Input.*`, no `DOM.focus`, no `Page.bringToFront`, no
  `Target.activateTarget`; no `Page.navigate`; no `Browser.setWindowBounds`, no
  `Emulation.*`. That list is prose, so
  `TestBrowserElementPointSendsOnlyReads` asserts the sent sequence **exactly**,
  for the main-document and in-frame paths both -- a later edit that adds a
  fifth command fails a test rather than a review.
- **The whole handler carries one budget**, 900 ms, shared by all four reads --
  not `cdpDefaultTimeout`'s 30 seconds, and not a fresh budget per read. `Page.*`
  is answered by the renderer, so a long task or a modal `alert()` blocks it;
  the narration upstream is abandoned after 1200 ms anyway, so a read that sits
  for 30 seconds produces the same user-visible outcome while holding a
  goroutine and a pending-reply slot for the other 29. Each read is handed what
  is left of the budget, capped at a 700 ms per-read ceiling, and a read with
  less than 20 ms left is **refused rather than issued** -- so the sidecar never
  spends longer on the question than the caller is willing to wait for the whole
  of it, and never spends a round trip on a reply nobody is waiting for.
  Whether the answer is *heard* is a weaker claim and is deliberately not made
  here: the brain's 1200 ms also pays for its own resolution work and two
  websocket legs, and transport is not the sidecar's to bound. One further
  qualification on "the handler's own work": `sendOnTimeout` writes to the
  browser's pipe *before* arming its timer, so a browser process that stops
  draining that pipe can stall a read outside its own timeout. This was a
  per-**read** bound until #610, which did not hold: four reads at 700 ms each is
  a 2800 ms worst case against a 1200 ms race.
- `Browser.getWindowForTarget` is a **browser-level** command, and it is scoped
  to the attached page only because `send` tags it with the flat-mode session
  id. An edit that sent it on `sendOn("")` with a caller-supplied `targetId`
  would be reading another target's window.

### Current generation only

The snapshot records, beside the coordinate map, the document it was taken under
and a generation counter. The handler refuses unless the map's document is the
document the browser is showing now, re-checks the generation after reading the
geometry, and re-reads the frame tree at the end.

The generation is not redundant with the document check: a snapshot of the
**same** document re-mints every coordinate and leaves the loaderId untouched,
so without it the answer could be a previous snapshot's number for an id the
click now resolves elsewhere.

What it does **not** cover: the window between the reply and the click. One
assistant message emitting `browser_snapshot` and then `browser_click` re-mints
every id in between, so the guarantee is "the generation live when the RPC was
answered", not "the generation the click will use". The brain's own local
narration path has the identical property.

An element the snapshot took from a same-origin **subframe** carries one more
check. A child document can commit a new document on its own while the main
frame's loaderId never moves, which leaves an in-frame coordinate pointing into
a document that no longer exists, so the snapshot also records a digest of every
frame's loaderId and in-frame ids are refused when it changes. Scoped to
in-frame ids on purpose: an unrelated advertising iframe reloading must not cost
a pointer for a main-document element.

### The coordinate space

**`screen_dip`: Chromium device-independent pixels, absolute on the sidecar's
screen, top-left origin.** Measured against a real Chromium at
`--force-device-scale-factor` 1, 1.5 and 2: `Browser.getWindowForTarget`'s
bounds are DIP, invariant under the scale factor, and identical to the page's
own `window.screenX`/`screenY`. That is why the geometry comes from the Browser
and Page domains and the page is never asked -- a page can install a `screenX`
getter, but it cannot install a frame tree.

`pebble.point_at` has one unit contract and it is not written as a unit:
`pebbleCore.PointAt` stores x/y and `advanceFrame` eases toward them in whatever
space `platformGetCursorPos()` returns. So:

| Platform | the pebble's space | equals `screen_dip`? |
|---|---|---|
| macOS | Cocoa points, already flipped to a top-left origin in `panels_darwin.go` | **yes** -- points are the 1x logical space |
| Linux | GDK logical px, top-left (`panels_linux.go`) | **yes**, when Chromium's device scale factor matches GDK's, which is the ordinary case |
| Windows | `GetCursorPos` under a PerMonitorV2 manifest, i.e. physical virtual-screen px | at 100% DPI **yes**; above it, off by the monitor's scale factor |

A per-platform conversion is deliberately **not** done in the sidecar. #585
removed a `devicePixelRatio` multiply that was wrong on two of three platforms;
there is no scale-factor helper in this tree to reuse (the only backing-scale
read is a C file-static in `region_select_darwin.go`, and
`platformGetScreenSize` is a hardcoded stub on darwin and linux); and the
brain's own local path has the identical Windows behaviour today, so this adds
no new error anywhere. The `space` field is the hook for closing it later: a
measured conversion ships a new space name, and a brain that does not recognise
a space refuses rather than misplacing the pointer.

**Known inexactness, y only.** `cssLayoutViewport.clientHeight` excludes
scrollbars while the window height includes them, so on a page with a horizontal
scrollbar the chrome height comes out one scrollbar too large and the point
lands that far low -- measured 15 CSS px. No scrollbar-inclusive height exists
anywhere in `getLayoutMetrics`, so recovering the term would need page script,
which read authority forbids and 15 px does not justify; the pebble's own disc
is 72x64, so it still covers the element. There is no viewport-width term, so x
is unaffected.

`cssVisualViewport` is **not** used for the viewport height, and that is
load-bearing: it shrinks under pinch zoom (measured: 437 to 218.5 at scale 2)
and would have thrown the pointer on every pinch-zoomed page. The layout
viewport is unchanged there. The page-zoom factor is
`cssVisualViewport.zoom`, the CSS-px-to-DIP ratio, measured *not* to be the
pinch factor; it is dimensionally required rather than guessed, since without it
a CSS-px offset is added to a DIP origin. A zoom outside `[0.1, 10]` is refused
rather than clamped, because it multiplies every term and a silently corrected
coordinate is a confident wrong pointer.

Still unverified, and needing a real desktop: the three rows of the platform
table, browser page zoom other than 1 (`--headless=new` ignores a profile's
persisted zoom level), and the assumption that all window chrome is vertical --
a Windows resizable border or a GTK client-side-decoration shadow would put
`bounds.left` left of the client area.

### What a version pairing does

The method name is the feature probe; there is no flag and no version gate.
Nothing in the brain compares a sidecar version to decide whether to call
something, and a new method has no reply field to duck-type on.

| Brain | Sidecar | Result |
|---|---|---|
| new | new, warm browser, id in the current map | a point arrives, the space is checked, the pebble flies |
| new | new, no browser running | `BROWSER_NOT_RUNNING`; no pointer, one log line, **and nothing launched** |
| new | new, stale document / stale frame / unknown id | a coded refusal; no pointer, one log line |
| new | new, **browser running headless**, or its window minimized | `BROWSER_GEOMETRY_UNAVAILABLE`; no pointer. Only the sidecar can tell |
| new | new, element outside the visible viewport | `BROWSER_GEOMETRY_UNAVAILABLE`; no pointer |
| new | new, busy page (a long task or a modal `alert()` blocks the renderer) | the handler's whole budget is 900 ms, so it gives up inside the narration's own 1200 ms; the refusal carries the code of the read it ran out of budget for (`BROWSER_GEOMETRY_UNAVAILABLE` or `BROWSER_SNAPSHOT_STALE`); no pointer |
| new | **old** (no such method) | `METHOD_NOT_FOUND`; the brain reads the **code**, reports "sidecar too old", and keeps #585's fail-closed path. Nothing falls back to `browser_evaluate`, to the brain's local coordinate cache, or to a fresh DOM query |
| new | new, but a future `space` value | refused. An unrecognised space is never trusted |
| old | new | never calls the method; nothing changes for it |
| new | new, but the pebble is not on the sidecar that serves the browser | the brain does not call at all -- the coordinate is a position on the browser sidecar's screen and the pebble is drawn on another |

The failure direction is always the same: **no pointer rather than a pointer at
the wrong element.** Every case above refuses instead of answering.

### Constants that must stay in step

This contract is the only thing holding these pairs of constants together, and
nothing fails on either side if they drift:

| meaning | sidecar | brain |
|---|---|---|
| the space name | `elementPointSpace` (`sidecar/browser_element_point.go`) | `ELEMENT_POINT_SPACE` (`src/actions/tools/sidecar-route.ts`) |
| the coordinate sanity bound | `maxElementPointCoord` (same file) | `MAX_ELEMENT_POINT_COORD` (same file) |
| the latency the answer must fit in | `elementPointBudget`, which must stay **under** `pebbleNarrationRace` (same file) | an inline `1200` in the `Promise.race` at `src/daemon/index.ts` |

The third pair is asymmetric and worth stating plainly: the brain's side is a
literal inside an IIFE, not an exported constant, so the sidecar keeps its own
copy as `pebbleNarrationRace` purely to be compared against. Nothing imports it
and nothing waits on it; `TestElementPointBudgetFitsTheNarrationRace` asserts
the inequality so the relationship is checked on the sidecar's side rather than
only described here. Raising the brain's race is safe; lowering it to 900 ms or
below without lowering `elementPointBudget` puts the handler back outside the
window, which is #610. The bound is strict on purpose -- a handler that answers
exactly at the deadline has already lost the race.

Renaming the space string on one side alone makes every point
`unusable_reply` -- which is the safe direction, and silent. Both ends check the
bound on purpose (the sidecar computes the point, the brain is what hands it to
`pebble.point_at`), so they are duplicated rather than shared; this table is
where the next editor of either finds the other.

The one place a point is returned that is not exactly right is the Windows
DPI-scale row above, plus the horizontal-scrollbar offset -- both bounded, both
measured, both stated, and both identical to what the brain's own local
narration path does today. Neither can name a different element: they are
off by a screen scale factor or by 15 CSS px, not by an element.

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
3. Sidecar sends `register` with its version, capabilities and features
4. Brain classifies the version against its floors (`src/sidecar/compat.ts`) and answers `register_ack`, or `register_rejected` and closes
5. Brain's SidecarManager registers the connection
6. Scheduler starts accepting events from this sidecar

### Registration and version handshake

```json
{
  "type": "register",
  "hostname": "laptop",
  "os": "windows",
  "platform": "amd64",
  "version": "0.10.0",
  "features": ["update_prompt", "update_apply"],
  "capabilities": ["terminal", "filesystem"],
  "unavailable_capabilities": [],
  "timezone": "Europe/Rome"
}
```

`version` is the sidecar's own semver (`"dev"` for unstamped builds). `features` lists optional protocol features; sidecars that predate it send none:

| Feature | Meaning |
|---|---|
| `update_prompt` | the sidecar can show its native update prompt (`sidecar.update_prompt`); Windows and macOS |
| `update_apply` | the sidecar can install an update on request (`sidecar.update_apply`) |
| `browser_elem_gen` | page replies carry `elem_gen`, and `browser_click`/`browser_type`/`browser_hover` compare a reviewed `elem_gen` (#676). Advertised on every build, dev included |

The brain answers every accepted registration with an ack carrying the sidecar version it ships with (`SIDECAR_LATEST_VERSION`, always equal to `sidecar/VERSION` at the brain's release):

```json
{ "type": "register_ack", "update_status": "ok", "latest": "0.10.0" }
```

`update_status` is `ok`, `suggested` (below `SIDECAR_RECOMMENDED_VERSION`; the ack then also carries `update_suggested: true` and `recommended`) or `dev`. Brains older than self-update send an ack only for `suggested`.

A sidecar below `SIDECAR_MIN_VERSION` is refused, told what to install, and the socket closes with code 4001:

```json
{ "type": "register_rejected", "reason": "incompatible", "min": "0.1.0", "your_version": "0.0.9", "latest": "0.10.0" }
```

### Self-update

`latest` is a suggestion. The sidecar decides whether it is an update and enforces how it is installed (`sidecar/updater.go`, `sidecar/internal/update`):

- only a version strictly newer than its own; a `dev` build never updates
- only from the npm registry (a registry override exists in `-tags jarvisdebug` builds only), and only once that exact version is published there; until then it reports `unavailable` and retries hourly
- the tarball's sha512 must match the registry's integrity value, and on Windows and macOS the payload must carry the pinned code signature
- an installer-managed install is swapped in place and the new binary relaunched. If it cannot be launched, the previous one is restored at once; if it launches but keeps failing to reach the brain (three starts without a `register_ack`), it restores the previous one on its next start (`sidecar/update_pending.go`). A bun/npm global install runs that package manager, pinned to the version and to the npm registry, and has its code signature checked before it runs. Anything else, or any failure, reports a command the user can run instead

The offer reaches the user as a native prompt after the first registration of each process (Windows, macOS; "Skip this version" silences only this prompt), a tray item, and the dashboard. The dashboard uses two routes: `POST /api/sidecars/:id/update-prompt` opens the native prompt, and `POST /api/sidecars/:id/update` installs directly on sidecars without one (Linux).

Brain -> sidecar RPCs (ungated):

| Method | Params | Result |
|---|---|---|
| `sidecar.update_prompt` | `{}` | `{ok: true}` once the prompt is opening; error `UNSUPPORTED` without a prompt |
| `sidecar.update_apply` | `{version}` | `{started: true}`; errors `UPDATE_UNAVAILABLE` (nothing to install, or `version` is not the one the sidecar confirmed), `UPDATE_BUSY`, `UPDATE_RETRY_LATER` (a few seconds after a failed attempt) |

Progress comes back as `sidecar_event`s with `event_type: "update_progress"`, which the brain keeps on the connection and exposes as `update_state` in `/api/sidecars`:

```json
{
  "type": "sidecar_event",
  "event_type": "update_progress",
  "timestamp": 1790000000000,
  "payload": { "phase": "failed", "version": "0.10.0", "error": "...", "manual_command": "npm install -g @usejarvis/sidecar@0.10.0" }
}
```

`phase` is one of `available` (the advertised version is published and installable), `unavailable` (not published yet, or the registry could not be reached, which `error` then says), `downloading`, `verifying`, `installing`, `restarting`, and `failed` (with `error` and `manual_command`). The sidecar reports `available`/`unavailable` after each registry check, so the dashboard only offers what it can install. A sidecar that predates self-update gets the brain's `notify.show` "Update Jarvis" notification instead, once per brain process.

### Sidecar disconnects

1. WebSocket closes (clean or network failure)
2. Brain's SidecarManager removes the connection
3. All pending RPCs for this sidecar transition to `FAILED` with "sidecar disconnected"
4. Scheduler drains remaining queued events from this sidecar (processes them, then removes the sidecar from rotation)

### Heartbeat

- Brain sends `ping` frames every 30 seconds
- Sidecar responds with `pong`
- If 3 consecutive pongs are missed, brain considers the sidecar disconnected
