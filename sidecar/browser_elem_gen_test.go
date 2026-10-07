package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// #676 on the sidecar: an element action that was REVIEWED carries the
// generation of the snapshot it was reviewed against, and the sidecar -- which
// owns the counter -- refuses it when the map is on any other generation.

// currentElemGen is the token the fixture's map is on right now, read the way
// the reply path reads it.
func currentElemGen(c *cdpClient) string {
	c.elemMu.Lock()
	defer c.elemMu.Unlock()
	return c.elemGenTokenLocked()
}

type elementActionCase struct {
	name   string
	params func(gen any) map[string]any
	make   func(cfg *SidecarConfig) RPCHandler
}

func elementActionCases() []elementActionCase {
	return []elementActionCase{
		{"click", func(gen any) map[string]any {
			return map[string]any{"element_id": float64(1), "elem_gen": gen}
		}, makeBrowserClickHandler},
		{"type", func(gen any) map[string]any {
			return map[string]any{"element_id": float64(1), "text": "x", "elem_gen": gen}
		}, makeBrowserTypeHandler},
		{"hover", func(gen any) map[string]any {
			return map[string]any{"element_id": float64(1), "elem_gen": gen}
		}, makeBrowserHoverHandler},
	}
}

func startElementAction(h RPCHandler, params map[string]any) (<-chan *RPCResult, <-chan error) {
	res := make(chan *RPCResult, 1)
	errs := make(chan error, 1)
	go func() {
		r, err := h(params)
		if err != nil {
			errs <- err
			return
		}
		res <- r
	}()
	return res, errs
}

// The headline: a reviewed generation that is not the map's refuses with the
// coded error, and NOTHING is sent to the browser -- not even the frame-tree
// read. Before #676 the handler ignored the unknown `elem_gen` param and went
// on to read the frame tree and dispatch, which is exactly why the brain must
// not send it to a sidecar that has not said it compares.
func TestReviewedElementActionRefusesASupersededSnapshot(t *testing.T) {
	for _, tc := range elementActionCases() {
		t.Run(tc.name, func(t *testing.T) {
			fb := newTypeFixture(t)
			reviewed := currentElemGen(fb.client)
			// A snapshot of the SAME document refilled the map after review: the
			// loaderId holds, so no other guard in refuseStaleElement can see it.
			fb.client.elemMu.Lock()
			fb.client.elemGen++
			fb.client.elemMu.Unlock()

			res, errs := startElementAction(tc.make(guardTestConfig()), tc.params(reviewed))
			select {
			case err := <-errs:
				var coded *codedError
				if !errors.As(err, &coded) || coded.code != browserSnapshotSupersededCode {
					t.Fatalf("%s error = %v, want a %s coded error", tc.name, err, browserSnapshotSupersededCode)
				}
				if !strings.Contains(err.Error(), "element [1]") || !strings.Contains(err.Error(), "nothing was done") {
					t.Fatalf("%s refusal = %q, want it to name the element and say nothing was done", tc.name, err)
				}
			case r := <-res:
				t.Fatalf("%s answered %v, want a refusal", tc.name, r.Result)
			case <-time.After(3 * time.Second):
				t.Fatalf("%s neither refused nor answered: it went on to talk to the browser", tc.name)
			}
			fb.noCommandWithin(300 * time.Millisecond)
		})
	}
}

// The other direction: the generation the call was reviewed against IS the
// map's, so the call goes on to the guards it always ran and dispatches.
// A regression guard, not a fail-first test: before #676 the param was ignored
// and this passed for that reason.
func TestReviewedClickOnTheReviewedSnapshotProceeds(t *testing.T) {
	fb := newTypeFixture(t)
	res, errs := startElementAction(makeBrowserClickHandler(guardTestConfig()),
		map[string]any{"element_id": float64(1), "elem_gen": currentElemGen(fb.client)})

	c := fb.nextCommand()
	if c.Method != "Page.getFrameTree" {
		t.Fatalf("first command = %q, want the document guard", c.Method)
	}
	fb.frameTreeReplyFull(c.ID, "https://app.example.com/", "L1", "https://app.example.com")
	fb.answerDomGeneration("ok")
	for i := 0; i < 3; i++ {
		c = fb.nextCommand()
		if c.Method != "Input.dispatchMouseEvent" {
			t.Fatalf("command %d = %q, want Input.dispatchMouseEvent", i, c.Method)
		}
		fb.reply(c.ID)
	}
	if got := awaitTypeResult(t, res, errs); !strings.Contains(got, "Clicked") {
		t.Fatalf("click result = %q, want success on the reviewed snapshot", got)
	}
}

// A key that is there and unusable was meant to bind the call. Ignoring it
// would be the fail-open the whole check removes, so it refuses -- before the
// browser is touched, or even launched.
func TestMalformedReviewedGenerationRefuses(t *testing.T) {
	for _, bad := range []any{float64(3), "", true, strings.Repeat("a", maxWireElemGen+1), []any{"x.3"}} {
		for _, tc := range elementActionCases() {
			fb := newTypeFixture(t)
			_, errs := startElementAction(tc.make(guardTestConfig()), tc.params(bad))
			select {
			case err := <-errs:
				var coded *codedError
				if !errors.As(err, &coded) || coded.code != browserSnapshotSupersededCode {
					t.Fatalf("%s with elem_gen=%v: error = %v, want a %s coded error", tc.name, bad, err, browserSnapshotSupersededCode)
				}
			case <-time.After(3 * time.Second):
				t.Fatalf("%s with elem_gen=%v did not refuse", tc.name, bad)
			}
			fb.noCommandWithin(100 * time.Millisecond)
		}
	}
}

// The counter restarts at zero on every cdpClient -- a relaunched browser, a
// headless switch, a restarted sidecar. Two maps on the same NUMBER must still
// hand out different generations, or a review of one passes against the other.
func TestTwoBrowsersOnTheSameCounterHandOutDifferentGenerations(t *testing.T) {
	a := newTypeFixture(t)
	b := newFakeBrowser(t)
	b.client.elemGen = a.client.elemGen
	ga, gb := currentElemGen(a.client), currentElemGen(b.client)
	if ga == gb {
		t.Fatalf("two clients on elemGen %d both hand out %q", a.client.elemGen, ga)
	}
	// And one client's token is stable until its map moves.
	if again := currentElemGen(a.client); again != ga {
		t.Fatalf("token moved without a fill: %q then %q", ga, again)
	}
	if len(ga) > maxWireElemGen {
		t.Fatalf("token %q is longer than the %d bytes an action accepts", ga, maxWireElemGen)
	}
}

// The reply side: a snapshot hands back the generation it FILLED, taken in the
// same critical section as the fill, and that is the value a reviewed action
// then passes with.
func TestSnapshotReplyCarriesTheGenerationItFilled(t *testing.T) {
	fb := newFakeBrowser(t)
	useFakeBrowserAsActiveCDP(t, fb.client)
	before := currentElemGen(fb.client)

	res, errs := startElementAction(makeBrowserSnapshotHandler(guardTestConfig()),
		map[string]any{"page_identity": true})

	c := fb.nextCommand()
	if c.Method != "Page.getFrameTree" {
		t.Fatalf("first command = %q, want Page.getFrameTree", c.Method)
	}
	fb.frameTreeReplyFull(c.ID, "https://app.example.com/", "L1", "https://app.example.com")
	fb.expectIsolatedWorld()
	c = fb.nextCommand()
	if c.Method != "Runtime.evaluate" {
		t.Fatalf("command = %q, want the snapshot script", c.Method)
	}
	fb.write(map[string]any{"id": c.ID, "result": map[string]any{
		"result": map[string]any{"value": `{"title":"App","url":"https://app.example.com/","text":"hi",` +
			`"elements":[{"id":1,"tag":"button","text":"Send","attrs":{},"x":300,"y":250}]}`},
	}})
	c = fb.nextCommand()
	if c.Method != "Page.getFrameTree" {
		t.Fatalf("command = %q, want the re-check", c.Method)
	}
	fb.frameTreeReplyFull(c.ID, "https://app.example.com/", "L1", "https://app.example.com")

	var reply pageReply
	select {
	case r := <-res:
		var ok bool
		if reply, ok = r.Result.(pageReply); !ok {
			t.Fatalf("snapshot result = %#v, want a pageReply", r.Result)
		}
	case err := <-errs:
		t.Fatalf("snapshot errored: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("snapshot never answered")
	}
	after := currentElemGen(fb.client)
	if reply.ElemGen == "" || reply.ElemGen == before {
		t.Fatalf("reply elem_gen = %q (before the fill: %q), want the generation the fill moved to", reply.ElemGen, before)
	}
	if reply.ElemGen != after {
		t.Fatalf("reply elem_gen = %q, want the map's own generation %q", reply.ElemGen, after)
	}
}

// A brain that did not ask for the structural reply gets the bare string it
// always parsed, generation or not.
func TestBareSnapshotReplyCarriesNoGeneration(t *testing.T) {
	res := browserPageResult("text", goodIdentity(), "abc.1", map[string]any{})
	if s, ok := res.Result.(string); !ok || s != "text" {
		t.Fatalf("bare reply = %#v, want the string unchanged", res.Result)
	}
}

// Advertised on every build, dev included: the brain refuses a reviewed click
// on a sidecar that does not say it compares, and a dev build that withheld it
// would refuse every reviewed remote click a developer tries.
func TestRegistrationAdvertisesTheElementGenerationOnEveryBuild(t *testing.T) {
	dev := newFakeUpdater(t, "dev", nativeMode(t))
	for _, updater := range [][]string{nil, dev.Features(), {featureUpdatePrompt, featureUpdateApply}} {
		got := registrationFeatures(updater)
		found := false
		for _, f := range got {
			found = found || f == featureBrowserElemGen
		}
		if !found {
			t.Fatalf("registration features %v (updater %v) lack %q", got, updater, featureBrowserElemGen)
		}
		for _, f := range updater {
			if !strings.Contains(strings.Join(got, ","), f) {
				t.Fatalf("registration features %v dropped the updater's %q", got, f)
			}
		}
	}
}
