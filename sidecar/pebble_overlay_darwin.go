//go:build darwin

package main

// Native pebble overlay — macOS.
//
// W2-T11: mirror of pebble_overlay_windows.go using AppKit NSWindow + NSView
// with Core Graphics drawing. NSWindow has true OS-level transparency
// natively (clear backgroundColor + isOpaque=false), so no per-pixel-alpha
// gymnastics are needed — we just override drawRect: and paint with
// CGContext primitives.
//
// IMPORTANT: AppKit windows + drawing are MAIN THREAD ONLY. The cgo bridge
// here uses dispatch_async(dispatch_get_main_queue(), ...) for everything
// that touches NSApp/NSWindow. The pebble's run goroutine pumps a 60fps
// timer that schedules a redraw on the main thread.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework AppKit -framework CoreGraphics

#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#include <string.h>
#include <stdlib.h>

// Forward declaration so the Objective-C category can call back into Go.
void jarvisPebbleSummonCallback(void);

// Global state shared across the AppKit objects (one pebble per process).
static NSWindow*  gPebbleWindow      = nil;
static NSView*    gPebbleView        = nil;
static NSTimer*   gPebbleTimer       = nil;
static int        gPebbleState       = 0; // 0=idle, 1=listening, 2=thinking, 3=speaking, 4=working
static int        gOffsetX           = 22;
static int        gOffsetY           = 26;
static double     gCurX              = 0;
static double     gCurY              = 0;
static unsigned long long gFrameTick = 0;
// gPebbleBodyText is the dynamic bubble copy (the live LLM transcript while
// speaking). Empty falls back to the per-state placeholder ("speaking…",
// "listening — go ahead.").
static NSString*  gPebbleBodyText    = nil;

// Riso colours (matched to the Windows pipeline / mock).
static const CGFloat kPaperR = 245.0/255.0, kPaperG = 242.0/255.0, kPaperB = 235.0/255.0;
static const CGFloat kInkR   = 26.0/255.0,  kInkG   = 26.0/255.0,  kInkB   = 26.0/255.0;
static const CGFloat kInk3R  = 106.0/255.0, kInk3G  = 103.0/255.0, kInk3B  = 96.0/255.0;
static const CGFloat kRuleR  = 203.0/255.0, kRuleG  = 195.0/255.0, kRuleB = 178.0/255.0;
static const CGFloat kAccR   = 194.0/255.0, kAccG   = 58.0/255.0,  kAccB   = 42.0/255.0;
static const CGFloat kWarmR  = 138.0/255.0, kWarmG  = 106.0/255.0, kWarmB  = 31.0/255.0;

static const CGFloat kWindowW = 360.0;
static const CGFloat kWindowH = 220.0;
static const CGFloat kAnchorX = 40.0;
static const CGFloat kAnchorY = 28.0;

@interface JarvisPebbleView : NSView
@end

@implementation JarvisPebbleView

- (BOOL)isFlipped { return YES; } // top-left origin to match the Windows code

- (void)drawRect:(NSRect)dirty {
    CGContextRef ctx = [[NSGraphicsContext currentContext] CGContext];

    // Anchor: pebble centre at (kAnchorX, kAnchorY) in view-local coords.
    CGFloat cx = kAnchorX;
    CGFloat cy = kAnchorY;

    // Frame-tick driven animations (matches Windows numbers).
    double phase4s = (double)(gFrameTick % 240) / 240.0;
    double phaseListen = (double)(gFrameTick % 57) / 57.0;
    double phaseThink = (double)(gFrameTick % 78) / 78.0;
    double phaseWork = (double)(gFrameTick % 96) / 96.0;

    if (gPebbleState == 0) {
        // IDLE — paper disc with shadow + hairline border + breathing dot.
        const CGFloat discR = 8.0;
        const CGFloat dotR = 2.0;
        const CGFloat shadowOffset = 2.0;

        // Shadow
        CGContextSetRGBFillColor(ctx, kInkR, kInkG, kInkB, 0.10);
        CGContextFillEllipseInRect(ctx, CGRectMake(cx-discR+shadowOffset, cy-discR+shadowOffset, discR*2, discR*2));
        // Disc
        CGContextSetRGBFillColor(ctx, kPaperR, kPaperG, kPaperB, 1.0);
        CGContextFillEllipseInRect(ctx, CGRectMake(cx-discR, cy-discR, discR*2, discR*2));
        // Border
        CGContextSetRGBStrokeColor(ctx, kRuleR, kRuleG, kRuleB, 1.0);
        CGContextSetLineWidth(ctx, 1.0);
        CGContextStrokeEllipseInRect(ctx, CGRectMake(cx-discR+0.5, cy-discR+0.5, discR*2-1, discR*2-1));
        // Breathing dot
        CGFloat breathe = 0.5 + 0.5*sin(phase4s * 2 * M_PI);
        CGFloat dotAlpha = 0.5 + 0.5*breathe;
        CGContextSetRGBFillColor(ctx, kInk3R, kInk3G, kInk3B, dotAlpha);
        CGContextFillEllipseInRect(ctx, CGRectMake(cx-dotR, cy-dotR, dotR*2, dotR*2));
        return;
    }

    if (gPebbleState == 1 || gPebbleState == 3) {
        // LISTENING (1) / SPEAKING (3) — wider pill with wave bars + bubble.
        BOOL speaking = (gPebbleState == 3);
        CGFloat pillW = 36.0;
        CGFloat pillH = 9.0;
        CGFloat shadowOffset = 2.0;

        CGFloat bgR = speaking ? kInkR : kPaperR;
        CGFloat bgG = speaking ? kInkG : kPaperG;
        CGFloat bgB = speaking ? kInkB : kPaperB;
        CGFloat brR = speaking ? kInkR : kAccR;
        CGFloat brG = speaking ? kInkG : kAccG;
        CGFloat brB = speaking ? kInkB : kAccB;
        CGFloat barR = speaking ? kPaperR : kAccR;
        CGFloat barG = speaking ? kPaperG : kAccG;
        CGFloat barB = speaking ? kPaperB : kAccB;

        // Pill shadow
        CGRect pillShadow = CGRectMake(cx-pillW+shadowOffset, cy-pillH+shadowOffset, pillW*2, pillH*2);
        CGPathRef shadowPath = CGPathCreateWithRoundedRect(pillShadow, pillH, pillH, NULL);
        CGContextAddPath(ctx, shadowPath);
        CGContextSetRGBFillColor(ctx, kInkR, kInkG, kInkB, 0.10);
        CGContextFillPath(ctx);
        CGPathRelease(shadowPath);

        // Pill fill
        CGRect pill = CGRectMake(cx-pillW, cy-pillH, pillW*2, pillH*2);
        CGPathRef pillPath = CGPathCreateWithRoundedRect(pill, pillH, pillH, NULL);
        CGContextAddPath(ctx, pillPath);
        CGContextSetRGBFillColor(ctx, bgR, bgG, bgB, 1.0);
        CGContextFillPath(ctx);

        // Pill border
        CGContextAddPath(ctx, pillPath);
        CGContextSetRGBStrokeColor(ctx, brR, brG, brB, 1.0);
        CGContextSetLineWidth(ctx, 1.0);
        CGContextStrokePath(ctx);
        CGPathRelease(pillPath);

        // 4 wave bars
        const int barCount = 4;
        const CGFloat barW = 2.0;
        const CGFloat barGap = 2.5;
        CGFloat totalW = barCount*barW + (barCount-1)*barGap;
        CGFloat startX = cx - totalW/2;
        for (int i = 0; i < barCount; i++) {
            CGFloat bx = startX + i*(barW+barGap);
            double phase = phaseListen + i*0.18;
            double v = 0.5 + 0.5*sin(phase * 2 * M_PI);
            CGFloat barH = 2.5 + v*5.5;
            CGRect bar = CGRectMake(bx, cy-barH/2, barW, barH);
            CGPathRef barPath = CGPathCreateWithRoundedRect(bar, barW/2, barW/2, NULL);
            CGContextAddPath(ctx, barPath);
            CGContextSetRGBFillColor(ctx, barR, barG, barB, 1.0);
            CGContextFillPath(ctx);
            CGPathRelease(barPath);
        }

        // Resolve body text (dynamic transcript wins over per-state placeholder).
        NSString* bodyText;
        if (gPebbleBodyText && [gPebbleBodyText length] > 0) {
            bodyText = gPebbleBodyText;
        } else {
            bodyText = speaking ? @"speaking…" : @"listening — go ahead.";
        }

        // Auto-fit bubble height: measure how tall the wrapped body text needs
        // to be inside the bubble's inner width, add eyebrow + paddings, clamp
        // to [108, 200]. Mirrors the Win32 computeBubbleBottom math.
        const CGFloat kBubbleX0 = 12, kBubbleY0 = 50, kBubbleX1 = 340;
        const CGFloat kBubbleY1Min = 108, kBubbleY1Max = 200;
        const CGFloat kBodyX0 = 26, kBodyX1 = 326, kBodyY0 = 84, kBubbleBottomP = 12;

        NSMutableParagraphStyle* paragraph = [[NSMutableParagraphStyle alloc] init];
        paragraph.lineBreakMode = NSLineBreakByWordWrapping;
        NSDictionary* bodyAttrsForMeasure = @{
            NSFontAttributeName: [NSFont systemFontOfSize:13 weight:NSFontWeightRegular],
            NSParagraphStyleAttributeName: paragraph,
        };
        NSRect measureRect = [bodyText boundingRectWithSize:NSMakeSize(kBodyX1-kBodyX0, CGFLOAT_MAX)
                                                    options:NSStringDrawingUsesLineFragmentOrigin | NSStringDrawingUsesFontLeading
                                                 attributes:bodyAttrsForMeasure];
        CGFloat textHeight = ceil(measureRect.size.height);
        CGFloat by1 = kBodyY0 + textHeight + kBubbleBottomP;
        if (by1 < kBubbleY1Min) by1 = kBubbleY1Min;
        if (by1 > kBubbleY1Max) by1 = kBubbleY1Max;

        // Bubble (auto-fit height)
        CGFloat cornerR = 6;
        CGFloat bs = 4; // shadow offset

        CGRect bubShadow = CGRectMake(kBubbleX0+bs, kBubbleY0+bs, kBubbleX1-kBubbleX0, by1-kBubbleY0);
        CGPathRef bubShadowPath = CGPathCreateWithRoundedRect(bubShadow, cornerR, cornerR, NULL);
        CGContextAddPath(ctx, bubShadowPath);
        CGContextSetRGBFillColor(ctx, kInkR, kInkG, kInkB, 0.12);
        CGContextFillPath(ctx);
        CGPathRelease(bubShadowPath);

        CGRect bub = CGRectMake(kBubbleX0, kBubbleY0, kBubbleX1-kBubbleX0, by1-kBubbleY0);
        CGPathRef bubPath = CGPathCreateWithRoundedRect(bub, cornerR, cornerR, NULL);
        CGContextAddPath(ctx, bubPath);
        CGContextSetRGBFillColor(ctx, bgR, bgG, bgB, 1.0);
        CGContextFillPath(ctx);
        CGContextAddPath(ctx, bubPath);
        CGContextSetRGBStrokeColor(ctx, speaking ? kInkR : kRuleR,
                                    speaking ? kInkG : kRuleG,
                                    speaking ? kInkB : kRuleB, 1.0);
        CGContextSetLineWidth(ctx, 1.0);
        CGContextStrokePath(ctx);
        CGPathRelease(bubPath);

        // Text — mono uppercase eyebrow + body
        CGFloat textR = speaking ? kPaperR : kInkR;
        CGFloat textG = speaking ? kPaperG : kInkG;
        CGFloat textB = speaking ? kPaperB : kInkB;
        CGFloat eyR = speaking ? kPaperR : kAccR;
        CGFloat eyG = speaking ? kPaperG : kAccG;
        CGFloat eyB = speaking ? kPaperB : kAccB;

        NSDictionary* eyebrowAttrs = @{
            NSFontAttributeName: [NSFont monospacedSystemFontOfSize:9 weight:NSFontWeightMedium],
            NSForegroundColorAttributeName: [NSColor colorWithCalibratedRed:eyR green:eyG blue:eyB alpha:1.0],
            NSKernAttributeName: @1.0,
        };
        NSAttributedString* eyebrow = [[NSAttributedString alloc] initWithString:@"JARVIS" attributes:eyebrowAttrs];
        [eyebrow drawAtPoint:NSMakePoint(26, 64)];

        NSDictionary* bodyAttrs = @{
            NSFontAttributeName: [NSFont systemFontOfSize:13 weight:NSFontWeightRegular],
            NSForegroundColorAttributeName: [NSColor colorWithCalibratedRed:textR green:textG blue:textB alpha:1.0],
            NSParagraphStyleAttributeName: paragraph,
        };
        NSAttributedString* body = [[NSAttributedString alloc] initWithString:bodyText attributes:bodyAttrs];
        // Wrap inside the bubble's auto-fitted body region. Last-line
        // truncation kicks in only when content would overflow the *capped*
        // card; otherwise the bubble grew to fit.
        CGFloat bodyDrawHeight = by1 - kBodyY0 - kBubbleBottomP/2.0;
        [body drawWithRect:NSMakeRect(kBodyX0, kBodyY0, kBodyX1-kBodyX0, bodyDrawHeight)
                   options:NSStringDrawingUsesLineFragmentOrigin | NSStringDrawingTruncatesLastVisibleLine
                   context:nil];
        return;
    }

    if (gPebbleState == 2) {
        // THINKING — pill with 3 bouncing dots
        CGFloat pillW = 14, pillH = 6, shadowOffset = 2;
        CGRect ps = CGRectMake(cx-pillW+shadowOffset, cy-pillH+shadowOffset, pillW*2, pillH*2);
        CGPathRef psPath = CGPathCreateWithRoundedRect(ps, pillH, pillH, NULL);
        CGContextAddPath(ctx, psPath);
        CGContextSetRGBFillColor(ctx, kInkR, kInkG, kInkB, 0.10);
        CGContextFillPath(ctx); CGPathRelease(psPath);

        CGRect p = CGRectMake(cx-pillW, cy-pillH, pillW*2, pillH*2);
        CGPathRef pp = CGPathCreateWithRoundedRect(p, pillH, pillH, NULL);
        CGContextAddPath(ctx, pp);
        CGContextSetRGBFillColor(ctx, kPaperR, kPaperG, kPaperB, 1.0);
        CGContextFillPath(ctx);
        CGContextAddPath(ctx, pp);
        CGContextSetRGBStrokeColor(ctx, kRuleR, kRuleG, kRuleB, 1.0);
        CGContextSetLineWidth(ctx, 1.0);
        CGContextStrokePath(ctx); CGPathRelease(pp);

        const int dotCount = 3;
        const CGFloat dotR = 1.4;
        const CGFloat dotGap = 4.0;
        CGFloat startX = cx - (dotCount-1)*dotGap/2;
        for (int i = 0; i < dotCount; i++) {
            double ph = phaseThink + i*0.15;
            double bounce = sin(ph * 2 * M_PI);
            CGFloat dy = -bounce*1.5;
            CGFloat alpha = 0.35 + 0.65 * MAX(0.0, bounce);
            CGContextSetRGBFillColor(ctx, kInk3R, kInk3G, kInk3B, alpha);
            CGContextFillEllipseInRect(ctx, CGRectMake(startX+i*dotGap-dotR, cy+dy-dotR, dotR*2, dotR*2));
        }
        return;
    }

    if (gPebbleState == 4) {
        // WORKING — pill with pulsing amber dot
        CGFloat pillW = 18, pillH = 7, shadowOffset = 2;
        CGRect ps = CGRectMake(cx-pillW+shadowOffset, cy-pillH+shadowOffset, pillW*2, pillH*2);
        CGPathRef psPath = CGPathCreateWithRoundedRect(ps, pillH, pillH, NULL);
        CGContextAddPath(ctx, psPath);
        CGContextSetRGBFillColor(ctx, kInkR, kInkG, kInkB, 0.10);
        CGContextFillPath(ctx); CGPathRelease(psPath);

        CGRect p = CGRectMake(cx-pillW, cy-pillH, pillW*2, pillH*2);
        CGPathRef pp = CGPathCreateWithRoundedRect(p, pillH, pillH, NULL);
        CGContextAddPath(ctx, pp);
        CGContextSetRGBFillColor(ctx, kPaperR, kPaperG, kPaperB, 1.0);
        CGContextFillPath(ctx);
        CGContextAddPath(ctx, pp);
        CGContextSetRGBStrokeColor(ctx, kRuleR, kRuleG, kRuleB, 1.0);
        CGContextSetLineWidth(ctx, 1.0);
        CGContextStrokePath(ctx); CGPathRelease(pp);

        double pulse = 0.85 + 0.15*sin(phaseWork * 2 * M_PI);
        CGFloat dotR = 2.5 * pulse;
        CGContextSetRGBFillColor(ctx, kWarmR, kWarmG, kWarmB, 1.0);
        CGContextFillEllipseInRect(ctx, CGRectMake(cx-pillW+5-dotR, cy-dotR, dotR*2, dotR*2));
        return;
    }
}
@end

// Schedule a frame: poll cursor, ease, reposition window, redraw view.
static void jarvisPebbleTick(void) {
    if (!gPebbleWindow || !gPebbleView) return;
    NSPoint mouse = [NSEvent mouseLocation];
    // mouseLocation is in screen coords with bottom-left origin; flip to top-left.
    NSScreen* main = [[NSScreen screens] firstObject];
    CGFloat screenH = main ? main.frame.size.height : 0;
    double cursorScreenX = mouse.x;
    double cursorScreenYFlipped = screenH - mouse.y;

    double tgtX = cursorScreenX + gOffsetX;
    double tgtY = cursorScreenYFlipped + gOffsetY;
    const double followFactor = 0.18;
    gCurX += (tgtX - gCurX) * followFactor;
    gCurY += (tgtY - gCurY) * followFactor;
    gFrameTick++;

    // Convert window's top-left target back to bottom-left frame origin.
    NSPoint topLeft = NSMakePoint(gCurX - kAnchorX, screenH - (gCurY - kAnchorY));
    NSRect frame = [gPebbleWindow frame];
    NSPoint origin = NSMakePoint(topLeft.x, topLeft.y - frame.size.height);
    [gPebbleWindow setFrameOrigin:origin];

    [gPebbleView setNeedsDisplay:YES];
}

// Called from the Go side via the cgo bridge — runs on main thread.
static void jarvisPebbleSpawnImpl(int offsetX, int offsetY) {
    if (gPebbleWindow != nil) return;
    gOffsetX = offsetX;
    gOffsetY = offsetY;

    NSRect frame = NSMakeRect(0, 0, kWindowW, kWindowH);
    gPebbleWindow = [[NSWindow alloc] initWithContentRect:frame
                                                styleMask:NSWindowStyleMaskBorderless
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
    [gPebbleWindow setOpaque:NO];
    [gPebbleWindow setBackgroundColor:[NSColor clearColor]];
    [gPebbleWindow setHasShadow:NO];
    [gPebbleWindow setLevel:NSScreenSaverWindowLevel];
    [gPebbleWindow setIgnoresMouseEvents:YES]; // global click-through
    [gPebbleWindow setHidesOnDeactivate:NO];
    [gPebbleWindow setCollectionBehavior:
        NSWindowCollectionBehaviorCanJoinAllSpaces |
        NSWindowCollectionBehaviorTransient |
        NSWindowCollectionBehaviorIgnoresCycle |
        NSWindowCollectionBehaviorFullScreenAuxiliary];

    gPebbleView = [[JarvisPebbleView alloc] initWithFrame:frame];
    [gPebbleWindow setContentView:gPebbleView];

    // Seed position at cursor + offset.
    NSPoint mouse = [NSEvent mouseLocation];
    NSScreen* main = [[NSScreen screens] firstObject];
    CGFloat screenH = main ? main.frame.size.height : 0;
    gCurX = mouse.x + offsetX;
    gCurY = (screenH - mouse.y) + offsetY;

    [gPebbleWindow makeKeyAndOrderFront:nil];

    // 60fps timer to repaint + reposition.
    gPebbleTimer = [NSTimer scheduledTimerWithTimeInterval:1.0/60.0
                                                    target:[NSBlockOperation blockOperationWithBlock:^{
                                                        jarvisPebbleTick();
                                                    }]
                                                  selector:@selector(main)
                                                  userInfo:nil
                                                   repeats:YES];
}

static void jarvisPebbleSetStateImpl(int state) {
    gPebbleState = state;
    if (gPebbleView) [gPebbleView setNeedsDisplay:YES];
}

static void jarvisPebbleSetTextImpl(const char* utf8) {
    if (utf8 == NULL) {
        gPebbleBodyText = nil;
    } else {
        gPebbleBodyText = [NSString stringWithUTF8String:utf8];
    }
    if (gPebbleView) [gPebbleView setNeedsDisplay:YES];
}

static void jarvisPebbleCloseImpl(void) {
    if (gPebbleTimer) {
        [gPebbleTimer invalidate];
        gPebbleTimer = nil;
    }
    if (gPebbleWindow) {
        [gPebbleWindow orderOut:nil];
        gPebbleWindow = nil;
    }
    gPebbleView = nil;
}

// Public C entry points marshalled onto the main thread.
void jarvisPebbleSpawn(int offsetX, int offsetY) {
    dispatch_async(dispatch_get_main_queue(), ^{ jarvisPebbleSpawnImpl(offsetX, offsetY); });
}

void jarvisPebbleSetState(int state) {
    dispatch_async(dispatch_get_main_queue(), ^{ jarvisPebbleSetStateImpl(state); });
}

void jarvisPebbleSetText(const char* utf8) {
    // Copy onto the heap so the Go-side buffer can be freed immediately.
    char* copy = utf8 ? strdup(utf8) : NULL;
    dispatch_async(dispatch_get_main_queue(), ^{
        jarvisPebbleSetTextImpl(copy);
        if (copy) free(copy);
    });
}

void jarvisPebbleClose(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ jarvisPebbleCloseImpl(); });
}
*/
import "C"

import (
	"sync/atomic"
	"unsafe"
)

type pebbleServiceDarwin struct {
	spawned        atomic.Bool
	summonCallback func()
}

func NewPebbleService() PebbleService {
	return &pebbleServiceDarwin{}
}

func (s *pebbleServiceDarwin) Spawn(spec PebbleSpec) error {
	if !s.spawned.CompareAndSwap(false, true) {
		return nil
	}
	ox := spec.CursorOffsetX
	oy := spec.CursorOffsetY
	if ox == 0 && oy == 0 {
		ox, oy = 22, 26
	}
	C.jarvisPebbleSpawn(C.int(ox), C.int(oy))
	return nil
}

func (s *pebbleServiceDarwin) SetState(state PebbleState) error {
	var i C.int
	switch state {
	case PebbleListening:
		i = 1
	case PebbleThinking:
		i = 2
	case PebbleSpeaking:
		i = 3
	case PebbleWorking:
		i = 4
	default:
		i = 0
	}
	C.jarvisPebbleSetState(i)
	return nil
}

func (s *pebbleServiceDarwin) SetText(text string) error {
	if text == "" {
		C.jarvisPebbleSetText(nil)
		return nil
	}
	cstr := C.CString(text)
	defer C.free(unsafe.Pointer(cstr))
	C.jarvisPebbleSetText(cstr)
	return nil
}

func (s *pebbleServiceDarwin) Close() error {
	if !s.spawned.CompareAndSwap(true, false) {
		return nil
	}
	C.jarvisPebbleClose()
	return nil
}

func (s *pebbleServiceDarwin) OnSummon(callback func()) {
	s.summonCallback = callback
	// macOS hotkey integration (NSEvent global monitor) lives in the
	// hotkeys_darwin.go path which is currently a stub. Wiring it to fire
	// summonCallback is part of the macOS hotkey ticket.
}
