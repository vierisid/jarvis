import type { BriefCompositionProvider } from '../composition';
import type { BriefRegistration } from '../capabilities';

export function registerCompositionIngredients(provider: BriefCompositionProvider): BriefRegistration[] {
  return [{ id: 'compositionIngredients', provider }];
}
