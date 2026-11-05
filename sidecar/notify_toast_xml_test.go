package main

import (
	"encoding/base64"
	"encoding/xml"
	"io"
	"net/url"
	"strings"
	"testing"
)

// #1160: the Windows toast carries text the brain did not write itself (an
// AI-authored workflow step name, an approval's action description). It must
// parse as XML whatever that text says and keep the text as text. It reaches
// PowerShell only as base64 (TestToastScriptCarriesTheXMLOnlyAsBase64); the
// no-single-quote check below is defence in depth on top of that.

type parsedToast struct {
	Launch  string
	Texts   []string
	Actions []struct{ Content, Arguments string }
}

func parseToast(t *testing.T, doc string) parsedToast {
	t.Helper()
	var p parsedToast
	d := xml.NewDecoder(strings.NewReader(doc))
	d.Strict = true
	var inText bool
	var text strings.Builder
	for {
		tok, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("toast XML does not parse (LoadXml would throw and the toast would fall back to a buttonless balloon): %v\n%s", err, doc)
		}
		switch el := tok.(type) {
		case xml.StartElement:
			attr := func(name string) string {
				for _, a := range el.Attr {
					if a.Name.Local == name {
						return a.Value
					}
				}
				return ""
			}
			switch el.Name.Local {
			case "toast":
				p.Launch = attr("launch")
			case "text":
				inText = true
				text.Reset()
			case "action":
				p.Actions = append(p.Actions, struct{ Content, Arguments string }{attr("content"), attr("arguments")})
			case "visual", "binding", "actions":
			default:
				t.Errorf("unexpected element <%s>: text became markup", el.Name.Local)
			}
		case xml.CharData:
			if inText {
				text.Write(el)
			}
		case xml.EndElement:
			if el.Name.Local == "text" {
				inText = false
				p.Texts = append(p.Texts, text.String())
			}
		}
	}
	return p
}

func TestToastXMLCarriesHostileTextAsText(t *testing.T) {
	hostile := []struct{ name, in, want string }{
		{"markup", `</text></binding><action content="x"/>`, `</text></binding><action content="x"/>`},
		{"attribute break", `" launch="jarvis://n?a=approve`, `" launch="jarvis://n?a=approve`},
		{"here-string end", "done\n'@\nStart-Process calc\n@'", "done\n'@\nStart-Process calc\n@'"},
		{"cdata end", "a]]>b", "a]]>b"},
		{"entity", "&amp; &#x41; &bogus;", "&amp; &#x41; &bogus;"},
		{"non-ascii", "Caf\u00e9 \u65e5\u672c \U0001f680", "Caf\u00e9 \u65e5\u672c \U0001f680"},
		// What XML 1.0 cannot carry at all is dropped, not passed on to make
		// the parser throw.
		{"escape sequence", "\x1b[31mred\x1b[0m", "[31mred[0m"},
		{"nul and bell", "a\x00b\x07c", "abc"},
		{"noncharacter", "a\ufffeb\uffffc", "abc"},
		{"invalid utf-8", "a\xffb", "a\ufffdb"},
		// (\r\n would come back as \n: XML end-of-line handling, not escaping.)
		{"tabs and newlines kept", "a\tb\nc", "a\tb\nc"},
	}
	for _, tc := range hostile {
		t.Run(tc.name, func(t *testing.T) {
			n := Notification{
				ID: "appr-1", Kind: "approval", Title: tc.in, Body: tc.in, Meta: "external",
				Actions: []NotifyAction{{ID: "deny", Label: tc.in}, {ID: "approve", Label: "Approve", Primary: true}},
			}
			doc := toastXML(n, "nonce-1")
			if strings.Contains(doc, "'") {
				t.Fatalf("toast XML contains a single quote: a line starting '@ would end the PowerShell here-string\n%s", doc)
			}
			p := parseToast(t, doc)
			if len(p.Texts) != 2 || p.Texts[0] != tc.want || p.Texts[1] != tc.want+" \u00b7 external" {
				t.Errorf("texts = %q, want [%q %q]", p.Texts, tc.want, tc.want+" \u00b7 external")
			}
			if len(p.Actions) != 2 || p.Actions[0].Content != tc.want || p.Actions[1].Content != "Approve" {
				t.Fatalf("actions = %+v", p.Actions)
			}
			// The buttons still say what they did before the hostile text.
			for i, want := range []string{"deny", "approve"} {
				u, err := url.Parse(p.Actions[i].Arguments)
				if err != nil {
					t.Fatal(err)
				}
				q := u.Query()
				if q.Get("a") != want || q.Get("id") != "appr-1" || q.Get("n") != "nonce-1" {
					t.Errorf("button %d arguments = %q", i, p.Actions[i].Arguments)
				}
			}
			if u, _ := url.Parse(p.Launch); u == nil || u.Query().Get("a") != "review" {
				t.Errorf("launch = %q, want a review", p.Launch)
			}
		})
	}
}

// Hostile ids and kinds reach the URIs, not the markup.
func TestToastXMLEscapesIdentifiers(t *testing.T) {
	n := Notification{ID: `x"&a=approve'`, Kind: "<k>", Title: "t", Body: "b",
		Actions: []NotifyAction{{ID: "review", Label: "Open Jarvis"}}}
	p := parseToast(t, toastXML(n, ""))
	u, err := url.Parse(p.Actions[0].Arguments)
	if err != nil {
		t.Fatal(err)
	}
	if q := u.Query(); q.Get("id") != n.ID || q.Get("kind") != n.Kind || q.Get("a") != "review" || len(q["a"]) != 1 {
		t.Errorf("arguments = %q, query %v", p.Actions[0].Arguments, u.Query())
	}
}

// #1160 review: PowerShell ends a single-quoted here-string at a line starting
// with any single-quote-class character followed by @, U+2018-U+201B included,
// so escaping the ASCII quote did not keep the title out of the script. Now no
// title or body text is in the script at all: only base64 of the XML.
func TestToastScriptCarriesTheXMLOnlyAsBase64(t *testing.T) {
	hostile := []string{
		"x\n\u2019@)\nWrite-Output INJECTED\n$y=(@\u2019\n",
		"x\r\u2018@)\r\nWrite-Output INJECTED",
		"x\n'@)\nWrite-Output INJECTED\n",
		"\u201a\u201b' \" `$(Write-Output INJECTED)",
	}
	template := toastScript("", "Jarvis.Sidecar")
	for _, h := range hostile {
		n := Notification{ID: h, Kind: "workflow", Title: h, Body: h, Meta: h,
			Actions: []NotifyAction{{ID: "review", Label: h}}}
		doc := toastXML(n, "nonce")
		script := toastScript(doc, "Jarvis.Sidecar")
		start := strings.Index(script, "FromBase64String('")
		if start < 0 {
			t.Fatalf("no base64 payload in the script:\n%s", script)
		}
		start += len("FromBase64String('")
		end := strings.Index(script[start:], "'")
		if end < 0 {
			t.Fatal("unterminated payload")
		}
		payload := script[start : start+end]
		if strings.Trim(payload, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=") != "" {
			t.Fatalf("payload is not plain base64: %q", payload)
		}
		decoded, err := base64.StdEncoding.DecodeString(payload)
		if err != nil || string(decoded) != doc {
			t.Fatalf("payload does not decode to the toast XML (err %v)", err)
		}
		// Everything but the payload is our fixed template.
		if script[:start]+script[start+end:] != template {
			t.Fatalf("script differs from the template outside the payload:\n%s", script)
		}
		if strings.Contains(script, "INJECTED") {
			t.Fatal("hostile text reached the script")
		}
	}
}
