export type ProviderSetupGuide = {
  name: string;
  description: string;
  processing: string;
  steps: Array<{ title: string; text: string; code?: string; codeLabel?: string }>;
  baseUrl: string;
  model: string;
  key: string;
  troubleshooting: string;
  links: Array<{ label: string; href: string }>;
};

// Shared by onboarding and Settings. Examples describe the provider's defaults,
// never the user's saved configuration. Keep changes aligned with these sources.
export const PROVIDER_SETUP_GUIDES: Record<string, ProviderSetupGuide> = {
  ollama: {
    name: "Ollama",
    description: "Download a model and run it on your own computer.",
    processing: "Choose a local model to keep model requests on your machine. Ollama also offers cloud models; those run remotely.",
    steps: [
      { title: "Install and open Ollama", text: "Download Ollama for Windows, macOS or Linux using the link below. Keep it running. On Linux, start ollama serve if the service is not already running." },
      { title: "Download a model", text: "Run this in your terminal. llama3.1:8b is an example that supports tools; choose a model that fits your available memory. The first download can take a few minutes.", code: "ollama pull llama3.1:8b", codeLabel: "Download example model" },
      { title: "Connect it to Jarvis", text: "Select Ollama and enter the base URL below. Jarvis reads the installed models. Choose the exact model, including its tag, then use Test connection. In Settings, add or save the provider and assign the model in the model picker below." },
    ],
    baseUrl: "http://localhost:11434",
    model: "llama3.1:8b",
    key: "No key for the local Ollama server.",
    troubleshooting: "Cannot connect? Check that Ollama is running. Missing model? Run ollama list and use the full name shown there. Use the native Ollama URL without /v1. Slow or out-of-memory responses usually need a smaller model or less context.",
    links: [{ label: "Download Ollama", href: "https://ollama.com/download" }, { label: "Ollama setup docs", href: "https://docs.ollama.com/quickstart" }],
  },
  omniroute: {
    name: "OmniRoute",
    description: "Connect Jarvis to the models and routes in your gateway.",
    processing: "OmniRoute runs locally, but its routes may use cloud providers. Where requests go depends on the upstream providers and fallbacks you configure.",
    steps: [
      { title: "Install and start the gateway", text: "With Node.js and npm installed, run these commands in your terminal. Keep the gateway running.", code: "npm install -g omniroute\nomniroute", codeLabel: "Install and start OmniRoute" },
      { title: "Set up a working route", text: "Open the OmniRoute dashboard at http://localhost:20128. Connect an upstream provider and configure a model or combo. Check that it works in OmniRoute first. If gateway authentication is enabled, create a client API key for Jarvis." },
      { title: "Connect it to Jarvis", text: "Select OmniRoute and enter its API URL below. Enter the gateway key if required. Jarvis loads your routes and combos; select one and use Test connection. In Settings, add or save the provider, then choose its route in the model picker below." },
    ],
    baseUrl: "http://localhost:20128/v1",
    model: "Choose a route from your live catalog.",
    key: "Your OmniRoute client key, if authentication is enabled. Otherwise leave blank.",
    troubleshooting: "An empty catalog usually means the gateway is unreachable, its key is missing, or no upstream is configured. Include /v1 in the API URL. The auto route only works when OmniRoute has a usable route behind it.",
    links: [{ label: "OmniRoute setup docs", href: "https://github.com/diegosouzapw/OmniRoute#-quick-start" }],
  },
  litellm: {
    name: "LiteLLM",
    description: "Use a proxy to give Jarvis one endpoint for your models.",
    processing: "LiteLLM forwards requests to the providers in its configuration. The example below uses local Ollama; cloud backends send requests off your machine.",
    steps: [
      { title: "Install the proxy", text: "Install uv using its installation guide below, then run this command. For this example, also start Ollama and download llama3.1:8b.", code: "uv tool install 'litellm[proxy]'", codeLabel: "Install LiteLLM" },
      { title: "Give your model an alias", text: "Save this as config.yaml. The alias jarvis-local is the model name you will enter in Jarvis.", code: "model_list:\n  - model_name: jarvis-local\n    litellm_params:\n      model: ollama_chat/llama3.1:8b\n      api_base: http://localhost:11434", codeLabel: "Example config.yaml" },
      { title: "Start the proxy and connect", text: "Run the command below. Select LiteLLM in Jarvis, enter the URL and alias, then use Test connection. In Settings, add or save the provider before assigning the alias in the model picker below.", code: "litellm --config config.yaml --host 127.0.0.1 --port 4000", codeLabel: "Start LiteLLM" },
    ],
    baseUrl: "http://localhost:4000/v1",
    model: "jarvis-local",
    key: "A LiteLLM client key if your proxy requires one. The local example uses no key.",
    troubleshooting: "Model not found? Enter model_name from the proxy configuration, not the upstream model path. If the proxy connects but generation fails, check the upstream model, URL and credentials. When the proxy is in Docker, its Ollama URL must also be reachable from that container.",
    links: [{ label: "Install uv", href: "https://docs.astral.sh/uv/getting-started/installation/" }, { label: "LiteLLM setup docs", href: "https://docs.litellm.ai/docs/proxy/quick_start" }, { label: "Ollama through LiteLLM", href: "https://docs.litellm.ai/docs/providers/ollama" }],
  },
  openai_compatible: {
    name: "OpenAI-compatible servers",
    description: "Connect LM Studio, llama.cpp, vLLM or another compatible server.",
    processing: "OpenAI-compatible describes the API format. Requests go to the server you configure; a local URL alone does not guarantee that its upstream model is local.",
    steps: [
      { title: "Choose and load a model", text: "For a desktop setup, install LM Studio and download a chat model that fits your hardware. Load it for serving. For llama.cpp or vLLM, follow that server's setup documentation below." },
      { title: "Start the API server", text: "In LM Studio, open the Developer tab and start the server. Copy the address it shows. Other servers may use a different port; they must support the OpenAI chat-completions API." },
      { title: "Connect it to Jarvis", text: "Select OpenAI-compatible. Enter the server address with /v1 and its exact served model ID, then use Test connection. In Settings, add or save the provider, then enter that model ID in the model picker below. The URL below is LM Studio's default example." },
    ],
    baseUrl: "http://localhost:1234/v1",
    model: "The exact ID shown by your server or its /v1/models endpoint.",
    key: "Your server's API key if authentication is enabled. Otherwise leave blank.",
    troubleshooting: "A 404 often means the port or /v1 path is wrong. A model error usually means the served ID differs from the download filename. Tool use and image support depend on both the server and the loaded model.",
    links: [{ label: "LM Studio server setup", href: "https://lmstudio.ai/docs/developer/core/server" }, { label: "llama.cpp server setup", href: "https://github.com/ggml-org/llama.cpp/tree/master/tools/server" }, { label: "vLLM server setup", href: "https://docs.vllm.ai/en/latest/serving/openai_compatible_server/" }],
  },
};

export function providerSetupGuide(kind: string): ProviderSetupGuide | undefined {
  return Object.hasOwn(PROVIDER_SETUP_GUIDES, kind) ? PROVIDER_SETUP_GUIDES[kind] : undefined;
}
