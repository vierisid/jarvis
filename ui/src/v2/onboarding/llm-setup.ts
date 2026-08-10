/** A custom Anthropic gateway chooses from its own catalog, not our curated IDs. */
export function modelForOnboardingTest(
  provider: string,
  customEndpoint: boolean,
  selectedModel: string,
  discoveredModels?: string[] | null,
): string | undefined {
  if (provider !== 'anthropic' || !customEndpoint) return selectedModel;
  // Until the gateway catalog is known, omit the model so the daemon
  // discovers and validates one. Once known, the user's pick from that
  // catalog is authoritative and gets validated as-is.
  return discoveredModels?.includes(selectedModel) ? selectedModel : undefined;
}

/** Persist the exact model that passed the connection test when available. */
export function onboardingDefaultModelRef(
  provider: string,
  selectedModel: string,
  validatedModel?: string,
): string {
  return `${provider}:${validatedModel || selectedModel || 'default'}`;
}
