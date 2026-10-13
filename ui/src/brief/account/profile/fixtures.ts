import { createProfilePort, type ProfileHost } from "./adapter";
import { ProfileController } from "./controller";
import { PROFILE_FIELDS, type ProfileValue } from "./model";

export const PROFILE_SCOPE = "d29-isolated-profile";
export const PROFILE_EXAMPLES = [
  "ready",
  "empty",
  "read-only",
  "save-failure",
  "lost-response",
  "conflict",
  "unavailable",
  "unsupported",
  "error",
] as const;
export type ProfileExample = (typeof PROFILE_EXAMPLES)[number];
export function profileEnvelope(profile: ProfileValue) {
  return {
    status: "ready",
    data: {
      contractVersion: 1,
      fields: PROFILE_FIELDS.map((f) => ({
        id: f.id,
        label: f.label,
        owner: f.questionId ? "assistant_context" : "account",
        questionId: f.questionId,
        state: f.questionId ? "editable" : "unavailable",
        reason: f.questionId ? null : "account_name_not_exposed",
      })),
      questions: [
        ...PROFILE_FIELDS.flatMap((f) =>
          f.questionId ? [{ id: f.questionId }] : [],
        ),
        { id: "interests" },
      ],
      profile,
    },
  };
}
export function makeProfileFixture(
  example: ProfileExample = "ready",
  delay = 0,
) {
  let revision = 1,
    failRead = example === "error",
    recovered = false;
  let profile: ProfileValue = {
    revision: revision.toString(16).padStart(64, "0"),
    answers:
      example === "empty"
        ? {}
        : {
            preferred_name: "Alex",
            company: "Example studio",
            work_role: "Founder and designer",
            current_projects:
              "Building a useful planning tool for a small team.",
            communication_preferences:
              "Clear answers, with time to think before deciding.",
            interests: "Walking and astronomy",
          },
  };
  const requests: { path: string; method: string; body?: unknown }[] = [];
  const writes: { revision: string; answers: Record<string, string | null> }[] =
    [];
  const change = (answers: Record<string, string>) => {
    profile = {
      revision: (++revision).toString(16).padStart(64, "0"),
      answers: { ...profile.answers, ...answers },
    };
  };
  const host: ProfileHost = {
    canWrite: example !== "read-only",
    async request(path, init) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (init.signal?.aborted) throw Error("Canceled");
      requests.push({
        path,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (example === "unavailable") return new Response(null, { status: 403 });
      if (example === "unsupported") return new Response(null, { status: 501 });
      if (init.method !== "PATCH")
        return failRead
          ? new Response(null, { status: 503 })
          : Response.json(profileEnvelope(profile));
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (!recovered && example === "save-failure")
        return new Response(null, { status: 503 });
      if (!recovered && example === "conflict")
        change({ company: "External correction" });
      if (body.revision !== profile.revision)
        return Response.json({ code: "revision_conflict" }, { status: 409 });
      const answers = { ...profile.answers };
      for (const [key, value] of Object.entries(body.answers)) {
        if (value === null || !String(value).trim()) delete answers[key];
        else answers[key] = String(value).trim();
      }
      if (JSON.stringify(answers) !== JSON.stringify(profile.answers)) {
        profile = {
          answers,
          revision: (++revision).toString(16).padStart(64, "0"),
        };
      }
      if (!recovered && example === "lost-response")
        throw Error("Lost response");
      return Response.json({ saved: true, profile });
    },
  };
  const port = {
    ...createProfilePort(PROFILE_SCOPE, host),
    source: "fixture" as const,
  };
  return {
    host,
    port,
    controller: new ProfileController(port),
    requests,
    writes,
    current: () => structuredClone(profile),
    change,
    failReads: (fail: boolean) => {
      failRead = fail;
    },
    recoverWrites: () => {
      recovered = true;
    },
  };
}
