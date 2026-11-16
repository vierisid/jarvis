# Quick start (self-hosted)

From zero to your first workflow in about 10 minutes. This is the path for a new self-hosted install on Linux, macOS, or WSL2. On Windows, run the brain in WSL2 or Docker.

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/vierisid/jarvis/main/install.sh | bash
```

This installs Bun if it is missing, puts the code in `~/.jarvis/daemon`, and adds the `jarvis` command. If the installer says your PATH changed, restart your terminal first.

Prefer a global install? It needs Bun 1.3.11 or later, which `bun install -g` does not check, so run `bun upgrade` first, then `bun install -g @usejarvis/brain`. On Linux, also install the libc development headers (`libc6-dev` on Debian/Ubuntu). Docker is covered in the [README](README.md#docker).

## 2. Start

```bash
jarvis start -d --no-open
```

Jarvis serves on port **3142** by default. Check with `curl http://localhost:3142/health`.

## 3. Get into the dashboard

Opening `http://localhost:3142` on its own shows a 401 page. Jarvis has no password. Each device gets an enrollment token.

```bash
jarvis enroll "my-laptop"
```

Pick one:

- **Desktop app (recommended).** Install it from [usejarvis.dev/download](https://usejarvis.dev/download/), launch it, and paste the token. It opens the dashboard already signed in.
- **Browser only.** Trade the token for a short-lived link. The link must be opened within 10 minutes; the browser then keeps its own session:

  ```bash
  curl -s -X POST http://localhost:3142/sidecar/token \
    -H "Authorization: Bearer <enrollment-token>"
  ```

  Open `http://localhost:3142/?token=<access_token>` using the `access_token` from the reply. The browser session ends when you close the browser or after 12 hours at most; run the `curl` again for a new link.

Keep the enrollment token private. It grants access to your Jarvis. See the [self-hosting guide](docs/SELF_HOSTING.md) for LAN and VPS setups and 401 troubleshooting.

## 4. Choose an AI provider

The dashboard setup screen asks which AI provider to use. This is where your API key goes. Keys are stored encrypted in the database. Nothing about providers goes in `config.yaml`: an `llm:` block there is ignored, and so are the old key environment variables.

Chat and workflows need a provider. If you leave setup without one, add it later in **Settings > LLM**, where you can also change providers. See [LLM providers](docs/LLM_PROVIDERS.md) for what each one needs.

## 5. Build your first workflow

1. Finish the setup screen (voice and a short intro to your work).
2. In **Workflows** (or in chat), describe a routine in one sentence, for example: "Every Monday at 9, summarize my unread email and send it to me."
3. Connect the apps it asks for. Jarvis shows the workflow on the canvas.
4. Run it once by hand and read the result before turning on the schedule.

More on how workflows run: [workflow guide](docs/WORKFLOW_AUTOMATION.md).

## Troubleshooting

- **401 page.** You opened the dashboard without a session. Follow step 3.
- **`jarvis: command not found`.** Restart your terminal, or run `export PATH="$HOME/.bun/bin:$PATH"`.
- **Provider test fails.** Check the key and that the account has credit. For Ollama, make sure `ollama serve` is running.
- **Where is my data?** In `~/.jarvis`. System settings (ports, public URL) are in `~/.jarvis/config.yaml`; see [config.example.yaml](config.example.yaml).
