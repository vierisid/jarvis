import { describe, expect, test } from "bun:test";
import {
  appEquivalentHints,
  flowOsWarnings,
  familyLabel,
  findOsConflicts,
  hostTarget,
  osCheckContextFor,
  osDisciplineLines,
  osFamily,
  OS_SENSITIVE_TOOL_PARAMS,
  reachableFamilies,
  renderExecutionEnvironment,
  resolveTarget,
  type ExecutionTarget,
  type OsFamily,
} from "./execution-environment";

const mac: ExecutionTarget = {
  id: "sc-mac",
  name: "Lapo's MacBook",
  os: "darwin",
  arch: "arm64",
  connected: true,
  capabilities: ["terminal", "desktop"],
};
const win: ExecutionTarget = {
  id: "sc-win",
  name: "Desk PC",
  os: "windows",
  arch: "amd64",
  connected: false,
  capabilities: ["terminal"],
};
const linuxHost: ExecutionTarget = {
  id: "",
  name: "Jarvis host (this brain)",
  os: "linux",
  arch: "x64",
  connected: true,
  isHost: true,
};

const families = (...f: OsFamily[]) => new Set<OsFamily>(f);

describe("osFamily", () => {
  test("maps GOOS, process.platform and friendly spellings", () => {
    expect(osFamily("darwin")).toBe("macos");
    expect(osFamily("macOS")).toBe("macos");
    expect(osFamily("win32")).toBe("windows");
    expect(osFamily("windows")).toBe("windows");
    expect(osFamily("linux")).toBe("linux");
  });

  test("is null for unknown / missing values", () => {
    expect(osFamily(null)).toBeNull();
    expect(osFamily("")).toBeNull();
    expect(osFamily("freebsd")).toBeNull();
  });
});

describe("reachableFamilies", () => {
  test("sidecars win over the host: a Linux brain does not excuse Linux syntax on a Mac fleet", () => {
    const fams = reachableFamilies([mac, linuxHost]);
    expect(fams).toEqual(families("macos"));
  });

  test("the host counts when no sidecar is enrolled", () => {
    expect(reachableFamilies([linuxHost])).toEqual(families("linux"));
  });

  test("covers every enrolled sidecar, offline ones included", () => {
    // The laptop asleep right now is still the machine a scheduled flow means.
    expect(reachableFamilies([mac, win, linuxHost])).toEqual(families("macos", "windows"));
  });

  test("is null when any candidate's OS was never reported", () => {
    const unknown: ExecutionTarget = { id: "sc-new", name: "New laptop", os: null };
    expect(reachableFamilies([mac, unknown, linuxHost])).toBeNull();
  });

  test("is null with no targets at all", () => {
    expect(reachableFamilies([])).toBeNull();
  });
});

describe("resolveTarget", () => {
  const all = [mac, win, linuxHost];
  test("resolves by exact id, then exact name, then substring -- like the runtime", () => {
    expect(resolveTarget(all, "sc-win")?.id).toBe("sc-win");
    expect(resolveTarget(all, "desk pc")?.id).toBe("sc-win");
    expect(resolveTarget(all, "MacBook")?.id).toBe("sc-mac");
  });

  test("is null for a name matching nothing", () => {
    expect(resolveTarget(all, "server-42")).toBeNull();
    expect(resolveTarget(all, "  ")).toBeNull();
  });
});

describe("findOsConflicts", () => {
  test("flags the reported bug: notepad.exe on a Mac-only fleet", () => {
    const conflicts = findOsConflicts("notepad.exe", families("macos"));
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]!.families).toEqual(["windows"]);
  });

  test("says nothing when the syntax matches a reachable machine", () => {
    expect(findOsConflicts("notepad.exe", families("windows"))).toEqual([]);
    expect(findOsConflicts("open -a TextEdit", families("macos"))).toEqual([]);
    expect(findOsConflicts("xdg-open notes.txt", families("linux"))).toEqual([]);
  });

  test("flags macOS and Linux syntax on the other families too", () => {
    expect(findOsConflicts("osascript -e 'beep'", families("windows"))).not.toEqual([]);
    expect(findOsConflicts("open -a TextEdit", families("linux"))).not.toEqual([]);
    expect(findOsConflicts("xdg-open notes.txt", families("macos"))).not.toEqual([]);
    expect(findOsConflicts("systemctl restart nginx", families("macos"))).not.toEqual([]);
  });

  test("flags OS-bound paths", () => {
    expect(findOsConflicts("C:\\Users\\lapo\\notes.txt", families("macos"))).not.toEqual([]);
    expect(findOsConflicts("%APPDATA%\\jarvis", families("linux"))).not.toEqual([]);
    expect(findOsConflicts("/Applications/Notes.app", families("windows"))).not.toEqual([]);
    expect(findOsConflicts("~/Library/Logs", families("linux"))).not.toEqual([]);
    expect(findOsConflicts("/home/dev/notes.txt", families("macos"))).not.toEqual([]);
  });

  test("cross-platform syntax is judged against every family it runs on", () => {
    // brew and sudo run on macOS AND Linux; only a Windows-only fleet is a miss.
    expect(findOsConflicts("brew install jq", families("linux"))).toEqual([]);
    expect(findOsConflicts("sudo systemctl restart x", families("macos", "linux"))).toEqual([]);
    expect(findOsConflicts("brew install jq", families("windows"))).not.toEqual([]);
  });

  test("leaves OS-neutral commands alone", () => {
    for (const cmd of ["git status", "echo hello", "python3 script.py", "node --version", "ls"]) {
      expect(findOsConflicts(cmd, families("macos"))).toEqual([]);
      expect(findOsConflicts(cmd, families("windows"))).toEqual([]);
      expect(findOsConflicts(cmd, families("linux"))).toEqual([]);
    }
  });
});

describe("findOsConflicts: precision on realistic commands", () => {
  // A false rejection costs the user the workflow they asked for, so the
  // program-name markers are anchored to command position. Before that, every
  // one of these legitimate commands was rejected: a `.exe` being deleted, an
  // app name inside a quoted string. Keep this table honest when adding a
  // marker -- it is the only thing standing between the check and the retry
  // loop burning four attempts on a command that was fine all along.
  const legitimate: Array<[string, OsFamily]> = [
    ["rm ~/Downloads/installer.exe", "macos"],
    ["mv report.exe.bak archive/", "macos"],
    ["echo 'explorer of the data lake'", "macos"],
    ["echo notepad > names.txt", "macos"],
    ["git pull && bun test", "macos"],
    ["ls /Users/lapo/Documents", "macos"],
    ["open https://example.com", "macos"],
    ["cat notes.md | pbcopy", "macos"],
    ["python script.py --reg add", "windows"],
    ["curl -s https://api.example.com/etc/config", "windows"],
    ["aws s3 cp x s3://bucket/var/data", "windows"],
    ["node scripts/build.js", "windows"],
    ["docker compose up -d", "linux"],
  ];

  const impossible: Array<[string, OsFamily]> = [
    ["notepad.exe", "macos"],
    ["notepad", "macos"],
    ["C:\\Windows\\System32\\notepad.exe", "macos"],
    ["powershell -Command Get-Process", "macos"],
    ["cmd /c dir", "linux"],
    ["open -a TextEdit", "windows"],
    ["osascript -e 'display notification'", "linux"],
    ["xdg-open notes.txt", "macos"],
    ["sudo systemctl restart nginx", "windows"],
    ["apt-get install jq", "windows"],
    ["cat x | pbcopy", "windows"],
    ["%APPDATA%\\jarvis\\config.json", "macos"],
    ["/Applications/Notes.app", "windows"],
    ["defaults write com.apple.finder X 1", "linux"],
    ["brew install jq", "windows"],
  ];

  test.each(legitimate)("leaves %j alone on %s", (cmd, fam) => {
    expect(findOsConflicts(cmd, families(fam))).toEqual([]);
  });

  test.each(impossible)("flags %j on %s", (cmd, fam) => {
    expect(findOsConflicts(cmd, families(fam)).length).toBeGreaterThan(0);
  });

  test("quotes back the offending fragment without the separator it followed", () => {
    const [conflict] = findOsConflicts("cd /tmp && notepad.exe", families("macos"));
    expect(conflict?.fragment).toBe("notepad.exe");
  });
});

describe("appEquivalentHints", () => {
  test("names the app the reachable OS actually ships", () => {
    expect(appEquivalentHints("notepad.exe", families("macos"))).toEqual(["on macOS use TextEdit"]);
    expect(appEquivalentHints("calc.exe", families("linux"))).toEqual(["on Linux use gnome-calculator"]);
  });

  test("is empty for an app with no mapping", () => {
    expect(appEquivalentHints("vim", families("macos"))).toEqual([]);
  });
});

describe("renderExecutionEnvironment", () => {
  test("lists every machine with its OS, arch and reachability", () => {
    const text = renderExecutionEnvironment([mac, win, linuxHost]).join("\n");
    expect(text).toContain("Lapo's MacBook");
    expect(text).toContain("macOS, arm64");
    expect(text).toContain("Desk PC");
    expect(text).toContain("OFFLINE");
    expect(text).toContain("can: terminal, desktop");
    expect(text).toContain("Jarvis host (this brain)");
  });

  test("tells the model to set `target` only when there is a choice to make", () => {
    expect(renderExecutionEnvironment([mac, win, linuxHost]).join("\n")).toContain("`target` param");
    expect(renderExecutionEnvironment([mac, linuxHost]).join("\n")).not.toContain("`target` param to the machine name");
  });

  test("names the OS the request has to fit", () => {
    expect(renderExecutionEnvironment([mac, linuxHost]).join("\n")).toContain(
      "The machines above run macOS.",
    );
  });

  test("renders nothing without an inventory, so callers can spread it blind", () => {
    expect(renderExecutionEnvironment([])).toEqual([]);
  });

  test("says so when a machine never reported its OS", () => {
    const text = renderExecutionEnvironment([{ id: "x", name: "New laptop", os: null }]).join("\n");
    expect(text).toContain("OS unknown (never connected)");
  });
});

describe("OS_SENSITIVE_TOOL_PARAMS stays in step with the real tools", () => {
  // The compose-time check keys off tool NAMES. A rename anywhere in the tool
  // registry would not break a type or a test -- the check would just quietly
  // stop firing and `notepad.exe` would sail through again. This is the guard.
  test("every named tool and param exists in the builtin registry", async () => {
    const { BUILTIN_TOOLS } = await import("../actions/tools/builtin");
    const byName = new Map(BUILTIN_TOOLS.map((t) => [t.name, t]));
    for (const [toolName, params] of Object.entries(OS_SENSITIVE_TOOL_PARAMS)) {
      const tool = byName.get(toolName);
      expect(tool, `tool "${toolName}" is no longer registered`).toBeDefined();
      for (const param of [...params, "target"]) {
        expect(
          Object.keys(tool!.parameters),
          `tool "${toolName}" no longer has a "${param}" param`,
        ).toContain(param);
      }
    }
  });
});

describe("flowOsWarnings: flows the composer never wrote", () => {
  // A flow drawn by hand in the visual editor never passes through the
  // composer's validation, so publish is the only place its OS fit is ever
  // checked.
  const ctx = osCheckContextFor([mac, linuxHost])!;

  const invokeStep = (name: string, toolName: string, params: Record<string, unknown>) => ({
    name,
    type: "PIECE",
    settings: { pieceName: "jarvis-tool", actionName: "invoke", input: { toolName, params } },
  });

  test("finds a wrong-OS step in a plain chain", () => {
    const trigger = {
      name: "trigger",
      type: "EMPTY",
      nextAction: invokeStep("step_1", "desktop_launch_app", { executable: "notepad.exe" }),
    };
    const warnings = flowOsWarnings(trigger, ctx);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("notepad.exe");
  });

  test("descends into loop bodies and router branches", () => {
    const trigger = {
      name: "trigger",
      type: "EMPTY",
      nextAction: {
        name: "loop_1",
        type: "LOOP_ON_ITEMS",
        settings: { items: "{{trigger.items}}" },
        firstLoopAction: invokeStep("step_1", "run_command", { command: "powershell -c ls" }),
        nextAction: {
          name: "router_1",
          type: "ROUTER",
          settings: { branches: [{ branchName: "a" }, { branchName: "b" }] },
          children: [invokeStep("step_2", "write_file", { path: "C:\\temp\\out.txt" }), null],
        },
      },
    };
    expect(flowOsWarnings(trigger, ctx)).toHaveLength(2);
  });

  test("says nothing about a flow that fits, or one with no shell steps", () => {
    const fine = {
      name: "trigger",
      type: "EMPTY",
      nextAction: invokeStep("step_1", "run_command", { command: "open -a TextEdit" }),
    };
    expect(flowOsWarnings(fine, ctx)).toEqual([]);
    expect(flowOsWarnings({ name: "trigger", type: "EMPTY" }, ctx)).toEqual([]);
  });

  test("survives a malformed or cyclic tree instead of hanging", () => {
    expect(flowOsWarnings(null, ctx)).toEqual([]);
    expect(flowOsWarnings({ name: "t", settings: "not-an-object" }, ctx)).toEqual([]);
    const cyclic: Record<string, unknown> = { name: "trigger", type: "EMPTY" };
    cyclic.nextAction = cyclic;
    expect(flowOsWarnings(cyclic, ctx)).toEqual([]);
  });
});

describe("osDisciplineLines", () => {
  test("names app equivalents from the same table the validator quotes", () => {
    const text = osDisciplineLines().join(" ");
    // APP_EQUIVALENTS is the single source: prose and hint must agree.
    const hint = appEquivalentHints("notepad", families("macos"))[0]!;
    expect(hint).toContain("TextEdit");
    expect(text).toContain("TextEdit (macOS)");
  });

  test("covers the traps that are not shell syntax", () => {
    const text = osDisciplineLines().join(" ");
    expect(text).toContain("MUST match the OS of the machine");
    expect(text).toContain("Cmd where Windows and Linux use Ctrl");
  });
});

describe("hostTarget", () => {
  test("reports the running process's OS and arch", () => {
    const h = hostTarget();
    expect(h.isHost).toBe(true);
    expect(h.os).toBe(process.platform);
    expect(h.arch).toBe(process.arch);
    expect(osFamily(h.os)).not.toBeNull();
  });
});

describe("familyLabel", () => {
  test("uses the spelling a human would write", () => {
    expect(familyLabel("macos")).toBe("macOS");
    expect(familyLabel("windows")).toBe("Windows");
    expect(familyLabel("linux")).toBe("Linux");
  });
});
