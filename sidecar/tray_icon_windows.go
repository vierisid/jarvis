//go:build windows

package main

// Runtime tray-icon synthesis: the notification-area icon mirrors the pebble
// state with a coloured dot at the drop's corner, matching the macOS status
// item (jarvisMakeDropImage in tray_darwin.go). Windows ships only two static
// .ico resources (brand / connection-error), so the stateful variants are
// composed at runtime: pull the brand icon's colour plane into a writable
// 32-bit DIB, paint the dot with full alpha directly into the pixel buffer
// (GDI fills would zero the alpha channel and render invisible on ARGB icons),
// and build a new HICON with CreateIconIndirect. Tray thread only.

import (
	"unsafe"
)

var (
	procGetIconInfo        = pebbleUser32.NewProc("GetIconInfo")
	procCreateIconIndirect = pebbleUser32.NewProc("CreateIconIndirect")
	procDestroyIcon        = pebbleUser32.NewProc("DestroyIcon")
	procGetDIBits          = pebbleGdi32.NewProc("GetDIBits")
	procGetObjectW         = pebbleGdi32.NewProc("GetObjectW")
)

// ICONINFO / BITMAP (Win32 layouts).
type trayIconInfo struct {
	fIcon    int32
	xHotspot uint32
	yHotspot uint32
	hbmMask  uintptr
	hbmColor uintptr
}

type trayGdiBitmap struct {
	bmType       int32
	bmWidth      int32
	bmHeight     int32
	bmWidthBytes int32
	bmPlanes     uint16
	bmBitsPixel  uint16
	bmBits       uintptr
}

// trayStateDotRGB returns the dot colour for a pebble state code — the same
// palette the macOS dot uses (tray_darwin.go). ok==false → no dot (idle).
func trayStateDotRGB(code int) (r, g, b uint8, ok bool) {
	switch code {
	case 1: // listening
		return 0xE6, 0x3B, 0x2E, true
	case 2, 4: // thinking / working — light ink on the dark tile, like macOS dark
		return 0xEE, 0xF1, 0xF4, true
	case 3: // speaking
		return 0x2D, 0x78, 0xFF, true
	case 5: // asking
		return 0xEA, 0xA4, 0x0E, true
	case 6: // done
		return 0x2F, 0xA4, 0x5E, true
	case 7: // muted — grey (macOS dashes the outline instead)
		return 0x80, 0x80, 0x80, true
	}
	return 0, 0, 0, false
}

// traySynthesizeStateIcon composes brand icon + state dot into a fresh HICON.
// Returns 0 on any failure (caller falls back to the static brand icon). The
// returned icon is owned by the caller (DestroyIcon when swapped out).
func traySynthesizeStateIcon(code int) uintptr {
	dr, dg, db, ok := trayStateDotRGB(code)
	if !ok {
		return 0
	}
	hInstance, _, _ := procGetModuleHandleW.Call(0)
	base, _, _ := procLoadIconW.Call(hInstance, uintptr(trayIconBrandID))
	if base == 0 {
		return 0
	}
	var ii trayIconInfo
	if r, _, _ := procGetIconInfo.Call(base, uintptr(unsafe.Pointer(&ii))); r == 0 {
		return 0
	}
	// GetIconInfo hands us private copies of both bitmaps — ours to delete.
	defer procDeleteObjectGdi.Call(ii.hbmMask)
	if ii.hbmColor == 0 {
		return 0 // monochrome icon — nothing sensible to compose onto
	}
	defer procDeleteObjectGdi.Call(ii.hbmColor)

	var bm trayGdiBitmap
	if r, _, _ := procGetObjectW.Call(ii.hbmColor, unsafe.Sizeof(bm), uintptr(unsafe.Pointer(&bm))); r == 0 {
		return 0
	}
	w, h := int(bm.bmWidth), int(bm.bmHeight)
	if w < 8 || h < 8 || w > 256 || h > 256 {
		return 0
	}
	// The verbatim-alpha copy below only holds for a 32bpp colour plane; a
	// 24/8bpp decode would come back with alpha 0 everywhere → invisible icon.
	if bm.bmBitsPixel != 32 {
		return 0
	}

	hdc, _, _ := procCreateCompatibleDC.Call(0)
	if hdc == 0 {
		return 0
	}
	defer procDeleteDC.Call(hdc)

	// Writable top-down 32-bit DIB for the colour plane.
	bi := pblBitmapInfo{Header: pblBitmapInfoHeader{
		BiSize:        uint32(unsafe.Sizeof(pblBitmapInfoHeader{})),
		BiWidth:       int32(w),
		BiHeight:      -int32(h),
		BiPlanes:      1,
		BiBitCount:    32,
		BiCompression: 0, // BI_RGB
	}}
	var bits unsafe.Pointer
	dib, _, _ := procCreateDIBSection.Call(hdc, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if dib == 0 || bits == nil {
		return 0
	}
	defer procDeleteObjectGdi.Call(dib) // CreateIconIndirect copies the bitmaps

	// Copy the icon's pixels (alpha bytes come through verbatim for 32bpp).
	if r, _, _ := procGetDIBits.Call(hdc, ii.hbmColor, 0, uintptr(h), uintptr(bits), uintptr(unsafe.Pointer(&bi)), 0); r == 0 {
		return 0
	}

	// State dot: filled circle bottom-right, ~45% of the edge so it reads at
	// 16 px in the tray. Direct pixel writes keep alpha 0xFF (opaque).
	px := unsafe.Slice((*uint32)(bits), w*h)
	d := w * 9 / 20
	cx := float64(w) - float64(d)/2 - 1
	cy := float64(h) - float64(d)/2 - 1
	rad := float64(d) / 2
	dot := uint32(0xFF000000) | uint32(dr)<<16 | uint32(dg)<<8 | uint32(db)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			fx, fy := float64(x)+0.5-cx, float64(y)+0.5-cy
			if fx*fx+fy*fy <= rad*rad {
				px[y*w+x] = dot
			}
		}
	}

	ii2 := trayIconInfo{fIcon: 1, hbmMask: ii.hbmMask, hbmColor: dib}
	icon, _, _ := procCreateIconIndirect.Call(uintptr(unsafe.Pointer(&ii2)))
	return icon
}
