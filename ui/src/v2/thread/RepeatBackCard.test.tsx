/**
 * #973: the classifier holds a high-impact room action and repeats back what
 * confirming runs, so the person checks its reading, not only their words.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RepeatBackCard } from "./RepeatBackCard";
import { repeatBackFrom } from "../../hooks/useWebSocket";

describe("a held room action's repeat-back (#973)", () => {
  test("the card says what confirming runs, and not that it misheard", () => {
    const html = renderToStaticMarkup(
      <RepeatBackCard transcript="add pay rent" confidence={0.99} action='Tasks: create task (title "Pay rent")' />,
    );
    expect(html).toContain("Tasks: create task (title &quot;Pay rent&quot;)");
    expect(html).toContain("confirm before I do it");
    expect(html).not.toContain("catch that");
    expect(html).not.toContain("% match");
  });

  test("a plain repeat-back is unchanged", () => {
    const html = renderToStaticMarkup(<RepeatBackCard transcript="mumble" confidence={0.4} />);
    expect(html).toContain("catch that");
    expect(html).toContain("40% match");
    expect(html).not.toContain("confirm before");
  });

  test("the daemon's action text reaches the card's data", () => {
    expect(repeatBackFrom({ id: "a", transcript: "t", confidence: 0.9, action: "Tasks: create task" }, 3))
      .toEqual({ id: "a", transcript: "t", confidence: 0.9, timestamp: 3, action: "Tasks: create task" });
    expect(repeatBackFrom({ id: "a", transcript: "t", action: 5 }, 3)).toEqual({ id: "a", transcript: "t", confidence: 0.4, timestamp: 3 });
    expect(repeatBackFrom({ id: "a" }, 3)).toBeNull();
  });
});
