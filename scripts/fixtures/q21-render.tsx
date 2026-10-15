import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownBody } from '../../ui/src/v2/thread/MarkdownBody';
import { AnswerRoom } from '../../ui/src/v2/rooms/answer/AnswerRoom';
import { TaskResultRoom } from '../../ui/src/v2/rooms/taskResult/TaskResultRoom';
import { richAttack } from '../../src/trust-boundaries/fixtures';

function Probe() {
  const [report, setReport] = useState('Not checked');
  return <main>
    <h1>Q-21 synthetic rendering check</h1>
    <p>Only synthetic fixtures. Each image must be a link; no content may load automatically.</p>
    <button onClick={async () => {
      const metrics = await (await fetch('/metrics')).json();
      const results = document.querySelector('#results')!;
      const hashBefore = window.location.hash;
      const references = [...results.querySelectorAll<HTMLAnchorElement>('a[data-footnote-ref]')];
      let footnoteRoundTrips = 0;
      for (const reference of references) {
        reference.click();
        const definition = document.activeElement;
        const backlink = definition?.querySelector<HTMLAnchorElement>('a[data-footnote-backref]');
        backlink?.click();
        if (backlink && document.activeElement === reference) footnoteRoundTrips++;
      }
      setReport(JSON.stringify({ imageRequests: metrics.imageRequests,
        activeElements: results.querySelectorAll('img,script,iframe,object,embed,link').length,
        executableLinks: [...results.querySelectorAll('a')].filter(a => /^(javascript|data|file|jarvis):/i.test(a.href)).length,
        imageLinks: [...results.querySelectorAll('a')].filter(a => a.textContent?.startsWith('Image:')).length,
        tables: results.querySelectorAll('table').length,
        footnoteRoundTrips,
        uniqueFootnoteIds: new Set(references.map(reference => reference.id)).size,
        hashPreserved: window.location.hash === hashBefore,
        scriptExecuted: Boolean((globalThis as unknown as { q21Executed?: boolean }).q21Executed),
      }, null, 2));
    }}>Check boundaries</button>
    <pre aria-label="Boundary report">{report}</pre>
    <div id="results">
      <section><h2>Thread activity</h2><MarkdownBody text={richAttack} /></section>
      <section><h2>Answer room</h2><AnswerRoom answerId="q21" /></section>
      <section><h2>Task result</h2><TaskResultRoom taskId="q21" /></section>
    </div>
  </main>;
}
createRoot(document.querySelector('#root')!).render(<Probe />);
