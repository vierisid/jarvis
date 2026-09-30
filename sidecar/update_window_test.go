package main

import "testing"

func TestTrayUpdateLabelFor(t *testing.T) {
	cases := []struct {
		o    UpdateOffer
		want string
	}{
		{UpdateOffer{}, ""},
		{UpdateOffer{Version: "0.10.0"}, "Update to v0.10.0…"},
		{UpdateOffer{Version: "0.10.0", Blocked: true}, "Update required: v0.10.0…"},
		{UpdateOffer{Blocked: true}, "Update required…"},
	}
	for _, c := range cases {
		if got := trayUpdateLabelFor(c.o); got != c.want {
			t.Errorf("trayUpdateLabelFor(%+v) = %q, want %q", c.o, got, c.want)
		}
	}
}

func TestUpdateViewOf(t *testing.T) {
	manual := func(v string) string { return "manual@" + v }
	cases := []struct {
		name     string
		o        UpdateOffer
		canApply bool
		want     updateWindowView
	}{
		{
			name:     "offer",
			o:        UpdateOffer{Version: "0.10.0", Current: "0.9.7", State: UpdateState{Phase: updatePhaseAvailable, Version: "0.10.0"}},
			canApply: true,
			want:     updateWindowView{Version: "0.10.0", Current: "0.9.7", Phase: updatePhaseAvailable, CanApply: true},
		},
		{
			// The version is not on npm yet: it is only known from the state,
			// and the page offers the manual command for it.
			name:     "not published yet",
			o:        UpdateOffer{Current: "0.9.7", Blocked: true, State: UpdateState{Phase: updatePhaseUnavailable, Version: "0.10.0"}},
			canApply: true,
			want:     updateWindowView{Version: "0.10.0", Current: "0.9.7", Blocked: true, Phase: updatePhaseUnavailable, Manual: "manual@0.10.0", CanApply: true},
		},
		{
			name:     "cannot apply",
			o:        UpdateOffer{Version: "0.10.0", Current: "0.9.7", State: UpdateState{Phase: updatePhaseAvailable, Version: "0.10.0"}},
			canApply: false,
			want:     updateWindowView{Version: "0.10.0", Current: "0.9.7", Phase: updatePhaseAvailable, Manual: "manual@0.10.0"},
		},
		{
			name:     "failed keeps its own command",
			o:        UpdateOffer{Version: "0.10.0", Current: "0.9.7", State: UpdateState{Phase: updatePhaseFailed, Version: "0.10.0", Error: "boom", ManualCommand: "npm install -g x"}},
			canApply: true,
			want:     updateWindowView{Version: "0.10.0", Current: "0.9.7", Phase: updatePhaseFailed, Error: "boom", Manual: "npm install -g x", CanApply: true},
		},
		{
			name:     "blocked by an old brain",
			o:        UpdateOffer{Current: "0.9.7", Blocked: true},
			canApply: true,
			want:     updateWindowView{Current: "0.9.7", Blocked: true, Manual: "manual@", CanApply: true},
		},
	}
	for _, c := range cases {
		if got := updateViewOf(c.o, c.canApply, manual); got != c.want {
			t.Errorf("%s:\n got  %+v\n want %+v", c.name, got, c.want)
		}
	}
}
