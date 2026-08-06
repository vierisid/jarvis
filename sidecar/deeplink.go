package main

// Browser -> sidecar enrollment deep link (the usejarvis free/self-host door).
//
// The connect page's "Self-hosted" row hands the pasted enrollment token to
// THIS machine via `jarvis://enroll?v=1&nonce=<nonce>&token=<jwt>` — the token
// never transits the usejarvis server (hosting repo ONBOARDING.md pins the
// contract). The OS launches a fresh process for the URI; that process
// forwards it over a user-scoped unix socket to the sidecar instance whose
// first-run window owns the live handshake, then exits. The receiving side
// (hosted_window.go) accepts the link ONLY when the URI's nonce matches its
// own live handshake — any web page can fire jarvis:// URIs, but only the
// real connect page knows the 256-bit nonce — verifies the token against the
// brain it names (verify_token.go), and reports just the VERDICT back to the
// server so the page can show success or the reason for rejection.
//
// The socket lives under ~/.jarvis (0600; the dir itself is created 0700 by
// setupLogging BEFORE runFirstRunWindow, which this bind depends on):
// filesystem-permission-gated IPC, deliberately NOT a TCP port. Go's net
// package supports AF_UNIX on every platform this sidecar targets (Windows 10
// 1803+ included), symmetrically for Listen and Dial.
//
// ACCEPTED RISK: x-scheme-handler delivery puts the token-bearing URI in the
// forwarder's argv, which on Linux is world-readable via /proc/<pid>/cmdline
// for the forwarder's brief lifetime. Same single-user-desktop exposure as
// `jarvis enroll` printing the token to a terminal; avoiding it entirely
// needs D-Bus activation (possible follow-up). Mirrored in ONBOARDING.md.

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const enrollDeepLinkPrefix = "jarvis://enroll"

// Bounds a forwarded URI read: a real one is nonce (43 chars) + a JWT (a few
// hundred bytes); anything larger is not ours.
const enrollDeepLinkMaxLen = 16 << 10

func deepLinkSocketPath() string {
	return filepath.Join(configDir, "enroll.sock")
}

// parseEnrollDeepLink extracts {nonce, token} from an enroll URI. The token is
// whitespace-trimmed (a wrapping-terminal paste travels the page -> URL intact,
// but be lenient anyway); structural JWT validation is the caller's job.
func parseEnrollDeepLink(raw string) (nonce, token string, err error) {
	u, perr := url.Parse(strings.TrimSpace(raw))
	if perr != nil {
		return "", "", fmt.Errorf("parse enroll deep link: %w", perr)
	}
	if u.Scheme != "jarvis" || u.Host != "enroll" {
		return "", "", fmt.Errorf("not an enroll deep link: %s://%s", u.Scheme, u.Host)
	}
	q := u.Query()
	// Forward-compat gate: today's contract is v=1 (an omitted v is treated as
	// 1 for leniency); a future bump must not be half-understood.
	if v := q.Get("v"); v != "" && v != "1" {
		return "", "", fmt.Errorf("unsupported enroll deep link version %q", v)
	}
	nonce = strings.TrimSpace(q.Get("nonce"))
	token = trimToken(q.Get("token"))
	if nonce == "" || token == "" {
		return "", "", fmt.Errorf("enroll deep link missing nonce or token")
	}
	return nonce, token, nil
}

// maybeForwardEnrollLaunch handles the OS launching this process with a
// jarvis://enroll URI: forward it to the running first-run window and exit —
// NEVER boot a full second sidecar off a URI launch. Returns false on a
// normal launch. Must run before maybeForwardProtocolLaunch: the Windows
// notification forwarder matches any jarvis:// URI and would swallow enroll
// links into the (tray-less during onboarding) notification path.
func maybeForwardEnrollLaunch() bool {
	var uri string
	for _, a := range os.Args[1:] {
		if strings.HasPrefix(a, enrollDeepLinkPrefix) {
			uri = a
			break
		}
	}
	if uri == "" {
		return false
	}
	if err := forwardEnrollDeepLink(uri); err != nil {
		// No listener = no first-run window waiting for a token. The connect
		// page shows a copy-token fallback for exactly this case, so just
		// leave a trace for the curious.
		fmt.Fprintf(os.Stderr, "jarvis: no setup window is waiting for a token (%v)\nOpen the Jarvis app, then click Connect on the web page again.\n", err)
	}
	return true
}

// maybeDropProtocolLaunch is the LAST protocol-launch check in main: any
// jarvis:// URI that neither the enroll forwarder nor the (Windows-only)
// notification forwarder claimed must still end this process. Registering the
// scheme on Linux made every jarvis:// URI a launch vector for ANY web page —
// without this sink, an unrecognized URI would fall through and boot a full
// second sidecar contending for the mic, hotkeys, and tray.
func maybeDropProtocolLaunch() bool {
	for _, a := range os.Args[1:] {
		if strings.HasPrefix(a, "jarvis://") {
			fmt.Fprintf(os.Stderr, "jarvis: ignoring unrecognized jarvis:// launch URI\n")
			return true
		}
	}
	return false
}

// forwardEnrollDeepLink hands the URI to the listening sidecar and waits for
// the ack so the write is fully consumed before this process exits.
func forwardEnrollDeepLink(uri string) error {
	conn, err := net.DialTimeout("unix", deepLinkSocketPath(), 2*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte(uri + "\n")); err != nil {
		return err
	}
	ack := make([]byte, 3)
	_, _ = io.ReadFull(conn, ack)
	return nil
}

// deepLinkListener owns the enroll socket for one first-run window session.
// Close is idempotent, joins in-flight onURI callbacks, and removes the
// socket — callers rely on "no callback runs after Close returns" to order
// teardown against the webview's Destroy.
type deepLinkListener struct {
	ln     net.Listener
	wg     sync.WaitGroup
	closed atomic.Bool
}

func listenEnrollDeepLinks(onURI func(uri string)) (*deepLinkListener, error) {
	path := deepLinkSocketPath()
	// A stale socket from a crashed run refuses the bind; nothing else may own
	// this path while no first-run window runs.
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	// 0600: same user only (no-op on Windows; the profile dir gates there).
	_ = os.Chmod(path, 0o600)
	l := &deepLinkListener{ln: ln}
	l.wg.Add(1)
	go func() {
		defer l.wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return // listener closed
			}
			l.wg.Add(1)
			go func() {
				defer l.wg.Done()
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
				line, rerr := bufio.NewReader(io.LimitReader(conn, enrollDeepLinkMaxLen)).ReadString('\n')
				// A read that never reached the newline (truncated writer,
				// over-limit payload) is not a URI — reject, don't guess.
				if rerr != nil {
					log.Printf("[deeplink] dropped unreadable forward: %v", rerr)
					return
				}
				uri := strings.TrimSpace(line)
				if uri == "" {
					return
				}
				if !l.closed.Load() {
					onURI(uri)
				}
				_, _ = conn.Write([]byte("ok\n"))
			}()
		}
	}()
	return l, nil
}

func (l *deepLinkListener) Close() {
	if l == nil || l.closed.Swap(true) {
		return
	}
	_ = l.ln.Close()
	l.wg.Wait()
	_ = os.Remove(deepLinkSocketPath())
}
