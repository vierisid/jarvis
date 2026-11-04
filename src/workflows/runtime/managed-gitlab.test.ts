import { expect, test } from "bun:test";
import { runManagedGitLabAction, managedGitLabInput } from "./managed-gitlab";
import {
  gitlabInputSchema,
  gitlabEngineProps,
  isGitLabReference,
} from "./managed-gitlab-inputs";
import {
  resolveGovernedPieceAction,
  tracksPieceCompletion,
} from "./piece-effects";
const piece = "@activepieces/piece-gitlab";
const input = {
  auth: { access_token: "PRIVATE_ACCESS", jarvis_managed: "gitlab" },
  projectId: "123",
  title: "An issue",
  description: "Some **Markdown**",
};
const issue = {
  id: 1001,
  iid: 7,
  project_id: 123,
  title: "An issue",
  description: "Some **Markdown**",
  state: "opened",
  web_url: "https://gitlab.com/example/sandbox/-/issues/7",
};
function fixture(body: unknown = issue, status = 201) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    request: (async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(body, { status });
    }) as typeof fetch,
  };
}
test("creates once on the fixed GitLab.com host with only reviewed fields and bounded outputs", async () => {
  const f = fixture({ ...issue, private_token: "SHOULD_NOT_ESCAPE" });
  expect(
    await runManagedGitLabAction("create_issue", input, f.request),
  ).toEqual(issue);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.url).toBe("https://gitlab.com/api/v4/projects/123/issues");
  expect(f.calls[0]?.init).toMatchObject({
    method: "POST",
    redirect: "error",
    headers: { Authorization: "Bearer PRIVATE_ACCESS" },
  });
  expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({
    title: input.title,
    description: input.description,
  });
});
test("optional description and numeric project IDs", async () => {
  const f = fixture({ ...issue, description: null });
  const { description: _, ...without } = input;
  expect(
    await runManagedGitLabAction(
      "create_issue",
      { ...without, projectId: 123 },
      f.request,
    ),
  ).toMatchObject({ description: "" });
  expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({
    title: input.title,
  });
});
for (const patch of [
  { projectId: "../1" },
  { projectId: "group/project" },
  { projectId: "https://attacker.test" },
  { projectId: 0 },
  { projectId: Number.MAX_SAFE_INTEGER + 1 },
  { title: "" },
  { title: "a".repeat(256) },
  { title: "line\n/close" },
  { description: "x".repeat(10001) },
  { description: "Hello\n/close" },
  { description: " /move group/project" },
  { description: "x\r/confidential" },
  { description: "\n\t/assign @someone" },
  { assignee_ids: [99] },
  { url: "https://attacker.test" },
  { baseUrl: "https://attacker.test" },
]) {
  test(
    "rejects unsupported input before HTTP: " +
      JSON.stringify(patch).slice(0, 80),
    async () => {
      const f = fixture();
      await expect(
        runManagedGitLabAction(
          "create_issue",
          { ...input, ...patch },
          f.request,
        ),
      ).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    },
  );
}
for (const action of [
  "custom_api_call",
  "delete_issue",
  "project_issue_event",
]) {
  test("does not run " + action, async () => {
    const f = fixture();
    await expect(
      runManagedGitLabAction(action, input, f.request),
    ).rejects.toThrow("not enabled");
    expect(f.calls).toHaveLength(0);
  });
}
for (const status of [200, 301, 401, 403, 404, 429, 500])
  test("provider error is redacted and never retried: " + status, async () => {
    const f = fixture({ error: "PRIVATE_ACCESS" }, status);
    const error = await runManagedGitLabAction(
      "create_issue",
      input,
      f.request,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("PRIVATE_ACCESS");
    expect(f.calls).toHaveLength(1);
  });
for (const patch of [
  { project_id: 999 },
  { id: -1 },
  { iid: 0 },
  { web_url: "https://attacker.test/-/issues/7" },
  { web_url: "https://gitlab.com/evil/-/issues/8" },
  { web_url: "https://gitlab.com/x/-/issues/7?token=secret" },
  { state: "unknown" },
  { description: {} },
  { title: null },
])
  test("validates issue response " + JSON.stringify(patch), async () => {
    const f = fixture({ ...issue, ...patch });
    await expect(
      runManagedGitLabAction("create_issue", input, f.request),
    ).rejects.toThrow("Check the project");
    expect(f.calls).toHaveLength(1);
  });
test("oversized and invalid JSON responses stop with an ambiguous-write message", async () => {
  for (const body of ['{"x":"' + "a".repeat(1048576) + '"}', "not JSON"]) {
    let calls = 0;
    await expect(
      runManagedGitLabAction("create_issue", input, (async () => {
        calls++;
        return new Response(body, { status: 201 });
      }) as any),
    ).rejects.toThrow("Check the project");
    expect(calls).toBe(1);
  }
});
test("network failure does not echo credentials or retry", async () => {
  let calls = 0;
  const error = await runManagedGitLabAction(
    "create_issue",
    input,
    (async () => {
      calls++;
      throw new Error("PRIVATE_ACCESS");
    }) as any,
  ).catch((e) => e);
  expect(String(error)).not.toContain("PRIVATE_ACCESS");
  expect(String(error)).toContain("Check the project");
  expect(calls).toBe(1);
});
test("shared schema, governance and managed dispatch preserve manual accounts", () => {
  expect(managedGitLabInput(piece, input)).toBe(true);
  expect(managedGitLabInput(piece, { auth: { access_token: "manual" } })).toBe(
    false,
  );
  expect(
    gitlabInputSchema("create_issue")?.fields.map((f) => [f.name, f.required]),
  ).toEqual([
    ["projectId", true],
    ["title", true],
    ["description", false],
  ]);
  expect(
    gitlabEngineProps(piece, "create_issue", input)?.projectId,
  ).toMatchObject({ type: "SHORT_TEXT", required: true });
  expect(
    gitlabEngineProps(piece, "create_issue", {
      auth: { access_token: "manual" },
    }),
  ).toBeNull();
  expect(isGitLabReference(piece, "{{connections['jarvis:gitlab']}}")).toBe(
    true,
  );
  expect(resolveGovernedPieceAction(piece, "create_issue", input)?.category).toBe(
    "write_data",
  );
  expect(resolveGovernedPieceAction(piece, "custom_api_call")?.category).toBe(
    "modify_settings",
  );
  expect(resolveGovernedPieceAction(piece, "unknown")?.category).toBe(
    "modify_settings",
  );
  expect(tracksPieceCompletion(piece, "create_issue")).toBe(true);
});

test("a templated description narrows to a write only on the managed connection reference",()=>{
 const templated="Reported: {{trigger.description}}";
 for(const auth of ["{{connections.jarvis:gitlab}}","{{connections['jarvis:gitlab']}}"]){
  expect(resolveGovernedPieceAction(piece,"create_issue",{auth,description:templated})?.category).toBe("write_data");
  // A literal quick action stays a settings change; the managed runtime refuses it anyway.
  expect(resolveGovernedPieceAction(piece,"create_issue",{auth,description:templated+"\n/confidential"})?.category).toBe("modify_settings");
 }
 for(const auth of [undefined,"{{connections.my-gitlab}}","{{connections.jarvis:gitlab}} ","{{connections.jarvis:wrike}}",{access_token:"manual"},"{{trigger.auth}}"])
  expect(resolveGovernedPieceAction(piece,"create_issue",{auth,description:templated})?.category).toBe("modify_settings");
});

test("manual issue descriptions cannot use quick actions at the plain-write authority level",()=>{
 for(const description of ["/move private/project","hello\n/confidential","{{trigger.description}}",{}]) expect(resolveGovernedPieceAction(piece,"create_issue",{description})?.category).toBe("modify_settings");
 expect(resolveGovernedPieceAction(piece,"create_issue")?.category).toBe("modify_settings");
 expect(resolveGovernedPieceAction(piece,"delete_project")?.category).toBe("delete_data");
});
