# Local provider setup guides

Onboarding and Settings / LLM offer a **Setup guide** popup for Ollama, OmniRoute,
LiteLLM and OpenAI-compatible servers. The content lives in one file,
`ui/src/v2/ui/provider-setup-guides.ts`, rendered by `ui/src/v2/ui/ProviderSetupGuide.tsx`.
Cloud-only providers have no guide.

## Behavior

- During onboarding the action appears above the selected provider's connection
  fields. In Settings / LLM it appears while adding a provider and when expanding
  an existing one.
- Each guide has install/start steps, connection details, copyable commands or
  URLs, official documentation links, Docker/network help and troubleshooting.
- The OpenAI-compatible guide uses LM Studio as its desktop example and links to
  llama.cpp and vLLM. The LiteLLM example uses an Ollama backend and a named alias.
- Guides distinguish local inference from gateways that forward to cloud models.
  They never install, run, save, select or test anything, and never show saved
  URLs or credentials.
- Closing the guide (Escape, backdrop, close or footer button) keeps the form as
  it was and returns focus to the trigger.

LiteLLM and OpenAI-compatible onboarding accept an optional API key, and Settings
allows a connection test without a key for kinds in `OPTIONAL_KEY_KINDS`.

## Why Settings tests after the model is saved

`testLLMProvider` (`src/daemon/llm-settings.ts`) tests a saved provider with the
model it is assigned to route. Before a model is assigned, Ollama falls back to
its SDK default (`llama3`, which may not be pulled) and LiteLLM has no default at
all, so a test can fail against a healthy server. The Ollama and LiteLLM guides
therefore say: save the provider, assign and save its model in the model picker,
then reopen the provider card and test. OpenAI-compatible discovers a model from
`/v1/models` when none is assigned.

## Keeping the guides current

Commands, default ports and links were checked against the linked upstream docs
on 2026-10-06. When a provider changes its install command, default port or docs
URL, update `provider-setup-guides.ts` and `ProviderSetupGuide.test.tsx` together.

Tests:

```sh
bun test ui/src/v2/ui/ProviderSetupGuide.test.tsx ui/src/v2/onboarding ui/src/v2/rooms/settings
```
