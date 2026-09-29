/*
 * prctl(PR_SET_DUMPABLE) for the daemon (#546). Linux only; compiled lazily
 * by Bun's embedded TinyCC, exactly as flock.c is, and never compiled at all
 * on macOS or Windows -- <sys/prctl.h> does not exist there.
 *
 * Reached through C rather than through `dlopen("libc.so.6")` for two
 * reasons. The soname is a guess (musl is libc.musl-<arch>.so.1, macOS has no
 * such file), and prctl(2) is VARIADIC -- `int prctl(int option, ...)` -- so a
 * bun:ffi declaration has to pin a fixed signature that the ABI does not
 * promise is compatible with a variadic callee. The compiler here has the real
 * prototype from the system header.
 */
#include <sys/prctl.h>
#include <errno.h>

/*
 * 0 on success, otherwise errno. The caller treats any failure as "hardening
 * unavailable" and carries on -- a daemon that will not start because a
 * defense-in-depth call failed is worse than one running without it.
 */
int do_set_dumpable(int value) {
    if (prctl(PR_SET_DUMPABLE, value, 0, 0, 0) == -1) return errno;
    return 0;
}

/*
 * The current flag, or -1 if the kernel would not say. Read back after the
 * set, because a seccomp filter or a sandboxed kernel (gVisor and friends) can
 * return success for the set and leave the process dumpable; the operator
 * should hear about that rather than believe in a control that is not there.
 */
int do_get_dumpable(void) {
    return prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
}
