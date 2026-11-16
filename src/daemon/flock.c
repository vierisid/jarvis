#include <sys/file.h>
#include <errno.h>
#include <fcntl.h>

int do_flock(int fd, int operation) {
    if (flock(fd, operation) == -1) return errno;
    return 0;
}

/* Mark fd close-on-exec, so no exec'd child inherits the lock. */
int do_cloexec(int fd) {
    int flags = fcntl(fd, F_GETFD);
    if (flags == -1) return errno;
    if (fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == -1) return errno;
    return 0;
}
