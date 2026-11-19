# Other people's Jarvises

How one person's Jarvis talks to another's. Built in passes on `notch/main`. This file states
what is built, the rules it keeps, and where it stops.

It ships dark. With `JARVIS_PEERS_ENGINE` unset nothing in `src/peers/` runs.

## The shape

```
notch  <->  brain  <->  src/peers  <->  the engine (a separate program, a child)  <->  its server
```

The keys, the pairing by code, the encryption and the mailbox are not written here. They are the
work of a separate program, the collab engine, which was made to sit under a coding agent. The
brain starts that program as a child and talks to it the way a coding agent would. What is written
here is the brain's side: starting it, speaking to it, and handing on what it asks of the person.

The engine is not part of this product yet. It is not bundled, it exists for Linux only, and its
server is a test server. So the switch is the place of the program:

| Setting | Meaning |
|---|---|
| `JARVIS_PEERS_ENGINE` | Full path of the engine program. Unset, or not a full path: off. Needs `JARVIS_NOTCH=1`. |
| `COLLAB_SERVER_URL` | Passed on to the engine: its server, for the first sign-in. |
| `COLLAB_KEYSTORE` | Passed on to the engine: `file` keeps its key out of the desktop's keychain. |

## Pass I1: the engine under the brain

| File | What it does |
|---|---|
| `src/peers/switch.ts` | The switch. |
| `src/peers/engine-process.ts` | Starts the program with an environment made name by name and a data folder of its own (`<data dir>/peers`, owner only). |
| `src/peers/engine-client.ts` | The brain's end of the line: MCP over the program's standard input and output. Calls a tool, hears a notice, is handed a dialog. |
| `src/peers/engine-read.ts` | Reads what the engine stored (status, contacts, inbox, requests) as JSON, through the program's own command line. |
| `src/peers/engine.ts` | Keeps one engine up: starts it again when it falls, 1 s later at first, doubling to 60 s. |

### Rules

1. **A dialog is never answered by the brain itself.** Whatever the engine asks of the person
   (approve a request, send a result, trust a device, change a rule) goes to one handler and its
   answer goes back unchanged. With no handler, or when the handler fails, or when it gives
   anything but accept, decline or cancel, the dialog is closed. The engine treats a closed dialog
   as "nothing changed". There is no path that says yes without the handler saying it.
2. **The engine is lent nothing.** The brain declares that it can show a dialog (a form, or a web
   page to open) and nothing else. A request of the engine for anything more (a model, most of
   all) is refused.
3. **Its environment is made, not passed on.** The engine decides from its environment whether a
   person can be asked. A brain started from a coding agent's shell carries that agent's variables
   and would turn every dialog off. So the engine gets the allowlist every child of the brain gets
   (`src/util/subprocess-env.ts`), the two settings above, what the desktop's keychain needs, and
   four values set here whatever was set outside: its data folder, arrival notices on, its own
   desktop notifications off, unattended work off. Nothing of the brain's own reaches it.
4. **Reads are fixed commands that open no line.** The command line of the engine does without
   the dialogs its tools go through. From here it is used to read only, with words that are fixed
   in code and `--offline` wherever a command would otherwise connect. A flag is added only when
   its value has the shape it must have (a device id is 22 characters of a fixed alphabet), so
   nothing a contact wrote can become a flag.
5. **A call made while the engine is down fails at once.** Nothing is queued for an engine that
   may come back as another one.

### Limits

- The engine answers a tool call in prose. Reading an id out of a sentence is done by the shape of
  the id, never by the words around it, and a newer engine may still word things differently. The
  engine's version is pinned by whoever sets its path.
- The engine's command line is reachable by anything that runs as the same user, including a shell
  the model was given. This is the engine's own limit and holds under a coding agent too. Nothing
  here widens it; nothing here closes it.
- Tested against a stand-in (`src/peers/testing/stand-in-engine.ts`) and, on the machine that has
  it, against the real engine with no network (`src/peers/engine-real.test.ts`, run only when
  `JARVIS_TEST_PEERS_ENGINE` names the program). Nothing that needs the engine's server has been
  run: no sign-in, no pairing, no message between two machines.
