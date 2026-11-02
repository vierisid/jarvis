import {closeSync, constants, fstatSync, openSync, readSync} from "node:fs";

const MAX_CONNECTION_BYTES = 65536;
/**
 * The file's text, read through one descriptor: a FIFO or device would block
 * this synchronous read (and the daemon with it), and a size checked by path
 * could change before the read, so the open never blocks, the descriptor must
 * be a regular file, and no more than the cap is read.
 */
export function readManagedConnectionFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    const buffer = Buffer.alloc(MAX_CONNECTION_BYTES + 1);
    let size = 0;
    for (
      let n;
      size < buffer.length &&
      (n = readSync(fd, buffer, size, buffer.length - size, null)) > 0;
    )
      size += n;
    if (size > MAX_CONNECTION_BYTES) throw new Error("too large");
    return buffer.toString("utf8", 0, size);
  } finally {
    closeSync(fd);
  }
}
