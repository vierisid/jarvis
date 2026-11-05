package main

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"strings"
)

// The Windows toast XML (notify_windows.go shows it through PowerShell's
// XmlDocument.LoadXml). Kept untagged so the escaping is tested on every
// platform, not only on a Windows runner: the title and body carry text the
// brain did not write itself (an AI-authored workflow step name, an approval's
// action description), and they reach an XML parser and a PowerShell script
// (only as base64 there, see toastScript).

// notifyURI is a button's protocol-activation target: jarvis://n?id=..&kind=..&a=..
func notifyURI(id, kind, action, nonce string) string {
	u := "jarvis://n?id=" + url.QueryEscape(id) + "&kind=" + url.QueryEscape(kind) + "&a=" + url.QueryEscape(action)
	if nonce != "" {
		u += "&n=" + url.QueryEscape(nonce)
	}
	return u
}

// toastXML builds the toast for n. The body click ("launch") always reviews
// in the app, never approves.
func toastXML(n Notification, nonce string) string {
	body := n.Body
	if n.Meta != "" {
		body += " \u00b7 " + n.Meta
	}
	var acts strings.Builder
	for _, a := range n.Actions {
		fmt.Fprintf(&acts, `<action content="%s" activationType="protocol" arguments="%s"/>`,
			xmlEscape(a.Label), xmlEscape(notifyURI(n.ID, n.Kind, a.ID, nonce)))
	}
	xml := `<toast activationType="protocol" launch="` + xmlEscape(notifyURI(n.ID, n.Kind, "review", nonce)) + `">` +
		`<visual><binding template="ToastGeneric">` +
		`<text>` + xmlEscape(n.Title) + `</text>` +
		`<text>` + xmlEscape(body) + `</text>` +
		`</binding></visual>`
	if acts.Len() > 0 {
		xml += `<actions>` + acts.String() + `</actions>`
	}
	return xml + `</toast>`
}

var xmlEscaper = strings.NewReplacer(
	"&", "&amp;",
	"<", "&lt;",
	">", "&gt;",
	`"`, "&quot;",
	"'", "&apos;",
)

// xmlEscape makes s safe as XML 1.0 text or a double-quoted attribute value.
// Besides the five markup characters it drops what XML 1.0 cannot carry at
// all, escaped or not: C0 controls other than tab, newline and carriage
// return, U+FFFE/U+FFFF, and invalid UTF-8 (#1160). One of those in a title
// made LoadXml throw, so the toast, with its Approve/Deny buttons, silently
// became the buttonless balloon fallback.
func xmlEscape(s string) string {
	s = strings.ToValidUTF8(s, "\ufffd")
	s = strings.Map(func(r rune) rune {
		if xmlChar(r) {
			return r
		}
		return -1
	}, s)
	return xmlEscaper.Replace(s)
}

// xmlChar is the XML 1.0 Char production.
func xmlChar(r rune) bool {
	return r == 0x09 || r == 0x0A || r == 0x0D ||
		(r >= 0x20 && r <= 0xD7FF) ||
		(r >= 0xE000 && r <= 0xFFFD) ||
		(r >= 0x10000 && r <= 0x10FFFF)
}

// toastScript is the PowerShell that shows the toast. The XML goes in as
// base64 (UTF-8), decoded by PowerShell itself, so no part of the title or
// body is ever PowerShell source. It used to sit in a single-quoted
// here-string, which a line starting '@ ends; escaping the ASCII quote was
// not enough, because PowerShell also accepts U+2018-U+201B as single quotes
// there (#1160). aumid is a fixed constant of ours.
func toastScript(xml, aumid string) string {
	payload := base64.StdEncoding.EncodeToString([]byte(xml))
	return `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null
[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]|Out-Null
$d=New-Object Windows.Data.Xml.Dom.XmlDocument
$d.LoadXml([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('` + payload + `')))
$t=New-Object Windows.UI.Notifications.ToastNotification $d
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('` + aumid + `').Show($t)`
}
