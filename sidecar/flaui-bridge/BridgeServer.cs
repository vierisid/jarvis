using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.AutomationElements.Infrastructure;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.Core.Tools;
using FlaUI.UIA3;

namespace FLAUIBridge;

public class BridgeServer : IDisposable
{
    public static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    private readonly UIA3Automation _automation;
    private readonly Dictionary<int, AutomationElement> _elementCache = new();
    private int _nextId;

    public BridgeServer()
    {
        _automation = new UIA3Automation();
    }

    public object HandleRequest(string method, JsonElement? p)
    {
        return method switch
        {
            "ping" => new { status = "ok" },
            "inspect" => Inspect(p),
            "find" => Find(p),
            "action" => DoAction(p),
            _ => throw new Exception($"Unknown method: {method}"),
        };
    }

    // ── inspect ──────────────────────────────────────────────────────

    private object Inspect(JsonElement? p)
    {
        _elementCache.Clear();
        _nextId = 0;

        int pid = GetPid(p);
        int maxDepth = GetInt(p, "depth", 3);
        bool includeInvisible = GetBool(p, "include_invisible", false);

        var window = FindWindowByPid(pid);
        if (window == null)
            throw new Exception($"No window found for PID {pid}");

        var elements = new List<Dictionary<string, object?>>();

        // Use RawViewWalker for maximum compatibility with modern apps (WinUI, XAML Islands)
        var walker = _automation.TreeWalkerFactory.GetRawViewWalker();
        WalkWithWalker(walker, window, 0, maxDepth, includeInvisible, elements);

        // Fallback: if walker found nothing, try FindAll with Descendants
        if (elements.Count == 0)
        {
            try
            {
                var all = window.FindAll(TreeScope.Descendants, TrueCondition.Default);
                foreach (var el in all)
                {
                    try
                    {
                        int id = _nextId++;
                        _elementCache[id] = el;
                        elements.Add(BuildElementInfo(el, id, 0));
                    }
                    catch { }
                }
            }
            catch { }
        }

        return new Dictionary<string, object?>
        {
            ["window_title"] = window.Name ?? "",
            ["pid"] = pid,
            ["element_count"] = elements.Count,
            ["elements"] = elements,
        };
    }

    private void WalkWithWalker(ITreeWalker walker, AutomationElement parent,
        int depth, int maxDepth, bool includeInvisible, List<Dictionary<string, object?>> results)
    {
        if (depth > maxDepth) return;

        AutomationElement child;
        try { child = walker.GetFirstChild(parent); }
        catch { return; }

        while (child != null)
        {
            try
            {
                var rect = child.BoundingRectangle;
                bool visible = rect.Width > 0 && rect.Height > 0;

                if (visible || includeInvisible)
                {
                    int id = _nextId++;
                    _elementCache[id] = child;
                    results.Add(BuildElementInfo(child, id, depth));
                }

                // Always recurse into children, even invisible containers
                WalkWithWalker(walker, child, depth + 1, maxDepth, includeInvisible, results);
            }
            catch { /* skip problematic elements */ }

            try { child = walker.GetNextSibling(child); }
            catch { break; }
        }
    }

    private Dictionary<string, object?> BuildElementInfo(AutomationElement el, int id, int depth)
    {
        var rect = el.BoundingRectangle;
        return new Dictionary<string, object?>
        {
            ["id"] = id,
            ["name"] = el.Name ?? "",
            ["automation_id"] = el.AutomationId ?? "",
            ["class_name"] = el.ClassName ?? "",
            ["control_type"] = el.ControlType.ToString(),
            ["enabled"] = el.IsEnabled,
            ["focusable"] = el.Properties.IsKeyboardFocusable.ValueOrDefault,
            ["rect"] = new Dictionary<string, int>
            {
                ["x"] = (int)rect.X, ["y"] = (int)rect.Y,
                ["w"] = (int)rect.Width, ["h"] = (int)rect.Height,
            },
            ["patterns"] = GetSupportedPatterns(el),
            ["depth"] = depth,
        };
    }

    // ── find ─────────────────────────────────────────────────────────

    private object Find(JsonElement? p)
    {
        int pid = GetPid(p);
        var window = FindWindowByPid(pid);
        if (window == null)
            throw new Exception($"No window found for PID {pid}");

        var cf = _automation.ConditionFactory;
        var conditions = new List<ConditionBase>();

        var automationId = GetStr(p, "automation_id");
        if (automationId != null)
            conditions.Add(cf.ByAutomationId(automationId));

        var name = GetStr(p, "name");
        if (name != null)
            conditions.Add(cf.ByName(name));

        var className = GetStr(p, "class_name");
        if (className != null)
            conditions.Add(cf.ByClassName(className));

        var controlType = GetStr(p, "control_type");
        if (controlType != null && Enum.TryParse<ControlType>(controlType, true, out var ct))
            conditions.Add(cf.ByControlType(ct));

        if (conditions.Count == 0)
            throw new Exception("At least one search criterion required: automation_id, name, class_name, or control_type");

        ConditionBase condition = conditions.Count == 1
            ? conditions[0]
            : new AndCondition(conditions.ToArray());

        var found = window.FindAll(TreeScope.Descendants, condition);
        var results = new List<Dictionary<string, object?>>();

        // Don't clear cache — allow mixing inspect + find results
        foreach (var el in found)
        {
            try
            {
                int id = _nextId++;
                _elementCache[id] = el;
                var rect = el.BoundingRectangle;
                results.Add(new Dictionary<string, object?>
                {
                    ["id"] = id,
                    ["name"] = el.Name ?? "",
                    ["automation_id"] = el.AutomationId ?? "",
                    ["class_name"] = el.ClassName ?? "",
                    ["control_type"] = el.ControlType.ToString(),
                    ["enabled"] = el.IsEnabled,
                    ["rect"] = new Dictionary<string, int>
                    {
                        ["x"] = (int)rect.X, ["y"] = (int)rect.Y,
                        ["w"] = (int)rect.Width, ["h"] = (int)rect.Height,
                    },
                    ["patterns"] = GetSupportedPatterns(el),
                });
            }
            catch { /* skip */ }
        }

        return new Dictionary<string, object?>
        {
            ["match_count"] = results.Count,
            ["elements"] = results,
        };
    }

    // ── action ───────────────────────────────────────────────────────

    private object DoAction(JsonElement? p)
    {
        int elementId = GetInt(p, "element_id", -1);
        if (elementId < 0 || !_elementCache.TryGetValue(elementId, out var element))
            throw new Exception($"Element [{elementId}] not found in cache — run inspect or find first");

        var action = GetStr(p, "action") ?? throw new Exception("Missing required parameter: action");

        return action switch
        {
            "click" => ClickAction(element),
            "double_click" => DoubleClickAction(element),
            "right_click" => RightClickAction(element),
            "invoke" => InvokeAction(element),
            "toggle" => ToggleAction(element),
            "select" => SelectAction(element),
            "set_value" => SetValueAction(element, p),
            "get_value" => GetValueAction(element),
            "get_text" => GetTextAction(element),
            "expand" => ExpandAction(element),
            "collapse" => CollapseAction(element),
            "scroll_into_view" => ScrollIntoViewAction(element),
            "focus" => FocusAction(element),
            _ => throw new Exception($"Unknown action: {action}"),
        };
    }

    private static object ClickAction(AutomationElement el)
    {
        el.Click();
        return new { success = true, action = "click" };
    }

    private static object DoubleClickAction(AutomationElement el)
    {
        el.DoubleClick();
        return new { success = true, action = "double_click" };
    }

    private static object RightClickAction(AutomationElement el)
    {
        el.RightClick();
        return new { success = true, action = "right_click" };
    }

    private static object InvokeAction(AutomationElement el)
    {
        var pattern = el.Patterns.Invoke.PatternOrDefault;
        if (pattern == null)
            throw new Exception("Element does not support Invoke pattern");
        pattern.Invoke();
        return new { success = true, action = "invoke" };
    }

    private static object ToggleAction(AutomationElement el)
    {
        var pattern = el.Patterns.Toggle.PatternOrDefault;
        if (pattern == null)
            throw new Exception("Element does not support Toggle pattern");
        pattern.Toggle();
        return new { success = true, action = "toggle", state = pattern.ToggleState.ToString() };
    }

    private static object SelectAction(AutomationElement el)
    {
        var pattern = el.Patterns.SelectionItem.PatternOrDefault;
        if (pattern == null)
            throw new Exception("Element does not support SelectionItem pattern");
        pattern.Select();
        return new { success = true, action = "select" };
    }

    private static object SetValueAction(AutomationElement el, JsonElement? p)
    {
        var value = GetStr(p, "value") ?? throw new Exception("Missing required parameter: value");
        var pattern = el.Patterns.Value.PatternOrDefault;
        if (pattern == null)
            throw new Exception("Element does not support Value pattern");
        pattern.SetValue(value);
        return new { success = true, action = "set_value" };
    }

    private static object GetValueAction(AutomationElement el)
    {
        var pattern = el.Patterns.Value.PatternOrDefault;
        if (pattern == null)
            throw new Exception("Element does not support Value pattern");
        return new { success = true, action = "get_value", value = pattern.Value.ValueOrDefault ?? "" };
    }

    private static object GetTextAction(AutomationElement el)
    {
        var pattern = el.Patterns.Text.PatternOrDefault;
        if (pattern != null)
            return new { success = true, action = "get_text", text = pattern.DocumentRange.GetText(-1) };

        // Fall back to Value pattern
        var valPattern = el.Patterns.Value.PatternOrDefault;
        if (valPattern != null)
            return new { success = true, action = "get_text", text = valPattern.Value.ValueOrDefault ?? "" };

        // Fall back to Name property
        return new { success = true, action = "get_text", text = el.Name ?? "" };
    }

    private static object ExpandAction(AutomationElement el)
    {
        var pattern = el.Patterns.ExpandCollapse.PatternOrDefault;
        if (pattern == null)
            throw new Exception("Element does not support ExpandCollapse pattern");
        pattern.Expand();
        return new { success = true, action = "expand" };
    }

    private static object CollapseAction(AutomationElement el)
    {
        var pattern = el.Patterns.ExpandCollapse.PatternOrDefault;
        if (pattern == null)
            throw new Exception("Element does not support ExpandCollapse pattern");
        pattern.Collapse();
        return new { success = true, action = "collapse" };
    }

    private static object ScrollIntoViewAction(AutomationElement el)
    {
        var pattern = el.Patterns.ScrollItem.PatternOrDefault;
        if (pattern == null)
            throw new Exception("Element does not support ScrollItem pattern");
        pattern.ScrollIntoView();
        return new { success = true, action = "scroll_into_view" };
    }

    private static object FocusAction(AutomationElement el)
    {
        el.Focus();
        return new { success = true, action = "focus" };
    }

    // ── Helpers ──────────────────────────────────────────────────────

    private AutomationElement? FindWindowByPid(int pid)
    {
        var desktop = _automation.GetDesktop();
        var condition = _automation.ConditionFactory.ByProcessId(pid);
        return desktop.FindFirst(TreeScope.Children, condition);
    }

    private int GetPid(JsonElement? p)
    {
        int pid = GetInt(p, "pid", 0);
        if (pid > 0) return pid;

        // Use foreground window PID
        var desktop = _automation.GetDesktop();
        var focused = desktop.FindFirst(TreeScope.Children,
            _automation.ConditionFactory.ByControlType(ControlType.Window));

        // Walk all windows and find the foreground one via Win32
        var fgHandle = GetForegroundWindowHandle();
        if (fgHandle == IntPtr.Zero)
            throw new Exception("No foreground window found");

        GetWindowThreadProcessId(fgHandle, out uint fgPid);
        if (fgPid == 0)
            throw new Exception("Could not determine foreground window PID");

        return (int)fgPid;
    }

    private static List<string> GetSupportedPatterns(AutomationElement el)
    {
        var patterns = new List<string>();
        try
        {
            if (el.Patterns.Invoke.IsSupported) patterns.Add("Invoke");
            if (el.Patterns.Value.IsSupported) patterns.Add("Value");
            if (el.Patterns.Toggle.IsSupported) patterns.Add("Toggle");
            if (el.Patterns.SelectionItem.IsSupported) patterns.Add("SelectionItem");
            if (el.Patterns.ExpandCollapse.IsSupported) patterns.Add("ExpandCollapse");
            if (el.Patterns.Scroll.IsSupported) patterns.Add("Scroll");
            if (el.Patterns.ScrollItem.IsSupported) patterns.Add("ScrollItem");
            if (el.Patterns.Text.IsSupported) patterns.Add("Text");
            if (el.Patterns.RangeValue.IsSupported) patterns.Add("RangeValue");
            if (el.Patterns.Transform.IsSupported) patterns.Add("Transform");
            if (el.Patterns.Window.IsSupported) patterns.Add("Window");
            if (el.Patterns.Grid.IsSupported) patterns.Add("Grid");
            if (el.Patterns.GridItem.IsSupported) patterns.Add("GridItem");
            if (el.Patterns.Table.IsSupported) patterns.Add("Table");
            if (el.Patterns.TableItem.IsSupported) patterns.Add("TableItem");
        }
        catch { /* some patterns may throw on access */ }
        return patterns;
    }

    private static int GetInt(JsonElement? p, string name, int defaultValue)
    {
        if (p?.TryGetProperty(name, out var prop) == true)
        {
            if (prop.ValueKind == JsonValueKind.Number) return prop.GetInt32();
            if (prop.ValueKind == JsonValueKind.String && int.TryParse(prop.GetString(), out var v)) return v;
        }
        return defaultValue;
    }

    private static bool GetBool(JsonElement? p, string name, bool defaultValue)
    {
        if (p?.TryGetProperty(name, out var prop) == true && prop.ValueKind is JsonValueKind.True or JsonValueKind.False)
            return prop.GetBoolean();
        return defaultValue;
    }

    private static string? GetStr(JsonElement? p, string name)
    {
        if (p?.TryGetProperty(name, out var prop) == true && prop.ValueKind == JsonValueKind.String)
            return prop.GetString();
        return null;
    }

    // Win32 interop for foreground window
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    private static IntPtr GetForegroundWindowHandle() => GetForegroundWindow();

    public void Dispose()
    {
        _automation.Dispose();
        GC.SuppressFinalize(this);
    }
}
