/**
 * Reading a child's pipe, shared by the two seams that run desktop tools:
 * native-exec.ts (osascript, desktop.ps1, screencapture) and capture-file.ts
 * (the X11 tools, the clipboard tools, the capture one-liners).
 */

export function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Read a pipe to the end, refusing more than `limit` bytes. What has arrived
 * so far is kept in `chunks`, so a caller that stops waiting -- a descendant
 * of the tool can hold the pipe open long after the tool exits -- can still
 * use it (#899 for native-exec, #902 for capture-file).
 */
export async function readCapped(stream: ReadableStream<Uint8Array>, limit: number, onOverflow: () => void, chunks: Uint8Array[] = []): Promise<string> {
  const reader = stream.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        onOverflow();
        throw codedError(`output passed ${limit} bytes`, 'ENOBUFS');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf-8');
}
