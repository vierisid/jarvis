import React, { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../../hooks/useApi";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, highlightActiveLine, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentOnInput, bracketMatching, foldGutter, foldKeymap, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { oneDark } from "@codemirror/theme-one-dark";

type Props = {
  projectId: string | null;
  filePath: string | null;
};

// Language mode detection from file extension
async function getLanguageExtension(filePath: string) {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true });
    case "html":
    case "htm":
      return (await import("@codemirror/lang-html")).html();
    case "css":
    case "scss":
      return (await import("@codemirror/lang-css")).css();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "md":
    case "mdx":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "py":
      return (await import("@codemirror/lang-python")).python();
    default:
      return null;
  }
}

export function SiteEditor({ projectId, filePath }: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "ok" | "error" } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const originalContentRef = useRef("");
  const filePathRef = useRef(filePath);
  const projectIdRef = useRef(projectId);

  // Keep refs in sync
  filePathRef.current = filePath;
  projectIdRef.current = projectId;

  // Save handler
  const handleSave = useCallback(async () => {
    const view = viewRef.current;
    if (!projectIdRef.current || !filePathRef.current || !view) return;

    const content = view.state.doc.toString();
    if (content === originalContentRef.current) return;

    setSaving(true);
    setMessage(null);
    try {
      await api(`/api/sites/projects/${projectIdRef.current}/file`, {
        method: "PUT",
        body: JSON.stringify({ path: filePathRef.current, content }),
      });
      originalContentRef.current = content;
      setIsDirty(false);
      setMessage({ text: "Saved", type: "ok" });
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Save failed", type: "error" });
    } finally {
      setSaving(false);
    }
  }, []);

  // Keyboard shortcut: Ctrl+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  // Load file and create/update editor
  useEffect(() => {
    if (!projectId || !filePath || !containerRef.current) {
      // Destroy existing editor
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
      return;
    }

    setLoading(true);
    setIsDirty(false);

    api<{ path: string; content: string }>(`/api/sites/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`)
      .then(async (res) => {
        originalContentRef.current = res.content;

        // Destroy previous editor
        if (viewRef.current) {
          viewRef.current.destroy();
          viewRef.current = null;
        }

        // Get language extension
        const langExt = await getLanguageExtension(filePath);

        const extensions = [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          rectangularSelection(),
          crosshairCursor(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          oneDark,
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const newContent = update.state.doc.toString();
              setIsDirty(newContent !== originalContentRef.current);
            }
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": { overflow: "auto", fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace" },
            ".cm-content": { minHeight: "100%" },
          }),
        ];

        if (langExt) extensions.push(langExt);

        const state = EditorState.create({
          doc: res.content,
          extensions,
        });

        const view = new EditorView({
          state,
          parent: containerRef.current!,
        });

        viewRef.current = view;
      })
      .catch(() => {
        originalContentRef.current = "";
      })
      .finally(() => setLoading(false));

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [projectId, filePath]);

  if (!projectId || !filePath) {
    return <div style={emptyStyle}>Click a file in the tree to open it</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* File header */}
      <div style={headerStyle}>
        <span style={{ fontSize: "12px", color: "var(--ink2)" }}>
          {filePath}
          {isDirty && <span style={{ color: "var(--j-warning)", marginLeft: 4 }}>*</span>}
        </span>
        <div style={{ display: "flex", gap: "6px", marginLeft: "auto", alignItems: "center" }}>
          {message && (
            <span style={{ fontSize: "11px", color: message.type === "ok" ? "var(--ok)" : "var(--j-error)" }}>
              {message.text}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            style={{ ...saveBtnStyle, opacity: isDirty ? 1 : 0.4 }}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {/* CodeMirror container - always rendered so ref stays mounted */}
      <div ref={containerRef} style={{ flex: 1, overflow: "hidden", display: loading ? "none" : "block" }} />
      {loading && <div style={{ ...emptyStyle, flex: 1 }}>Loading...</div>}
    </div>
  );
}

const emptyStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "var(--ink3)",
  fontSize: "12px",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "6px 12px",
  borderBottom: "1px solid var(--rule)",
  background: "var(--bg)",
};

const saveBtnStyle: React.CSSProperties = {
  padding: "3px 10px",
  fontSize: "11px",
  background: "rgba(0, 212, 255, 0.1)",
  border: "1px solid rgba(0, 212, 255, 0.3)",
  borderRadius: "4px",
  color: "var(--ink)",
  cursor: "pointer",
};
