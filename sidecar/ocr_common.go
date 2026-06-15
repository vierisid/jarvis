package main

import "bytes"

// sanitizeOCRJSON makes OCR-engine JSON safe to decode. OCR output regularly
// contains raw control characters (e.g. BEL 0x07) inside string values, which
// are illegal in JSON — and some producers (notably Windows PowerShell 5.1's
// ConvertTo-Json) fail to escape them. Replacing every raw control byte
// (0x00–0x1F) with a space yields valid JSON without dropping word boundaries;
// legitimately escaped sequences ("\n" = backslash + 'n') are left untouched.
func sanitizeOCRJSON(b []byte) []byte {
	out := bytes.Clone(b)
	for i, c := range out {
		if c < 0x20 {
			out[i] = ' '
		}
	}
	return out
}
