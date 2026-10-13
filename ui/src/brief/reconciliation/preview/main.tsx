import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { BriefReconciliationClient } from '../client';
import { useBriefProjection, useBriefReconciliation } from '../react';
import { decisionsSource, inspectionSource, memorySource } from '../sources';
const client = new BriefReconciliationClient({ pollMs: 120_000 }); // Deliberate manual replay window; production defaults to 30s.
const decisions = client.projection(decisionsSource());
const memory = client.projection(memorySource());
const run = client.projection(inspectionSource({ flowId: 'flow-a', versionId: 'version-a', runId: 'run-a' }));
function App() {
  const observer = useBriefReconciliation(client, true), ws = useWebSocket({ observer });
  const d = useBriefProjection(decisions), m = useBriefProjection(memory), r = useBriefProjection(run);
  const [message, setMessage] = useState('Synthetic data only. No external effects.');
  const action = async (name: string, message: string) => { await fetch(`/fixture/${name}`, { method: 'POST' }); setMessage(message); };
  return <main><style>{`body{font:17px system-ui;background:#f6f6f3;color:#222;margin:0}main{max-width:1000px;margin:48px auto;padding:24px}h1{font-size:32px}section{background:white;padding:22px;border:1px solid #ddd;border-radius:12px;margin:18px 0}button{padding:10px 14px;margin:5px;border:1px solid #aaa;border-radius:8px;background:#fff}textarea{display:block;width:95%;padding:12px;margin-top:10px;font:inherit}p{line-height:1.5}code{font-size:15px}`}</style>
    <h1>Dashboard recovery · F-27</h1><p>Isolated behavior fixture · Socket: {ws.isConnected ? 'connected' : 'disconnected'}</p>
    <section><label>Draft to preserve<textarea aria-label="Draft to preserve" defaultValue="Keep my unfinished draft" /></label>
      <p>Selected: <code>flow-a / version-a / run-a</code></p>
      <p>Inspection: {r.state} · {r.data?.run?.label ?? 'No fresh run snapshot'} · {r.data?.run?.status ?? 'unknown'}</p></section>
    <section><h2>Needs you</h2><p>Queue: {d.state} · Total: {d.data?.total ?? 'unknown (server supplies no total)'}</p>
      <ul>{d.data?.items.map(item => <li key={item.decisionId}>{item.decisionId} · revision {item.revision}</li>)}</ul></section>
    <section><h2>Memory</h2><p>Memory: {m.state} · Count: {m.data?.total ?? 'unavailable'}</p>
      <ul>{m.data?.items.map(item => <li key={item.factId}>{item.sentence}</li>)}</ul></section>
    <section><h2>Recovery controls</h2><p role="status">{message}</p>
      <button onClick={() => action('drop', 'Canonical data changed; all associated events were dropped.')}>Drop updates</button>
      <button onClick={() => action('reconnect', 'Socket closed; automatic reconnect refreshes snapshots.')}>Reconnect</button>
      <button onClick={() => action('reorder', 'Delivered sequences 1, 4, 4, 2, 3.')}>Duplicate and reorder</button>
      <button onClick={() => action('unavailable', 'Memory reads now return unavailable.')}>Make memory unavailable</button>
      <button onClick={() => action('recover', 'Memory reads restored; the forgotten fact remains absent.')}>Recover memory</button>
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
