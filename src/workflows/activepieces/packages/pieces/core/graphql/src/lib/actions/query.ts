import {
  httpClient,
  HttpError,
  HttpHeaders,
  HttpRequest,
  QueryParams,
} from '@activepieces/pieces-common';
import {
  createAction,
  DynamicPropsValue,
  PieceAuth,
  Property,
} from '@activepieces/pieces-framework';
import { assertNotNullOrUndefined } from '@activepieces/shared';
import { httpMethodDropdown } from '../common/props';
import axios from 'axios';
// Jarvis (#961): the workflow egress guard.
import { egressGuardedAxios, egressPolicyFromEnv, egressRefusalIn } from '../../../../../../../../runtime/http-egress';

export const query = createAction({
  name: 'send_request',
  displayName: 'Send Request',
  description: 'Makes a GraphQL request.',
  props: {
    method: httpMethodDropdown,
    url: Property.ShortText({
      displayName: 'URL',
      required: true,
    }),
    queryParams: Property.Object({
      displayName: 'Query params',
      required: true,
    }),
    headers: Property.Object({
      displayName: 'Headers',
      required: true,
    }),
    query: Property.LongText({
      displayName: 'Query',
      required: true,
    }),
    variables: Property.Json({
      displayName: 'Variables',
      required: false,
    }),
    use_proxy: Property.Checkbox({
      displayName: 'Use Proxy',
      defaultValue: false,
      description: 'Use a proxy for this request',
      required: false,
    }),
    proxy_settings: Property.DynamicProperties({
      displayName: 'Proxy Settings',
      auth: PieceAuth.None(),
      refreshers: ['use_proxy'],
      required: false,
      props: async ({ use_proxy }) => {
        if (!use_proxy) return {};

        const fields: DynamicPropsValue = {};

        fields['proxy_host'] = Property.ShortText({
          displayName: 'Proxy Host',
          required: true,
        });

        fields['proxy_port'] = Property.Number({
          displayName: 'Proxy Port',
          required: true,
        });

        fields['proxy_username'] = Property.ShortText({
          displayName: 'Proxy Username',
          required: false,
        });

        fields['proxy_password'] = Property.ShortText({
          displayName: 'Proxy Password',
          required: false,
        });

        return fields;
      },
    }),
    timeout: Property.Number({
      displayName: 'Timeout(in seconds)',
      required: false,
    }),
    failsafe: Property.Checkbox({
      displayName: 'No Error on Failure',
      required: false,
    }),
  },
  // Jarvis (#961): a GraphQL request always carries its query as a body, so it
  // is a send, not a read, and is never repeated by default (Q-07): the engine
  // refuses a retry whose first attempt's outcome is unknown anyway.
  errorHandlingOptions: {
    continueOnFailure: { hide: true },
    retryOnFailure: { hide: true, defaultValue: false },
  },
  async run(context) {
    const {
      method,
      url,
      headers,
      queryParams,
      query,
      variables,
      timeout,
      failsafe,
      use_proxy,
    } = context.propsValue;

    assertNotNullOrUndefined(method, 'Method');
    assertNotNullOrUndefined(url, 'URL');

    const request: HttpRequest = {
      method,
      url,
      queryParams: queryParams as QueryParams,
      headers: headers as HttpHeaders,
      timeout: timeout ? timeout * 1000 : 0,
      body: JSON.stringify({ query, variables }),
    };

    // === JARVIS PATCH (#961): every connection passes the egress guard ===
    // As the core HTTP piece: each hop is resolved once, checked against this
    // install's policy and connected to at the checked address, a redirect to
    // another origin is refused (a GraphQL request is never a read), and a
    // proxy, which would pick the address itself, is refused.
    if (use_proxy) {
      throw new Error('Jarvis does not send GraphQL steps through a proxy: the address check would not apply. Turn off "Use Proxy".');
    }
    // === END JARVIS PATCH ===
    try {
      return await httpClient.sendRequest(request, egressGuardedAxios(axios, egressPolicyFromEnv(), { read: false }) as never);
    } catch (error) {
      // A refused address fails the step as itself, even with "No Error on Failure".
      const refused = egressRefusalIn(error);
      if (refused) throw refused;
      if (failsafe) {
        return (error as HttpError).errorMessage();
      }

      throw error;
    }
  },
});
