# Brief data availability

The current home surface is named **Now**. Its HTTP widgets and the Goals and Authority rooms use the same per-endpoint availability contract. A connected event stream does not prove that the approval inbox loaded successfully.

## UI contract

Each `RemoteData<T>` carries `data`, `availability`, `error`, `updatedAt` (Unix milliseconds), and an endpoint-specific `refresh()`.

| State | Meaning | Presentation |
| --- | --- | --- |
| `loading` | No successful response yet; first request is pending | Loading label; unknown counts shown as a dash |
| `ready` | Latest completed request succeeded and its response decoded | Current snapshot; an empty list may show a confirmed empty state |
| `stale` | A refresh failed after a successful response | Preserve the snapshot and timestamp, label it "Stale" and "not current", offer Retry; suppress reassuring empty claims |
| `unavailable` | Request failed with no successful snapshot | Explain the failure and offer Retry; unknown counts remain a dash |

Polling retains the last completed state while the next request is pending. "Ready" denotes the latest successful poll, not a transactional snapshot across endpoints or a guarantee of real-time freshness. HTTP errors, offline fetch failures, invalid JSON, unexpected payload containers, and a 10-second timeout fail the affected resource. Successful sibling endpoints publish immediately and continue polling even while another request is pending. Recovery clears only that resource's error and advances its timestamp. Hidden pages do not poll; becoming visible or coming online refreshes them. Unmount aborts requests; late responses cannot replace a different resource's data.

Snapshots remain in memory for the mounted view. Reloading starts at `loading`; there is no persistent cache of approval or goal data across sign-ins.

For rolling query windows, a stable URL factory supplies the current range at each refresh without changing the resource identity. Calendar uses this to request the next seven days and filters out past appointments at render time. A failed request for a later window retains its last good snapshot under a stale label; if all retained appointments have passed, it does not claim there are no commitments.

## Consumers

- Goals: goal list, metrics, and overdue data are independent. Current summary counts are withheld when their source is stale or unavailable; retained goal rows remain inspectable under their stale notice.
- Authority: emergency status, pending approvals, unfinished approvals, decision history, audit entries, audit statistics, configuration, and suggestions are independent. A missing emergency status is "unknown", never "all systems normal". Pause and Kill remain available; action endpoints still validate requests. Audit filters remain available during outages, including filters with no cached matches; retained counts are labelled "Last known" and unknown counts are a dash.
- Now: every HTTP widget has its own status and Retry. Waiting and its Vitals count require successful pending and unfinished approval snapshots plus a live event connection before claiming zero. Known requests are retained and deduplicated by ID; saved requests link to Authority. An unknown inbox keeps Waiting visible. Offline status does not disable section retries.

Within Now, the widgets fed by the live event stream rather than HTTP - right now, today, tasks due, agents roster, and the agent and event counts in vitals - are not on this contract either: with the stream down they still print a confident empty line, qualified only by the global Offline indicator in the header. Waiting is the exception, because an approval missed is the one that matters.

Rooms outside this set - Agents, Calendar, Content, Memory, Tasks and Workspaces - still resolve their own fetches and still render a failed load as an empty result: under a total outage the Memory room reports zero entities, facts and relationships without an error. Moving them onto this contract is follow-up work, so do not read a dash or a stale notice as available everywhere one would be warranted.

This changes presentation and fetch lifecycle only. It does not bypass authentication, change approval execution, or infer service failure when an API deliberately returns a successful empty array.

## Verification

`ui/src/v2/rooms/availability.test.tsx` exercises hooks and real room components: 401/403/429/500/502/503/504, network failure, malformed JSON/container, partial and delayed responses, timeout/retry, polling/unmount, late responses, retained nonempty and empty snapshots, recovery, audit filtering during outages, advancing calendar windows, and the Now approval summary. Browser checks use these same components against synthetic API responses in light and dark themes; they do not measure deployed outage incidence.
