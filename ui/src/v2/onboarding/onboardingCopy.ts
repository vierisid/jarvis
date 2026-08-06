import type { DashboardLocale } from "../i18n/translations";

type Choice = { id: string; icon: string; name: string; body: string; required?: boolean; soon?: boolean };
type TourCard = { text: string; tryText: string };

export interface OnboardingCopy {
  steps: Record<string, string>;
  setupTitle: string;
  stepProgress: (step: number, total: number, label: string) => string;
  common: Record<string, string>;
  welcome: Record<string, string>;
  permissions: { title: string; subtitle: (device: string) => string; rows: Choice[]; review: (location: string) => string };
  brain: Record<string, string>;
  hearing: { title: string; subtitle: string; choices: Choice[] };
  speaking: { title: string; subtitle: string; choices: Choice[] };
  connect: { title: string; subtitle: string; botToken: string; rows: Choice[] };
  allSet: Record<string, string>;
  provider: Record<string, string>;
  tour: { cards: TourCard[]; title: string; morning: string; count: (current: number, total: number) => string };
  mic: Record<string, string>;
  interview: Record<string, string>;
  phases: Record<string, string>;
  errors: Record<string, string>;
}

const en: OnboardingCopy = {
  steps: {
    welcome: "Welcome", perms: "Permissions", brain: "The brain", hear: "Hearing",
    speak: "Speaking", connect: "Connect", interview: "The interview", tour: "The tour", allset: "All set",
  },
  setupTitle: "Jarvis · Setup",
  stepProgress: (step, total, label) => `Step ${step} of ${total} · ${label}`,
  common: {
    back: "Back", continue: "Continue", soon: "Soon", comingSoon: "coming soon",
    connected: "Connected", connect: "Connect", connecting: "Connecting…", save: "Save",
    saving: "Saving…", skipNow: "Skip for now", testing: "Testing…", testConnection: "Test connection",
    required: "required", openSettings: "Open settings ↗", apiKey: "API key", pasteKey: "paste your key",
    model: "Model", modelId: "model id", playing: "Playing…", preview: "Preview", testHear: "Test & hear",
    settingUp: "Setting up…", finish: "Finish", next: "Next", skipTour: "Skip tour",
  },
  welcome: {
    title: "This is your Jarvis.",
    subtitle: "Let’s spend about five minutes setting it up: what it can touch, the brain and voice it runs on, and a little about you. You can skip anything and finish later.",
    language: "Language · Idioma", languageLabel: "Jarvis response language", look: "Choose your look",
    light: "Light", dark: "Dark", setup: "Set up Jarvis", later: "I’ll do this later",
  },
  permissions: {
    title: "Let Jarvis reach your machine.",
    subtitle: (device) => `It acts on your computer through these. Jarvis can’t grant them itself (the OS won’t let it), so each one opens the exact settings pane. Grant what you’re comfortable with, or approve later when your ${device} asks.`,
    rows: [
      { id: "access", icon: "access", name: "Accessibility", body: "Click, type, and read on-screen controls so Jarvis can operate your apps.", required: true },
      { id: "screen", icon: "screen", name: "Screen Recording", body: "See your screen for Awareness: OCR, and noticing when you’re stuck." },
      { id: "auto", icon: "auto", name: "Automation", body: "Drive other apps directly: your calendar, browser, and mail." },
      { id: "files", icon: "files", name: "Files & Folders", body: "Read and write the files and folders you point it at." },
    ],
    review: (location) => `Review or revoke any of these anytime in ${location}, or from Settings → Permissions.`,
  },
  brain: {
    title: "Pick a brain for Jarvis.",
    subtitle: "Bring your own: Ollama runs locally with no key, or add an API key for Anthropic, OpenAI, and more. Jarvis AI, our hosted brain, is coming soon. Change it anytime in Settings.",
    testHint: "Test the connection to continue.", included: "Jarvis AI is included with your plan. Nothing to configure.",
    readingOllama: "Reading installed models from Ollama…",
    ollamaError: "Could not reach Ollama at this URL — showing suggestions instead. Make sure Ollama is running (models must include their tag, e.g. llama3.1:8b).",
    liveCatalog: "Live model catalog loads from your NVIDIA account.",
    compatibleHint: "Any server that speaks /v1/chat/completions: llama.cpp, vLLM, LM Studio, TGI. Include the /v1 suffix.",
    proxyHint: "The model below must match an alias defined on your proxy.",
  },
  hearing: {
    title: "How should Jarvis hear you?",
    subtitle: "Speech to text powers voice messages and the mic button. Skip if you only plan to type; wire it up later in Settings.",
    choices: [
      { id: "skip", icon: "micoff", name: "Skip for now", body: "Text only. Wire up speech later from Settings." },
      { id: "openai", icon: "mic", name: "OpenAI Whisper", body: "Cloud Whisper. Accurate, needs an OpenAI key." },
      { id: "groq", icon: "mic", name: "Groq Whisper", body: "Fastest hosted Whisper. Needs a Groq key." },
      { id: "local", icon: "mic", name: "Local Whisper.cpp", body: "Runs on your machine. No key needed." },
    ],
  },
  speaking: {
    title: "Should Jarvis speak to you?",
    subtitle: "Voice replies are optional. Hear a voice before you choose; you can change this in Settings later.",
    choices: [
      { id: "off", icon: "voloff", name: "No voice", body: "Text replies only. Lightest option." },
      { id: "edge", icon: "vol", name: "Edge TTS", body: "Free, clean, ships with Jarvis. Pick a voice below." },
      { id: "elevenlabs", icon: "vol", name: "ElevenLabs", body: "Higher fidelity. Needs an ElevenLabs key." },
    ],
  },
  connect: {
    title: "Connect your world.",
    subtitle: "Hook up the apps Jarvis should know about. All optional, all revocable from Settings.",
    botToken: "Bot token from @BotFather",
    rows: [
      { id: "google", icon: "calendar", name: "Google Calendar", body: "Read your schedule and add holds." },
      { id: "gmail", icon: "mail", name: "Gmail", body: "Triage and draft, with your approval." },
      { id: "telegram", icon: "send", name: "Telegram", body: "Talk to Jarvis from your phone." },
      { id: "discord", icon: "chat", name: "Discord", body: "In the code as a stub today.", soon: true },
      { id: "whatsapp", icon: "chat", name: "WhatsApp", body: "In the code as a stub today.", soon: true },
    ],
  },
  allSet: {
    title: "You’re all set.", online: "Bringing your dashboard online now.", brain: "brain", voice: "voice",
    textOnly: "text only", profile: "profile saved to your Vault", open: "Open Jarvis",
    resumed: "Your brain is wired up, and I know a little about you.", voiceOn: ", voice is on",
    wired: "is wired up", knowYou: ", and I know a little about you.",
  },
  provider: {
    "no key": "no key", "API key": "API key", local: "local", "self-hosted": "self-hosted", proxy: "proxy",
    baseUrl: "Base URL", ollamaUrl: "Ollama base URL", proxyUrl: "LiteLLM proxy URL",
  },
  tour: {
    title: "Jarvis · tour", morning: "good morning", count: (current, total) => `${current} of ${total}`,
    cards: [
      { text: "This is the Pebble, your companion. It lives at your cursor. Click it any time to talk to me.", tryText: "→ Click the Pebble to try" },
      { text: "Press ⌘J to summon Talk, the conversation panel. Everything we say lives there, across sessions.", tryText: "→ Press ⌘J" },
      { text: "The Index, on the left, is every room. Names spelled out, badges flag what needs you. Recognition over recall.", tryText: "" },
      { text: "Now is your monitoring surface: what I’m doing and what’s waiting on you, at a glance.", tryText: "" },
      { text: "Authority is your control panel, with a kill-switch. Nothing with real-world impact happens without your yes.", tryText: "" },
    ],
  },
  mic: {
    title: "Default microphone", denied: "Couldn’t access the microphone — you can test it later in Settings.",
    live: "Say something to check your level", requesting: "Requesting microphone access…",
  },
  interview: {
    done: "Got it.", farewell: "I have plenty to start with. Welcome to Jarvis.", fact: "fact", facts: "facts",
    vault: "in your Vault", continue: "Continue", title: "Jarvis · getting to know you", skip: "Skip",
    ready: "Getting ready to chat…", placeholder: "Type your answer, or just talk", listening: "Listening", send: "Send",
  },
  phases: { connecting: "connecting…", ready: "ready", error: "reconnecting…", thinking: "thinking", speaking: "speaking", listening: "listening", done: "done" },
  errors: {
    testFailed: "Test failed.", setupFailed: "Setup failed.", enterKey: "Enter an API key first.", enterUrl: "Enter a base URL first.", pasteEleven: "Paste your ElevenLabs key first.",
    elevenRejected: "ElevenLabs rejected this key. Check it is valid and has text-to-speech access.", voiceReady: "voice ready",
    skipSave: "Couldn’t save the skip", daemon: "Couldn’t reach the daemon — try again.", progress: "Couldn’t reach the daemon to save your progress — try again.",
    googleCredentials: "Google needs its API credentials first. Add them in Settings → Integrations, then connect here.",
    googleStart: "Couldn’t start Google sign-in.", popup: "Your browser blocked the sign-in window. Allow pop-ups, or open Settings → Integrations to connect.",
    googleDaemon: "Couldn’t reach the daemon to start Google sign-in.", telegramConnect: "Telegram token saved, but the bot couldn’t connect.",
    telegramSave: "Couldn’t save the Telegram token", telegramDaemon: "Couldn’t reach the daemon to save the Telegram token.",
    elevenHint: "Test your ElevenLabs key and pick a voice to continue.", stopSignin: "Stop waiting for the sign-in",
  },
};

const es: OnboardingCopy = {
  steps: {
    welcome: "Bienvenida", perms: "Permisos", brain: "El cerebro", hear: "Escucha",
    speak: "Voz", connect: "Conexiones", interview: "La entrevista", tour: "El recorrido", allset: "Todo listo",
  },
  setupTitle: "Jarvis · Configuración",
  stepProgress: (step, total, label) => `Paso ${step} de ${total} · ${label}`,
  common: {
    back: "Atrás", continue: "Continuar", soon: "Pronto", comingSoon: "próximamente",
    connected: "Conectado", connect: "Conectar", connecting: "Conectando…", save: "Guardar",
    saving: "Guardando…", skipNow: "Omitir por ahora", testing: "Probando…", testConnection: "Probar conexión",
    required: "obligatorio", openSettings: "Abrir ajustes ↗", apiKey: "Clave de API", pasteKey: "pega tu clave",
    model: "Modelo", modelId: "id del modelo", playing: "Reproduciendo…", preview: "Escuchar", testHear: "Probar y escuchar",
    settingUp: "Configurando…", finish: "Finalizar", next: "Siguiente", skipTour: "Omitir recorrido",
  },
  welcome: {
    title: "Este es tu Jarvis.",
    subtitle: "Dediquemos unos cinco minutos a configurarlo: a qué puede acceder, qué cerebro y voz usará, y un poco sobre ti. Puedes omitir cualquier paso y terminarlo más tarde.",
    language: "Idioma · Language", languageLabel: "Idioma de respuesta de Jarvis", look: "Elige la apariencia",
    light: "Claro", dark: "Oscuro", setup: "Configurar Jarvis", later: "Lo haré más tarde",
  },
  permissions: {
    title: "Permite que Jarvis acceda a tu equipo.",
    subtitle: (device) => `Jarvis actúa en tu equipo mediante estos permisos. No puede concedérselos por sí mismo porque el sistema operativo no lo permite, así que cada opción abre el panel correspondiente. Concede los que quieras o apruébalos más tarde cuando tu ${device} los solicite.`,
    rows: [
      { id: "access", icon: "access", name: "Accesibilidad", body: "Hacer clic, escribir y leer controles en pantalla para manejar tus aplicaciones.", required: true },
      { id: "screen", icon: "screen", name: "Grabación de pantalla", body: "Ver tu pantalla para Awareness, OCR y detectar cuándo necesitas ayuda." },
      { id: "auto", icon: "auto", name: "Automatización", body: "Controlar directamente otras aplicaciones, como calendario, navegador y correo." },
      { id: "files", icon: "files", name: "Archivos y carpetas", body: "Leer y escribir en los archivos y carpetas que indiques." },
    ],
    review: (location) => `Puedes revisar o revocar estos permisos en cualquier momento en ${location}, o desde Ajustes → Permisos.`,
  },
  brain: {
    title: "Elige un cerebro para Jarvis.",
    subtitle: "Usa el tuyo: Ollama funciona localmente sin clave, o añade una clave de API de Anthropic, OpenAI y otros. Jarvis AI, nuestro servicio alojado, estará disponible pronto. Puedes cambiarlo en Ajustes.",
    testHint: "Prueba la conexión para continuar.", included: "Jarvis AI está incluido en tu plan. No necesitas configurar nada.",
    readingOllama: "Leyendo los modelos instalados en Ollama…",
    ollamaError: "No se pudo acceder a Ollama en esta URL; se muestran sugerencias. Comprueba que Ollama esté en ejecución y que los modelos incluyan su etiqueta, por ejemplo llama3.1:8b.",
    liveCatalog: "El catálogo de modelos se carga desde tu cuenta de NVIDIA.",
    compatibleHint: "Cualquier servidor compatible con /v1/chat/completions: llama.cpp, vLLM, LM Studio o TGI. Incluye el sufijo /v1.",
    proxyHint: "El modelo debe coincidir con un alias definido en tu proxy.",
  },
  hearing: {
    title: "¿Cómo debe escucharte Jarvis?",
    subtitle: "La conversión de voz a texto permite enviar mensajes de voz y usar el micrófono. Omítela si solo vas a escribir; podrás configurarla después en Ajustes.",
    choices: [
      { id: "skip", icon: "micoff", name: "Omitir por ahora", body: "Solo texto. Configura la voz más tarde en Ajustes." },
      { id: "openai", icon: "mic", name: "OpenAI Whisper", body: "Whisper en la nube. Preciso; necesita una clave de OpenAI." },
      { id: "groq", icon: "mic", name: "Groq Whisper", body: "Whisper alojado de alta velocidad. Necesita una clave de Groq." },
      { id: "local", icon: "mic", name: "Whisper.cpp local", body: "Se ejecuta en tu equipo. No necesita clave." },
    ],
  },
  speaking: {
    title: "¿Quieres que Jarvis te hable?",
    subtitle: "Las respuestas por voz son opcionales. Escucha una voz antes de elegir; podrás cambiarla más tarde en Ajustes.",
    choices: [
      { id: "off", icon: "voloff", name: "Sin voz", body: "Solo respuestas de texto. La opción más ligera." },
      { id: "edge", icon: "vol", name: "Edge TTS", body: "Gratis, claro e incluido con Jarvis. Elige una voz abajo." },
      { id: "elevenlabs", icon: "vol", name: "ElevenLabs", body: "Mayor fidelidad. Necesita una clave de ElevenLabs." },
    ],
  },
  connect: {
    title: "Conecta tu mundo.",
    subtitle: "Conecta las aplicaciones que Jarvis debe conocer. Todas son opcionales y puedes revocar el acceso desde Ajustes.",
    botToken: "Token del bot de @BotFather",
    rows: [
      { id: "google", icon: "calendar", name: "Google Calendar", body: "Leer tu agenda y reservar espacios." },
      { id: "gmail", icon: "mail", name: "Gmail", body: "Clasificar y redactar con tu aprobación." },
      { id: "telegram", icon: "send", name: "Telegram", body: "Habla con Jarvis desde tu teléfono." },
      { id: "discord", icon: "chat", name: "Discord", body: "Actualmente disponible como implementación inicial.", soon: true },
      { id: "whatsapp", icon: "chat", name: "WhatsApp", body: "Actualmente disponible como implementación inicial.", soon: true },
    ],
  },
  allSet: {
    title: "Todo está listo.", online: "Preparando tu panel ahora.", brain: "cerebro", voice: "voz",
    textOnly: "solo texto", profile: "perfil guardado en tu Bóveda", open: "Abrir Jarvis",
    resumed: "Tu cerebro está conectado y ya sé un poco sobre ti.", voiceOn: ", la voz está activada",
    wired: "está conectado", knowYou: ", y ya sé un poco sobre ti.",
  },
  provider: {
    "no key": "sin clave", "API key": "clave de API", local: "local", "self-hosted": "alojamiento propio", proxy: "proxy",
    baseUrl: "URL base", ollamaUrl: "URL base de Ollama", proxyUrl: "URL del proxy LiteLLM",
  },
  tour: {
    title: "Jarvis · recorrido", morning: "buenos días", count: (current, total) => `${current} de ${total}`,
    cards: [
      { text: "Esta es la Piedra, tu compañera. Vive junto al cursor. Haz clic en ella cuando quieras hablar conmigo.", tryText: "→ Haz clic en la Piedra para probar" },
      { text: "Pulsa ⌘J para abrir Conversación. Todo lo que digamos permanece allí entre sesiones.", tryText: "→ Pulsa ⌘J" },
      { text: "El Índice de la izquierda contiene todas las salas. Los nombres están visibles y los indicadores señalan lo que requiere tu atención.", tryText: "" },
      { text: "Ahora es tu superficie de seguimiento: muestra de un vistazo lo que estoy haciendo y lo que espera tu atención.", tryText: "" },
      { text: "Autoridad es tu panel de control e incluye un interruptor de emergencia. Nada con impacto real ocurre sin tu aprobación.", tryText: "" },
    ],
  },
  mic: {
    title: "Micrófono predeterminado", denied: "No se pudo acceder al micrófono; puedes probarlo después en Ajustes.",
    live: "Di algo para comprobar el nivel", requesting: "Solicitando acceso al micrófono…",
  },
  interview: {
    done: "Entendido.", farewell: "Ya tengo suficiente para empezar. Te doy la bienvenida a Jarvis.", fact: "dato", facts: "datos",
    vault: "en tu Bóveda", continue: "Continuar", title: "Jarvis · conociéndote", skip: "Omitir",
    ready: "Preparando la conversación…", placeholder: "Escribe tu respuesta o simplemente habla", listening: "Escuchando", send: "Enviar",
  },
  phases: { connecting: "conectando…", ready: "listo", error: "reconectando…", thinking: "pensando", speaking: "hablando", listening: "escuchando", done: "terminado" },
  errors: {
    testFailed: "La prueba falló.", setupFailed: "La configuración falló.", enterKey: "Introduce primero una clave de API.", enterUrl: "Introduce primero una URL base.", pasteEleven: "Pega primero tu clave de ElevenLabs.",
    elevenRejected: "ElevenLabs rechazó esta clave. Comprueba que sea válida y permita usar texto a voz.", voiceReady: "voz lista",
    skipSave: "No se pudo guardar la omisión", daemon: "No se pudo acceder al servicio; inténtalo de nuevo.", progress: "No se pudo guardar tu progreso; inténtalo de nuevo.",
    googleCredentials: "Google necesita primero sus credenciales de API. Añádelas en Ajustes → Integraciones y vuelve a conectar.",
    googleStart: "No se pudo iniciar la sesión de Google.", popup: "El navegador bloqueó la ventana de inicio de sesión. Permite las ventanas emergentes o conecta desde Ajustes → Integraciones.",
    googleDaemon: "No se pudo acceder al servicio para iniciar la sesión de Google.", telegramConnect: "El token de Telegram se guardó, pero el bot no pudo conectarse.",
    telegramSave: "No se pudo guardar el token de Telegram", telegramDaemon: "No se pudo acceder al servicio para guardar el token de Telegram.",
    elevenHint: "Prueba tu clave de ElevenLabs y elige una voz para continuar.", stopSignin: "Dejar de esperar el inicio de sesión",
  },
};

export const ONBOARDING_COPY: Record<DashboardLocale, OnboardingCopy> = { en, es };
