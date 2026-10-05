import { BriefCapabilities, type BriefCapabilityId, type BriefRegistration } from '../capabilities.ts';

/**
 * Integration owner: F track, coordinated by Lapo.
 * Future PRs put construction in registrations/<feature>.ts and compose it here.
 * Keep providers explicit and optional. Do not import a not-yet-merged module.
 * No feature providers or activations ship in F-01; shell flags do not enable them.
 */
export function createBriefCapabilities(
  registrations: readonly BriefRegistration[] = [],
  enable: readonly BriefCapabilityId[] = [],
): BriefCapabilities {
  return new BriefCapabilities(registrations, enable);
}
