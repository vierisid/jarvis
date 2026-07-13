package main

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png" // register PNG decoder for image.Decode
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	xdraw "golang.org/x/image/draw"
)

func NewHandlerRegistry(cfg *SidecarConfig, cfgMu sync.Locker, availableCaps []SidecarCapability, panels PanelService, pebble PebbleService, subPebble SubPebbleService, playback *AudioPlaybackService, regions RegionSelectionService, onReloaded func(), brainURL string, panelToken func(context.Context) (string, error)) map[string]RPCHandler {
	caps := make(map[string]bool)
	for _, c := range availableCaps {
		caps[c] = true
	}

	registry := make(map[string]RPCHandler)

	if caps[CapTerminal] {
		registry["run_command"] = makeRunCommandHandler(cfg)
	}
	if caps[CapFilesystem] {
		registry["read_file"] = makeReadFileHandler(cfg)
		registry["write_file"] = makeWriteFileHandler(cfg)
		registry["list_directory"] = makeListDirectoryHandler(cfg)
	}
	if caps[CapClipboard] {
		registry["get_clipboard"] = handleGetClipboard
		registry["set_clipboard"] = handleSetClipboard
	}
	if caps[CapScreenshot] {
		registry["capture_screen"] = handleCaptureScreen
	}
	if caps[CapAwareness] {
		registry["fetch_capture"] = makeFetchCaptureHandler(cfg)
		registry["cleanup_captures"] = makeCleanupCapturesHandler(cfg)
	}
	if caps[CapSystemInfo] {
		registry["get_system_info"] = handleGetSystemInfo
	}
	if caps[CapDesktop] {
		registry["list_windows"] = handleListWindows
		registry["get_window_tree"] = handleGetWindowTree
		registry["click_element"] = handleClickElement
		registry["type_text"] = handleTypeText
		registry["press_keys"] = handlePressKeys
		registry["launch_app"] = handleLaunchApp
		registry["focus_window"] = handleFocusWindow
		registry["find_element"] = handleFindElement
	}
	if caps[CapBrowser] {
		// The browser launches lazily on the first browser_* call (headed by
		// default; pass headless:true to start it hidden) — not at startup.
		registry["browser_navigate"] = makeBrowserNavigateHandler(cfg)
		registry["browser_snapshot"] = makeBrowserSnapshotHandler(cfg)
		registry["browser_click"] = makeBrowserClickHandler(cfg)
		registry["browser_type"] = makeBrowserTypeHandler(cfg)
		registry["browser_hover"] = makeBrowserHoverHandler(cfg)
		registry["browser_press_key"] = makeBrowserPressKeyHandler(cfg)
		registry["browser_screenshot"] = makeBrowserScreenshotHandler(cfg)
		registry["browser_scroll"] = makeBrowserScrollHandler(cfg)
		registry["browser_evaluate"] = makeBrowserEvaluateHandler(cfg)
		registry["browser_close"] = makeBrowserCloseHandler(cfg)
	}

	if caps[CapWindows] && panels != nil {
		registry["panel.spawn"] = makePanelSpawnHandler(panels, brainURL, panelToken)
		registry["panel.close"] = makePanelCloseHandler(panels)
		registry["panel.focus"] = makePanelFocusHandler(panels)
		registry["panel.list"] = makePanelListHandler(panels)
		registry["panel.set_follow"] = makePanelSetFollowHandler(panels)
		registry["panel.set_window_state"] = makePanelSetWindowStateHandler(panels)
	}

	if caps[CapPebble] && pebble != nil {
		registry["pebble.spawn"] = makePebbleSpawnHandler(pebble)
		registry["pebble.close"] = makePebbleCloseHandler(pebble)
		registry["pebble.set_state"] = makePebbleSetStateHandler(pebble)
		registry["pebble.set_eye"] = makePebbleSetEyeHandler(pebble)
		registry["pebble.set_blinded"] = makePebbleSetBlindedHandler(pebble)
		registry["pebble.set_answer_overflow"] = makePebbleSetAnswerOverflowHandler(pebble)
		registry["pebble.point_at"] = makePebblePointAtHandler(pebble)
		if playback != nil {
			registry["pebble.play_audio"] = makePebblePlayAudioHandler(playback)
			registry["pebble.stop_audio"] = makePebbleStopAudioHandler(playback)
		}
		// Region selection (T19) is gated alongside the pebble cap since
		// it's only useful in the ambient flow.
		_ = regions // wired via direct closure in client.go (needs sendFn)
	}

	if caps[CapSubPebble] && subPebble != nil {
		registry["sub_pebble.spawn"] = makeSubPebbleSpawnHandler(subPebble)
		registry["sub_pebble.set_state"] = makeSubPebbleSetStateHandler(subPebble)
		registry["sub_pebble.set_color"] = makeSubPebbleSetColorHandler(subPebble)
		registry["sub_pebble.set_expanded"] = makeSubPebbleSetExpandedHandler(subPebble)
		registry["sub_pebble.set_label"] = makeSubPebbleSetLabelHandler(subPebble)
		registry["sub_pebble.close"] = makeSubPebbleCloseHandler(subPebble)
		registry["sub_pebble.close_all"] = makeSubPebbleCloseAllHandler(subPebble)
	}

	// Administrative handlers — not gated by capability
	registry["get_config"] = makeGetConfigHandler(cfg)
	registry["update_config"] = makeUpdateConfigHandler(cfg, cfgMu, onReloaded)

	return registry
}

// --- Terminal ---

func makeRunCommandHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		command, _ := params["command"].(string)
		if command == "" {
			return nil, fmt.Errorf("missing required parameter: command")
		}

		cwd, _ := params["cwd"].(string)
		if cwd == "" {
			cwd, _ = os.Getwd()
		}

		timeoutMs := cfg.Terminal.TimeoutMs
		if t, ok := params["timeout"].(float64); ok && t > 0 {
			timeoutMs = int(t)
		}

		for _, blocked := range cfg.Terminal.BlockedCommands {
			if strings.Contains(command, blocked) {
				return &RPCResult{Result: map[string]any{
					"stdout":    "",
					"stderr":    fmt.Sprintf("Command blocked: %s", blocked),
					"exit_code": 1,
				}}, nil
			}
		}

		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
		defer cancel()

		shell := cfg.Terminal.DefaultShell
		if shell == "" {
			shell = platformDefaultShell()
		}
		var cmd *exec.Cmd
		if shell == "cmd.exe" {
			cmd = exec.CommandContext(ctx, shell, "/C", command)
		} else {
			cmd = exec.CommandContext(ctx, shell, "-c", command)
		}
		hideSubprocessWindow(cmd)
		cmd.Dir = cwd

		var stdoutBuf, stderrBuf strings.Builder
		cmd.Stdout = &stdoutBuf
		cmd.Stderr = &stderrBuf

		err := cmd.Run()
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = 1
			}
		}

		return &RPCResult{Result: map[string]any{
			"stdout":    stdoutBuf.String(),
			"stderr":    stderrBuf.String(),
			"exit_code": exitCode,
		}}, nil
	}
}

// --- Filesystem ---

func isBlockedPath(filePath string, blockedPaths []string) bool {
	resolved, _ := filepath.Abs(filePath)
	for _, bp := range blockedPaths {
		abs, _ := filepath.Abs(bp)
		if strings.HasPrefix(resolved, abs) {
			return true
		}
	}
	return false
}

func makeReadFileHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		path, _ := params["path"].(string)
		if path == "" {
			return nil, fmt.Errorf("missing required parameter: path")
		}
		if isBlockedPath(path, cfg.Filesystem.BlockedPaths) {
			return nil, fmt.Errorf("path is blocked: %s", path)
		}

		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		if info.Size() > int64(cfg.Filesystem.MaxFileSizeKB)*1024 {
			return nil, fmt.Errorf("file exceeds max size of %dKB", cfg.Filesystem.MaxFileSizeKB)
		}

		content, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"content": string(content)}}, nil
	}
}

func makeWriteFileHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		path, _ := params["path"].(string)
		content, _ := params["content"].(string)
		if path == "" {
			return nil, fmt.Errorf("missing required parameter: path")
		}
		if _, ok := params["content"]; !ok {
			return nil, fmt.Errorf("missing required parameter: content")
		}
		if isBlockedPath(path, cfg.Filesystem.BlockedPaths) {
			return nil, fmt.Errorf("path is blocked: %s", path)
		}

		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"success": true}}, nil
	}
}

func makeListDirectoryHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		dirPath, _ := params["path"].(string)
		if dirPath == "" {
			return nil, fmt.Errorf("missing required parameter: path")
		}
		if isBlockedPath(dirPath, cfg.Filesystem.BlockedPaths) {
			return nil, fmt.Errorf("path is blocked: %s", dirPath)
		}

		entries, err := os.ReadDir(dirPath)
		if err != nil {
			return nil, err
		}

		results := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			entryType := "file"
			if entry.IsDir() {
				entryType = "directory"
			}
			size := int64(0)
			if info, err := entry.Info(); err == nil {
				size = info.Size()
			}
			results = append(results, map[string]any{
				"name": entry.Name(),
				"type": entryType,
				"size": size,
			})
		}
		return &RPCResult{Result: map[string]any{"entries": results}}, nil
	}
}

// --- Clipboard ---

func runCmd(name string, args []string, input string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	hideSubprocessWindow(cmd) // critical on Windows GUI builds — see subprocess_windows.go
	if input != "" {
		cmd.Stdin = strings.NewReader(input)
	}
	out, err := cmd.Output()
	return string(out), err
}

func handleGetClipboard(params map[string]any) (*RPCResult, error) {
	content, err := platformClipboardRead()
	if err != nil {
		return nil, err
	}
	return &RPCResult{Result: map[string]any{"content": content}}, nil
}

func handleSetClipboard(params map[string]any) (*RPCResult, error) {
	content, _ := params["content"].(string)
	if _, ok := params["content"]; !ok {
		return nil, fmt.Errorf("missing required parameter: content")
	}

	if err := platformClipboardWrite(content); err != nil {
		return nil, err
	}
	return &RPCResult{Result: map[string]any{"success": true}}, nil
}

// --- Screenshot ---

// captureScreenBytes invokes the platform screenshot tool, returning the raw PNG.
// Both the RPC handler and the ScreenObserver use this to skip a base64
// round-trip on the in-process path.
func captureScreenBytes() ([]byte, error) {
	tmpFile := filepath.Join(os.TempDir(), fmt.Sprintf("jarvis-screenshot-%d.png", time.Now().UnixNano()))
	defer os.Remove(tmpFile)

	if err := platformCaptureScreen(tmpFile); err != nil {
		return nil, fmt.Errorf("screenshot capture failed: %w", err)
	}
	return os.ReadFile(tmpFile)
}

func handleCaptureScreen(params map[string]any) (*RPCResult, error) {
	data, err := captureScreenBytes()
	if err != nil {
		return nil, err
	}

	// `compact: true` (T9 auto-screenshot path) downsizes + re-encodes
	// the PNG as JPEG so it fits comfortably under the WS message limit
	// while still being readable enough for vision LLMs to pick out
	// button text. Without it, raw PNG screenshots on a 4K monitor can
	// hit 5+ MB and get dropped before the LLM sees them.
	compact := false
	if v, ok := params["compact"].(bool); ok {
		compact = v
	}
	maxW := 1600
	if v, ok := params["max_width"].(float64); ok && v > 0 {
		maxW = int(v)
	}
	jpegQ := 80
	if v, ok := params["jpeg_quality"].(float64); ok && v > 0 {
		jpegQ = int(v)
	}
	// Always decode once to pull the original dimensions — the daemon
	// uses them to scale POINT coordinates back into real-screen space
	// when the user's monitor is bigger than the resized image.
	origW, origH, _ := readImageSize(data)
	mime := "image/png"
	dstW, dstH := origW, origH
	// Whether to overlay a coordinate grid so the vision LLM can read
	// coordinates off labelled gridlines rather than guess pixel
	// positions (vision models are notoriously bad at unaided
	// localization). Default ON when compact is requested — that's the
	// pebble flow that needs accuracy.
	grid := compact
	if v, ok := params["grid"].(bool); ok {
		grid = v
	}
	if compact {
		shrunk, sw, sh, err := shrinkScreenshotWithGrid(data, maxW, jpegQ, grid)
		if err == nil && len(shrunk) > 0 && len(shrunk) < len(data) {
			data = shrunk
			mime = "image/jpeg"
			dstW, dstH = sw, sh
		}
	}

	return &RPCResult{
		Result: map[string]any{
			"captured":    true,
			"bytes":       len(data),
			"mime":        mime,
			"width":       dstW,
			"height":      dstH,
			"orig_width":  origW,
			"orig_height": origH,
		},
		BinaryRaw:  data,
		BinaryMime: mime,
	}, nil
}

// --- Awareness: fetch a saved capture by path ---

// makeFetchCaptureHandler returns a handler that reads a previously-saved capture
// PNG from disk and returns it as inline binary. The requested path is required
// to resolve underneath the configured capture directory, with symlinks evaluated
// so that a symlink inside the dir cannot point outside it.
func makeFetchCaptureHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		raw, _ := params["path"].(string)
		if raw == "" {
			return nil, fmt.Errorf("missing required parameter: path")
		}

		captureDir, err := filepath.Abs(cfg.Awareness.CaptureDir)
		if err != nil {
			return nil, fmt.Errorf("resolve capture dir: %w", err)
		}
		if resolved, err := filepath.EvalSymlinks(captureDir); err == nil {
			captureDir = resolved
		}

		target, err := filepath.Abs(raw)
		if err != nil {
			return nil, fmt.Errorf("resolve path: %w", err)
		}
		resolvedTarget, err := filepath.EvalSymlinks(target)
		if err != nil {
			return nil, fmt.Errorf("read capture: %w", err)
		}

		rel, err := filepath.Rel(captureDir, resolvedTarget)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("path not within capture dir")
		}

		data, err := os.ReadFile(resolvedTarget)
		if err != nil {
			return nil, fmt.Errorf("read capture: %w", err)
		}

		return &RPCResult{
			Result:     map[string]any{"size": len(data)},
			BinaryRaw:  data,
			BinaryMime: "image/png",
		}, nil
	}
}

// --- Awareness: prune old capture files ---

// makeCleanupCapturesHandler deletes capture files in CaptureDir whose mtime is
// before the provided cutoff (epoch ms). Empty date directories are removed.
// Returns counts so the brain can log progress.
//
// Safety: the cutoff must be in the past. A small clock-skew tolerance is
// allowed (1 minute into the future), but we never wipe newer files than that.
func makeCleanupCapturesHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		beforeMs, ok := params["before_ms"].(float64)
		if !ok || beforeMs <= 0 {
			return nil, fmt.Errorf("missing or invalid before_ms")
		}
		cutoff := time.UnixMilli(int64(beforeMs))
		if cutoff.After(time.Now().Add(time.Minute)) {
			return nil, fmt.Errorf("cutoff must be in the past")
		}

		captureDir := cfg.Awareness.CaptureDir
		filesDeleted := 0
		dirsRemoved := 0

		entries, err := os.ReadDir(captureDir)
		if err != nil {
			if os.IsNotExist(err) {
				return &RPCResult{Result: map[string]any{"files_deleted": 0, "dirs_removed": 0}}, nil
			}
			return nil, fmt.Errorf("read capture dir: %w", err)
		}

		for _, dateEntry := range entries {
			if !dateEntry.IsDir() {
				continue
			}
			dateDir := filepath.Join(captureDir, dateEntry.Name())
			files, err := os.ReadDir(dateDir)
			if err != nil {
				continue
			}
			for _, f := range files {
				if f.IsDir() {
					continue
				}
				p := filepath.Join(dateDir, f.Name())
				info, err := f.Info()
				if err != nil {
					continue
				}
				if info.ModTime().Before(cutoff) {
					if err := os.Remove(p); err == nil {
						filesDeleted++
					}
				}
			}
			if remaining, _ := os.ReadDir(dateDir); len(remaining) == 0 {
				if err := os.Remove(dateDir); err == nil {
					dirsRemoved++
				}
			}
		}

		return &RPCResult{Result: map[string]any{
			"files_deleted": filesDeleted,
			"dirs_removed":  dirsRemoved,
		}}, nil
	}
}

// readImageSize decodes only the image config (header) so we can
// surface dimensions cheaply without a full decode.
func readImageSize(buf []byte) (int, int, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(buf))
	if err != nil {
		return 0, 0, err
	}
	return cfg.Width, cfg.Height, nil
}

// shrinkScreenshotWithGrid downscales + JPEG-encodes a screenshot,
// optionally overlaying a coordinate grid before encoding. The grid
// gives vision LLMs a visual reference frame: every 100 px a faint
// hairline, every 200 px a labelled gridline ("x=200", "y=400" …) so
// the model can READ coordinates off nearby labels instead of
// guessing pixel positions.
func shrinkScreenshotWithGrid(pngBytes []byte, maxW, jpegQ int, drawGrid bool) ([]byte, int, int, error) {
	src, _, err := image.Decode(bytes.NewReader(pngBytes))
	if err != nil {
		return nil, 0, 0, err
	}
	srcW := src.Bounds().Dx()
	srcH := src.Bounds().Dy()
	dstW := srcW
	dstH := srcH
	if srcW > maxW {
		dstW = maxW
		dstH = srcH * maxW / srcW
	}
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	if dstW != srcW || dstH != srcH {
		xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Over, nil)
	} else {
		xdraw.Draw(dst, dst.Bounds(), src, image.Point{}, xdraw.Src)
	}
	if drawGrid {
		drawCoordinateGrid(dst)
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: jpegQ}); err != nil {
		return nil, 0, 0, err
	}
	return buf.Bytes(), dstW, dstH, nil
}

// drawCoordinateGrid paints a labelled grid over the image so the
// vision LLM can read pixel coordinates from gridline labels. Light
// alpha so UI underneath stays visible; semi-transparent label boxes
// so labels never sit unreadably on noisy backgrounds.
func drawCoordinateGrid(img *image.RGBA) {
	w := img.Bounds().Dx()
	h := img.Bounds().Dy()
	// Hairline (faint) every 100 px.
	hair := color.RGBA{R: 200, G: 60, B: 50, A: 70}
	// Major gridline (slightly stronger) every 200 px.
	major := color.RGBA{R: 200, G: 60, B: 50, A: 130}
	// Vertical lines.
	for x := 100; x < w; x += 100 {
		col := hair
		if x%200 == 0 {
			col = major
		}
		drawVLine(img, x, 0, h, col)
	}
	for y := 100; y < h; y += 100 {
		col := hair
		if y%200 == 0 {
			col = major
		}
		drawHLine(img, 0, w, y, col)
	}
	// Labels every 200 px. Painted with a tiny inline pixel font.
	labelBg := color.RGBA{R: 0, G: 0, B: 0, A: 200}
	labelFg := color.RGBA{R: 255, G: 255, B: 255, A: 255}
	for x := 200; x < w; x += 200 {
		drawLabel(img, fmt.Sprintf("x=%d", x), x+2, 2, labelBg, labelFg)
	}
	for y := 200; y < h; y += 200 {
		drawLabel(img, fmt.Sprintf("y=%d", y), 2, y+2, labelBg, labelFg)
	}
}

func drawVLine(img *image.RGBA, x, y0, y1 int, c color.RGBA) {
	for y := y0; y < y1; y++ {
		blendPixel(img, x, y, c)
	}
}
func drawHLine(img *image.RGBA, x0, x1, y int, c color.RGBA) {
	for x := x0; x < x1; x++ {
		blendPixel(img, x, y, c)
	}
}
func blendPixel(img *image.RGBA, x, y int, c color.RGBA) {
	if x < 0 || y < 0 || x >= img.Bounds().Dx() || y >= img.Bounds().Dy() {
		return
	}
	off := y*img.Stride + x*4
	a := int(c.A)
	inv := 255 - a
	img.Pix[off+0] = uint8((int(img.Pix[off+0])*inv + int(c.R)*a) / 255)
	img.Pix[off+1] = uint8((int(img.Pix[off+1])*inv + int(c.G)*a) / 255)
	img.Pix[off+2] = uint8((int(img.Pix[off+2])*inv + int(c.B)*a) / 255)
}

// 5×7 pixel font for the digits we need. Each glyph is encoded as a
// flat slice of 35 bools (5×7), row-major. Covers 0–9, =, x, y. Tiny
// but readable at the size vision LLMs receive screenshots.
var pixelFont = map[rune][35]bool{
	'0': {false, true, true, true, false,
		true, false, false, false, true,
		true, false, false, true, true,
		true, false, true, false, true,
		true, true, false, false, true,
		true, false, false, false, true,
		false, true, true, true, false},
	'1': {false, false, true, false, false,
		false, true, true, false, false,
		true, false, true, false, false,
		false, false, true, false, false,
		false, false, true, false, false,
		false, false, true, false, false,
		true, true, true, true, true},
	'2': {false, true, true, true, false,
		true, false, false, false, true,
		false, false, false, false, true,
		false, false, true, true, false,
		false, true, false, false, false,
		true, false, false, false, false,
		true, true, true, true, true},
	'3': {true, true, true, true, false,
		false, false, false, false, true,
		false, false, false, false, true,
		false, true, true, true, false,
		false, false, false, false, true,
		false, false, false, false, true,
		true, true, true, true, false},
	'4': {false, false, false, true, false,
		false, false, true, true, false,
		false, true, false, true, false,
		true, false, false, true, false,
		true, true, true, true, true,
		false, false, false, true, false,
		false, false, false, true, false},
	'5': {true, true, true, true, true,
		true, false, false, false, false,
		true, true, true, true, false,
		false, false, false, false, true,
		false, false, false, false, true,
		true, false, false, false, true,
		false, true, true, true, false},
	'6': {false, false, true, true, false,
		false, true, false, false, false,
		true, false, false, false, false,
		true, true, true, true, false,
		true, false, false, false, true,
		true, false, false, false, true,
		false, true, true, true, false},
	'7': {true, true, true, true, true,
		false, false, false, false, true,
		false, false, false, true, false,
		false, false, true, false, false,
		false, true, false, false, false,
		false, true, false, false, false,
		false, true, false, false, false},
	'8': {false, true, true, true, false,
		true, false, false, false, true,
		true, false, false, false, true,
		false, true, true, true, false,
		true, false, false, false, true,
		true, false, false, false, true,
		false, true, true, true, false},
	'9': {false, true, true, true, false,
		true, false, false, false, true,
		true, false, false, false, true,
		false, true, true, true, true,
		false, false, false, false, true,
		false, false, false, true, false,
		false, true, true, false, false},
	'=': {false, false, false, false, false,
		false, false, false, false, false,
		true, true, true, true, true,
		false, false, false, false, false,
		true, true, true, true, true,
		false, false, false, false, false,
		false, false, false, false, false},
	'x': {false, false, false, false, false,
		false, false, false, false, false,
		true, false, false, false, true,
		false, true, false, true, false,
		false, false, true, false, false,
		false, true, false, true, false,
		true, false, false, false, true},
	'y': {false, false, false, false, false,
		false, false, false, false, false,
		true, false, false, false, true,
		false, true, false, true, false,
		false, false, true, false, false,
		false, false, true, false, false,
		true, true, false, false, false},
}

func drawLabel(img *image.RGBA, text string, x, y int, bg, fg color.RGBA) {
	const charW = 6 // 5 px glyph + 1 px spacing
	const charH = 7
	const padX = 1
	const padY = 1
	bgW := len(text)*charW - 1 + padX*2
	bgH := charH + padY*2
	for dy := 0; dy < bgH; dy++ {
		for dx := 0; dx < bgW; dx++ {
			blendPixel(img, x+dx, y+dy, bg)
		}
	}
	cx := x + padX
	cy := y + padY
	for _, r := range text {
		glyph, ok := pixelFont[r]
		if !ok {
			cx += charW
			continue
		}
		for row := 0; row < charH; row++ {
			for col := 0; col < 5; col++ {
				if glyph[row*5+col] {
					blendPixel(img, cx+col, cy+row, fg)
				}
			}
		}
		cx += charW
	}
}

// --- Config Management ---

func makeGetConfigHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		return &RPCResult{Result: map[string]any{
			"capabilities": cfg.Capabilities,
			"terminal": map[string]any{
				"blocked_commands": cfg.Terminal.BlockedCommands,
				"default_shell":    cfg.Terminal.DefaultShell,
				"timeout_ms":       cfg.Terminal.TimeoutMs,
			},
			"filesystem": map[string]any{
				"blocked_paths":    cfg.Filesystem.BlockedPaths,
				"max_file_size_kb": cfg.Filesystem.MaxFileSizeKB,
			},
			"browser": map[string]any{
				"executable_path": cfg.Browser.ExecutablePath,
				"profile_dir":     cfg.Browser.ProfileDir,
				"cdp_port":        cfg.Browser.CDPPort, // deprecated; retained for back-compat
			},
			"awareness": map[string]any{
				"screen_interval_ms":   cfg.Awareness.ScreenIntervalMs,
				"window_interval_ms":   cfg.Awareness.WindowIntervalMs,
				"min_change_threshold": cfg.Awareness.MinChangeThreshold,
				"stuck_threshold_ms":   cfg.Awareness.StuckThresholdMs,
			},
		}}, nil
	}
}

func makeUpdateConfigHandler(cfg *SidecarConfig, mu sync.Locker, onReloaded func()) RPCHandler {
	getConfig := makeGetConfigHandler(cfg)

	return func(params map[string]any) (*RPCResult, error) {
		// Mutate the shared *SidecarConfig under the same lock that editConfig /
		// reloadConfig / Preferences use — this handler runs on a per-RPC
		// goroutine while those run on the settings/reconnect paths, all touching
		// the same struct. No early returns until the explicit Unlock below.
		mu.Lock()
		// Update capabilities
		if caps, ok := params["capabilities"].([]any); ok {
			newCaps := make([]SidecarCapability, 0, len(caps))
			for _, c := range caps {
				if s, ok := c.(string); ok {
					newCaps = append(newCaps, s)
				}
			}
			cfg.Capabilities = newCaps
		}

		// Update terminal
		if terminal, ok := params["terminal"].(map[string]any); ok {
			if v, ok := terminal["timeout_ms"].(float64); ok {
				cfg.Terminal.TimeoutMs = int(v)
			}
			if v, ok := terminal["default_shell"].(string); ok {
				cfg.Terminal.DefaultShell = v
			}
			if v, ok := terminal["blocked_commands"].([]any); ok {
				cmds := make([]string, 0, len(v))
				for _, c := range v {
					if s, ok := c.(string); ok {
						cmds = append(cmds, s)
					}
				}
				cfg.Terminal.BlockedCommands = cmds
			}
		}

		// Update filesystem
		if fs, ok := params["filesystem"].(map[string]any); ok {
			if v, ok := fs["max_file_size_kb"].(float64); ok {
				cfg.Filesystem.MaxFileSizeKB = int(v)
			}
			if v, ok := fs["blocked_paths"].([]any); ok {
				paths := make([]string, 0, len(v))
				for _, p := range v {
					if s, ok := p.(string); ok {
						paths = append(paths, s)
					}
				}
				cfg.Filesystem.BlockedPaths = paths
			}
		}

		// Update browser
		if browser, ok := params["browser"].(map[string]any); ok {
			if v, ok := browser["executable_path"].(string); ok {
				cfg.Browser.ExecutablePath = v
			}
			if v, ok := browser["profile_dir"].(string); ok {
				cfg.Browser.ProfileDir = v
			}
			if v, ok := browser["cdp_port"].(float64); ok {
				cfg.Browser.CDPPort = int(v)
			}
		}

		// Update awareness
		if awareness, ok := params["awareness"].(map[string]any); ok {
			if v, ok := awareness["screen_interval_ms"].(float64); ok {
				cfg.Awareness.ScreenIntervalMs = int(v)
			}
			if v, ok := awareness["window_interval_ms"].(float64); ok {
				cfg.Awareness.WindowIntervalMs = int(v)
			}
			if v, ok := awareness["min_change_threshold"].(float64); ok {
				cfg.Awareness.MinChangeThreshold = v
			}
			if v, ok := awareness["stuck_threshold_ms"].(float64); ok {
				cfg.Awareness.StuckThresholdMs = int(v)
			}
		}

		// Persist to disk while still holding the lock, then release it.
		err := SaveConfig(cfg)
		mu.Unlock()
		if err != nil {
			return nil, fmt.Errorf("failed to save config: %w", err)
		}

		// onReloaded (reloadConfig) acquires the same lock, so it must run only
		// after we've released it — otherwise it self-deadlocks.
		if onReloaded != nil {
			onReloaded()
		}

		// Return updated config
		return getConfig(params)
	}
}

// --- System Info ---

func handleGetSystemInfo(params map[string]any) (*RPCResult, error) {
	hostname, _ := os.Hostname()
	return &RPCResult{Result: map[string]any{
		"hostname":   hostname,
		"platform":   runtime.GOOS,
		"arch":       runtime.GOARCH,
		"cpus":       runtime.NumCPU(),
		"uptime":     0, // Go stdlib doesn't expose system uptime easily
		"go_version": runtime.Version(),
	}}, nil
}

// --- Launch-App Helpers ---

// extractArgs extracts the "args" parameter from an RPC params map.
// It accepts:
//   - string:  returned as-is (e.g. "--verbose --output /tmp/foo")
//   - []any:   each element is fmt.Sprint'd and joined with spaces
//   - missing: returns ("", nil)
//
// Returns an error if "args" is present but has an unsupported type,
// so callers never silently ignore a malformed request.
func extractArgs(params map[string]any) (string, error) {
	raw, exists := params["args"]
	if !exists || raw == nil {
		return "", nil
	}
	switch v := raw.(type) {
	case string:
		return v, nil
	case []any:
		parts := make([]string, 0, len(v))
		for i, elem := range v {
			s, ok := elem.(string)
			if !ok {
				return "", fmt.Errorf("args[%d]: expected string, got %T", i, elem)
			}
			parts = append(parts, s)
		}
		return strings.Join(parts, " "), nil
	default:
		return "", fmt.Errorf("args: expected string or array, got %T", raw)
	}
}
