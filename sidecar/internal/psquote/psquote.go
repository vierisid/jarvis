// Package psquote builds PowerShell literals out of arbitrary strings. Shared
// by the sidecar and the installer, which are separate main packages and so
// cannot share an unexported helper.
package psquote

import (
	"encoding/base64"
	"strings"
)

// PowerShell single-quoted literals have exactly one escape: a doubled quote.
// The tokenizer also accepts the typographic single quotes U+2018..U+201B as
// quote characters (both opening and closing), so a value containing one of
// those could end the literal early unless it is doubled as well.
var quoteReplacer = strings.NewReplacer(
	"'", "''",
	"\u2018", "\u2018\u2018",
	"\u2019", "\u2019\u2019",
	"\u201a", "\u201a\u201a",
	"\u201b", "\u201b\u201b",
)

// SingleQuoted returns s as a PowerShell single-quoted literal, quotes included.
func SingleQuoted(s string) string {
	return "'" + quoteReplacer.Replace(s) + "'"
}

// UTF8Base64Expr returns a PowerShell expression that evaluates to s. The
// value travels as base64, so no quoting rules apply to it at all and non-ASCII
// text survives regardless of the console code page.
func UTF8Base64Expr(s string) string {
	return "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" +
		base64.StdEncoding.EncodeToString([]byte(s)) + "'))"
}
