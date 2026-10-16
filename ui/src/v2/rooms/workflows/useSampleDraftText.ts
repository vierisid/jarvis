import { useContext, useEffect, useState } from "react";
import { WorkflowEditorEnvironment } from "./WorkflowEditorEnvironment";

/** Unfinished sample JSON is scoped to the current owner, flow and version. */
export function useSampleDraftText(key: string, incoming: string) {
  const { sampleDrafts } = useContext(WorkflowEditorEnvironment);
  const [text, setText] = useState(() => sampleDrafts?.get(key) ?? incoming);
  const [savedText, markSaved] = useState(incoming);
  useEffect(() => {
    if (text === incoming) sampleDrafts?.delete(key);
    else sampleDrafts?.set(key, text);
  }, [sampleDrafts, key, text, incoming]);
  // A save can finish while this node's inspector is unmounted. A remounted
  // editor must acknowledge the confirmed server value without replacing newer
  // typing. The explicit markSaved callback still records the submitted text.
  useEffect(() => { markSaved(incoming); }, [incoming]);
  return { text, setText, hasUnsavedEdits: !sameSampleValue(text, savedText), markSaved };
}

/** JSON formatting does not change the sample that a test run will consume. */
function sameSampleValue(text: string, saved: string): boolean {
  if (text.trim() === saved.trim()) return true;
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(JSON.parse(saved));
  } catch {
    // An unfinished/invalid draft must remain unsaved, never silently discarded.
    return false;
  }
}
