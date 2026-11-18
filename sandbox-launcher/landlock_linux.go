//go:build linux

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

// The Landlock syscalls have the same numbers on every Linux architecture
// (they are in the generic table), see include/uapi/asm-generic/unistd.h.
const (
	sysLandlockCreateRuleset = 444
	sysLandlockAddRule       = 445
	sysLandlockRestrictSelf  = 446

	landlockCreateRulesetVersion = 1 << 0
	landlockRulePathBeneath      = 1

	prSetNoNewPrivs = 38

	// O_PATH, which package syscall does not export. This value holds for
	// the generic table (amd64, arm64, riscv64, 386, arm); the launcher is
	// built for linux amd64 and arm64 only.
	oPath = 0o10000000
)

// Filesystem access rights, include/uapi/linux/landlock.h.
const (
	accessExecute    = 1 << 0
	accessWriteFile  = 1 << 1
	accessReadFile   = 1 << 2
	accessReadDir    = 1 << 3
	accessRemoveDir  = 1 << 4
	accessRemoveFile = 1 << 5
	accessMakeChar   = 1 << 6
	accessMakeDir    = 1 << 7
	accessMakeReg    = 1 << 8
	accessMakeSock   = 1 << 9
	accessMakeFifo   = 1 << 10
	accessMakeBlock  = 1 << 11
	accessMakeSym    = 1 << 12
	accessRefer      = 1 << 13 // ABI 2
	accessTruncate   = 1 << 14 // ABI 3
	accessIoctlDev   = 1 << 15 // ABI 5

	// Scopes, ABI 6: no connecting to an abstract unix socket made outside
	// the sandbox, and no signals to processes outside it (the daemon).
	scopeAbstractUnixSocket = 1 << 0
	scopeSignal             = 1 << 1
)

// The rights a file (not a directory) can carry; the kernel refuses a rule
// that gives a file any other.
const fileRights = accessExecute | accessWriteFile | accessReadFile | accessTruncate | accessIoctlDev

// handledRights is every filesystem right this kernel's ABI can restrict.
// Rights the kernel does not know cannot be handled, so they stay allowed:
// before ABI 2 a file can never be moved between directories, before ABI 3
// truncate(2) is not restricted, before ABI 5 device ioctls are not.
func handledRights(abi int) uint64 {
	r := uint64(accessExecute | accessWriteFile | accessReadFile | accessReadDir |
		accessRemoveDir | accessRemoveFile | accessMakeChar | accessMakeDir |
		accessMakeReg | accessMakeSock | accessMakeFifo | accessMakeBlock | accessMakeSym)
	if abi >= 2 {
		r |= accessRefer
	}
	if abi >= 3 {
		r |= accessTruncate
	}
	if abi >= 5 {
		r |= accessIoctlDev
	}
	return r
}

func handledScopes(abi int) uint64 {
	if abi >= 6 {
		return scopeAbstractUnixSocket | scopeSignal
	}
	return 0
}

// Read-only: read files and directories, and execute (the engine runs Bun,
// and a CODE step starts Bun again).
const readOnlyRights = accessExecute | accessReadFile | accessReadDir

// Read-write: everything except execute and making device nodes, so nothing
// written inside the sandbox can be run as a program.
const readWriteRights = accessWriteFile | accessReadFile | accessReadDir | accessRemoveDir |
	accessRemoveFile | accessMakeDir | accessMakeReg | accessMakeSock | accessMakeFifo |
	accessMakeSym | accessRefer | accessTruncate | accessIoctlDev

func abiVersion() int {
	v, _, errno := syscall.Syscall(sysLandlockCreateRuleset, 0, 0, landlockCreateRulesetVersion)
	if errno != 0 {
		return 0
	}
	return int(v)
}

// ruleRights is what a rule for `path` grants, limited to what the ruleset
// handles and, for anything that is not a directory, to file rights.
func ruleRights(want uint64, isDir bool, handled uint64) uint64 {
	r := want & handled
	if !isDir {
		r &= fileRights
	}
	return r
}

func addPathRule(rulesetFd int, path string, want, handled uint64) error {
	fd, err := syscall.Open(path, oPath|syscall.O_CLOEXEC, 0)
	if err != nil {
		// A path that is not there has nothing to grant. The daemon passes
		// optional system paths (/lib64, /etc/pki) that a distribution may lack.
		if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ENOTDIR) {
			return nil
		}
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer syscall.Close(fd)
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return fmt.Errorf("stat %s: %w", path, err)
	}
	rights := ruleRights(want, st.Mode&syscall.S_IFMT == syscall.S_IFDIR, handled)
	if rights == 0 {
		return nil
	}
	// struct landlock_path_beneath_attr is packed: u64 allowed_access, s32 parent_fd.
	var attr [12]byte
	binary.NativeEndian.PutUint64(attr[0:8], rights)
	binary.NativeEndian.PutUint32(attr[8:12], uint32(int32(fd)))
	_, _, errno := syscall.Syscall6(sysLandlockAddRule, uintptr(rulesetFd), landlockRulePathBeneath,
		uintptr(unsafe.Pointer(&attr[0])), 0, 0, 0)
	runtime.KeepAlive(&attr)
	if errno != 0 {
		return fmt.Errorf("landlock_add_rule %s: %w", path, errno)
	}
	return nil
}

func restrictAndExec(p policy) error {
	// Every step below acts on the calling thread only (no_new_privs and the
	// Landlock domain are per thread), and execve keeps the thread that called
	// it. So all of it, exec included, happens on this one locked thread.
	runtime.LockOSThread()

	abi := abiVersion()
	if abi < 1 {
		return errors.New("this kernel offers no Landlock (it needs Linux 5.13 or later with landlock in the lsm= list)")
	}
	handled := handledRights(abi)

	// struct landlock_ruleset_attr: u64 handled_access_fs, u64
	// handled_access_net, u64 scoped. A kernel that knows a shorter struct
	// accepts the longer one as long as the fields it does not know are zero.
	var attr [24]byte
	binary.NativeEndian.PutUint64(attr[0:8], handled)
	binary.NativeEndian.PutUint64(attr[16:24], handledScopes(abi))
	fd, _, errno := syscall.Syscall(sysLandlockCreateRuleset, uintptr(unsafe.Pointer(&attr[0])), uintptr(len(attr)), 0)
	runtime.KeepAlive(&attr)
	if errno != 0 {
		return fmt.Errorf("landlock_create_ruleset: %w", errno)
	}
	rulesetFd := int(fd)

	for _, path := range p.readOnly {
		if err := addPathRule(rulesetFd, path, readOnlyRights, handled); err != nil {
			return err
		}
	}
	for _, path := range p.readWrite {
		if err := addPathRule(rulesetFd, path, readWriteRights, handled); err != nil {
			return err
		}
	}

	if _, _, errno := syscall.RawSyscall6(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0, 0, 0, 0); errno != 0 {
		return fmt.Errorf("prctl(PR_SET_NO_NEW_PRIVS): %w", errno)
	}
	if _, _, errno := syscall.RawSyscall(sysLandlockRestrictSelf, uintptr(rulesetFd), 0, 0); errno != 0 {
		return fmt.Errorf("landlock_restrict_self: %w", errno)
	}
	syscall.Close(rulesetFd)

	err := syscall.Exec(p.argv[0], p.argv, os.Environ())
	return fmt.Errorf("exec %s: %w", p.argv[0], err)
}
