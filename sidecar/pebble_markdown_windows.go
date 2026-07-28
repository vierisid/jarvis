//go:build windows

package main

import (
	"regexp"
	"strings"
	"syscall"
	"unsafe"
)

// Markdown rendering for the speaking bubble.
//
// The LLM answer arrives as raw markdown. Showing it verbatim looks broken
// (literal **bold** and ## headings) and reads small. This renders it as
// readable, styled text: headings larger + bold, bullet / numbered lists with
// hanging markers, blockquotes and code lines muted/mono, paragraph spacing.
// Inline emphasis markers are stripped (the words are kept) — at this size the
// block structure is what carries meaning, not inline bold runs.
//
// Two passes share one code path: computeBubbleBottom measures (draw=false) to
// size the card, drawBubbleText measures + paints (draw=true). Fonts are
// created once per pass and every SelectObject is paired with a restore before
// the matching DeleteObject (a font that is still selected can't be deleted —
// that was the GDI handle leak that crashed the overlay after a few minutes).

type mdStyle int

const (
	mdNormal mdStyle = iota
	mdH1
	mdH2
	mdH3
	mdBullet
	mdNumber
	mdCode
	mdQuote
	mdSpacer // blank line — vertical gap only
)

type mdBlock struct {
	style  mdStyle
	text   string
	indent int32 // extra left indent (list / quote), in px
}

var (
	mdLinkRe = regexp.MustCompile(`\[([^\]]+)\]\([^)]*\)`)
	mdNumRe  = regexp.MustCompile(`^\d+[.)]\s+`)
)

// stripInlineMd removes inline emphasis/code/link syntax, keeping the text.
func stripInlineMd(s string) string {
	s = mdLinkRe.ReplaceAllString(s, "$1") // [text](url) -> text
	// Order matters: strip the doubled markers before the single ones.
	for _, tok := range []string{"**", "__", "~~", "`", "*", "_"} {
		s = strings.ReplaceAll(s, tok, "")
	}
	return strings.TrimSpace(s)
}

// parseMarkdownBlocks splits raw markdown into renderable blocks.
func parseMarkdownBlocks(src string) []mdBlock {
	lines := strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n")
	blocks := make([]mdBlock, 0, len(lines))
	inFence := false
	for _, raw := range lines {
		trimmed := strings.TrimSpace(raw)
		if strings.HasPrefix(trimmed, "```") {
			inFence = !inFence
			continue
		}
		if inFence {
			blocks = append(blocks, mdBlock{style: mdCode, text: raw, indent: 8})
			continue
		}
		if trimmed == "" {
			blocks = append(blocks, mdBlock{style: mdSpacer})
			continue
		}
		switch {
		case strings.HasPrefix(trimmed, "### "):
			blocks = append(blocks, mdBlock{style: mdH3, text: stripInlineMd(trimmed[4:])})
		case strings.HasPrefix(trimmed, "## "):
			blocks = append(blocks, mdBlock{style: mdH2, text: stripInlineMd(trimmed[3:])})
		case strings.HasPrefix(trimmed, "# "):
			blocks = append(blocks, mdBlock{style: mdH1, text: stripInlineMd(trimmed[2:])})
		case strings.HasPrefix(trimmed, "> "):
			blocks = append(blocks, mdBlock{style: mdQuote, text: stripInlineMd(trimmed[2:]), indent: 12})
		case strings.HasPrefix(trimmed, "- "), strings.HasPrefix(trimmed, "* "), strings.HasPrefix(trimmed, "+ "):
			blocks = append(blocks, mdBlock{style: mdBullet, text: "•   " + stripInlineMd(trimmed[2:]), indent: 12})
		case mdNumRe.MatchString(trimmed):
			blocks = append(blocks, mdBlock{style: mdNumber, text: stripInlineMd(trimmed), indent: 12})
		default:
			blocks = append(blocks, mdBlock{style: mdNormal, text: stripInlineMd(trimmed)})
		}
	}
	return blocks
}

// makeMdFont builds an antialiased font. px is negative for character height.
func makeMdFont(px, weight int32, face string) uintptr {
	f, _ := syscall.UTF16PtrFromString(face)
	font, _, _ := procCreateFontW.Call(
		uintptr(px), 0, 0, 0,
		uintptr(weight),
		0, 0, 0,
		uintptr(ansiCharset), 0, 0,
		uintptr(antialiasedQuality), 0,
		uintptr(unsafe.Pointer(f)),
	)
	return font
}

// mdFonts is the small set of fonts the markdown renderer needs. Created once
// per pass; delete() frees them (none must be selected into the DC by then).
type mdFonts struct {
	body, h1, h2, h3, code uintptr
}

func newMdFonts() mdFonts {
	const sans = "Familjen Grotesk"
	return mdFonts{
		body: makeMdFont(-16, fwNormal, sans), // body grew 13 -> 16 (was unreadable)
		h1:   makeMdFont(-22, fwBold, sans),
		h2:   makeMdFont(-19, fwBold, sans),
		h3:   makeMdFont(-16, fwBold, sans),
		code: makeMdFont(-14, fwNormal, "Spline Sans Mono"),
	}
}

func (f mdFonts) delete() {
	procDeleteObjectGdi.Call(f.body)
	procDeleteObjectGdi.Call(f.h1)
	procDeleteObjectGdi.Call(f.h2)
	procDeleteObjectGdi.Call(f.h3)
	procDeleteObjectGdi.Call(f.code)
}

// blockFont/blockColor/blockTopGap describe how each style renders.
func (f mdFonts) blockAttrs(st mdStyle) (font uintptr, col uint32, topGap int32) {
	switch st {
	case mdH1:
		return f.h1, colorRef(pebbleInkR, pebbleInkG, pebbleInkB), 10
	case mdH2:
		return f.h2, colorRef(pebbleInkR, pebbleInkG, pebbleInkB), 9
	case mdH3:
		return f.h3, colorRef(pebbleInkR, pebbleInkG, pebbleInkB), 8
	case mdCode:
		return f.code, colorRef(pebbleInk3R, pebbleInk3G, pebbleInk3B), 2
	case mdQuote:
		return f.body, colorRef(pebbleInk3R, pebbleInk3G, pebbleInk3B), 3
	default: // normal / bullet / number
		return f.body, colorRef(pebbleInkR, pebbleInkG, pebbleInkB), 3
	}
}

// layoutMarkdown measures (and optionally draws) the blocks between x0..x1,
// starting at yStart, stopping before maxY. Returns the y after the last block.
// memDC must already have BkMode = transparent set by the caller.
func layoutMarkdown(memDC uintptr, fonts mdFonts, blocks []mdBlock, x0, x1, yStart, maxY int32, draw bool) int32 {
	y := yStart
	nullTerm := int32(-1)
	for _, b := range blocks {
		if b.style == mdSpacer {
			y += 6
			continue
		}
		font, col, topGap := fonts.blockAttrs(b.style)
		y += topGap
		if y >= maxY {
			break
		}
		left := x0 + b.indent
		prev, _, _ := procSelectObject.Call(memDC, font)

		str, serr := syscall.UTF16PtrFromString(b.text)
		if serr != nil { // interior NUL in daemon text → skip, don't DrawTextW(NULL)
			procSelectObject.Call(memDC, prev)
			continue
		}
		// Measure wrapped height: CALCRECT keeps the width and returns Bottom.
		m := pblRect{Left: left, Top: y, Right: x1, Bottom: y}
		procDrawTextW.Call(memDC,
			uintptr(unsafe.Pointer(str)), uintptr(nullTerm),
			uintptr(unsafe.Pointer(&m)),
			uintptr(uint32(dtLeft|dtWordBreak|dtCalcRect)),
		)
		h := m.Bottom - y
		if h < 1 {
			h = 1
		}

		if draw {
			procSetTextColor.Call(memDC, uintptr(col))
			d := pblRect{Left: left, Top: y, Right: x1, Bottom: y + h}
			procDrawTextW.Call(memDC,
				uintptr(unsafe.Pointer(str)), uintptr(nullTerm),
				uintptr(unsafe.Pointer(&d)),
				uintptr(uint32(dtLeft|dtWordBreak)),
			)
		}
		procSelectObject.Call(memDC, prev) // restore before the fonts get deleted
		y += h + 3                         // inter-block leading
	}
	return y
}
