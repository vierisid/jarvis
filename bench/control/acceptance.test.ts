import { describe, expect, it } from 'bun:test';
import { noSemanticRefsReason } from './acceptance.ts';

/**
 * A get_window_tree result with no sigs used to be reported as a stale sidecar
 * build, whatever the machine. On macOS and Linux that is wrong twice over:
 * the semantic walk exists only in sidecar/desktop_windows.go, so there is no
 * build to go and get. The message is the whole deliverable of that path -- the
 * check skips either way -- so it is what these tests pin.
 */
describe('noSemanticRefsReason', () => {
  it('blames the platform, not the build, on a non-Windows sidecar', () => {
    const reason = noSemanticRefsReason('darwin');
    expect(reason).toContain('Windows-only');
    expect(reason).toContain('os=darwin');
    // The point of the change: no rebuild advice where rebuilding cannot help.
    expect(reason).not.toContain('predates this feature');
    expect(reason).not.toContain('stop every jarvis-sidecar process');
  });

  it('says the same for linux', () => {
    const reason = noSemanticRefsReason('linux');
    expect(reason).toContain('Windows-only');
    expect(reason).toContain('os=linux');
    expect(reason).not.toContain('predates this feature');
  });

  it('still blames the build on Windows, where a rebuild is the fix', () => {
    const reason = noSemanticRefsReason('windows');
    expect(reason).toContain('predates this feature');
    expect(reason).toContain('stop every jarvis-sidecar process');
    // No platform caveat: this sidecar is on the one OS that implements it.
    expect(reason).not.toContain('Windows-only');
  });

  it('hedges when the daemon did not report an OS, instead of asserting a stale build', () => {
    for (const os of [undefined, 'unknown']) {
      const reason = noSemanticRefsReason(os);
      expect(reason).toContain('predates this feature');
      // A pre-`os` daemon must not send a macOS operator rebuilding either.
      expect(reason).toContain('Windows-only');
    }
  });

  it('names the RPC and the flag in every case, so the skip line is self-explaining', () => {
    for (const os of ['windows', 'darwin', 'linux', 'unknown', undefined]) {
      expect(noSemanticRefsReason(os)).toContain('get_window_tree ignored semantic:true');
    }
  });
});
