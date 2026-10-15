package main

import (
	"strings"
	"testing"
	"time"
)

func requireBrowserOutcome(t *testing.T, res <-chan *RPCResult, errs <-chan error, code string) {
	t.Helper()
	select {
	case err := <-errs:
		if got := handlerRPCError(err); got.Code != code {
			t.Fatalf("outcome = %#v, want %s", got, code)
		}
	case r := <-res:
		t.Fatalf("refusal was returned as success: %#v", r)
	case <-time.After(3 * time.Second):
		t.Fatal("handler did not answer")
	}
}

func TestBrowserOutcomeFeatureAdvertised(t *testing.T) {
	for _, update := range [][]string{nil, {"update_prompt"}} {
		if !strings.Contains(strings.Join(registrationFeatures(update), ","), featureBrowserActionOutcomes) {
			t.Fatal("missing browser outcome negotiation")
		}
	}
}

func TestBrowserOutcomeStaleDocumentHasNoInput(t *testing.T) {
	for _, tc := range elementActionCases() {
		t.Run(tc.name, func(t *testing.T) {
			fb := newTypeFixture(t)
			params := tc.params(currentElemGen(fb.client))
			params["action_outcome"] = true
			res, errs := startElementAction(tc.make(guardTestConfig()), params)
			c := fb.nextCommand()
			if c.Method != "Page.getFrameTree" {
				t.Fatalf("unexpected command: %s", c.Method)
			}
			fb.frameTreeReplyFull(c.ID, "https://app.example.com/other", "L2", "https://app.example.com")
			requireBrowserOutcome(t, res, errs, "BROWSER_ACTION_REFUSED")
			fb.noCommandWithin(100 * time.Millisecond)
		})
	}
}

func TestBrowserOutcomeFocusLossRetainsPartialEffect(t *testing.T) {
	for _, afterInsert := range []bool{false, true} {
		t.Run(map[bool]string{false: "after-clear", true: "after-insert"}[afterInsert], func(t *testing.T) {
			fb := newTypeFixture(t)
			res, errs := callTypeHandler(t, map[string]any{"element_id": float64(1), "text": "fixture", "action_outcome": true})
			c := fb.nextCommand()
			fb.frameTreeReplyFull(c.ID, "https://app.example.com/", "L1", "https://app.example.com")
			fb.answerDomGeneration("ok")
			c = fb.nextCommand() // Focus/clear already ran.
			fb.write(map[string]any{"id": c.ID, "result": map[string]any{"result": map[string]any{"value": "ok"}}})
			c = fb.nextCommand() // First focus check.
			if afterInsert {
				fb.write(map[string]any{"id": c.ID, "result": map[string]any{"result": map[string]any{"value": "ok"}}})
				c = fb.nextCommand()
				if c.Method != "Input.insertText" {
					t.Fatalf("wanted insert, got %s", c.Method)
				}
				fb.reply(c.ID)
				c = fb.nextCommand()
			}
			fb.write(map[string]any{"id": c.ID, "result": map[string]any{"result": map[string]any{"value": "not_focused"}}})
			requireBrowserOutcome(t, res, errs, "BROWSER_ACTION_UNCERTAIN")
			fb.noCommandWithin(100 * time.Millisecond)
		})
	}
}

func TestBrowserOutcomeOptInPreservesLegacyReply(t *testing.T) {
	for _, opt := range []any{nil, false, "true", float64(1)} {
		r, err := browserActionRefusal(map[string]any{"action_outcome": opt}, "legacy refusal", false)
		if err != nil || r.Result != "legacy refusal" {
			t.Fatalf("legacy reply changed: %v %v", r, err)
		}
	}
}
