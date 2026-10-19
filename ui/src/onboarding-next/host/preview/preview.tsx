import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OptionalOnboardingEntry } from '../Entry.tsx';
import { previewConfiguration } from './fixture.tsx';
import '../../../brief/styles/index.css';
import '../../../v2/v2.css';
import './preview.css';
function Preview() {
  const [mode, setMode] = useState<'full' | 'partial' | 'empty' | 'disabled'>('full');
  const [reset, setReset] = useState(0);
  const assembly = useMemo(() => previewConfiguration({ mode, storage: sessionStorage }), [mode, reset]);
  return <div className="brief-root jarvis-v2-root">
    <header className="on-preview__toolbar"><strong>ON-U-10 · fixture assembly</strong>
      <label>Registry <select value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="full">Full fixture</option><option value="partial">Actual partial set</option><option value="empty">Empty</option><option value="disabled">Disabled</option></select></label>
      <button onClick={() => setReset(n => n + 1)}>Restart preview</button>
      <button onClick={assembly.advance}>Advance build fixture</button><button onClick={assembly.disconnect}>Disconnect</button><button onClick={assembly.reconnect}>Restore connection</button>
      <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; setReset(n => n + 1); }}>Toggle theme</button>
    </header>
    <OptionalOnboardingEntry key={`${mode}:${reset}`} configuration={assembly.config} legacy={<section className="on-preview__room"><h1>Legacy fallback selected</h1><p>The production gate mounts the complete unchanged wizard here. This isolated preview performs no legacy setup.</p></section>}>
      <section className="on-preview__room"><h1>Dashboard handoff</h1><p>No Talk request, run, publish or enable action was sent.</p></section>
    </OptionalOnboardingEntry>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
