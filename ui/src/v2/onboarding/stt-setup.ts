export type LocalSTTServerType = "whisper_cpp" | "openai_compatible";

/** Build the local STT block sent by onboarding without guessing its API. */
export function localSTTSetup(endpoint: string, serverType: LocalSTTServerType) {
  return { endpoint: endpoint.trim(), server_type: serverType };
}
