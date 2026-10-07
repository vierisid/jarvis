# Local provider setup guides

Approved scope: provide separate setup popups for Ollama, OmniRoute, LiteLLM and
OpenAI-compatible servers, in onboarding and Settings. Built from main `abb14deb`
on `feat/local-provider-guides`.

## Behavior

- Select a supported provider during onboarding, then choose **Setup guide** above
  its connection fields. In Settings / LLM, the same action appears while adding
  a provider and when expanding an existing provider.
- Each guide has installation/startup steps, connection details, copyable commands
  or URLs, official documentation, Docker/network help and troubleshooting.
- The OpenAI-compatible guide uses LM Studio as its desktop example and links to
  llama.cpp and vLLM setup instructions. It explains that ports and served model
  IDs vary. The LiteLLM example uses an Ollama backend and a named proxy alias.
- Guides distinguish local inference from gateways that forward to cloud models.
  They do not install, run, save, select or test anything automatically.
- Native modal isolation, explicit Tab boundary handling, Escape, backdrop and
  close buttons preserve the form and return focus to the guide trigger. The body
  scrolls independently; the close action stays visible on narrow screens.
- Copy failures are announced with a manual-copy fallback. Examples never include
  saved URLs or credentials.

One shared content file (`ui/src/v2/ui/provider-setup-guides.ts`) feeds the shared
`ProviderSetupGuide` component. No new package or backend endpoint is required.
Existing theme tokens are used and no motion is introduced.

Two related setup inconsistencies are corrected: LiteLLM and OpenAI-compatible
onboarding now accept optional API keys, and Settings permits connection tests
without a key for providers that explicitly declare their key optional.

The Ollama and LiteLLM guides distinguish the two setup flows: onboarding can
test the model entered in its form; Settings must first save the provider, assign
and save its model in the model picker, then reopen the provider card to test.
LiteLLM's custom alias saves when focus leaves the model field.

## Verification

Verified on 2026-10-06: 115 affected tests / 402 assertions passed; UI build and
TypeScript passed. Browser checks covered all four providers at 1440, 820 and
390px in both themes (24 combinations), new and saved Settings providers,
clipboard, keyboard focus, form retention, optional keys and ten backdrop closes
under reduced motion. No browser runtime errors were observed. The build retains
the existing Bun warnings for Tailwind at-rules.

Review correction verified on 2026-10-06: 34 focused guide/API tests and 116
assertions passed, and the browser checks above were rerun with fresh screenshots.
An additional browser check followed the revised Settings sequence for Ollama
and LiteLLM, calling the real `testLLMProvider` against simulated HTTP model
servers. Both servers rejected the old test-before-model order and accepted the
exact assigned model after saving (`llama3.1:8b` and `jarvis-local`). Settings
persistence was in memory; no live model inference was used. Results and the two
Settings guide screenshots are in `evidence/settings-*-sequence.png` and
`evidence/settings-sequence-checks.json`.

Run the affected suite and build from the repository root:

```sh
bun test ui/src/v2/ui/ProviderSetupGuide.test.tsx ui/src/v2/onboarding \
  ui/src/v2/rooms/settings/tabs/LLMTab.models.test.ts \
  ui/src/v2/rooms/settings/auth-header.test.ts
bun run build:ui
bunx tsc --noEmit
```

Browser evidence in `evidence/` renders the actual onboarding and LLM Settings
components against isolated API fixtures. No real account configuration, gateway,
model download or inference was used. The broad browser matrix mocks connection
success; the additional Settings sequence check exercises real connection-testing
code with simulated model servers. Neither establishes live provider availability.

Manual review:

1. In self-hosted onboarding, reach the brain step. Select each of the four
   providers, enter a URL and any optional key, then open its guide.
2. Check the provider-specific steps, copy a URL, expand both help sections and
   follow an official documentation link.
3. Cycle Tab and Shift+Tab, then close with Escape. Check focus returns and all
   entered fields are unchanged. Repeat with the close button and backdrop.
4. Repeat from Settings / LLM when adding a provider and editing an existing one.
   For Ollama and LiteLLM, add/save the provider, assign and save its model below,
   then reopen the provider card and test. Click outside LiteLLM's alias field to
   save it. Keyless local setups must allow Test connection.
5. Review both themes at desktop, tablet and mobile widths. Scroll the guide;
   its footer remains accessible and the underlying page stays still.

Sources are linked in each guide and were checked on 2026-10-06. External provider
installation and commands have not been executed as part of this UI change.
