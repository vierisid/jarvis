//go:build darwin

package main

// Native pebble overlay — macOS (AppKit NSWindow + NSView, Core Graphics).
//
// W2-T11: mirror of pebble_overlay_windows.go / pebble_overlay_linux.go.
// NSWindow has true OS-level transparency natively (clear backgroundColor +
// isOpaque=false), so we just override drawRect: and paint with CGContext.
//
// Motion + state + the [POINT:..] machine + lifecycle live in the shared
// pebbleCore runtime (pebble_runtime.go); the frame loop runs on its own
// goroutine and pushes each eased frame here via jarvisPebblePresent. This file
// owns only the native window + drawing.
//
// IMPORTANT: AppKit windows + drawing are MAIN THREAD ONLY. The cgo bridge here
// marshals everything that touches NSApp/NSWindow onto the main queue via
// dispatch_async(dispatch_get_main_queue(), ...). The process's Cocoa main
// runloop must be running for those blocks to drain (the panels webview service
// arranges that on macOS, as it did before this migration).

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework AppKit -framework CoreGraphics

#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#include <string.h>
#include <stdlib.h>

// Global state shared across the AppKit objects (one pebble per process).
// Position/easing/offset moved to pebbleCore (Go) — no gCurX/gCurY/gOffset/
// gTimer here anymore. State + frame tick are pushed every frame by
// jarvisPebblePresent (the shared Go runtime drives motion); drawRect: reads them.
static NSWindow*  gPebbleWindow      = nil;
static NSView*    gPebbleView        = nil;
static int        gPebbleState       = 0; // 0=idle, 1=listening, 2=thinking, 3=speaking, 4=working
static unsigned long long gFrameTick = 0;
// Awareness/answer indicators pushed each frame (§5.3): gEye = awareness/OCR
// firing, gBlinded = awareness hard-paused (struck-through eye), gAnswerOverflow
// = the speaking bubble should show the "open full" button.
static int        gEye               = 0;
static int        gBlinded           = 0;
static int        gAnswerOverflow    = 0;
// gPebbleBodyText is the dynamic bubble copy (the live LLM transcript while
// speaking). nil falls back to the per-state placeholder ("speaking…",
// "listening — go ahead."). ARC manages the strong reference.
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

// draw_eye_cg paints the awareness eye (§5.3): lens outline + iris dot (pulses
// while awareness fires), muted + struck-through when blinded. Mirrors the
// Windows drawEyeGlyph / Linux draw_eye_glyph. Drawn on top of the state glyph.
static void draw_eye_cg(CGContextRef ctx) {
    if (!gEye && !gBlinded) return;
    CGFloat ex = kAnchorX + 14.0, ey = kAnchorY - 10.0;
    const CGFloat lensR = 4.5, irisR = 1.4;
    CGFloat r, g, b;
    if (gBlinded) { r = kInk3R; g = kInk3G; b = kInk3B; }
    else          { r = kAccR;  g = kAccG;  b = kAccB;  }

    CGContextSetRGBStrokeColor(ctx, r, g, b, 220/255.0);
    CGContextSetLineWidth(ctx, 1.0);
    CGContextStrokeEllipseInRect(ctx, CGRectMake(ex-lensR, ey-lensR, lensR*2, lensR*2));

    CGFloat irisA = 220/255.0;
    if (gEye && !gBlinded) {
        int cf = 75;
        double ph = (double)(gFrameTick % cf) / cf;
        double v = ph * 2; if (v > 1) v = 2 - v;
        irisA = (178 + 77*v) / 255.0;
    }
    CGContextSetRGBFillColor(ctx, r, g, b, irisA);
    CGContextFillEllipseInRect(ctx, CGRectMake(ex-irisR, ey-irisR, irisR*2, irisR*2));

    if (gBlinded) {
        CGContextSetRGBStrokeColor(ctx, kAccR, kAccG, kAccB, 1.0);
        CGContextSetLineWidth(ctx, 1.0);
        CGContextMoveToPoint(ctx, ex - lensR - 1.5, ey + lensR + 1.5);
        CGContextAddLineToPoint(ctx, ex + lensR + 1.5, ey - lensR - 1.5);
        CGContextStrokePath(ctx);
    }
}

// draw_answer_cg paints the "open full ↗" overflow button at the bubble's
// bottom-right (§5.3). by1 is the auto-fitted bubble bottom.
static void draw_answer_cg(CGContextRef ctx, CGFloat by1, BOOL speaking) {
    const CGFloat btnW = 108, btnH = 22, insetR = 10, insetB = 8, kBubbleX1 = 340;
    CGFloat bxL = kBubbleX1 - insetR - btnW;
    CGFloat byTop = by1 - insetB - btnH;
    CGFloat tr = speaking ? kPaperR : kAccR;
    CGFloat tg = speaking ? kPaperG : kAccG;
    CGFloat tb = speaking ? kPaperB : kAccB;

    CGRect rect = CGRectMake(bxL, byTop, btnW, btnH);
    CGPathRef fillPath = CGPathCreateWithRoundedRect(rect, 5.0, 5.0, NULL);
    CGContextAddPath(ctx, fillPath);
    CGContextSetRGBFillColor(ctx, tr, tg, tb, speaking ? 32/255.0 : 36/255.0);
    CGContextFillPath(ctx);
    CGContextAddPath(ctx, fillPath);
    CGContextSetRGBStrokeColor(ctx, tr, tg, tb, speaking ? 200/255.0 : 220/255.0);
    CGContextSetLineWidth(ctx, 1.0);
    CGContextStrokePath(ctx);
    CGPathRelease(fillPath);

    NSDictionary* attrs = @{
        NSFontAttributeName: [NSFont systemFontOfSize:10 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName: [NSColor colorWithCalibratedRed:tr green:tg blue:tb alpha:1.0],
    };
    NSAttributedString* label = [[NSAttributedString alloc] initWithString:@"open full ↗" attributes:attrs];
    [label drawAtPoint:NSMakePoint(bxL + 12, byTop + 5)];
}

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
        draw_eye_cg(ctx);
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
        if (gAnswerOverflow) draw_answer_cg(ctx, by1, speaking);
        draw_eye_cg(ctx);
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
        draw_eye_cg(ctx);
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
        draw_eye_cg(ctx);
        return;
    }
    draw_eye_cg(ctx);
}
@end

// jarvisPebbleSpawnImpl creates the overlay window only — the shared Go loop
// drives motion + repaint via jarvisPebblePresent. Runs on the main thread.
static void jarvisPebbleSpawnImpl(void) {
    if (gPebbleWindow != nil) return;

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

    [gPebbleWindow makeKeyAndOrderFront:nil];
    // No NSTimer — runPebbleLoop (Go) ticks at 16ms and calls present() each
    // frame, which dispatch_async's jarvisPebblePresentImpl onto the main queue.
}

// jarvisPebblePresentImpl applies one eased frame on the main thread: the shared
// Go runtime already eased the position (x,y in top-left space) and bumped the
// frame tick; we push state/tick/text, convert to the bottom-left window origin
// (Y-flip), and redraw.
static void jarvisPebblePresentImpl(int x, int y, int state, unsigned long long tick,
                                    int eye, int blinded, int answerOverflow, int alphaPct, NSString* body) {
    if (!gPebbleWindow || !gPebbleView) return;
    // Ethereal-mode window opacity (0..100 from the Go runtime).
    [gPebbleWindow setAlphaValue:(CGFloat)alphaPct / 100.0];
    gPebbleState = state;
    gFrameTick = tick;
    gEye = eye;
    gBlinded = blinded;
    gAnswerOverflow = answerOverflow;
    gPebbleBodyText = body; // ARC: nil clears, otherwise retains

    // advanceFrame() publishes renderedX/renderedY in the SAME top-left space
    // platformGetCursorPos() returns. macOS windows use a bottom-left origin,
    // so flip Y: origin.y = screenH - y - windowHeight (matches the old tick's
    // `screenH - (gCurY - kAnchorY) - frameH`, fed from Go's renderedX/Y).
    NSScreen* main = [[NSScreen screens] firstObject];
    CGFloat screenH = main ? main.frame.size.height : 0;
    NSRect wframe = [gPebbleWindow frame];
    NSPoint origin = NSMakePoint((CGFloat)x, screenH - (CGFloat)y - wframe.size.height);
    [gPebbleWindow setFrameOrigin:origin];

    [gPebbleView setNeedsDisplay:YES];
}

static void jarvisPebbleCloseImpl(void) {
    if (gPebbleWindow) {
        [gPebbleWindow orderOut:nil];
        gPebbleWindow = nil;
    }
    gPebbleView = nil;
    gPebbleBodyText = nil;
}

// Public C entry points marshalled onto the main thread.

// jarvisPebbleSpawn creates the window only.
void jarvisPebbleSpawn(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ jarvisPebbleSpawnImpl(); });
}

// jarvisPebblePresent pushes one eased frame from the Go runtime. text may be
// NULL/empty (drawRect: falls back to the per-state placeholder).
void jarvisPebblePresent(int x, int y, int state, unsigned long long tick,
                         int eye, int blinded, int answerOverflow, int alphaPct, const char* text) {
    // Copy onto the heap so the Go-side buffer can be freed immediately.
    char* copy = (text && *text) ? strdup(text) : NULL;
    dispatch_async(dispatch_get_main_queue(), ^{
        NSString* body = copy ? [NSString stringWithUTF8String:copy] : nil;
        jarvisPebblePresentImpl(x, y, state, tick, eye, blinded, answerOverflow, alphaPct, body);
        if (copy) free(copy);
    });
}

void jarvisPebbleClose(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ jarvisPebbleCloseImpl(); });
}
*/
import "C"

import (
	"log"
	"sync/atomic"
	"unsafe"
)

// pebbleServiceDarwin is the AppKit adapter for the shared pebbleCore runtime
// (pebble_runtime.go). The shared loop owns motion + state + lifecycle; this
// file owns only the native window + drawing (the cgo block above) and bridges
// each frame onto the Cocoa main queue.
type pebbleServiceDarwin struct {
	pebbleCore
	summonCallback    atomic.Value // func(); re-assigned per reconnect, read by the hotkey goroutine
	paletteCallback   atomic.Value // func()
	hotkeyStop        func() // summon hotkey listener stop
	paletteHotkeyStop func() // palette hotkey listener stop
}

func NewPebbleService() PebbleService {
	// Unlike Linux (which spins its own gtk_main goroutine), macOS relies on the
	// process's existing Cocoa main runloop (arranged by the panels webview
	// service) to drain the dispatch_async(main_queue) blocks. No loop to spin
	// up here.
	s := &pebbleServiceDarwin{}
	s.state.Store(PebbleIdle)
	s.bubbleText.Store("")
	return s
}

func (s *pebbleServiceDarwin) Spawn(spec PebbleSpec) error {
	if !s.spawned.CompareAndSwap(false, true) {
		return nil
	}
	s.spec = spec
	if s.spec.CursorOffsetX == 0 && s.spec.CursorOffsetY == 0 {
		s.spec.CursorOffsetX, s.spec.CursorOffsetY = 22, 26
	}
	// Seed the eased position at the cursor so the pebble doesn't fly in from
	// the screen corner on the first frame.
	if cx, cy, err := platformGetCursorPos(); err == nil {
		s.curX = float64(cx + s.spec.CursorOffsetX)
		s.curY = float64(cy + s.spec.CursorOffsetY)
	}
	s.stopCh = make(chan struct{})
	s.doneCh = make(chan struct{})
	go runPebbleLoop(&s.pebbleCore, s)

	// Global hotkeys (§5.4): summon + palette. macOS needs Accessibility trust;
	// a failed/unfired grab is non-fatal.
	if s.spec.SummonHotkey != "" {
		if stop, err := startHotkeyListener(s.spec.SummonHotkey, func() {
			if cb, ok := s.summonCallback.Load().(func()); ok && cb != nil {
				cb()
			}
		}); err != nil {
			log.Printf("[pebble] summon hotkey %q not registered: %v", s.spec.SummonHotkey, err)
		} else {
			s.hotkeyStop = stop
			log.Printf("[pebble] summon hotkey %q registered", s.spec.SummonHotkey)
		}
	}
	if s.spec.PaletteHotkey != "" {
		if stop, err := startHotkeyListener(s.spec.PaletteHotkey, func() {
			if cb, ok := s.paletteCallback.Load().(func()); ok && cb != nil {
				cb()
			}
		}); err != nil {
			log.Printf("[pebble] palette hotkey %q not registered: %v", s.spec.PaletteHotkey, err)
		} else {
			s.paletteHotkeyStop = stop
			log.Printf("[pebble] palette hotkey %q registered", s.spec.PaletteHotkey)
		}
	}
	return nil
}

// ─── pebblePlatform primitives (all AppKit work marshals to the main queue) ──

func (s *pebbleServiceDarwin) createWindow() error { C.jarvisPebbleSpawn(); return nil }
func (s *pebbleServiceDarwin) pumpMessages()       {} // the Cocoa runloop pumps for us

func (s *pebbleServiceDarwin) present() error {
	// advanceFrame() already eased + published renderedX/renderedY + frameTick.
	state, _ := s.state.Load().(PebbleState)
	text, _ := s.bubbleText.Load().(string)
	var cstr *C.char
	if text != "" {
		cstr = C.CString(text)
		defer C.free(unsafe.Pointer(cstr))
	}
	answerID, _ := s.answerOverflowID.Load().(string)
	alpha := s.EtherealAlpha()
	if alpha < 0 {
		alpha = 0
	} else if alpha > 1 {
		alpha = 1
	}
	C.jarvisPebblePresent(
		C.int(s.renderedX.Load()), C.int(s.renderedY.Load()),
		C.int(pebbleStateToInt(state)), C.ulonglong(s.frameTick),
		pebbleBoolToCInt(s.eyeActive.Load()), pebbleBoolToCInt(s.blinded.Load()),
		pebbleBoolToCInt(answerID != ""), C.int(alpha*100), cstr,
	)
	return nil
}

// pebbleBoolToCInt maps a Go bool to the 0/1 C.int the renderer flags expect.
func pebbleBoolToCInt(b bool) C.int {
	if b {
		return 1
	}
	return 0
}

func (s *pebbleServiceDarwin) destroyWindow() { C.jarvisPebbleClose() }

func (s *pebbleServiceDarwin) Close() error {
	if !s.spawned.CompareAndSwap(true, false) {
		return nil
	}
	if s.hotkeyStop != nil {
		s.hotkeyStop()
		s.hotkeyStop = nil
	}
	if s.paletteHotkeyStop != nil {
		s.paletteHotkeyStop()
		s.paletteHotkeyStop = nil
	}
	close(s.stopCh)
	<-s.doneCh
	return nil
}

// SetState / SetText / PointAt / SetEye / SetBlinded / SetAnswerOverflow are
// promoted from the embedded pebbleCore (pebble_runtime.go); present() pushes
// the state to the renderer each frame. PointAt now works on macOS. drawRect:
// renders idle/listening/thinking/speaking/working + bubble text + the eye /
// blinded strike / answer-overflow button (§5.3). The pointing label is already
// handled (PointAt sets state=listening + bubbleText=label).

func (s *pebbleServiceDarwin) OnSummon(callback func())  { s.summonCallback.Store(callback) }
func (s *pebbleServiceDarwin) OnPalette(callback func()) { s.paletteCallback.Store(callback) }

// OnBlindToggle / OnAnswerOpen — the callbacks are accepted; the summon/palette
// hotkeys fire via the NSEvent monitor (§5.4). The disc long-press (blind
// toggle) and answer-button click still need the pebble window to catch input;
// that input wiring is the documented residual in §5.4.
func (s *pebbleServiceDarwin) OnBlindToggle(callback func())      { _ = callback }
func (s *pebbleServiceDarwin) OnAnswerOpen(callback func(string)) { _ = callback }
