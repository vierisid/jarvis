import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInterviewSession } from "./useInterviewSession";
import type { OnboardingStatus } from "./useOnboardingStatus";
import type { JarvisLanguage } from "../language";
import { useI18n } from "../i18n/I18nProvider";
import { ONBOARDING_COPY } from "./onboardingCopy";
import "./OnboardingWizard.css";

/* ═══════════════════ Onboarding · the nine-screen first-run flow ═══════════
   Faithful to the design (usejarvis-onboarding.html): Welcome · Permissions
   · The brain · Hearing · Speaking · Connect · The interview · The tour · All
   set. The ported steps (brain / hearing / speaking / interview) keep the real
   daemon wiring; the new steps (welcome / permissions / connect / tour / all
   set) are built to the design. The Pebble is the only thing alive. */

type StepKey =
  | "welcome" | "perms" | "brain" | "hear" | "speak" | "connect" | "interview" | "tour" | "allset";

const LANGUAGES: ReadonlyArray<{ id: JarvisLanguage; label: string }> = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
];

const STEPS: ReadonlyArray<StepKey> = [
  "welcome", "perms", "brain", "hear", "speak", "connect", "interview", "tour", "allset",
];

/* — inline SVG glyphs (design I{}) — */
const SVG: Record<string, string> = {
  access: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3l4.5 13 2-5.5 5.5-2z"/></svg>',
  screen: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 10s3-5.5 8-5.5 8 5.5 8 5.5-3 5.5-8 5.5-8-5.5-8-5.5z"/><circle cx="10" cy="10" r="2.4"/></svg>',
  auto: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="5.5" height="5.5" rx="1.2"/><rect x="11.5" y="3" width="5.5" height="5.5" rx="1.2"/><rect x="3" y="11.5" width="5.5" height="5.5" rx="1.2"/><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.2"/></svg>',
  files: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 6a1 1 0 0 1 1-1h3.6l1.6 2H16a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>',
  mic: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="7" y="2.5" width="6" height="9.5" rx="3"/><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0"/><path d="M10 15v2.5"/></svg>',
  micoff: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="7" y="2.5" width="6" height="9.5" rx="3"/><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0"/><path d="M10 15v2.5"/><path d="M3 3l14 14"/></svg>',
  vol: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 8h3l4-3v10l-4-3H4z"/><path d="M14 7a4 4 0 0 1 0 6"/></svg>',
  voloff: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l4-3v10l-4-3H4z"/><path d="M13.5 8l4 4M17.5 8l-4 4"/></svg>',
  calendar: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4.5" width="14" height="12.5" rx="2"/><path d="M3 8.5h14M7 3v3M13 3v3"/></svg>',
  mail: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="3" y="5" width="14" height="10" rx="2"/><path d="M3.5 6l6.5 4.5L16.5 6"/></svg>',
  send: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M17 3L8.5 11.5M17 3l-5.5 14-3-6-6-3z"/></svg>',
  chat: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 5h12a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H8l-4 3V6a1 1 0 0 1 1-1z"/></svg>',
  check: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4.5 6.5 11.5 3 8"/></svg>',
};
const Glyph = ({ k }: { k: string }) => <span dangerouslySetInnerHTML={{ __html: SVG[k] ?? "" }} />;

/* — providers (backend kind ids); model lists per the design — */
type Provider = {
  id: string; name: string; abbr: string; kind: string; reco?: boolean; soon?: boolean;
  noConfig?: boolean; needsKey?: boolean; needsBaseUrl?: boolean; freeModel?: boolean;
  urlLabel?: string; urlPh?: string; models?: string[]; hint?: string;
};
const PROVIDERS: Provider[] = [
  { id: "jarvis", name: "Jarvis AI", abbr: "JA", kind: "no key", soon: true, noConfig: true },
  { id: "anthropic", name: "Anthropic", abbr: "A", kind: "API key", needsKey: true, models: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"] },
  { id: "openai", name: "OpenAI", abbr: "O", kind: "API key", needsKey: true, models: ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5-mini", "o4-mini"] },
  { id: "groq", name: "Groq", abbr: "G", kind: "API key", needsKey: true, models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
  { id: "gemini", name: "Gemini", abbr: "Ge", kind: "API key", needsKey: true, models: ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro"] },
  { id: "ollama", name: "Ollama", abbr: "Ol", kind: "local", needsBaseUrl: true, urlLabel: "Ollama base URL", urlPh: "http://localhost:11434", models: ["llama3.1", "llama3.2", "mistral", "qwen2.5"] },
  { id: "openrouter", name: "OpenRouter", abbr: "OR", kind: "API key", needsKey: true, models: ["anthropic/claude-opus-4", "openai/gpt-5.4", "google/gemini-2.5-pro"] },
  { id: "nvidia", name: "NVIDIA NIM", abbr: "N", kind: "API key", needsKey: true, models: ["meta/llama-3.3-70b-instruct"], hint: "Live model catalog loads from your NVIDIA account." },
  { id: "openai_compatible", name: "OpenAI-compatible", abbr: "C", kind: "self-hosted", needsBaseUrl: true, freeModel: true, urlLabel: "Base URL", urlPh: "http://localhost:8080/v1", hint: "Any server that speaks /v1/chat/completions: llama.cpp, vLLM, LM Studio, TGI. Include the /v1 suffix." },
  { id: "litellm", name: "LiteLLM", abbr: "L", kind: "proxy", needsBaseUrl: true, freeModel: true, urlLabel: "LiteLLM proxy URL", urlPh: "http://localhost:4000/v1", hint: "The model below must match an alias defined on your proxy." },
];

const EDGE_VOICES = [
  { label: "Aria · US Female", id: "en-US-AriaNeural" },
  { label: "Guy · US Male", id: "en-US-GuyNeural" },
  { label: "Sonia · UK Female", id: "en-GB-SoniaNeural" },
  { label: "Natasha · AU Female", id: "en-AU-NatashaNeural" },
  { label: "Jenny · US Female", id: "en-US-JennyNeural" },
  { label: "Davis · US Male", id: "en-US-DavisNeural" },
  { label: "Elvira · España · Femenina", id: "es-ES-ElviraNeural" },
  { label: "Álvaro · España · Masculina", id: "es-ES-AlvaroNeural" },
  { label: "Dalia · México · Femenina", id: "es-MX-DaliaNeural" },
  { label: "Jorge · México · Masculina", id: "es-MX-JorgeNeural" },
];

const DEFAULT_EDGE_VOICE: Record<JarvisLanguage, string> = {
  en: "en-US-AriaNeural",
  es: "es-ES-ElviraNeural",
};

// ElevenLabs premade voice ids — stable, no /voices call needed (so a key
// that can synthesize but lacks the voices_read scope still works).
const ELEVEN_PREMADE = [
  { voice_id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel · calm" },
  { voice_id: "AZnzlk1XvdvUeBnXmlld", name: "Domi · strong" },
  { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Bella · soft" },
  { voice_id: "ErXwobaYiN019PkySvjV", name: "Antoni · warm" },
  { voice_id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli · emotional" },
  { voice_id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh · deep" },
];

const ELEVEN_STYLE_ES: Record<string, string> = {
  "21m00Tcm4TlvDq8ikWAM": "Rachel · tranquila",
  AZnzlk1XvdvUeBnXmlld: "Domi · potente",
  EXAVITQu4vr4xnSDxMaL: "Bella · suave",
  ErXwobaYiN019PkySvjV: "Antoni · cálido",
  MF3mGyEYCl7XYWbV9V6O: "Elli · expresiva",
  TxGEqnHWrfWFTfGW9XjX: "Josh · profundo",
};

const IS_MAC = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.userAgent || (navigator as { platform?: string }).platform || "");
// Deep links to the OS privacy pane per permission. The app can't self-grant
// (the OS forbids it), but it can open the exact place you grant it.
const PERM_PANE: Record<string, { mac: string; win: string }> = {
  access: { mac: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", win: "ms-settings:easeofaccess" },
  screen: { mac: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture", win: "ms-settings:privacy-general" },
  auto: { mac: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation", win: "ms-settings:privacy-general" },
  files: { mac: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles", win: "ms-settings:privacy-broadfilesystemaccess" },
};

// Play MP3 bytes returned by /api/tts/preview in the dashboard itself.
async function playPreviewAudio(res: Response): Promise<void> {
  const buf = await res.arrayBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
  const a = new Audio(url);
  a.onended = () => URL.revokeObjectURL(url);
  await a.play().catch(() => URL.revokeObjectURL(url));
}

const TOUR_POS: React.CSSProperties[] = [
  { right: 18, bottom: 50 }, { right: 18, top: 60 }, { left: 130, top: 58 },
  { left: 130, top: 104 }, { left: 130, top: 150 },
];

type TestState = { status: "idle" | "testing" | "ok" | "err"; msg?: string };

export function OnboardingWizard({
  status,
  onComplete,
}: {
  status: OnboardingStatus | null;
  onComplete: () => void;
}) {
  const { setLocale, t } = useI18n();
  const startStep = useMemo<number>(() => {
    if (!status?.setup_completed) return 0;
    if (!status.profile_completed && !status.setup_skipped_profile) return 6;
    if (!status.tutorial_completed && !status.tutorial_dismissed) return 7;
    return 8;
  }, [status]);

  const [step, setStep] = useState(startStep);
  const key = STEPS[step]!;
  // True when the wizard is running the setup steps in this session (fresh
  // start) — a resume at the interview/tour never touched brain/voice state,
  // so the recap must not print those defaults as if they were saved.
  const configuredThisSession = startStep === 0;

  // welcome
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"),
  );
  const [language, setLanguage] = useState<JarvisLanguage>(status?.language ?? "en");
  const copy = ONBOARDING_COPY[language];
  const applyTheme = (t: "light" | "dark") => {
    setTheme(t);
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("jarvis-theme", t); } catch { /* ignore */ }
  };
  useEffect(() => {
    setLocale(language);
  }, [language, setLocale]);

  // permissions
  // brain
  const [provId, setProvId] = useState("anthropic");
  const prov = PROVIDERS.find((p) => p.id === provId)!;
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [test, setTest] = useState<TestState>({ status: "idle" });
  // hearing
  const [stt, setStt] = useState<"skip" | "openai" | "groq" | "local">("skip");
  const [sttKey, setSttKey] = useState("");
  const [sttEndpoint, setSttEndpoint] = useState("http://localhost:8080");
  // speaking
  const [tts, setTts] = useState<"off" | "edge" | "elevenlabs">("edge");
  const [edgeVoice, setEdgeVoice] = useState(DEFAULT_EDGE_VOICE[language]);
  const [elevenKey, setElevenKey] = useState("");
  const [elevenVoice, setElevenVoice] = useState(ELEVEN_PREMADE[0]!.voice_id);
  const [elevenModel, setElevenModel] = useState("eleven_flash_v2_5");
  const [ttsTest, setTtsTest] = useState<TestState>({ status: "idle" });
  const [previewing, setPreviewing] = useState(false);
  // connect
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [googleState, setGoogleState] = useState<"idle" | "pending" | "connected">("idle");
  const [connectErr, setConnectErr] = useState<string | null>(null);
  const [tgOpen, setTgOpen] = useState(false);
  const [tgToken, setTgToken] = useState("");
  const [tgBusy, setTgBusy] = useState(false);
  // tour
  const [tourI, setTourI] = useState(0);
  // flow
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the ElevenLabs test whenever the key changes or the provider flips.
  useEffect(() => { setTtsTest({ status: "idle" }); }, [elevenKey, tts]);

  // Keep first-run voice output aligned with the selected response language.
  // Users can still choose any voice manually after reaching the Speaking step.
  useEffect(() => { setEdgeVoice(DEFAULT_EDGE_VOICE[language]); }, [language]);

  useEffect(() => {
    const p = PROVIDERS.find((x) => x.id === provId)!;
    setModel(p.models?.[0] ?? "");
    setTest({ status: "idle" });
  }, [provId]);

  // Same for the brain test: a changed key, base URL, or model invalidates a
  // previous "Connected" verdict.
  useEffect(() => { setTest((t) => (t.status === "idle" ? t : { status: "idle" })); }, [apiKey, baseUrl, model]);

  // Ollama serves only what the operator pulled, and every id carries a tag
  // ("qwen2.5:3b"). The curated list is untagged guesswork — picking from it
  // yields ":latest", usually not pulled, and the first chat 404s. Ask the
  // daemon for the real catalog instead — debounced, since the base URL
  // arrives one keystroke at a time and every probe of a half-typed host is
  // a doomed network call. Falls back to the curated list when Ollama is
  // unreachable (empty base URL means "let the daemon pick its default").
  const [ollamaModels, setOllamaModels] = useState<string[] | null>(null);
  const [ollamaLoading, setOllamaLoading] = useState(false);
  useEffect(() => {
    if (provId !== "ollama") return;
    let cancelled = false;
    setOllamaLoading(true);
    const timer = window.setTimeout(() => {
      fetch(`/api/config/llm/ollama/models?base_url=${encodeURIComponent(baseUrl.trim())}`)
        .then((r) => r.json())
        .then((d: { ok: boolean; models?: string[] }) => {
          if (cancelled) return;
          setOllamaModels(d.ok && d.models && d.models.length > 0 ? d.models : []);
        })
        .catch(() => { if (!cancelled) setOllamaModels([]); })
        .finally(() => { if (!cancelled) setOllamaLoading(false); });
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [provId, baseUrl]);

  // Snap the untagged curated default to its installed sibling once the real
  // list arrives ("qwen2.5" -> "qwen2.5:3b"), so the test button works
  // without the user having to notice the mismatch. The model field is a
  // strict select here, so the selection always came from a list we offered —
  // snapping can't clobber a hand-typed id. The [apiKey, baseUrl, model]
  // effect above resets a stale test verdict when this fires.
  useEffect(() => {
    if (provId !== "ollama") return;
    if (!ollamaModels || ollamaModels.length === 0) return;
    if (!ollamaModels.includes(model)) {
      const sameFamily = ollamaModels.find((m) => m.split(":")[0] === model.split(":")[0]);
      setModel(sameFamily ?? ollamaModels[0]!);
    }
  }, [ollamaModels, provId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The Google OAuth poll outlives the click handler — keep its id in a ref so
  // finishing/unmounting the wizard stops it (it ran for up to 5 min after).
  const googlePollRef = useRef<number | null>(null);
  const stopGooglePoll = useCallback(() => {
    if (googlePollRef.current != null) { window.clearInterval(googlePollRef.current); googlePollRef.current = null; }
  }, []);
  useEffect(() => stopGooglePoll, [stopGooglePoll]);

  const go = (n: number) => { setError(null); setStep(n); };
  const next = () => go(Math.min(step + 1, STEPS.length - 1));
  const back = () => go(Math.max(0, step - 1));

  /* — brain: test connection — */
  const runTest = useCallback(async () => {
    setTest({ status: "testing" });
    try {
      const body: Record<string, unknown> = { provider: provId, model };
      if (prov.needsKey) { if (!apiKey) { setTest({ status: "err", msg: copy.errors.enterKey }); return; } body.api_key = apiKey; }
      if (prov.needsBaseUrl) { if (!baseUrl.trim()) { setTest({ status: "err", msg: copy.errors.enterUrl }); return; } body.base_url = baseUrl.trim(); }
      if ((provId === "openai_compatible" || provId === "litellm") && apiKey) body.api_key = apiKey;
      const r = await fetch("/api/config/llm/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await r.json()) as { ok: boolean; model?: string; error?: string };
      if (data.ok) setTest({ status: "ok", msg: data.model ?? model });
      else setTest({ status: "err", msg: data.error ?? copy.errors.testFailed });
    } catch (e) {
      setTest({ status: "err", msg: e instanceof Error ? e.message : copy.errors.testFailed });
    }
  }, [provId, model, apiKey, baseUrl, prov, copy]);

  const brainReady = !prov.soon && (prov.noConfig || test.status === "ok");

  /* — the setup POST: fires when leaving Speaking (llm + stt + tts) — */
  const saveSetup = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const entry: Record<string, unknown> = { kind: prov.kind === "no key" ? "jarvis" : provId };
      if (prov.needsKey && apiKey) entry.api_key = apiKey;
      if (prov.needsBaseUrl) entry.base_url = baseUrl.trim();
      const llm: Record<string, unknown> = { providers: { [provId]: entry }, default: `${provId}:${model || "default"}` };

      const ttsBlock: Record<string, unknown> = { enabled: tts !== "off", provider: tts === "off" ? "edge" : tts };
      if (tts === "edge") { ttsBlock.voice = edgeVoice; ttsBlock.rate = "+0%"; }
      else if (tts === "elevenlabs") ttsBlock.elevenlabs = { api_key: elevenKey, voice_id: elevenVoice, model: elevenModel };

      const payload: Record<string, unknown> = { user: { language }, llm, tts: ttsBlock };
      if (stt !== "skip") {
        const sttBlock: Record<string, unknown> = { provider: stt };
        if ((stt === "openai" || stt === "groq") && sttKey) sttBlock[stt] = { api_key: sttKey };
        else if (stt === "local") sttBlock.local = { endpoint: sttEndpoint.trim(), server_type: "whisper_cpp" };
        payload.stt = sttBlock;
      }
      const r = await fetch("/api/onboarding/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error((await r.text().catch(() => "")) || `HTTP ${r.status}`);
      go(5);
    } catch (e) {
      setError(e instanceof Error ? e.message : copy.errors.setupFailed!);
    } finally { setBusy(false); }
  }, [language, prov, provId, apiKey, baseUrl, model, tts, edgeVoice, elevenKey, elevenVoice, elevenModel, stt, sttKey, sttEndpoint, copy]);

  const skipAll = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/onboarding/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language }),
      });
      if (!r.ok) throw new Error((await r.text().catch(() => "")) || `HTTP ${r.status}`);
      onComplete();
    } catch (e) {
      // Closing anyway would replay onboarding next launch — surface it instead.
      setError(e instanceof Error && e.message ? `${copy.errors.skipSave!}: ${e.message}` : copy.errors.daemon!);
    } finally { setBusy(false); }
  }, [language, onComplete, copy]);

  /* — speaking: ElevenLabs test via real synthesis — */
  // A synthesis call exercises the exact TTS path the app uses (and plays the
  // sample), so it validates the key without depending on the voices-list
  // scope. If it 401s, the key is genuinely bad.
  const testElevenLabs = useCallback(async () => {
    if (!elevenKey.trim()) { setTtsTest({ status: "err", msg: copy.errors.pasteEleven }); return; }
    setTtsTest({ status: "testing" });
    try {
      const r = await fetch("/api/tts/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "elevenlabs", api_key: elevenKey.trim(), voice_id: elevenVoice, model: elevenModel, text: language === "es" ? "Hola, soy Jarvis. Así es como voy a sonar." : undefined }) });
      if (!r.ok) {
        const t = await r.json().catch(() => ({ error: "" })) as { error?: string };
        const m = (t.error || "").includes("401") ? copy.errors.elevenRejected! : (t.error || copy.errors.testFailed!).slice(0, 90);
        setTtsTest({ status: "err", msg: m });
        return;
      }
      await playPreviewAudio(r);
      setTtsTest({ status: "ok", msg: copy.errors.voiceReady });
    } catch (e) {
      setTtsTest({ status: "err", msg: e instanceof Error ? e.message : copy.errors.testFailed });
    }
  }, [language, elevenKey, elevenVoice, elevenModel, copy]);

  /* — connect actions — */
  // Google: real OAuth. Open the consent URL, then poll status until the
  // round-trip completes (covers both Calendar + Gmail — one Google grant).
  const connectGoogle = useCallback(async () => {
    setConnectErr(null);
    setGoogleState("pending");
    try {
      const r = await fetch("/api/auth/google/init", { method: "POST" });
      const d = (await r.json().catch(() => ({}))) as { auth_url?: string; error?: string };
      if (!r.ok || !d.auth_url) {
        // Most common: no Google app credentials configured on this daemon.
        setGoogleState("idle");
        setConnectErr(
          (d.error || "").toLowerCase().includes("credential")
            ? copy.errors.googleCredentials!
            : (d.error || copy.errors.googleStart!).slice(0, 120),
        );
        return;
      }
      const win = window.open(d.auth_url, "_blank", "noopener,noreferrer");
      if (!win) {
        // No popup → no sign-in in flight; don't sit in "Connecting…" polling.
        setGoogleState("idle");
        setConnectErr(copy.errors.popup!);
        return;
      }
    } catch {
      setGoogleState("idle");
      setConnectErr(copy.errors.googleDaemon!);
      return;
    }
    let tries = 0;
    stopGooglePoll();
    googlePollRef.current = window.setInterval(async () => {
      tries += 1;
      try {
        const s = await fetch("/api/auth/google/status");
        const d = (await s.json()) as { status?: string; is_authenticated?: boolean };
        if (d.is_authenticated || d.status === "connected") {
          stopGooglePoll();
          setGoogleState("connected");
          setConnected((c) => new Set(c).add("google").add("gmail"));
        }
      } catch { /* ignore */ }
      if (tries > 150) { stopGooglePoll(); setGoogleState((g) => (g === "pending" ? "idle" : g)); } // ~5 min cap
    }, 2000);
  }, [stopGooglePoll, copy]);

  const cancelGoogle = useCallback(() => {
    stopGooglePoll();
    setGoogleState("idle");
  }, [stopGooglePoll]);

  // Telegram: real — needs a bot token, saved to the channels config.
  const saveTelegram = useCallback(async () => {
    if (!tgToken.trim()) return;
    setTgBusy(true);
    setConnectErr(null);
    try {
      const r = await fetch("/api/config/channels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ telegram: { bot_token: tgToken.trim(), enabled: true } }) });
      // The route hot-applies the config and can return HTTP 200 with
      // ok:false when the save succeeded but connecting the bot failed —
      // treat that as a failure so the wizard doesn't claim "connected".
      const body = r.ok ? await r.json().catch(() => null) as { ok?: boolean; message?: string } | null : null;
      if (r.ok && body?.ok !== false) { setConnected((c) => new Set(c).add("telegram")); setTgOpen(false); setTgToken(""); }
      else if (r.ok) setConnectErr((body?.message || copy.errors.telegramConnect!).slice(0, 120));
      else setConnectErr(((await r.text().catch(() => "")) || `${copy.errors.telegramSave} (HTTP ${r.status}).`).slice(0, 120));
    } catch { setConnectErr(copy.errors.telegramDaemon!); }
    finally { setTgBusy(false); }
  }, [tgToken, copy]);

  /* — tour + finish — */
  // Both check the response: silently swallowing a failed POST would replay
  // the whole tour on next launch.
  const endTour = useCallback(async (endpoint: string) => {
    try {
      const r = await fetch(endpoint, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      go(8);
    } catch {
      setError(copy.errors.progress!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copy]);
  const finishTour = useCallback(() => endTour("/api/onboarding/tutorial/complete"), [endTour]);
  const skipTour = useCallback(() => endTour("/api/onboarding/tutorial/dismiss"), [endTour]);

  // Real preview: synthesize a sample and play the returned MP3 in the
  // dashboard (no config round-trip, no Pebble dependency).
  const preview = useCallback(async () => {
    if (previewing) return;
    setPreviewing(true);
    try {
      const body: Record<string, unknown> = { provider: tts === "elevenlabs" ? "elevenlabs" : "edge" };
      if (tts === "elevenlabs") { body.api_key = elevenKey.trim(); body.voice_id = elevenVoice; body.model = elevenModel; }
      else body.voice = edgeVoice;
      if (language === "es") body.text = "Hola, soy Jarvis. Así es como voy a sonar.";
      const r = await fetch("/api/tts/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) await playPreviewAudio(r);
    } catch { /* best-effort */ }
    window.setTimeout(() => setPreviewing(false), 2000);
  }, [language, previewing, tts, edgeVoice, elevenKey, elevenVoice, elevenModel]);

  const speakReady = tts !== "elevenlabs" || ttsTest.status === "ok";
  const edgeVoices = EDGE_VOICES.filter((voice) => voice.id.startsWith(language === "es" ? "es-" : "en-"));

  /* — progress bar (steps 1..5 only) — */
  const showProgress = step >= 1 && step <= 5;
  const progress = showProgress && (
    <>
      <div className="obw-steps">
        {STEPS.map((_, i) => <i key={i} className={i < step ? "done" : i === step ? "cur" : ""} />)}
      </div>
      <div className="obw-steplab">{copy.stepProgress(step + 1, STEPS.length, copy.steps[key]!)}</div>
    </>
  );

  const drop = (cls = "", size = 60) => (
    <span className={`obw-drop ${cls}`} style={{ width: size, height: size }}>
      <span className="in" /><span className="ring" />
    </span>
  );

  return (
    <div className="obw">
      <div className="obw-bar">
        <i /><i /><i />
        <span className="obw-wt">{key === "welcome" || key === "interview" || key === "tour" || key === "allset" ? "Jarvis" : copy.setupTitle}</span>
      </div>
      {progress}

      {key === "interview" ? (
        <InterviewStep language={language} ttsDisabled={tts === "off"} onComplete={() => go(7)} />
      ) : key === "tour" ? (
        renderTour()
      ) : (
        <div className="obw-scroll">{renderStep()}</div>
      )}
    </div>
  );

  /* ─────────── step renderers ─────────── */
  function renderStep() {
    switch (key) {
      case "welcome": return (
        <div className="obw-body mid"><div className="obw-wrap">
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 20, position: "relative" }}>
            <span className="obw-bloom" style={{ width: 150, height: 150, left: "50%", top: "50%", transform: "translate(-50%,-52%)" }} />
            {drop("", 60)}
          </div>
          <div className="obw-word" style={{ fontSize: 15, marginBottom: 11 }}><span className="u">use</span>jarvis</div>
          <h2>{copy.welcome.title}</h2>
          <div className="obw-sub" style={{ maxWidth: "34ch", margin: "9px auto 0" }}>
            {copy.welcome.subtitle}
          </div>
          <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 11, alignItems: "center" }}>
            <div className="obw-themelab">{copy.welcome.language}</div>
            <div className="obw-themeseg" aria-label={copy.welcome.languageLabel}>
              {LANGUAGES.map((option) => (
                <button
                  key={option.id}
                  className={language === option.id ? "on" : ""}
                  onClick={() => setLanguage(option.id)}
                  aria-pressed={language === option.id}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="obw-themelab">{copy.welcome.look}</div>
            <div className="obw-themeseg">
              <button className={theme === "light" ? "on" : ""} onClick={() => applyTheme("light")}>{copy.welcome.light}</button>
              <button className={theme === "dark" ? "on" : ""} onClick={() => applyTheme("dark")}>{copy.welcome.dark}</button>
            </div>
            <button className="obw-btn obw-btn-pri" style={{ minWidth: 208, marginTop: 8 }} onClick={next}>{copy.welcome.setup}</button>
            <button className="obw-skip" disabled={busy} onClick={skipAll}>{copy.welcome.later}</button>
            {error && <div className="obw-hint" style={{ color: "var(--listen)" }}>{error}</div>}
          </div>
        </div></div>
      );

      case "perms": {
        return (
          <div className="obw-body"><div className="obw-wrap wide">
            <h2>{copy.permissions.title}</h2>
            <div className="obw-sub">{copy.permissions.subtitle(IS_MAC ? "Mac" : "PC")}</div>
            <div className="obw-rows" style={{ marginTop: 16 }}>
              {copy.permissions.rows.map((row) => (
                <button key={row.id} type="button" className="obw-prow" style={{ cursor: "pointer", textAlign: "left", width: "100%", background: "var(--raise)" }}
                  onClick={() => { try { window.open((IS_MAC ? PERM_PANE[row.id]?.mac : PERM_PANE[row.id]?.win) || "", "_blank"); } catch { /* webview may block the scheme */ } }}>
                  <span className="pg"><Glyph k={row.icon} /></span>
                  <div className="pt"><div className="pn">{row.name}{row.required && <span className="req">{copy.common.required}</span>}</div><div className="pb">{row.body}</div></div>
                  <span className="obw-grant" style={{ pointerEvents: "none" }}>{copy.common.openSettings}</span>
                </button>
              ))}
            </div>
            <div className="obw-hint" style={{ marginTop: 12 }}>{copy.permissions.review(
              language === "es"
                ? IS_MAC ? "Ajustes del Sistema → Privacidad y seguridad" : "Configuración de Windows → Privacidad y seguridad"
                : IS_MAC ? "System Settings → Privacy & Security" : "Windows Settings → Privacy & security",
            )}</div>
            <div className="obw-btnrow"><button className="obw-btn obw-btn-ghost" onClick={back}>{copy.common.back}</button><span className="grow" /><button className="obw-btn obw-btn-pri" onClick={next}>{copy.common.continue}</button></div>
          </div></div>
        );
      }

      case "brain": return (
        <div className="obw-body"><div className="obw-wrap wide">
          <h2>{copy.brain.title}</h2>
          <div className="obw-sub">{copy.brain.subtitle}</div>
          <div className="obw-provgrid" style={{ marginTop: 14 }}>
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                className={`obw-prov ${p.reco ? "reco" : ""} ${p.soon ? "soon" : ""} ${provId === p.id ? "on" : ""}`}
                disabled={p.soon}
                aria-disabled={p.soon}
                onClick={() => { if (!p.soon) setProvId(p.id); }}
              >
                <span className="pd">{p.abbr}</span>
                <div>
                  <div className="pn">{p.name}{p.soon && <span className="obw-soon">{copy.common.soon}</span>}</div>
                  <div className="pk">{p.soon ? copy.common.comingSoon : (copy.provider[p.kind] ?? p.kind)}</div>
                </div>
              </button>
            ))}
          </div>
          <div className="obw-provdetail">{renderProvDetail()}</div>
          <div className="obw-btnrow"><button className="obw-btn obw-btn-ghost" onClick={back}>{copy.common.back}</button><span className="grow" /><button className="obw-btn obw-btn-pri" disabled={!brainReady} onClick={next}>{copy.common.continue}</button></div>
          {!brainReady && !prov.noConfig && <div className="obw-hint" style={{ marginTop: 8 }}>{copy.brain.testHint}</div>}
        </div></div>
      );

      case "hear": {
        return (
          <div className="obw-body"><div className="obw-wrap wide">
            <h2>{copy.hearing.title}</h2>
            <div className="obw-sub">{copy.hearing.subtitle}</div>
            <div className="obw-choices" style={{ marginTop: 14 }}>
              {copy.hearing.choices.map((option) => (
                <button key={option.id} className={`obw-choice ${stt === option.id ? "on" : ""}`} onClick={() => setStt(option.id as typeof stt)}>
                  <span className="gi"><Glyph k={option.icon} /></span>
                  <div className="ct"><div className="cn">{option.name}</div><div className="cb">{option.body}</div></div>
                  <span className="rad" />
                </button>
              ))}
            </div>
            {(stt === "openai" || stt === "groq") && (
              <div className="obw-subctl"><input className="obw-inp" type="password" placeholder={`${copy.common.pasteKey} · ${stt === "openai" ? "OpenAI" : "Groq"}`} value={sttKey} onChange={(e) => setSttKey(e.target.value)} /></div>
            )}
            {stt === "local" && (
              <div className="obw-subctl"><input className="obw-inp" placeholder="http://localhost:8080" value={sttEndpoint} onChange={(e) => setSttEndpoint(e.target.value)} /></div>
            )}
            {stt !== "skip" && <MicLevelCheck language={language} />}
            <div className="obw-btnrow"><button className="obw-btn obw-btn-ghost" onClick={back}>{copy.common.back}</button><span className="grow" /><button className="obw-btn obw-btn-pri" onClick={next}>{copy.common.continue}</button></div>
          </div></div>
        );
      }

      case "speak": {
        return (
          <div className="obw-body"><div className="obw-wrap wide">
            <h2>{copy.speaking.title}</h2>
            <div className="obw-sub">{copy.speaking.subtitle}</div>
            <div className="obw-choices" style={{ marginTop: 14 }}>
              {copy.speaking.choices.map((option) => (
                <button key={option.id} className={`obw-choice ${tts === option.id ? "on" : ""}`} onClick={() => setTts(option.id as typeof tts)}>
                  <span className="gi"><Glyph k={option.icon} /></span>
                  <div className="ct"><div className="cn">{option.name}</div><div className="cb">{option.body}</div></div>
                  <span className="rad" />
                </button>
              ))}
            </div>
            {tts === "edge" && (
              <div className="obw-subctl">
                <select className="obw-inp" style={{ flex: 1 }} value={edgeVoice} onChange={(e) => setEdgeVoice(e.target.value)}>
                  {edgeVoices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                </select>
                <span className={`obw-drop ${previewing ? "s-speak" : ""}`} style={{ width: 24, height: 24, flexShrink: 0 }}><span className="in" /></span>
                <button className="obw-btn obw-btn-ghost sm" disabled={previewing} onClick={preview}>{previewing ? copy.common.playing : copy.common.preview}</button>
                {previewing && <span className="obw-wave">{Array.from({ length: 5 }, (_, i) => <b key={i} style={{ animationDelay: `${(i * 0.12).toFixed(2)}s` }} />)}</span>}
              </div>
            )}
            {tts === "elevenlabs" && (
              <div style={{ marginTop: 9 }}>
                <div className="obw-subctl" style={{ flexWrap: "wrap" }}>
                  <select className="obw-inp" style={{ flex: 1, minWidth: 150 }} value={elevenVoice} onChange={(e) => setElevenVoice(e.target.value)}>
                    {ELEVEN_PREMADE.map((v) => <option key={v.voice_id} value={v.voice_id}>{language === "es" ? ELEVEN_STYLE_ES[v.voice_id] ?? v.name : v.name}</option>)}
                  </select>
                  <select className="obw-inp" style={{ width: 148 }} value={elevenModel} onChange={(e) => setElevenModel(e.target.value)}>
                    <option value="eleven_flash_v2_5">Flash v2.5 ({language === "es" ? "rápido" : "fast"})</option>
                    <option value="eleven_multilingual_v2">Multilingual v2</option>
                    <option value="eleven_turbo_v2_5">Turbo v2.5</option>
                  </select>
                </div>
                <div className="obw-subctl" style={{ flexWrap: "wrap" }}>
                  <input className="obw-inp" type="password" style={{ flex: 1, minWidth: 180 }} placeholder={`${copy.common.pasteKey} · ElevenLabs`} value={elevenKey} onChange={(e) => setElevenKey(e.target.value)} />
                  <button className="obw-btn obw-btn-ghost sm" disabled={ttsTest.status === "testing" || !elevenKey.trim()} onClick={testElevenLabs}>{ttsTest.status === "testing" ? copy.common.testing : copy.common.testHear}</button>
                  <span className={`obw-drop ${previewing ? "s-speak" : ""}`} style={{ width: 24, height: 24, flexShrink: 0 }}><span className="in" /></span>
                  {ttsTest.status === "ok" && <span className="obw-testres ok"><span className="dot" />{copy.common.connected} · {ttsTest.msg}</span>}
                  {ttsTest.status === "err" && <span className="obw-testres err"><span className="dot" />{ttsTest.msg}</span>}
                </div>
              </div>
            )}
            {error && <div className="obw-hint" style={{ color: "var(--listen)", marginTop: 10 }}>{error}</div>}
            {!speakReady && <div className="obw-hint" style={{ marginTop: 10 }}>{copy.errors.elevenHint}</div>}
            <div className="obw-btnrow"><button className="obw-btn obw-btn-ghost" onClick={back}>{copy.common.back}</button><span className="grow" /><button className="obw-btn obw-btn-pri" disabled={busy || !speakReady} onClick={saveSetup}>{busy ? copy.common.settingUp : copy.common.continue}</button></div>
          </div></div>
        );
      }

      case "connect": {
        return (
          <div className="obw-body"><div className="obw-wrap wide">
            <h2>{copy.connect.title}</h2>
            <div className="obw-sub">{copy.connect.subtitle}</div>
            <div className="obw-rows" style={{ marginTop: 14 }}>
              {copy.connect.rows.map((row) => {
                const isGoogle = row.id === "google" || row.id === "gmail";
                const isConnected = connected.has(row.id);
                return (
                  <div key={row.id} className="obw-prow" style={{ flexWrap: "wrap" }}>
                    <span className="pg"><Glyph k={row.icon} /></span>
                    <div className="pt"><div className="pn">{row.name}</div><div className="pb">{row.body}</div></div>
                    {row.soon ? <span className="obw-pill">{copy.common.soon}</span>
                      : isConnected ? <span className="obw-granted"><Glyph k="check" />{copy.common.connected}</span>
                      : isGoogle ? (
                        googleState === "pending"
                          ? <button className="obw-grant" onClick={cancelGoogle} title={copy.errors.stopSignin}>{copy.common.connecting} ✕</button>
                          : <button className="obw-grant" onClick={connectGoogle}>{copy.common.connect}</button>
                      )
                      : row.id === "telegram" ? <button className="obw-grant" onClick={() => setTgOpen((o) => !o)}>{copy.common.connect}</button>
                      : <span className="obw-pill">{copy.common.soon}</span>}
                    {row.id === "telegram" && tgOpen && !isConnected && (
                      <div style={{ flexBasis: "100%", display: "flex", gap: 8, marginTop: 10 }}>
                        <input className="obw-inp" style={{ flex: 1 }} placeholder={copy.connect.botToken} value={tgToken} onChange={(e) => setTgToken(e.target.value)} />
                        <button className="obw-btn obw-btn-pri sm" disabled={tgBusy || !tgToken.trim()} onClick={saveTelegram}>{tgBusy ? copy.common.saving : copy.common.save}</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {connectErr && <div className="obw-hint" style={{ color: "var(--listen)", marginTop: 12 }}>{connectErr}</div>}
            <div className="obw-btnrow"><button className="obw-btn obw-btn-ghost" onClick={back}>{copy.common.back}</button><button className="obw-skip grow" onClick={next} style={{ textAlign: "left", marginLeft: 8 }}>{copy.common.skipNow}</button><button className="obw-btn obw-btn-pri" onClick={next}>{copy.common.continue}</button></div>
          </div></div>
        );
      }

      case "allset": return (
        <div className="obw-body mid"><div className="obw-wrap">
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 18, position: "relative" }}>
            <span className="obw-bloom ok" style={{ width: 150, height: 150, left: "50%", top: "50%", transform: "translate(-50%,-52%)" }} />
            <span className="obw-drop s-done" style={{ width: 58, height: 58 }}><span className="in" /></span>
          </div>
          <h2>{copy.allSet.title}</h2>
          <div className="obw-sub" style={{ maxWidth: "33ch", margin: "9px auto 0" }}>
            {recapLine()} {copy.allSet.online}
          </div>
          <div className="obw-recap">
            {configuredThisSession ? (
              <>
                <div><span className="ok">✓</span> {copy.allSet.brain} · {prov.name}</div>
                <div><span className="ok">✓</span> {copy.allSet.voice} · {tts === "off" ? copy.allSet.textOnly : tts === "edge" ? `Edge (${EDGE_VOICES.find((v) => v.id === edgeVoice)?.label.split(" ")[0]})` : "ElevenLabs"}{stt !== "skip" ? " + Whisper" : ""}</div>
                <div><span className="ok">✓</span> {copy.allSet.profile}</div>
              </>
            ) : (
              // Resumed past the setup steps: this session never touched
              // brain/voice, so don't print their defaults as saved config.
              <div><span className="ok">✓</span> {copy.allSet.profile}</div>
            )}
          </div>
          <div style={{ marginTop: 22 }}><button className="obw-btn obw-btn-pri" style={{ minWidth: 208 }} onClick={onComplete}>{copy.allSet.open}</button></div>
        </div></div>
      );

      default: return null;
    }
  }

  function recapLine() {
    if (!configuredThisSession) return copy.allSet.resumed;
    return `${prov.name} ${copy.allSet.wired}${tts !== "off" ? copy.allSet.voiceOn : ""}${copy.allSet.knowYou}`;
  }

  function renderProvDetail() {
    if (prov.noConfig) return <div className="obw-testres ok" style={{ fontSize: 12 }}><span className="dot" />{copy.brain.included}</div>;
    // The live Ollama catalog when we have one, the curated list otherwise.
    const pickerModels = provId === "ollama" && ollamaModels && ollamaModels.length > 0 ? ollamaModels : (prov.models ?? []);
    return (
      <>
        {prov.needsBaseUrl && <div className="obw-field"><label>{provId === "ollama" ? copy.provider.ollamaUrl : provId === "litellm" ? copy.provider.proxyUrl : copy.provider.baseUrl}</label><input className="obw-inp" placeholder={prov.urlPh} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></div>}
        {prov.needsKey && <div className="obw-field"><label>{copy.common.apiKey}</label><input className="obw-inp" type="password" placeholder={copy.common.pasteKey} value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></div>}
        {prov.freeModel
          ? <div className="obw-field"><label>{copy.common.model}</label><input className="obw-inp" placeholder={copy.common.modelId} value={model} onChange={(e) => setModel(e.target.value)} /></div>
          : <div className="obw-field"><label>{copy.common.model}</label><select className="obw-inp" value={model} onChange={(e) => setModel(e.target.value)}>{pickerModels.map((m) => <option key={m} value={m}>{m}</option>)}</select></div>}
        {provId === "ollama" && ollamaLoading && <div className="obw-hint">{copy.brain.readingOllama}</div>}
        {provId === "ollama" && !ollamaLoading && ollamaModels?.length === 0 && <div className="obw-hint">{copy.brain.ollamaError}</div>}
        <div className="obw-testrow">
          <button className="obw-btn obw-btn-ghost sm" disabled={test.status === "testing"} onClick={runTest}>{test.status === "testing" ? copy.common.testing : copy.common.testConnection}</button>
          {test.status === "ok" && <span className="obw-testres ok"><span className="dot" />{copy.common.connected} · {test.msg}</span>}
          {test.status === "err" && <span className="obw-testres err"><span className="dot" />{test.msg}</span>}
        </div>
        {prov.hint && <div className="obw-hint">{provId === "nvidia" ? copy.brain.liveCatalog : provId === "openai_compatible" ? copy.brain.compatibleHint : provId === "litellm" ? copy.brain.proxyHint : prov.hint}</div>}
      </>
    );
  }

  function renderTour() {
    const card = copy.tour.cards[tourI]!;
    const pos = TOUR_POS[tourI]!;
    return (
      <div className="obw-tourstage">
        <div className="obw-tourframe">
          <div className="obw-miniapp">
            <div className="mrail">
              <div className="mh">{t("nav.run")}</div><div className="mr">{t("room.workflows")}</div><div className="mr">{t("room.agents")}</div><div className="mr">{t("room.tasks")}</div>
              <div className="mh">{t("nav.know")}</div><div className="mr">{t("room.memory")}</div><div className="mr">{t("room.goals")}</div>
              <div className="mh">{t("nav.guard")}</div><div className="mr">{t("room.authority")} <span className="bd">2</span></div><div className="mr on">{t("nav.now")}</div>
            </div>
            <div className="mmain">
              <div className="mtop">{t("nav.now")} · {copy.tour.morning}</div>
              <div className="mgrid"><div className="mcard" /><div className="mcard" /><div className="mcard" /><div className="mcard" /></div>
              <span className="mpeb obw-drop" style={{ width: 26, height: 26 }}><span className="in" /></span>
            </div>
          </div>
          <div className="obw-tourdim" />
          <div className="obw-spot" style={pos}>
            <div className="sh"><span className="sd"><span className="in" /></span><span className="sl">{copy.tour.title}</span><span className="sc">{copy.tour.count(tourI + 1, copy.tour.cards.length)}</span></div>
            <div className="sm">{card.text}</div>
            {card.tryText && <div className="stry">{card.tryText}</div>}
            {error && <div className="stry" style={{ color: "var(--listen)" }}>{error}</div>}
            <div className="sb">
              <button className="obw-skip" onClick={skipTour}>{copy.common.skipTour}</button><span className="grow" />
              <button className="obw-btn obw-btn-pri sm" onClick={() => (tourI === copy.tour.cards.length - 1 ? finishTour() : setTourI(tourI + 1))}>{tourI === copy.tour.cards.length - 1 ? copy.common.finish : copy.common.next}</button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

/* ─────────── Mic level check (Hearing step) ───────────
   A REAL meter: getUserMedia + AnalyserNode drive the bars. Mounted only when
   an STT option is selected, so text-only users never see a mic prompt. Falls
   back to honest copy when access is denied/unavailable. */
function MicLevelCheck({ language }: { language: JarvisLanguage }) {
  const copy = ONBOARDING_COPY[language];
  const [level, setLevel] = useState(0); // 0..1 RMS, boosted for visibility
  const [micState, setMicState] = useState<"requesting" | "live" | "denied">("requesting");
  useEffect(() => {
    let raf = 0;
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let cancelled = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        setMicState("live");
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const v = (buf[i]! - 128) / 128; sum += v * v; }
          setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        if (!cancelled) setMicState("denied");
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => { /* already closed */ });
    };
  }, []);
  const BARS = 9;
  return (
    <div className="obw-miccheck">
      <div className="obw-micbars live">
        {Array.from({ length: BARS }, (_, i) => <b key={i} className={micState === "live" && level * BARS >= i + 0.5 ? "on" : ""} />)}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>{copy.mic.title}</div>
        <div style={{ fontSize: 11, color: "var(--ink3)" }}>
          {micState === "denied"
            ? copy.mic.denied
            : micState === "live" ? copy.mic.live : copy.mic.requesting}
        </div>
      </div>
    </div>
  );
}

/* ─────────── The interview (step 7) ───────────
   The design's ivstage, driven by the real useInterviewSession hook — the WS
   lifecycle, TTS playback, live STT, facts counter, skip and done are all
   preserved; only the presentation is rebuilt to Monochrome Lab. */
const IV_PHASE_CLASS: Record<string, string> = { thinking: "s-think", speaking: "s-speak", done: "s-done" };

function InterviewStep({ language, ttsDisabled, onComplete }: { language: JarvisLanguage; ttsDisabled: boolean; onComplete: () => void }) {
  const copy = ONBOARDING_COPY[language];
  const session = useInterviewSession({ ttsDisabled });
  const [composerText, setComposerText] = useState("");
  const recognizerRef = useRef<{ stop: () => void } | null>(null);

  // Auto-arm browser SpeechRecognition while the orb is "listening" (voice
  // input), unless the user opted into text-only. Mirrors the old room.
  useEffect(() => {
    if (session.textOnly) return;
    if (session.phase !== "listening") {
      if (recognizerRef.current) { try { recognizerRef.current.stop(); } catch { /* ignore */ } recognizerRef.current = null; }
      return;
    }
    const Ctor = (window as unknown as { SpeechRecognition?: new () => never; webkitSpeechRecognition?: new () => never }).SpeechRecognition
      || (window as unknown as { webkitSpeechRecognition?: new () => never }).webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new (Ctor as unknown as new () => {
      continuous: boolean; interimResults: boolean; lang: string;
      onresult: (e: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void;
      onend: () => void; onerror: () => void; start: () => void; stop: () => void;
    })();
    rec.continuous = false; rec.interimResults = true; rec.lang = language === "es" ? "es-ES" : "en-US";
    let finalText = "";
    rec.onresult = (event) => {
      let interim = "", captured = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]!; const t = String(r?.[0]?.transcript ?? "");
        if (r?.isFinal) captured += t; else interim += t;
      }
      if (captured) finalText += captured;
      session.setPartialUserText((finalText + interim).trim());
    };
    rec.onend = () => { const text = finalText.trim(); recognizerRef.current = null; if (text) session.sendUserMessage(text); };
    rec.onerror = () => { recognizerRef.current = null; };
    try { rec.start(); recognizerRef.current = rec; } catch { /* ignore */ }
    return () => { try { rec.stop(); } catch { /* ignore */ } recognizerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, session.phase, session.textOnly]);

  const sendTyped = () => { const t = composerText.trim(); if (!t) return; setComposerText(""); session.sendUserMessage(t); };
  const [skipErr, setSkipErr] = useState<string | null>(null);
  const skip = async () => {
    setSkipErr(null);
    try {
      const r = await fetch("/api/onboarding/profile/skip", { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onComplete();
    } catch {
      // Completing anyway would replay the interview next launch.
      setSkipErr(copy.errors.daemon!);
    }
  };

  if (session.phase === "done") {
    return (
      <div className="obw-scroll"><div className="obw-body mid"><div className="obw-wrap">
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 16, position: "relative" }}>
          <span className="obw-bloom ok" style={{ width: 140, height: 140, left: "50%", top: "50%", transform: "translate(-50%,-52%)" }} />
          <span className="obw-drop s-done" style={{ width: 52, height: 52 }}><span className="in" /></span>
        </div>
        <h2>{copy.interview.done}</h2>
        <div className="obw-sub" style={{ maxWidth: "34ch", margin: "9px auto 0" }}>{session.farewell || copy.interview.farewell}</div>
        <div className="obw-recap" style={{ marginTop: 10 }}><div>{session.factsRecorded} {session.factsRecorded === 1 ? copy.interview.fact : copy.interview.facts} {copy.interview.vault}</div></div>
        <div style={{ marginTop: 20 }}><button className="obw-btn obw-btn-pri" style={{ minWidth: 180 }} onClick={onComplete}>{copy.interview.continue}</button></div>
      </div></div></div>
    );
  }

  const msgs = session.messages;
  const lastAsstIdx = msgs.map((m) => m.role).lastIndexOf("assistant");
  const currentQ = lastAsstIdx >= 0 ? msgs[lastAsstIdx]!.text : (session.phase === "connecting" ? copy.interview.ready : "…");
  const history = (lastAsstIdx >= 0 ? msgs.slice(0, lastAsstIdx) : msgs).slice(-4);

  return (
    <div className="obw-iv">
      <div className="obw-ivhead">
        <span className="l">{copy.interview.title}</span>
        <span className="r">
          <span className="facts"><b>{session.factsRecorded}</b> {session.factsRecorded === 1 ? copy.interview.fact : copy.interview.facts}</span>
          {skipErr && <span className="obw-hint" style={{ color: "var(--listen)" }}>{skipErr}</span>}
          <button type="button" className="obw-skip" onClick={skip}>{copy.interview.skip}</button>
        </span>
      </div>
      <div className="obw-ivstage">
        <span className="obw-bloom" />
        <span className={`obw-drop iv-peb ${IV_PHASE_CLASS[session.phase] ?? ""}`} style={{ width: 54, height: 54 }}>
          <span className="in" /><span className="ring" />
        </span>
        <div className="obw-ivphase">{copy.phases[session.phase] ?? session.phase}</div>
        <div className="obw-ivq">{currentQ}</div>
        {history.length > 0 && (
          <div className="obw-ivtrans">
            {history.map((m, i) => <div key={i} className={`obw-bub ${m.role === "assistant" ? "jv" : "me"}`}>{m.text}</div>)}
          </div>
        )}
        {session.partialUserText && (
          <div className="obw-ivphase" style={{ fontStyle: "italic", color: "var(--ink2)", textTransform: "none", letterSpacing: 0 }}>“{session.partialUserText}”</div>
        )}
      </div>
      <div className="obw-ivcomposer">
        <input className="obw-inp" placeholder={copy.interview.placeholder} value={composerText}
          onChange={(e) => setComposerText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") sendTyped(); }} />
        {session.phase === "listening" && !session.textOnly && <span className="obw-voicepill"><span className="ld" />{copy.interview.listening}</span>}
        <button type="button" className="obw-btn obw-btn-pri sm" onClick={sendTyped}>{copy.interview.send}</button>
      </div>
    </div>
  );
}
