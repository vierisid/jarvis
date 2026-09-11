package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// expandHome replaces a leading "~" with the user's home directory so
// blocklist entries can be written portably ("~/.ssh").
func expandHome(p string) string {
	if p == "~" {
		return homeDir()
	}
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		return filepath.Join(homeDir(), p[2:])
	}
	return p
}

// caseInsensitiveFS reports whether path comparison must ignore case on this
// platform (NTFS and the default APFS/HFS+ volumes are case-insensitive).
func caseInsensitiveFS() bool {
	return runtime.GOOS == "windows" || runtime.GOOS == "darwin"
}

// canonicalPath returns the absolute, cleaned, symlink-resolved form of p,
// case-folded on case-insensitive platforms, so two spellings of the same
// file compare equal.
//
// A path that does not exist yet (write_file creating a new file) cannot be
// resolved directly, so the deepest existing ancestor is resolved and the
// remainder re-appended: a new file inside a symlinked directory still maps
// to the directory's real location.
func canonicalPath(p string) string {
	p = expandHome(p)
	if runtime.GOOS == "windows" {
		p = stripWindowsPathPrefix(p)
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = filepath.Clean(p)
	}
	resolved := resolveExistingPrefix(abs)
	if caseInsensitiveFS() {
		resolved = strings.ToLower(resolved)
	}
	return resolved
}

// stripWindowsPathPrefix folds the Win32 namespace prefixes back to plain
// paths so they compare against a plain blocklist entry: `\\?\C:\x` and
// `\??\C:\x` become `C:\x`, `\\?\UNC\srv\share` becomes `\\srv\share`, and
// `\\.\C:\x` (device namespace) becomes `C:\x`. Without this filepath.Rel
// sees two different volumes and the containment test fails open.
func stripWindowsPathPrefix(p string) string {
	// Go's own volume detection accepts either separator in these prefixes
	// (`//?/C:/x` is the same volume as `\\?\C:\x`), so normalise the
	// prefix region's slashes before matching. Only the head is touched;
	// the remainder keeps its separators for Abs/Clean to settle.
	if len(p) >= 4 && (p[0] == '\\' || p[0] == '/') {
		norm4 := strings.ReplaceAll(p[:4], "/", `\`)
		if norm4 == `\\?\` || norm4 == `\??\` || norm4 == `\\.\` {
			if len(p) >= 8 && strings.EqualFold(strings.ReplaceAll(p[:8], "/", `\`), norm4+`UNC\`) {
				p = norm4 + `UNC\` + p[8:]
			} else {
				p = norm4 + p[4:]
			}
		}
	}
	for {
		lower := strings.ToLower(p)
		switch {
		case strings.HasPrefix(lower, `\\?\unc\`):
			p = `\\` + p[len(`\\?\unc\`):]
		case strings.HasPrefix(lower, `\\.\unc\`):
			p = `\\` + p[len(`\\.\unc\`):]
		case strings.HasPrefix(p, `\\?\`), strings.HasPrefix(p, `\??\`), strings.HasPrefix(p, `\\.\`):
			p = p[4:]
		default:
			return p
		}
	}
}

func resolveExistingPrefix(abs string) string {
	if r, err := filepath.EvalSymlinks(abs); err == nil {
		return r
	}
	dir, base := filepath.Split(abs)
	dir = filepath.Clean(dir)
	if base == "" || dir == abs {
		return abs // volume root, or nothing left to strip
	}
	return filepath.Join(resolveExistingPrefix(dir), base)
}

// pathWithin reports whether target is root itself or lies inside it. Both
// arguments must already be canonical. A plain prefix compare would also
// match "/home/u/.sshfoo" against "/home/u/.ssh"; this does not.
func pathWithin(target, root string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false // different Windows volumes, or unrelated roots
	}
	if rel == "." {
		return true
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return !filepath.IsAbs(rel)
}

// defaultBlockedPaths is the out-of-the-box read/write blocklist: the
// credentials on this machine and the places a process gets persisted from.
// The brain's model already has a shell here, so this is defence in depth
// against the cheapest exfiltration and persistence moves, not a boundary.
//
// Deliberately narrow inside ~/.jarvis: site-builder projects and other
// working data live there too and must stay editable.
//
// Entries are written in `~/` form so the saved list stays portable across a
// home move or a config copied between users; canonicalPath expands them.
func defaultBlockedPaths() []string {
	paths := []string{
		// This sidecar's own credential, and the brain's secrets when both
		// run on one machine (src/cli/backup.ts lists the brain's set).
		"~/.jarvis/sidecar.yaml",
		"~/.jarvis/config.yaml",
		"~/.jarvis/jarvis.db",
		"~/.jarvis/jarvis.db-wal",
		"~/.jarvis/jarvis.db-shm",
		"~/.jarvis/google-tokens.json",
		"~/.jarvis/sidecar-keys",
		"~/.jarvis/.secrets.enc",
		"~/.jarvis/.secrets.key",
		"~/.jarvis/captures",
		"~/.jarvis/browser",
		// Credentials.
		"~/.ssh",
		"~/.gnupg",
		"~/.aws",
		"~/.kube",
		"~/.netrc",
		"~/.npmrc",
		"~/.git-credentials",
		"~/.docker/config.json",
		// Persistence: shell startup files and login items.
		"~/.bashrc",
		"~/.bash_profile",
		"~/.profile",
		"~/.zshrc",
		"~/.zprofile",
		"~/.zshenv",
		"~/.config/autostart",
		"~/.config/systemd/user",
	}
	switch runtime.GOOS {
	case "darwin":
		paths = append(paths, "~/Library/LaunchAgents")
	case "windows":
		// PowerShell profiles are the rc-file analogue; the Startup folder
		// is the login item.
		paths = append(paths,
			"~/Documents/WindowsPowerShell",
			"~/Documents/PowerShell",
		)
		appdata := os.Getenv("APPDATA")
		if appdata == "" {
			// A service or scheduled-task launch can strip the environment;
			// UserConfigDir reads the same folder and errors instead of
			// silently returning nothing.
			if d, err := os.UserConfigDir(); err == nil {
				appdata = d
			}
		}
		if appdata != "" {
			paths = append(paths, filepath.Join(appdata, "Microsoft", "Windows", "Start Menu", "Programs", "Startup"))
		}
	}
	return paths
}
