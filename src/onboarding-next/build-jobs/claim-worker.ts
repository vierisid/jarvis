// Isolated process fixture: no scheduler or model. Only runs when executed directly.
export {};
if (import.meta.main) {
  const { initWorkflowDb, getWorkflowDb, closeWorkflowDb } = await import('../../workflows/db');
  const { createSqliteBuildStore } = await import('./store');
  const [path, jobId, actorId, projectId, clock] = process.argv.slice(2);
  try {
    initWorkflowDb(path!);
    const store = createSqliteBuildStore(getWorkflowDb(), { now: () => Number(clock) });
    console.log('READY');
    await new Response(Bun.stdin.stream()).text(); // Parent starts both claims after sequential DB initialization.
    const claim = store.claim({ actorId: actorId!, projectId: projectId! }, jobId!, 30000, 120000);
    console.log(`CLAIM:${JSON.stringify(claim?.token ?? null)}`);
  } finally { closeWorkflowDb(); }
}
