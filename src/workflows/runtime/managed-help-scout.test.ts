import { expect, test } from "bun:test";
import {
  runManagedHelpScoutAction as run,
  MANAGED_HELP_SCOUT_ACTIONS,
} from "./managed-help-scout";
import {
  helpScoutInputSchema,
  helpScoutEngineProps,
  isHelpScoutReference,
} from "./managed-help-scout-inputs";
import {
  resolveGovernedPieceAction,
  tracksPieceCompletion,
} from "./piece-effects";
import { compileWorkflow } from "./workflow-readiness";
import { PieceCatalog } from "./piece-catalog";
const auth = {
    access_token: "SECRET",
    jarvis_user: "123",
    jarvis_managed: "help-scout",
  },
  piece = "@activepieces/piece-help-scout";
const customer = {
  id: 11,
  firstName: "Example",
  lastName: "Customer",
  _embedded: { emails: [{ value: "customer@example.test" }] },
};
const conversation = {
  id: 22,
  number: 33,
  mailboxId: 44,
  subject: "Request",
  status: "closed",
  preview: "Message",
  primaryCustomer: { id: 11, email: "customer@example.test" },
};
function page(
  key: string,
  rows: unknown[],
  extra: Record<string, unknown> = {},
) {
  return {
    _embedded: { [key]: rows },
    page: {
      number: 1,
      totalElements: rows.length,
      totalPages: rows.length ? 1 : 0,
      ...extra,
    },
  };
}
function fake(
  reply: (
    url: URL,
    init: RequestInit,
    n: number,
  ) => Response | Promise<Response>,
) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const request = (async (input: unknown, init: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    expect(url.origin).toBe("https://api.helpscout.net");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer SECRET",
    );
    return reply(url, init, calls.length);
  }) as typeof fetch;
  return { request, calls };
}
test("customer search filters substring matches and returns the established found/data envelope", async () => {
  const f = fake((url) => {
    expect(url.searchParams.get("query")).toBe(
      '(email:"customer@example.test")',
    );
    return Response.json(
      page("customers", [
        {
          ...customer,
          id: 9,
          _embedded: { emails: [{ value: "prefixcustomer@example.test" }] },
        },
        customer,
      ]),
    );
  });
  expect(
    await run(
      "find_customer",
      { auth, email: "Customer@Example.test" },
      f.request,
    ),
  ).toEqual({
    found: true,
    data: {
      id: 11,
      firstName: "Example",
      lastName: "Customer",
      email: "customer@example.test",
    },
  });
});
test("complete pagination uses fixed endpoints and rejects duplicate exact matches", async () => {
  const f = fake((url, _init, n) => {
    expect(url.searchParams.get("page")).toBe(String(n));
    return Response.json(
      page("customers", [{ ...customer, id: n }], {
        totalElements: 2,
        totalPages: 2,
        number: n,
      }),
    );
  });
  await expect(
    run("find_customer", { auth, email: "customer@example.test" }, f.request),
  ).rejects.toThrow("More than one");
  expect(f.calls).toHaveLength(2);
});
test("empty complete searches return found false", async () => {
  const f = fake(() => Response.json(page("customers", [])));
  expect(
    await run(
      "find_customer",
      { auth, email: "customer@example.test" },
      f.request,
    ),
  ).toEqual({ found: false, data: {} });
});
for (const raw of [
  { _embedded: { customers: [customer] } },
  page("customers", [customer], { totalPages: 11 }),
  page("customers", [customer], { totalElements: 2 }),
  page("customers", [{ ...customer, _embedded: {} }]),
  { ...page("customers", []), _links: { next: { href: "https://evil.test" } } },
])
  test(
    "invalid/incomplete search never reports a match " +
      JSON.stringify(raw).slice(0, 80),
    async () => {
      const f = fake(() => Response.json(raw));
      await expect(
        run(
          "find_customer",
          { auth, email: "customer@example.test" },
          f.request,
        ),
      ).rejects.toThrow();
    },
  );
test("conversation ID is read directly and matches the returned identity", async () => {
  const f = fake((url) => {
    expect(url.pathname).toBe("/v2/conversations/22");
    return Response.json(conversation);
  });
  expect(
    await run("find_conversation", { auth, conversationId: "22" }, f.request),
  ).toEqual({ found: true, data: conversation });
  await expect(
    run(
      "find_conversation",
      { auth, conversationId: "23" },
      fake(() => Response.json(conversation)).request,
    ),
  ).rejects.toThrow();
});
test("inbox and number search includes closed conversations", async () => {
  const f = fake((url) => {
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: "all",
      mailbox: "44",
      number: "33",
      page: "1",
    });
    return Response.json(page("conversations", [conversation]));
  });
  expect(
    await run(
      "find_conversation",
      { auth, mailboxId: "44", number: "33" },
      f.request,
    ),
  ).toEqual({ found: true, data: conversation });
});
test("notes are plain text, attributed to the connected user and confirmed by Resource-ID", async () => {
  const f = fake((url, init) => {
    expect(url.pathname).toBe("/v2/conversations/22/notes");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Review &lt;draft&gt; &amp; reply<br>Tomorrow",
      user: 123,
    });
    return new Response(null, {
      status: 201,
      headers: { "Resource-ID": "55" },
    });
  });
  expect(
    await run(
      "add_note",
      { auth, conversationId: "22", text: "Review <draft> & reply\nTomorrow" },
      f.request,
    ),
  ).toEqual({ id: "55" });
  expect(f.calls).toHaveLength(1);
});
for (const answer of [
  () => new Response(null, { status: 201 }),
  () => new Response(null, { status: 204 }),
  () => new Response("SECRET", { status: 429 }),
  () => new Response("SECRET", { status: 401 }),
  () => new Response("SECRET", { status: 503 }),
  () => {
    throw new Error("SECRET transport");
  },
])
  test("uncertain notes are never retried and errors disclose no provider body", async () => {
    const f = fake(answer);
    const error = await run(
      "add_note",
      { auth, conversationId: "22", text: "Note" },
      f.request,
    ).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("SECRET");
    expect(f.calls).toHaveLength(1);
  });
for (const [action, input] of [
  ["send_reply", {}],
  ["add_note", { conversationId: "../x", text: "Note" }],
  ["add_note", { conversationId: 22, text: "" }],
  ["add_note", { conversationId: 22, text: "Note", userId: 999 }],
  ["find_conversation", {}],
  ["find_conversation", { mailboxId: 44 }],
  ["find_conversation", { conversationId: 22, number: 33 }],
  ["find_customer", { email: 'a" OR x@evil.test' }],
] as const)
  test(
    "invalid or unsupported input is rejected before HTTP " +
      action +
      JSON.stringify(input),
    async () => {
      const f = fake(() => Response.json({}));
      await expect(
        run(action, { auth, ...input }, f.request),
      ).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    },
  );
test("oversized and malformed provider bodies are refused", async () => {
  for (const response of [
    new Response("bad SECRET"),
    new Response('"' + "x".repeat(1048577) + '"'),
  ]) {
    const f = fake(() => response);
    await expect(
      run("find_conversation", { auth, conversationId: 22 }, f.request),
    ).rejects.toThrow("invalid or oversized");
  }
});
test("shared schemas apply only to managed credentials and all enabled actions are governed", () => {
  for (const action of MANAGED_HELP_SCOUT_ACTIONS) {
    expect(helpScoutInputSchema(action)).not.toBeNull();
    expect(helpScoutEngineProps(piece, action, { auth })).not.toBeNull();
    expect(resolveGovernedPieceAction(piece, action)?.known).toBe(true);
  }
  expect(
    helpScoutEngineProps(piece, "add_note", {
      auth: { access_token: "manual" },
    }),
  ).toBeNull();
  expect(helpScoutInputSchema("send_reply")).toBeNull();
  expect(
    isHelpScoutReference(piece, "{{connections['jarvis:help-scout']}}"),
  ).toBe(true);
});

test("conversation preflight requires one complete lookup mode and leaves manual inputs unchanged", () => {
  const pieces = new PieceCatalog([
    {
      name: piece,
      displayName: "Help Scout",
      description: "",
      auth: { type: "OAUTH2" },
      actions: {
        find_conversation: {
          name: "find_conversation",
          displayName: "Find Conversation",
          description: "",
          inputSchema: { fields: [] },
        },
      },
    },
  ]);
  const checks = (input: Record<string, unknown>) =>
    compileWorkflow(
      {
        name: "trigger",
        type: "EMPTY",
        nextAction: {
          name: "find",
          type: "PIECE",
          settings: {
            pieceName: piece,
            actionName: "find_conversation",
            input,
          },
        },
      },
      { pieces },
    ).issues.filter(
      (i) =>
        i.path.startsWith("settings.input.") &&
        i.path !== "settings.input.auth",
    );
  const connection = "{{connections.jarvis:help-scout}}";
  expect(checks({ auth: connection })).toHaveLength(2);
  expect(checks({ auth: connection, mailboxId: "34" })).toHaveLength(1);
  expect(checks({ auth: connection, mailboxId: "34", number: "12" })).toEqual(
    [],
  );
  expect(checks({ auth: connection, conversationId: "456" })).toEqual([]);
  expect(
    checks({ auth: connection, conversationId: "{{trigger.id}}" }),
  ).toEqual([]);
  expect(
    checks({ auth: connection, conversationId: "456", mailboxId: "34" }),
  ).toHaveLength(1);
  expect(
    checks({ auth: "{{connections.manual}}", subject: "Support" }),
  ).toEqual([]);
});
test("notes use completion receipts while lookups remain repeatable reads", () => {
  expect(tracksPieceCompletion(piece, "add_note")).toBe(true);
  expect(tracksPieceCompletion(piece, "find_customer")).toBe(false);
  expect(tracksPieceCompletion(piece, "find_conversation")).toBe(false);
});
