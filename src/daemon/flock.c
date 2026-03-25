#include <sys/file.h>
#include <errno.h>

int do_flock(int fd, int operation) {
    if (flock(fd, operation) == -1) return errno;
    return 0;
}
