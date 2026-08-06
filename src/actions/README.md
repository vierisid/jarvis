# J.A.R.V.I.S. Action Layer

The Action Layer provides cross-platform interfaces for controlling applications, browsers, terminals, and managing tool execution.

## Architecture

```
src/actions/
├── app-control/      # Cross-platform application control
│   ├── interface.ts  # Common interface & platform factory
│   ├── linux.ts      # Linux/X11 implementation
│   ├── windows.ts    # Windows: sidecar-first + PowerShell fallback
│   ├── macos.ts      # macOS: sidecar-first + AppleScript fallback
│   └── scripts/      # Fixed script assets (desktop.ps1, desktop.applescript)
├── browser/          # Chrome DevTools Protocol
│   ├── cdp.ts        # CDP client implementation
│   └── session.ts    # Browser session management
├── terminal/         # Command execution
│   ├── executor.ts   # Shell command executor
│   └── wsl-bridge.ts # WSL integration
├── tools/            # Tool registry & execution
│   └── registry.ts   # Dynamic tool management
└── index.ts          # Public API exports
```

## Components

### App Control

Cross-platform application and window management with UI automation.

**Interface:**
```typescript
import { getAppController } from '@/actions';

const controller = getAppController(); // Returns platform-specific implementation

// Get active window
const activeWindow = await controller.getActiveWindow();
console.log(activeWindow.title, activeWindow.bounds);

// List all windows
const windows = await controller.listWindows();

// UI automation
await controller.typeText("Hello World");
await controller.pressKeys(['ctrl', 'a']);
await controller.focusWindow(pid);

// Screenshots
const screenBuffer = await controller.captureScreen();
const windowBuffer = await controller.captureWindow(pid);
```

**Linux Implementation:**

Uses X11 tools (xdotool, xprop, wmctrl, ImageMagick):
- Window management and focus control
- Keyboard/mouse input simulation
- Screenshot capture
- Geometry and property inspection

**Status:**
- ✅ Linux: Fully implemented (X11 tools)
- ✅ Windows: Sidecar-first (desktop-bridge, full UI Automation); PowerShell/Win32 fallback for windows, input, screenshots
- ✅ macOS: Sidecar-first; AppleScript/screencapture fallback for windows, input, screenshots
- ⏳ UI element trees (getWindowTree) require the sidecar on Windows/macOS

### Browser Control

Chrome DevTools Protocol client for browser automation.

**Usage:**
```typescript
import { BrowserSession, CDPBrowser } from '@/actions';

const session = new BrowserSession(9222); // Default CDP port

// Check availability
if (await session.isAvailable()) {
  await session.ensureConnected();

  const browser = session.getBrowser();

  // List tabs
  const tabs = await browser.listTabs();

  // Navigate
  await browser.navigate(tabs[0].id, 'https://example.com');

  // Execute JavaScript
  const result = await browser.evaluate(tabs[0].id, 'document.title');

  // Screenshot
  const screenshot = await browser.screenshot(tabs[0].id);

  await session.disconnect();
}
```

**Requirements:**

Launch Chrome with remote debugging:
```bash
google-chrome --remote-debugging-port=9222
```

Or Chrome/Chromium headless:
```bash
chromium --headless --remote-debugging-port=9222
```

### Terminal Executor

Cross-platform shell command execution with streaming support.

**Usage:**
```typescript
import { TerminalExecutor } from '@/actions';

const executor = new TerminalExecutor({
  shell: '/bin/bash', // Auto-detected if not specified
  timeout: 30000,     // Default timeout in ms
});

// Execute command
const result = await executor.execute('ls -la', {
  cwd: '/home/user',
  env: { DEBUG: 'true' },
  timeout: 10000,
});

console.log(result.stdout);
console.log(result.stderr);
console.log(result.exitCode);
console.log(result.duration);

// Stream output
for await (const chunk of executor.stream('npm install')) {
  process.stdout.write(chunk);
}
```

**Shell Detection:**
- Linux/macOS: `$SHELL` or `/bin/bash`
- Windows: `%COMSPEC%` or `powershell.exe`

### WSL Bridge

Windows Subsystem for Linux integration.

**Usage:**
```typescript
import { WSLBridge } from '@/actions';

// Detect WSL environment
if (WSLBridge.isWSL()) {
  const bridge = new WSLBridge();

  // Run Windows commands from WSL
  const result = await bridge.runWindowsCommand('dir C:\\Users');

  // Run PowerShell scripts
  const psResult = await bridge.runPowerShell('Get-Process | Select -First 5');

  // Path conversion
  const winPath = await bridge.convertToWindowsPath('/home/user/file.txt');
  const wslPath = await bridge.convertToWSLPath('C:\\Users\\user\\file.txt');

  // Get Windows home directory
  const winHome = bridge.getWindowsHome();
}
```

**Detection:**
- Checks `/proc/version` for "microsoft" or "WSL"
- Checks `$WSL_DISTRO_NAME` or `$WSL_INTEROP` environment variables

### Tool Registry

Dynamic tool registration and execution with parameter validation.

**Usage:**
```typescript
import { ToolRegistry, type ToolDefinition } from '@/actions';

const registry = new ToolRegistry();

// Define a tool
const searchTool: ToolDefinition = {
  name: 'search_files',
  description: 'Search for files by pattern',
  category: 'filesystem',
  parameters: {
    pattern: {
      type: 'string',
      description: 'Search pattern (glob)',
      required: true,
    },
    directory: {
      type: 'string',
      description: 'Directory to search',
      required: false,
    },
  },
  execute: async (params) => {
    const pattern = params.pattern as string;
    const dir = (params.directory as string) || '.';

    // Implementation here
    return { found: [] };
  },
};

// Register tool
registry.register(searchTool);

// Execute tool
const result = await registry.execute('search_files', {
  pattern: '*.ts',
  directory: '/src',
});

// Query registry
console.log(registry.list('filesystem'));
console.log(registry.getCategories());
console.log(registry.count());
```

**Features:**
- Parameter type validation
- Required parameter enforcement
- Category organization
- Graceful error handling

## Installation

The Action Layer uses native Bun APIs and requires no additional npm packages.

### Linux Dependencies

For full app-control functionality:

```bash
# Ubuntu/Debian
sudo apt install xdotool x11-utils wmctrl imagemagick scrot

# Fedora
sudo dnf install xdotool xorg-x11-utils wmctrl ImageMagick scrot

# Arch
sudo pacman -S xdotool xorg-xprop wmctrl imagemagick scrot
```

### Browser Dependencies

Chrome/Chromium with remote debugging enabled:

```bash
google-chrome --remote-debugging-port=9222 &
```

## Examples

### Complete Example: Screenshot Active Window

```typescript
import { getAppController } from '@/actions';

async function screenshotActiveWindow() {
  const controller = getAppController();

  const activeWindow = await controller.getActiveWindow();
  console.log(`Capturing: ${activeWindow.title}`);

  const screenshot = await controller.captureWindow(activeWindow.pid);
  await Bun.write('screenshot.png', screenshot);

  console.log('Saved screenshot.png');
}

screenshotActiveWindow();
```

### Complete Example: Automate Browser

```typescript
import { BrowserSession } from '@/actions';

async function automateSearch() {
  const session = new BrowserSession();
  await session.ensureConnected();

  const browser = session.getBrowser();
  const tabs = await browser.listTabs();
  const tabId = tabs[0]?.id;

  if (!tabId) {
    throw new Error('No tabs found');
  }

  await browser.navigate(tabId, 'https://google.com');

  const title = await browser.evaluate(tabId, 'document.title');
  console.log('Page title:', title);

  await session.disconnect();
}

automateSearch();
```

### Complete Example: WSL File Transfer

```typescript
import { WSLBridge, TerminalExecutor } from '@/actions';

async function copyToWindows() {
  if (!WSLBridge.isWSL()) {
    throw new Error('Not running in WSL');
  }

  const bridge = new WSLBridge();
  const executor = new TerminalExecutor();

  // Copy file from WSL to Windows
  const wslFile = '/home/user/data.json';
  const winPath = await bridge.convertToWindowsPath(wslFile);

  await bridge.runPowerShell(
    `Copy-Item "${winPath}" "C:\\Users\\Public\\data.json"`
  );

  console.log('File copied to Windows');
}

copyToWindows();
```

## Error Handling

All methods throw descriptive errors with installation instructions when dependencies are missing:

```typescript
try {
  await controller.captureScreen();
} catch (error) {
  // Error includes installation instructions:
  // "No screenshot tool found. Please install one:
  //   ImageMagick: sudo apt install imagemagick
  //   Scrot: sudo apt install scrot"
}
```

## Testing

Run the test suite:

```bash
bun run src/actions/test.ts
```

Expected output:
```
Testing J.A.R.V.I.S. Action Layer

1. App Controller
   Platform: linux
   ✓ App controller initialized for linux

2. Terminal Executor
   Detected shell: /bin/bash
   ✓ Command executed: Hello from JARVIS
   Duration: 35ms

3. WSL Bridge
   Running in WSL: true
   Windows home: Not detected

4. Browser Session
   Chrome DevTools available: false

5. Tool Registry
   Registered tools: 1
   Categories: utility
   ✓ Tool execution: Echo: Hello JARVIS!

✓ Action Layer test complete!
```

## Platform Support Matrix

| Feature | Linux | Windows | macOS |
|---------|-------|---------|-------|
| Window Management | ✅ | ⏳ | ⏳ |
| UI Automation | ✅ | ⏳ | ⏳ |
| Keyboard Input | ✅ | ⏳ | ⏳ |
| Screenshots | ✅ | ⏳ | ⏳ |
| Browser CDP | ✅ | ✅ | ✅ |
| Terminal Execution | ✅ | ✅ | ✅ |
| WSL Bridge | ✅ | N/A | N/A |
| Tool Registry | ✅ | ✅ | ✅ |

## Future Enhancements

### Windows Implementation
- Use UI Automation COM API via N-API bindings
- PowerShell UIAutomation module fallback
- Consider AutoHotkey IPC bridge for complex automation

### macOS Implementation
- AXUIElement API via Swift/Objective-C bridge
- AppleScript integration for legacy apps
- Consider node-mac-automation package

### Linux Enhancements
- AT-SPI2 integration for accessibility tree
- Wayland support (currently X11 only)
- Direct D-Bus bindings for better performance

## License

Part of Project J.A.R.V.I.S. - See root LICENSE file.
