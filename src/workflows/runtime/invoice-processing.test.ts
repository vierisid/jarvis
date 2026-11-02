import { expect, test } from 'bun:test';
import { tracksPieceCompletion } from './piece-effects';

test('Drive file uploads must use durable completion receipts, like Sheets appends', () => {
  for (const action of ['upload_gdrive_file', 'drive_upload_file', 'drive_upload_from_url'])
    expect(tracksPieceCompletion('@activepieces/piece-google-drive', action)).toBe(true);
});
