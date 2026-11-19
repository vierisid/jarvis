package main

// notch.open_url - the brain asks for a web page to be opened in the person's
// own browser. One thing uses it: signing in to the server through which one
// person's Jarvis talks to another's (docs/peers/README.md). The sign-in is
// done by the person, in their browser, on a page of that server; the brain
// only has the page opened.
//
// Only a page that is reached safely is opened: https, a host, no name or
// password inside the address, and no longer than an address can sensibly
// be. Anything else is refused here, whatever the brain checked before.
//
//	Params: { "url": string }
//	Result: { "opened": true }

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// notchOpenURLMax is the longest address that is opened. A sign-in address
// carries a challenge and a state and stays well under it.
const notchOpenURLMax = 4096

// notchOpenURLAllowed says whether the address is one to open, and gives it
// back as it will be handed to the browser.
func notchOpenURLAllowed(raw string) (string, bool) {
	if raw == "" || len(raw) > notchOpenURLMax || strings.TrimSpace(raw) != raw {
		return "", false
	}
	for _, r := range raw {
		// No control characters and no spaces: what is handed to the browser is one address.
		if r <= 0x20 || r == 0x7f {
			return "", false
		}
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Opaque != "" {
		return "", false
	}
	return parsed.String(), true
}

func makeNotchOpenURLHandler(open func(ctx context.Context, url string) error) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		raw, _ := params["url"].(string)
		address, ok := notchOpenURLAllowed(raw)
		if !ok {
			return nil, fmt.Errorf("notch.open_url: not an address that is opened")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := open(ctx, address); err != nil {
			return nil, fmt.Errorf("notch.open_url: the browser did not take it")
		}
		return &RPCResult{Result: map[string]any{"opened": true}}, nil
	}
}
