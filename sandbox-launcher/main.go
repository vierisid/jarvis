// jarvis-sandbox starts the workflow engine inside a file sandbox (#1154).
//
// Usage:
//
//	jarvis-sandbox --abi
//	jarvis-sandbox [--ro PATH]... [--rw PATH]... -- PROGRAM [ARG]...
//
// --abi prints the Landlock ABI version this kernel offers (0 when it offers
// none) and exits 0. The daemon asks once at boot to decide between the
// sandbox, a warned fallback, or a refusal (workflows.sandbox).
//
// Otherwise it builds a Landlock ruleset in which only the --ro paths can be
// read (and executed) and only the --rw paths can be read and written, sets
// no_new_privs, restricts itself, and execs PROGRAM with the environment it
// was given. The restriction is inherited by everything PROGRAM starts, so the
// CODE-step children the engine spawns run under the same rules.
//
// It never runs PROGRAM unsandboxed: when the kernel has no Landlock, or any
// step fails, it exits 125 with a message and PROGRAM is not started. Falling
// back is the daemon's decision, not the launcher's.
//
// Landlock needs no privilege and no extra container capability. A seccomp
// profile that blocks its syscalls reads as "no Landlock" (ENOSYS).
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// exitLauncherFailed is what a refusal exits with. 125 is the value env(1)
// and container runtimes use for "the wrapper failed, the program never ran".
const exitLauncherFailed = 125

type policy struct {
	readOnly  []string
	readWrite []string
	argv      []string
	abiOnly   bool
}

func parseArgs(args []string) (policy, error) {
	var p policy
	for i := 0; i < len(args); i++ {
		switch a := args[i]; a {
		case "--abi":
			p.abiOnly = true
		case "--ro", "--rw":
			if i+1 >= len(args) {
				return p, fmt.Errorf("%s needs a path", a)
			}
			i++
			path := args[i]
			if !filepath.IsAbs(path) {
				return p, fmt.Errorf("%s %q: path must be absolute", a, path)
			}
			if a == "--ro" {
				p.readOnly = append(p.readOnly, path)
			} else {
				p.readWrite = append(p.readWrite, path)
			}
		case "--":
			p.argv = args[i+1:]
			i = len(args)
		default:
			return p, fmt.Errorf("unknown argument %q", a)
		}
	}
	if p.abiOnly {
		return p, nil
	}
	if len(p.argv) == 0 {
		return p, errors.New("no program after --")
	}
	if !filepath.IsAbs(p.argv[0]) {
		return p, fmt.Errorf("program %q must be an absolute path", p.argv[0])
	}
	return p, nil
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "jarvis-sandbox: "+format+"\n", args...)
	os.Exit(exitLauncherFailed)
}

func main() {
	p, err := parseArgs(os.Args[1:])
	if err != nil {
		fail("%v", err)
	}
	if p.abiOnly {
		fmt.Println(abiVersion())
		return
	}
	if err := restrictAndExec(p); err != nil {
		fail("%v; the program was not started", err)
	}
}
