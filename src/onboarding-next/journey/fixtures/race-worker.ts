/** Test-only subprocess. Its only accessible store is the test's temporary DB. */
import { Database } from 'bun:sqlite';
import { createJourneyProvider, createSettingsJourneyPersistence } from '../index.ts';

const [path, journeyId, requestId] = process.argv.slice(2);
if (!path || !journeyId || !requestId) throw new Error('Missing test arguments');
const db = new Database(path, { create: false, readwrite: true });
db.exec('PRAGMA busy_timeout = 3000');
try {
  const p = createJourneyProvider({
    authorize: () => ({ actorId: 'test-actor', projectId: 'test-project' }),
    persistence: createSettingsJourneyPersistence({
      databaseForScope: () => db,
      readLegacy: () => { throw new Error('Already initialized'); },
    }),
  });
  const result = await p.transition({ journeyId, expectedRevision: 0, requestId, command: { type: 'navigate', stepId: 'explain' } });
  console.log(JSON.stringify(result));
} finally { db.close(); }
