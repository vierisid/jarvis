package main

// X.500 subject-DN parsing for the Windows publisher pin. Platform-neutral so
// it can be unit-tested on any runner (the pin itself is Windows-only).

import "strings"

// subjectCN extracts the CN component from an X.500 subject DN as PowerShell
// renders it ("CN=Acme, Inc., O=Acme, C=US"). Quoted values are unwrapped;
// escaped commas (\,) do not terminate the value.
func subjectCN(subject string) (string, bool) {
	for _, part := range splitDN(subject) {
		part = strings.TrimSpace(part)
		if v, ok := strings.CutPrefix(part, "CN="); ok {
			v = strings.TrimSpace(v)
			if len(v) >= 2 && strings.HasPrefix(v, `"`) && strings.HasSuffix(v, `"`) {
				v = v[1 : len(v)-1]
			}
			return unescapeDNValue(v), true
		}
	}
	return "", false
}

// unescapeDNValue reverses RFC 4514 escaping: \x for any special character
// (, + " \ < > ; = and leading/trailing space) and \XX hex pairs. Reversing
// only \, would leave a CN like `Jarvis \+ Co` mismatched against the pin and
// reject a legitimately signed payload.
func unescapeDNValue(v string) string {
	var b strings.Builder
	for i := 0; i < len(v); i++ {
		if v[i] != '\\' || i+1 >= len(v) {
			b.WriteByte(v[i])
			continue
		}
		if i+2 < len(v) {
			if hi, ok := hexVal(v[i+1]); ok {
				if lo, ok2 := hexVal(v[i+2]); ok2 {
					b.WriteByte(hi<<4 | lo)
					i += 2
					continue
				}
			}
		}
		b.WriteByte(v[i+1])
		i++
	}
	return b.String()
}

func hexVal(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// splitDN splits on unescaped, unquoted commas.
func splitDN(dn string) []string {
	var parts []string
	var cur strings.Builder
	inQuotes := false
	for i := 0; i < len(dn); i++ {
		c := dn[i]
		switch {
		case c == '\\' && i+1 < len(dn):
			cur.WriteByte(c)
			i++
			cur.WriteByte(dn[i])
		case c == '"':
			inQuotes = !inQuotes
			cur.WriteByte(c)
		case c == ',' && !inQuotes:
			parts = append(parts, cur.String())
			cur.Reset()
		default:
			cur.WriteByte(c)
		}
	}
	return append(parts, cur.String())
}
