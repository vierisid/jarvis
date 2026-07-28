package main

import (
	"testing"
	"time"
)

func TestNotifyNonceMintAndConsume(t *testing.T) {
	n := mintNotifyNonce("appr-1")
	if n == "" {
		t.Fatal("mint returned empty nonce")
	}
	if !consumeNotifyNonce("appr-1", n) {
		t.Fatal("valid nonce rejected")
	}
	if consumeNotifyNonce("appr-1", n) {
		t.Fatal("nonce consumed twice (replay must fail)")
	}
}

func TestNotifyNonceRejectsWrongOrMissing(t *testing.T) {
	n := mintNotifyNonce("appr-2")
	if consumeNotifyNonce("appr-2", "not-the-nonce") {
		t.Fatal("wrong nonce accepted")
	}
	if consumeNotifyNonce("", n) {
		t.Fatal("empty id accepted")
	}
	if consumeNotifyNonce("appr-2", "") {
		t.Fatal("empty nonce accepted")
	}
	if consumeNotifyNonce("other-id", n) {
		t.Fatal("nonce accepted for a different id")
	}
	// The legitimate pair still works after the failed attempts above.
	if !consumeNotifyNonce("appr-2", n) {
		t.Fatal("valid nonce rejected after failed attempts")
	}
}

func TestNotifyNonceExpiry(t *testing.T) {
	n := mintNotifyNonce("appr-3")
	notifyNonceMu.Lock()
	e := notifyNonces["appr-3"]
	e.expires = time.Now().Add(-time.Second)
	notifyNonces["appr-3"] = e
	notifyNonceMu.Unlock()
	if consumeNotifyNonce("appr-3", n) {
		t.Fatal("expired nonce accepted")
	}
}

func TestNotifyNonceRemintInvalidatesPrevious(t *testing.T) {
	first := mintNotifyNonce("appr-4")
	second := mintNotifyNonce("appr-4")
	if consumeNotifyNonce("appr-4", first) {
		t.Fatal("stale nonce from before a re-mint accepted")
	}
	if !consumeNotifyNonce("appr-4", second) {
		t.Fatal("current nonce rejected")
	}
}
