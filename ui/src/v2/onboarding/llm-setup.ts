/** A custom Anthropic gateway chooses from its own catalog, not our curated IDs. */
export function modelForOnboardingTest(
  provider: string,
  customEndpoint: boolean,
  selectedModel: string,
): string | undefined {
  return provider === 'anthropic' && customEndpoint ? undefined : selectedModel;
}

/** Persist the exact model that passed the connection test when available. */
export function onboardingDefaultModelRef(
  provider: string,
  selectedModel: string,
  validatedModel?: string,
): string {
  return `${provider}:${validatedModel || selectedModel || 'default'}`;
}
