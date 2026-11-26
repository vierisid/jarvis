/**
 * The pipe between the brain and the page, as the preview and the tests have
 * it: a function call that can be made slow, and can lose what it carries.
 *
 * On a desktop the pipe is the desktop app and, behind it, the connection to
 * the brain: a message can be late (a brain on another machine), and can be
 * lost (the desktop app's queue was full, the connection went down). The
 * messages are made for that (./../../../../src/notch/protocol.ts): this is
 * where it can be seen, and tested without waiting.
 */
export interface NotchPipeOptions {
  /** How long a message is on its way, in ms, asked for each message. */
  delayMs: () => number;
  /** How many of a hundred messages are lost, asked for each message. */
  lossPercent: () => number;
  /** A number from 0 up to 1. */
  random?: () => number;
  /** A call after a while: the browser's, or a test's clock. */
  after: (ms: number, fn: () => void) => void;
}

/**
 * One direction of the pipe. Hands it `deliver`, and it calls it after the
 * delay, or never. Says whether the message is on its way (false: lost).
 * With a delay of 0 it is delivered at once, inside the call.
 */
export function createNotchPipe(options: NotchPipeOptions): (deliver: () => void) => boolean {
  const random = options.random ?? Math.random;
  return (deliver) => {
    const loss = Math.max(0, Math.min(100, Number(options.lossPercent()) || 0));
    if (loss > 0 && random() * 100 < loss) return false;
    const delay = Math.max(0, Number(options.delayMs()) || 0);
    if (delay === 0) deliver(); else options.after(delay, deliver);
    return true;
  };
}
