import {
  httpClient,
  HttpError,
  HttpHeaders,
  HttpRequest,
  QueryParams,
  AuthenticationType,
} from '@activepieces/pieces-common';
import {
  ApFile,
  createAction,
  DynamicPropsValue,
  PieceAuth,
  Property,
} from '@activepieces/pieces-framework';
import { assertNotNullOrUndefined, isEmpty } from '@activepieces/shared';
import FormData from 'form-data';
import { httpMethodDropdown } from '../common/props';
import axios from 'axios';
// Jarvis (#961): the egress guard and the one method rule the daemon judges by.
import { EgressRefusedError, egressGuardedAxios, egressPolicyFromEnv, egressRefusalIn } from '../../../../../../../../runtime/http-egress';
import { httpRequestIsRead } from '../../../../../../../../runtime/piece-effects';
import { continuedFailure, describeHttpFailure, httpFailureOf, isRetryableFailure } from '../../../../../../../../runtime/http-failure';

enum AuthType {
  NONE = 'NONE',
  BASIC = AuthenticationType.BASIC,
  BEARER_TOKEN = AuthenticationType.BEARER_TOKEN,
}

export const httpSendRequestAction = createAction({
  name: 'send_request',
  displayName: 'Send HTTP request',
  description: 'Send HTTP request',
  props: {
    method: httpMethodDropdown,
    url: Property.ShortText({
      displayName: 'URL',
      required: true,
    }),
    headers: Property.Object({
      displayName: 'Headers',
      required: true,
    }),
    queryParams: Property.Object({
      displayName: 'Query params',
      required: true,
    }),
    authType: Property.StaticDropdown<AuthType>({
      displayName: 'Authentication',
      required: true,
      defaultValue: AuthType.NONE,
      options: {
        disabled: false,
        options: [
          { label: 'None', value: AuthType.NONE },
          { label: 'Basic Auth', value: AuthType.BASIC },
          { label: 'Bearer Token', value: AuthType.BEARER_TOKEN },
        ],
      },
    }),
    authFields: Property.DynamicProperties({
      displayName: 'Authentication Fields',
      required: false,
      auth: PieceAuth.None(),
      refreshers: ['authType'],
      props: async ({ authType }) => {
        if (!authType) {
          return {};
        }
        const authTypeEnum = authType.toString() as AuthType;
        let fields: DynamicPropsValue = {};
        switch (authTypeEnum) {
          case AuthType.NONE:
            fields = {};
            break;
          case AuthType.BASIC:
            fields = {
              username: Property.ShortText({
                displayName: 'Username',
                description: 'The username to use for authentication.',
                required: true,
              }),
              password: Property.ShortText({
                displayName: 'Password',
                description: 'The password to use for authentication.',
                required: true,
              }),
            };
            break;
          case AuthType.BEARER_TOKEN:
            fields = {
              token: Property.ShortText({
                displayName: 'Token',
                description: 'The Bearer token to use for authentication.',
                required: true,
              }),
            };
            break;
          default:
            throw new Error('Invalid authentication type');
        }
        return fields;
      },
    }),
    body_type: Property.StaticDropdown({
      displayName: 'Body Type',
      required: false,
      defaultValue: 'none',
      options: {
        disabled: false,
        options: [
          {
            label: 'None',
            value: 'none',
          },
          {
            label: 'Form Data',
            value: 'form_data',
          },
          {
            label: 'JSON',
            value: 'json',
          },
          {
            label: 'Raw',
            value: 'raw',
          },
        ],
      },
    }),
    body: Property.DynamicProperties({
      displayName: 'Body',
      refreshers: ['body_type'],
      required: false,
      auth: PieceAuth.None(),
      props: async ({ body_type }) => {
        if (!body_type) return {};

        const bodyTypeInput = body_type as unknown as string;

        const fields: DynamicPropsValue = {};

        switch (bodyTypeInput) {
          case 'none':
            break;
          case 'json':
            fields['data'] = Property.Json({
              displayName: 'JSON Body',
              required: true,
            });
            break;
          case 'raw':
            fields['data'] = Property.LongText({
              displayName: 'Raw Body',
              required: true,
            });
            break;
          case 'form_data':
            fields['data'] = Property.Array({
              displayName: 'Form Data',
              required: true,
              properties: {
                fieldName: Property.ShortText({
                  displayName: 'Field Name',
                  required: true
                }),
                fieldType: Property.StaticDropdown({
                  displayName: 'Field Type',
                  required: true,
                  options: {
                    disabled: false,
                    options: [
                      { label: 'Text', value: 'text' },
                      { label: 'File', value: 'file' }
                    ]
                  }
                }),
                textFieldValue: Property.LongText({
                  displayName: 'Text Field Value',
                  required: false
                }),
                fileFieldValue: Property.File({
                  displayName: 'File Field Value',
                  required: false
                })
              }
            });
            break;
        }
        return fields;
      },
    }),
    response_is_binary: Property.Checkbox({
      displayName: 'Response is Binary',
      description:
        'Enable for files like PDFs, images, etc. A base64 body will be returned.',
      required: false,
      defaultValue: false,
    }),
    use_proxy: Property.Checkbox({
      displayName: 'Use Proxy',
      defaultValue: false,
      description: 'Use a proxy for this request',
      required: false,
    }),
    proxy_settings: Property.DynamicProperties({
      auth: PieceAuth.None(),
      displayName: 'Proxy Settings',
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
    followRedirects: Property.Checkbox({
      displayName: 'Follow redirects',
      required: false,
      defaultValue: false,
    }),
    failureMode: Property.StaticDropdown({
      displayName: 'On Failure',
      required: false,
      defaultValue: 'continue_none',
      options: {
        disabled: false,
        options: [
          { label: 'Retry on errors (5xx, timeouts, 408, 429)', value: 'retry_all' },
          { label: 'Retry on internal errors (5xx)', value: 'retry_5xx' },
          { label: 'Do not retry', value: 'retry_none' },
          { label: 'Continue flow on all errors', value: 'continue_all' },
          { label: 'Continue flow on 4xx errors', value: 'continue_4xx' },
          { label: 'Do not continue (stop the flow)', value: 'continue_none' },
        ],
      },
    })
  },
  errorHandlingOptions: {
    continueOnFailure: { hide: true, defaultValue: false },
    retryOnFailure: { hide: true, defaultValue: false },
  },
  async run(context) {
    const {
      method,
      url,
      headers,
      queryParams,
      body,
      body_type,
      response_is_binary,
      timeout,
      failureMode,
      use_proxy,
      authType,
      authFields,
      followRedirects,
    } = context.propsValue;

    assertNotNullOrUndefined(method, 'Method');
    assertNotNullOrUndefined(url, 'URL');

    const request: HttpRequest = {
      method,
      url,
      headers: headers as HttpHeaders,
      queryParams: queryParams as QueryParams,
      timeout: timeout ? timeout * 1000 : 0,
      followRedirects,
    };

    switch (authType) {
      case AuthType.BASIC:
        if (authFields) {
          request.authentication = {
            username: authFields['username'],
            password: authFields['password'],
            type: AuthenticationType.BASIC,
          };
        }
        break;
      case AuthType.BEARER_TOKEN:
        if (authFields) {
          request.authentication = {
            token: authFields['token'],
            type: AuthenticationType.BEARER_TOKEN,
          };
        }
        break;
    }

    // Set response type to arraybuffer if binary response is expected
    if (response_is_binary) {
      request.responseType = 'arraybuffer';
    }

    if (body) {
      const bodyInput = body['data'];
      if (body_type === 'form_data') {
        const formBodyInput = bodyInput as Array<{
          fieldName: string;
          fieldType: 'text' | 'file';
          textFieldValue?: string;
          fileFieldValue?: ApFile;
        }>;

        const formData = new FormData();

        for (const { fieldName, fieldType, textFieldValue, fileFieldValue } of formBodyInput) {
          if (fieldType === 'text' && !isEmpty(textFieldValue)) {
            formData.append(fieldName, textFieldValue);
          } else if (fieldType === 'file' && !isEmpty(fileFieldValue)) {
            formData.append(fieldName, fileFieldValue!.data,{filename:fileFieldValue?.filename});
          }
        }

        request.body = formData;
        request.headers = { ...request.headers, ...formData.getHeaders() };
      } else {
        request.body = bodyInput;
      }
    }

    // === JARVIS PATCH (#961): every connection passes the egress guard ===
    // Each hop is resolved once, checked against this install's policy and
    // connected to at the checked address (runtime/http-egress.ts). A proxy
    // would pick the address itself, so the step refuses one rather than run
    // unguarded.
    const apiRequest = async () => {
      if (use_proxy) {
        throw new EgressRefusedError('Jarvis does not send HTTP steps through a proxy: the address check would not apply. Turn off "Use Proxy".');
      }
      return await httpClient.sendRequest(request, egressGuardedAxios(axios, egressPolicyFromEnv(), { read: httpRequestIsRead({ method, body }) }) as never);
    };

    let attempts = 0;
    // Only a read (a GET or HEAD with no body) is tried again by the step
    // itself. Anything else may have reached the server whatever the error
    // says, so it is sent
    // once (Q-07); "Retry on ..." still decides whether a 5xx or 4xx fails the
    // step or continues it.
    const maxAttempts = httpRequestIsRead({ method, body }) ? 3 : 1;
    // === END JARVIS PATCH ===

    while (attempts < maxAttempts) {
      try {
        const response = await apiRequest();
        return handleBinaryResponse(
          response.body,
          response.status,
          response.headers,
          response_is_binary
        );
      } catch (error) {
        // Jarvis (#961): a refused address fails the step as itself; it is
        // never retried or continued past as if the server had answered.
        const refused = egressRefusalIn(error);
        // An earlier attempt reached the server, so a refusal now is not a request never sent (#1153).
        if (refused) throw attempts > 0 && !refused.afterSend ? new EgressRefusedError(refused.message, { afterSend: true }) : refused;
        attempts++;

        // === JARVIS PATCH: a failure reads as a sentence (runtime/http-failure.ts) ===
        // Anything that is not an HTTP failure keeps its own message. A 4xx
        // other than 408 and 429 is not sent again whatever "Retry on" says: the
        // same request would be refused the same way.
        const failure = httpFailureOf(error);
        if (!failure) throw error;
        const message = describeHttpFailure(failure, { url, timeoutSeconds: timeout });
        const fail = () => { throw new Error(message); };
        const retry = isRetryableFailure(failure) && attempts < maxAttempts;
        switch (failureMode) {
          case 'retry_all': {
            if (retry) continue;
            return fail();
          }
          case 'retry_5xx': {
            if (failure.hasResponse && failure.status !== undefined && failure.status < 500) {
              return continuedFailure(failure, message); // below 500, 408 and 429 included: the flow continues, as before
            }
            if (retry) continue;
            return fail();
          }

          case 'continue_all':
            return continuedFailure(failure, message);
          case 'continue_4xx':
            if (failure.hasResponse && failure.status !== undefined && failure.status >= 400 && failure.status < 500) {
              return continuedFailure(failure, message);
            }
            if (retry) continue;
            return fail();
          case 'continue_none':
          default:
            return fail();
        }
        // === END JARVIS PATCH ===
      }
    }

    throw new Error('Unexpected error occured');
  },
});

const handleBinaryResponse = (
  bodyContent: string | ArrayBuffer | Buffer,
  status: number,
  headers?: HttpHeaders,
  isBinary?: boolean
) => {
  let body;

  if (isBinary && isBinaryBody(bodyContent)) {
    body = Buffer.from(bodyContent as unknown as string).toString('base64');
  } else {
    body = bodyContent;
  }

  // Jarvis: `ok` is the flag a continued failure also carries (`ok: false`).
  return { status, headers, body, ok: true };
};

const isBinaryBody = (body: string | ArrayBuffer | Buffer) => {
  return body instanceof ArrayBuffer || Buffer.isBuffer(body);
};
