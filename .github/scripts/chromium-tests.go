// Print the name of every Go test that drives a real Chromium, one per line.
//
// Run by .github/scripts/chromium-test-partition.sh, which compares this list
// against what `go test -list <pattern>` returns for the pattern CI passes to
// -run and -skip. See that script for why the two are compared at all (#639).
//
// "Drives a real Chromium" means: a top-level `func TestXxx(*testing.T)` whose
// body calls the launcher probe (findChromiumExecutable), which is the call all
// four such tests open with before they will touch a browser.
//
// This is an AST walk rather than a grep for three reasons, each of which was a
// real defect in a grep-based version of this check:
//
//   - The browser test files are full of raw-string fixtures holding HTML, CSS
//     and Go source. A line-oriented scan that decides "which function is this
//     line inside" by looking backwards for `^func ` can be fooled by a `func
//     Test...` line at column zero INSIDE such a fixture, and if the fixture
//     happens to name a test that is already in the set, the two lists still
//     match and the check passes while a real Chromium test sits in the
//     un-retried step. That is the exact defect this check exists to catch,
//     passing through the check.
//   - The file set has to be the one the go tool compiles, not every *_test.go
//     on disk. `go list` is asked for it below, so build constraints
//     (//go:build darwin, _windows_test.go), the nested module under
//     third_party/ and testdata/ are all handled the way `go test ./...`
//     handles them. A find-based scan derived tests that `go test -list` can
//     never return on this GOOS, which is an unfixable red.
//   - Go's rule for a test name is "Test" followed by something that does not
//     start with a lowercase letter, so `Testable` is an ordinary function.
//     A `^Test[A-Za-z0-9_]*$` regex calls it a test.
//
// A call reached through a helper is NOT attributed, and is reported as an
// error rather than ignored: under-reporting is what puts a test back in the
// un-retried step, so this fails closed and says where to look.
//
// Usage: go run chromium-tests.go [-dir sidecar] [-probe findChromiumExecutable]
// Output: one test name per line on stdout. Problems go to stderr, exit 1.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

func main() {
	dir := flag.String("dir", ".", "module directory to scan")
	probe := flag.String("probe", "findChromiumExecutable", "launcher probe function name")
	flag.Parse()

	names, problems, err := chromiumTests(*dir, *probe)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}
	if len(problems) > 0 {
		fmt.Fprintf(os.Stderr, "%s is called where it cannot be attributed to a test:\n", *probe)
		for _, p := range problems {
			fmt.Fprintf(os.Stderr, "    %s\n", p)
		}
		fmt.Fprintf(os.Stderr, "Call the probe directly in each test, or teach %s to follow the helper.\n",
			filepath.Base(os.Args[0]))
		os.Exit(1)
	}
	for _, n := range names {
		fmt.Println(n)
	}
}

// testFiles asks the go tool which test files each package actually compiles,
// so the answer tracks build constraints and package boundaries exactly.
func testFiles(dir string) ([]string, error) {
	cmd := exec.Command("go", "list", "-json", "./...")
	cmd.Dir = dir
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("go list failed in %s (the packages do not build): %w", dir, err)
	}

	var files []string
	dec := json.NewDecoder(strings.NewReader(string(out)))
	for dec.More() {
		var pkg struct {
			Dir          string
			TestGoFiles  []string
			XTestGoFiles []string
		}
		if err := dec.Decode(&pkg); err != nil {
			return nil, fmt.Errorf("parsing go list output: %w", err)
		}
		for _, f := range append(pkg.TestGoFiles, pkg.XTestGoFiles...) {
			files = append(files, filepath.Join(pkg.Dir, f))
		}
	}
	sort.Strings(files)
	return files, nil
}

// isTestName applies Go's own rule: "Test" followed by nothing, or by a rune
// that is not a lowercase letter. `go test` treats anything else as an ordinary
// function (and rejects `func Testxxx(*testing.T)` outright).
func isTestName(name string) bool {
	if !strings.HasPrefix(name, "Test") {
		return false
	}
	rest := name[len("Test"):]
	if rest == "" {
		return true
	}
	return !unicode.IsLower([]rune(rest)[0])
}

func chromiumTests(dir, probe string) (names []string, problems []string, err error) {
	files, err := testFiles(dir)
	if err != nil {
		return nil, nil, err
	}

	fset := token.NewFileSet()
	seen := map[string]bool{}

	for _, path := range files {
		f, perr := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if perr != nil {
			return nil, nil, fmt.Errorf("parsing %s: %w", path, perr)
		}

		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			// Anything that is not a plain top-level func -- a method, a
			// package-level var initialiser -- is walked separately below.
			if !ok || fn.Recv != nil || fn.Body == nil || !isTestName(fn.Name.Name) {
				continue
			}
			if callsProbe(fn.Body, probe) {
				seen[fn.Name.Name] = true
			}
		}

		// Every other mention of the probe in this file: a helper, a method, a
		// package-level var. Reported, never dropped.
		for _, decl := range f.Decls {
			if fn, ok := decl.(*ast.FuncDecl); ok && fn.Recv == nil && fn.Body != nil && isTestName(fn.Name.Name) {
				continue
			}
			ast.Inspect(decl, func(n ast.Node) bool {
				if isProbeCall(n, probe) {
					pos := fset.Position(n.Pos())
					problems = append(problems, fmt.Sprintf("%s:%d", pos.Filename, pos.Line))
				}
				return true
			})
		}
	}

	for n := range seen {
		names = append(names, n)
	}
	sort.Strings(names)
	sort.Strings(problems)
	return names, problems, nil
}

func callsProbe(body *ast.BlockStmt, probe string) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		if isProbeCall(n, probe) {
			found = true
		}
		return !found
	})
	return found
}

// isProbeCall matches a call to the probe by bare name, which is how the
// sidecar's own tests call it (same package). A selector call such as
// pkg.findChromiumExecutable() is not matched, and could not be: the probe is
// unexported.
func isProbeCall(n ast.Node, probe string) bool {
	call, ok := n.(*ast.CallExpr)
	if !ok {
		return false
	}
	ident, ok := call.Fun.(*ast.Ident)
	return ok && ident.Name == probe
}
