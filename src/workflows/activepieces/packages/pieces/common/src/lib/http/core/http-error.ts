import { AxiosError } from 'axios';

export class HttpError extends Error {
  private readonly status: number;
  private readonly responseBody: unknown;
  // === JARVIS PATCH: what a plain-language failure needs (runtime/http-failure.ts) ===
  // `status` is 500 when nothing answered, so a timeout reads as a server
  // error; these say whether a response came back and what the transport said.
  readonly hasResponse: boolean;
  readonly code: string | undefined;
  readonly responseHeaders: unknown;
  // === END JARVIS PATCH ===

  constructor(private readonly requestBody: unknown, err: AxiosError) {
    const status = err?.response?.status || 500;
    const responseBody = Buffer.isBuffer(err?.response?.data) ? err?.response?.data.toString() : err?.response?.data;

    super(
      JSON.stringify({
        response: {
          status: status,
          body: responseBody,
        },
        request: {
          body: requestBody,
        },
      })
    );

    this.status = status;
    this.responseBody = responseBody;
    // === JARVIS PATCH: see above ===
    this.hasResponse = err?.response !== undefined && err?.response !== null;
    this.code = typeof err?.code === 'string' ? err.code : undefined;
    // Not enumerable: the client logs this error, and a header can carry a cookie.
    Object.defineProperty(this, 'responseHeaders', { value: err?.response?.headers, enumerable: false });
    // === END JARVIS PATCH ===
  }

  public errorMessage() {
    return {
      response: {
        status: this.status,
        body: this.responseBody,
      },
      request: {
        body: this.requestBody,
      },
    };
  }

  get response() {
    return {
      status: this.status,
      body: this.responseBody,
    };
  }

  get request() {
    return {
      body: this.requestBody,
    };
  }
}
