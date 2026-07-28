package main

// Single-use nonces for notification action URIs. Platform-neutral (and kept
// out of the _windows file) so the linux `go test ./...` CI gate actually
// exercises it — the Windows job only cross-compiles.
//
// Threat model: protocol activation (jarvis://) and WM_COPYDATA are
// world-invokable, so approve/deny must prove the URI came from a toast we
// minted — this kills blind spoofing by id. A same-user process can still
// observe the nonce while the toast is being raised (the XML rides a
// PowerShell command line, which is same-user-readable, as is our memory);
// same-user attackers are outside what a nonce can defend against.

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"sync"
	"time"
)

const notifyNonceTTL = 10 * time.Minute

type notifyNonceEntry struct {
	nonce   string
	expires time.Time
}

var (
	notifyNonceMu sync.Mutex
	notifyNonces  = map[string]notifyNonceEntry{}
)

// mintNotifyNonce creates and stores the nonce for a notification id, pruning
// expired entries. Re-minting for the same id invalidates the previous toast's
// buttons (they degrade to review). Returns "" on entropy failure — then
// approve/deny buttons simply won't validate (fail closed).
func mintNotifyNonce(id string) string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	n := hex.EncodeToString(b)
	notifyNonceMu.Lock()
	defer notifyNonceMu.Unlock()
	now := time.Now()
	for k, e := range notifyNonces {
		if now.After(e.expires) {
			delete(notifyNonces, k)
		}
	}
	notifyNonces[id] = notifyNonceEntry{nonce: n, expires: now.Add(notifyNonceTTL)}
	return n
}

// consumeNotifyNonce validates and burns the nonce for id (single use — the
// first of Approve/Deny to arrive wins; a replay finds nothing).
func consumeNotifyNonce(id, nonce string) bool {
	if id == "" || nonce == "" {
		return false
	}
	notifyNonceMu.Lock()
	defer notifyNonceMu.Unlock()
	e, ok := notifyNonces[id]
	if !ok || time.Now().After(e.expires) || subtle.ConstantTimeCompare([]byte(e.nonce), []byte(nonce)) != 1 {
		return false
	}
	delete(notifyNonces, id)
	return true
}
