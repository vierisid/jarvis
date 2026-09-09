import { useContext, useEffect, useState } from "react";
import { WorkflowDraftContext } from "../onboarding/WorkflowDraftContext";

export function useTalkDraft() {
  const { prompt, consume } = useContext(WorkflowDraftContext);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!prompt) return;
    setDraft(prompt);
    setOpen(true);
    consume();
  }, [prompt, consume]);

  // Keep edits here when Talk is closed and its composer unmounts.
  return { open, setOpen, draft, setDraft };
}
