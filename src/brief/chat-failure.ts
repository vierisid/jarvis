import { getLLMErrorCode } from '../llm/provider';
import { failureText, projectFailure } from '../failures/projection';

const providerCodes = new Set([
  'background_throttled', 'auth', 'forbidden', 'rate_limit', 'network', 'bad_request',
  'unsupported_tools', 'not_found', 'server', 'quota_exhausted', 'content_policy', 'restricted',
]);

/** Only authored recovery copy crosses the chat boundary, never upstream bodies. */
export function briefChatFailure(error: unknown, toolsRan: boolean): { code: string; message: string } {
  const code = getLLMErrorCode(error);
  if (!providerCodes.has(code)) return {
    code: 'generation_failed',
    message: toolsRan
      ? 'This response could not finish. Check what earlier actions did before sending another request.'
      : 'This response could not finish. You can send a new message to try again.',
  };
  const failure = projectFailure({ source: 'provider', code }, { label: 'Your request', sideEffects: toolsRan });
  return { code: `provider_${code}`, message: failureText(failure) };
}
