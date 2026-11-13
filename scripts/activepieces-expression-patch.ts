/** Exact replacements fail a vendor sync if the supported expression boundary drifts. */
export const expressionPatches = {
  "packages/server/engine/src/lib/handler/context/flow-execution-context.ts": [
    ["import { StepExecutionPath } from './step-execution-path'", "import { StepExecutionPath } from './step-execution-path'\nimport { stepExpressionOutput } from '../../../../../../../../runtime/engine-expression-data'"],
    ['acc[stepName] = step.output', 'acc[stepName] = stepExpressionOutput(step)'],
  ],

  'packages/server/engine/src/lib/core/code/no-op-code-sandbox.ts': [
    ["import { CodeSandbox } from '../../core/code/code-sandbox-common'", "import type { CodeSandbox } from '../../core/code/code-sandbox-common'"],
    ["import { spawn } from 'node:child_process'", "import { spawn } from 'node:child_process'\nimport { evaluateWorkflowExpression } from '../../../../../../../../runtime/safe-expression'"],
    // #512: the CODE-step child gets a sanitized env rather than the engine's.
    // Registered here so a vendor sync re-applies it instead of dropping it.
    ["import { evaluateWorkflowExpression } from '../../../../../../../../runtime/safe-expression'", "import { evaluateWorkflowExpression } from '../../../../../../../../runtime/safe-expression'\nimport { sanitizedEnv } from '../../../../../../../../../util/subprocess-env'"],
    [
      "            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],\n        })",
      "            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],\n" +
      '            // Jarvis: this child runs a CODE step, i.e. workflow-authored code.\n' +
      "            // Inheriting would hand it the engine's own env: SANDBOX_ID (what\n" +
      "            // the daemon's worker RPC accepts an engine connection on), the WS\n" +
      "            // port, and the reaper's JARVIS_ENGINE_* markers. This is env\n" +
      '            // hygiene, not isolation: at the same uid the child can still read\n' +
      "            // /proc/<engine pid>/environ, and up the parent chain the daemon's\n" +
      '            // /proc/<pid>/environ, which holds every secret it started with.\n' +
      '            env: sanitizedEnv(),\n' +
      '        })',
    ],
    [
      '    async runScript({ script, scriptContext, functions }) {\n' +
      '        const newContext = {\n' +
      '            ...scriptContext,\n' +
      '            ...functions,\n' +
      '        }\n' +
      '        const params = Object.keys(newContext)\n' +
      '        const args = Object.values(newContext)\n' +
      '        const body = `return (${script})`\n' +
      '        const fn = Function(...params, body)\n' +
      '        return fn(...args)',
      '    async runScript({ script, scriptContext }) {\n' +
      '        // Jarvis: expressions may read data, never execute arbitrary code or callbacks.\n' +
      '        return evaluateWorkflowExpression(script, scriptContext)',
    ],
    // #837 and #863: the CODE child runs with --no-install and the engine's
    // --config=<empty bunfig>. Registered so a vendor sync re-applies both.
    [
      "async function runInChildProcess(",
      "/**\n * Jarvis (#863): the Bun config the CODE child must run with, as argv. The\n * engine is spawned with `--config=<empty file>` (spawnEngine, spawn.ts), and\n * the child gets that same argument. Only that spelling, with a non-empty\n * value, replaces the cwd `bunfig.toml`: `--config <path>`, `-c` and\n * `--config=` all leave it read (measured). With none to forward -- this module\n * run outside a spawned engine, as unit tests do -- POSIX gets `/dev/null`,\n * which Bun reads as an empty config (measured, 1.3.8 and 1.4.2). Windows has\n * no such path, so it refuses rather than run the step with the cwd config.\n */\nexport function codeChildConfigArgs(execArgv: readonly string[] = process.execArgv, platform: string = process.platform): string[] {\n    const own = execArgv.filter(a => a.startsWith('--config='))\n    const last = own[own.length - 1]\n    if (last !== undefined && last.length > '--config='.length) return [last]\n    if (platform !== 'win32') return ['--config=/dev/null']\n    throw new Error('CODE step refused: the engine was not started with --config=<empty bunfig>, so the step would read a bunfig.toml from its working directory (#863).')\n}\n\nasync function runInChildProcess(",
    ],
    [
      "        const child = spawn(process.execPath, ['--eval', CODE_RUNNER_SCRIPT], {",
      "        // Jarvis (#837): `--no-install`, because a step file has no `node_modules`\n        // above it unless the daemon installed its declared dependencies there\n        // (code-materialize.ts), and with none Bun AUTO-INSTALLS any bare name the\n        // code requires: fetches the latest version from the npm registry and runs\n        // it. Measured with `is-number`, into an empty install cache. Bun-only:\n        // under Node there is no auto-install and the flag would be rejected.\n        //\n        // Jarvis (#863): and the engine's own `--config=<empty bunfig>`, so a\n        // `bunfig.toml` in the cwd this child inherits is never read: its\n        // `preload` would run before the step, as code nothing pins. And\n        // `--no-env-file`, so a `.env` there cannot add variables to the\n        // sanitized env below (a proxy for every request the step makes).\n        const args = process.versions.bun ? [...codeChildConfigArgs(), '--no-env-file', '--no-install', '--eval', CODE_RUNNER_SCRIPT] : ['--eval', CODE_RUNNER_SCRIPT]\n        const child = spawn(process.execPath, args, {",
    ],
  ],
  // #961: the core HTTP piece connects only through the egress guard, refuses a
  // proxy, and tries a request that is not a read once. Registered so a vendor
  // sync re-applies it; `http-egress.test.ts` and `core-pieces.test.ts` cover it.
  "packages/pieces/core/http/src/lib/actions/send-http-request-action.ts": [
    ["import { HttpsProxyAgent } from 'https-proxy-agent';\nimport axios from 'axios';",
      "import axios from 'axios';\n// Jarvis (#961): the egress guard and the one method rule the daemon judges by.\nimport { EgressRefusedError, egressGuardedAxios, egressPolicyFromEnv, egressRefusalIn } from '../../../../../../../../runtime/http-egress';\nimport { httpRequestIsRead } from '../../../../../../../../runtime/piece-effects';"],
    ["    const apiRequest = async () => {\n      if (use_proxy) {\n        const proxySettings = context.propsValue.proxy_settings;\n        assertNotNullOrUndefined(proxySettings, 'Proxy Settings');\n        assertNotNullOrUndefined(proxySettings['proxy_host'], 'Proxy Host');\n        assertNotNullOrUndefined(proxySettings['proxy_port'], 'Proxy Port');\n        let proxyUrl;\n\n        if (proxySettings.proxy_username && proxySettings.proxy_password) {\n          proxyUrl = `http://${proxySettings.proxy_username}:${proxySettings.proxy_password}@${proxySettings.proxy_host}:${proxySettings.proxy_port}`;\n        } else {\n          proxyUrl = `http://${proxySettings.proxy_host}:${proxySettings.proxy_port}`;\n        }\n\n        const httpsAgent = new HttpsProxyAgent(proxyUrl);\n        const axiosClient = axios.create({\n          httpsAgent,\n        });\n\n        return await httpClient.sendRequest(request, axiosClient);\n      }\n      return await httpClient.sendRequest(request);\n    };\n\n    let attempts = 0;\n\n    while (attempts < 3) {",
      "    // === JARVIS PATCH (#961): every connection passes the egress guard ===\n    // Each hop is resolved once, checked against this install's policy and\n    // connected to at the checked address (runtime/http-egress.ts). A proxy\n    // would pick the address itself, so the step refuses one rather than run\n    // unguarded.\n    const apiRequest = async () => {\n      if (use_proxy) {\n        throw new EgressRefusedError('Jarvis does not send HTTP steps through a proxy: the address check would not apply. Turn off \"Use Proxy\".');\n      }\n      return await httpClient.sendRequest(request, egressGuardedAxios(axios, egressPolicyFromEnv(), { read: httpRequestIsRead({ method, body }) }) as never);\n    };\n\n    let attempts = 0;\n    // Only a read (a GET or HEAD with no body) is tried again by the step\n    // itself. Anything else may have reached the server whatever the error\n    // says, so it is sent\n    // once (Q-07); \"Retry on ...\" still decides whether a 5xx or 4xx fails the\n    // step or continues it.\n    const maxAttempts = httpRequestIsRead({ method, body }) ? 3 : 1;\n    // === END JARVIS PATCH ===\n\n    while (attempts < maxAttempts) {"],
    ["      } catch (error) {\n        attempts++;\n",
      "      } catch (error) {\n        // Jarvis (#961): a refused address fails the step as itself; it is\n        // never retried or continued past as if the server had answered.\n        const refused = egressRefusalIn(error);\n        // An earlier attempt reached the server, so a refusal now is not a request never sent (#1153).\n        if (refused) throw attempts > 0 && !refused.afterSend ? new EgressRefusedError(refused.message, { afterSend: true }) : refused;\n        attempts++;\n"],
    ["          case 'retry_all': {\n            if (attempts < 3) continue;",
      "          case 'retry_all': {\n            if (attempts < maxAttempts) continue;"],
    ["              if (attempts < 3) continue;\n              throw error; // after 3 tries, throw",
      "              if (attempts < maxAttempts) continue;\n              throw error; // after 3 tries, throw"],
    ["            if (attempts < 3) continue;\n            throw error;\n          case 'continue_none':",
      "            if (attempts < maxAttempts) continue;\n            throw error;\n          case 'continue_none':"],
    // Jarvis: failures read as sentences, 4xx is not retried, a continued failure keeps the success shape (runtime/http-failure.ts).
    ["import { EgressRefusedError, egressGuardedAxios, egressPolicyFromEnv, egressRefusalIn } from '../../../../../../../../runtime/http-egress';\nimport { httpRequestIsRead } from '../../../../../../../../runtime/piece-effects';\n\nenum AuthType {",
      "import { EgressRefusedError, egressGuardedAxios, egressPolicyFromEnv, egressRefusalIn } from '../../../../../../../../runtime/http-egress';\nimport { httpRequestIsRead } from '../../../../../../../../runtime/piece-effects';\nimport { continuedFailure, describeHttpFailure, httpFailureOf, isRetryableFailure } from '../../../../../../../../runtime/http-failure';\n\nenum AuthType {"],
    ["        disabled: false,\n        options: [\n          { label: 'Retry on all errors (4xx, 5xx)', value: 'retry_all' },\n          { label: 'Retry on internal errors (5xx)', value: 'retry_5xx' },\n          { label: 'Do not retry', value: 'retry_none' },",
      "        disabled: false,\n        options: [\n          { label: 'Retry on errors (5xx, timeouts, 408, 429)', value: 'retry_all' },\n          { label: 'Retry on internal errors (5xx)', value: 'retry_5xx' },\n          { label: 'Do not retry', value: 'retry_none' },"],
    ["        attempts++;\n\n        switch (failureMode) {\n          case 'retry_all': {\n            if (attempts < maxAttempts) continue;\n            throw error;\n          }\n          case 'retry_5xx': {\n            if (\n              (error as HttpError).response.status >= 500 &&\n              (error as HttpError).response.status < 600\n            ) {\n              if (attempts < maxAttempts) continue;\n              throw error; // after 3 tries, throw\n            }\n            return (error as HttpError).errorMessage(); //throw error; // non 5xxx error\n          }\n\n          case 'continue_all':\n            return (error as HttpError).errorMessage();\n          case 'continue_4xx':\n            if (\n              (error as HttpError).response?.status >= 400 &&\n              (error as HttpError).response?.status < 500\n            ) {\n              return (error as HttpError).errorMessage();\n            }\n            if (attempts < maxAttempts) continue;\n            throw error;\n          case 'continue_none':\n            throw error;\n          default:\n            throw error;\n        }\n      }\n    }",
      "        attempts++;\n\n        // === JARVIS PATCH: a failure reads as a sentence (runtime/http-failure.ts) ===\n        // Anything that is not an HTTP failure keeps its own message. A 4xx\n        // other than 408 and 429 is not sent again whatever \"Retry on\" says: the\n        // same request would be refused the same way.\n        const failure = httpFailureOf(error);\n        if (!failure) throw error;\n        const message = describeHttpFailure(failure, { url, timeoutSeconds: timeout });\n        const fail = () => { throw new Error(message); };\n        const retry = isRetryableFailure(failure) && attempts < maxAttempts;\n        switch (failureMode) {\n          case 'retry_all': {\n            if (retry) continue;\n            return fail();\n          }\n          case 'retry_5xx': {\n            if (failure.hasResponse && failure.status !== undefined && failure.status < 500) {\n              return continuedFailure(failure, message); // below 500, 408 and 429 included: the flow continues, as before\n            }\n            if (retry) continue;\n            return fail();\n          }\n\n          case 'continue_all':\n            return continuedFailure(failure, message);\n          case 'continue_4xx':\n            if (failure.hasResponse && failure.status !== undefined && failure.status >= 400 && failure.status < 500) {\n              return continuedFailure(failure, message);\n            }\n            if (retry) continue;\n            return fail();\n          case 'continue_none':\n          default:\n            return fail();\n        }\n        // === END JARVIS PATCH ===\n      }\n    }"],
    ["  }\n\n  return { status, headers, body };\n};\n",
      "  }\n\n  // Jarvis: `ok` is the flag a continued failure also carries (`ok: false`).\n  return { status, headers, body, ok: true };\n};\n"],
  ],
  // #961: the core SMTP, GraphQL and FTP/SFTP pieces connect only through the
  // egress guard. SMTP sends once; GraphQL refuses a proxy and is not retried by
  // default; the SFTP piece lists no trigger and keeps FTP data connections on
  // the checked address; the PDF piece drops "Convert to Image" (a shell, its
  // source is stubbed by sync-activepieces.ts) and the password generator uses
  // a CSPRNG. `activepieces-expression-patch.test.ts` round-trips them.
  "packages/pieces/core/smtp/src/lib/common/index.ts": [
    ["  },\n};",
      "  },\n  // === END JARVIS PATCH ===\n};"],
    ["    const smtpOptions = smtpCommon.constructConfig(auth);\n    const transporter = nodemailer.createTransport(smtpOptions);\n    return transporter;",
      "    const smtpOptions = smtpCommon.constructConfig(auth);\n    const host = String(auth.host ?? '').trim();\n    const address = await resolveGuardedAddress(host, egressPolicyFromEnv(), { label: 'SMTP connection' });\n    const transporter = nodemailer.createTransport({\n      ...smtpOptions,\n      host: address,\n      ...(isIP(host.replace(/^\\[(.*)\\]$/u, '$1')) === 0 ? { servername: host } : {}),\n    }, {\n      // Message defaults: nothing in a message may make nodemailer read a\n      // local file or fetch a URL (an attachment or html given as { path }).\n      disableFileAccess: true,\n      disableUrlAccess: true,\n    });\n    return transporter;"],
    ["  },\n  createSMTPTransport(auth: smtpAuthParams) {\n    const smtpOptions = smtpCommon.constructConfig(auth);",
      "  },\n  // === JARVIS PATCH (#961): the mail server passes the egress guard ===\n  // The host is resolved once, every address is checked against this\n  // install's policy, and nodemailer connects to the checked address, never\n  // resolving the name itself. The name stays the TLS servername, so the\n  // certificate is still checked against it.\n  async createSMTPTransport(auth: smtpAuthParams) {\n    const smtpOptions = smtpCommon.constructConfig(auth);"],
    ["import nodemailer from 'nodemailer';\n",
      "import nodemailer from 'nodemailer';\nimport { isIP } from 'node:net';\n// Jarvis (#961): the workflow egress guard.\nimport { egressPolicyFromEnv, resolveGuardedAddress } from '../../../../../../../../runtime/http-egress';\n"],
  ],
  "packages/pieces/core/smtp/src/index.ts": [
    ["    } catch (e) {\n      const castedError = (e as Record<string, unknown>)",
      "    } catch (e) {\n      // Jarvis (#961): a refused address says which rule refused it.\n      if ((e as { code?: unknown })?.code === 'ERR_EGRESS_REFUSED') {\n        return { valid: false, error: (e as Error).message };\n      }\n      const castedError = (e as Record<string, unknown>)"],
    ["        try {\n      const transporter = smtpCommon.createSMTPTransport(auth);\n      return new Promise((resolve, reject) => {",
      "        try {\n      // Jarvis (#961): resolved and checked by the egress guard first.\n      const transporter = await smtpCommon.createSMTPTransport(auth);\n      return new Promise((resolve, reject) => {"],
  ],
  "packages/pieces/core/smtp/src/lib/actions/send-email.ts": [
    ["  }\n}\n\nfunction getFrom(senderName: string|undefined, from: string) {",
      "  }\n}\n// === END JARVIS PATCH ===\n\nfunction getFrom(senderName: string|undefined, from: string) {"],
    ["async function sendWithRetry(transporter: any, mailOptions: any) {\n  const maxRetries = 3;\n  let retryCount = 0;\n  \n  while (retryCount < maxRetries) {\n    try {\n      const info = await transporter.sendMail(mailOptions);\n      return info;\n    } catch (error: any) {\n      if ('code' in error && error.code === 'ECONNRESET' && retryCount < maxRetries - 1) {\n        retryCount++;\n        await new Promise(resolve => setTimeout(resolve, 3000));\n        continue;\n      }\n      throw error;\n    }\n  }\n}",
      "async function sendWithRetry(transporter: any, mailOptions: any) {\n  return await transporter.sendMail(mailOptions);\n}"],
    ["\nasync function sendWithRetry(transporter: any, mailOptions: any) {",
      "\n// === JARVIS PATCH (#961): an email is sent once ===\n// Upstream tried again after ECONNRESET, but a reset after the server took the\n// message (after DATA) is a sent email, and trying again sends it twice. The\n// send is tracked (Q-07): an attempt whose outcome is unknown is refused\n// rather than repeated.\nasync function sendWithRetry(transporter: any, mailOptions: any) {"],
    ["  run: async ({ auth, propsValue }) => {\n    const transporter = smtpCommon.createSMTPTransport(auth.props);\n",
      "  run: async ({ auth, propsValue }) => {\n    // Jarvis (#961): resolved and checked by the egress guard first.\n    const transporter = await smtpCommon.createSMTPTransport(auth.props);\n"],
  ],
  "packages/pieces/core/graphql/src/lib/actions/query.ts": [
    ["    } catch (error) {\n      if (failsafe) {",
      "    } catch (error) {\n      // A refused address fails the step as itself, even with \"No Error on Failure\".\n      const refused = egressRefusalIn(error);\n      if (refused) throw refused;\n      if (failsafe) {"],
    ["    try {\n      if (use_proxy) {\n        const proxySettings = context.propsValue.proxy_settings;\n        assertNotNullOrUndefined(proxySettings, 'Proxy Settings');\n        assertNotNullOrUndefined(proxySettings['proxy_host'], 'Proxy Host');\n        assertNotNullOrUndefined(proxySettings['proxy_port'], 'Proxy Port');\n        let proxyUrl;\n\n        if (proxySettings['proxy_username'] && proxySettings['proxy_password']) {\n          proxyUrl = `http://${proxySettings['proxy_username']}:${proxySettings['proxy_password']}@${proxySettings['proxy_host']}:${proxySettings['proxy_port']}`;\n        } else {\n          proxyUrl = `http://${proxySettings['proxy_host']}:${proxySettings['proxy_port']}`;\n        }\n  \n        const httpsAgent = new HttpsProxyAgent(proxyUrl)\n        const axiosClient = axios.create({\n          httpsAgent,\n        });\n\n        const proxied_response = await axiosClient.request(request);\n        return proxied_response.data;\n      }\n      return await httpClient.sendRequest(request);\n    } catch (error) {",
      "    try {\n      return await httpClient.sendRequest(request, egressGuardedAxios(axios, egressPolicyFromEnv(), { read: false }) as never);\n    } catch (error) {"],
    ["\n    try {",
      "\n    // === JARVIS PATCH (#961): every connection passes the egress guard ===\n    // As the core HTTP piece: each hop is resolved once, checked against this\n    // install's policy and connected to at the checked address, a redirect to\n    // another origin is refused (a GraphQL request is never a read), and a\n    // proxy, which would pick the address itself, is refused.\n    if (use_proxy) {\n      throw new EgressRefusedError('Jarvis does not send GraphQL steps through a proxy: the address check would not apply. Turn off \"Use Proxy\".');\n    }\n    // === END JARVIS PATCH ===\n    try {"],
    ["    continueOnFailure: { hide: true },\n    retryOnFailure: { defaultValue: true },\n  },",
      "    continueOnFailure: { hide: true },\n    retryOnFailure: { hide: true, defaultValue: false },\n  },"],
    ["  },\n  errorHandlingOptions: {",
      "  },\n  // Jarvis (#961): a GraphQL request always carries its query as a body, so it\n  // is a send, not a read, and is never repeated by default (Q-07): the engine\n  // refuses a retry whose first attempt's outcome is unknown anyway.\n  errorHandlingOptions: {"],
    ["import axios from 'axios';\n",
      "import axios from 'axios';\n// Jarvis (#961): the workflow egress guard.\nimport { EgressRefusedError, egressGuardedAxios, egressPolicyFromEnv, egressRefusalIn } from '../../../../../../../../runtime/http-egress';\n"],
    ["import { httpMethodDropdown } from '../common/props';\nimport { HttpsProxyAgent } from 'https-proxy-agent';\nimport axios from 'axios';",
      "import { httpMethodDropdown } from '../common/props';\nimport axios from 'axios';"],
    // Jarvis: failures read as sentences, 4xx is not retried, a continued failure keeps the success shape (runtime/http-failure.ts).
    ["// Jarvis (#961): the workflow egress guard.\nimport { EgressRefusedError, egressGuardedAxios, egressPolicyFromEnv, egressRefusalIn } from '../../../../../../../../runtime/http-egress';\n\nexport const query = createAction({",
      "// Jarvis (#961): the workflow egress guard.\nimport { EgressRefusedError, egressGuardedAxios, egressPolicyFromEnv, egressRefusalIn } from '../../../../../../../../runtime/http-egress';\nimport { continuedFailure, describeHttpFailure, graphqlErrorMessage, httpFailureOf } from '../../../../../../../../runtime/http-failure';\n\nexport const query = createAction({"],
    ["    // === END JARVIS PATCH ===\n    try {\n      return await httpClient.sendRequest(request, egressGuardedAxios(axios, egressPolicyFromEnv(), { read: false }) as never);\n    } catch (error) {\n      // A refused address fails the step as itself, even with \"No Error on Failure\".\n      const refused = egressRefusalIn(error);\n      if (refused) throw refused;\n      if (failsafe) {\n        return (error as HttpError).errorMessage();\n      }\n\n      throw error;\n    }\n  },",
      "    // === END JARVIS PATCH ===\n    try {\n      const response = await httpClient.sendRequest(request, egressGuardedAxios(axios, egressPolicyFromEnv(), { read: false }) as never);\n      // === JARVIS PATCH: a GraphQL server answers 200 with an `errors` array when the query failed ===\n      // The step fails on it, naming the first error, unless \"No Error on\n      // Failure\" is on; then it returns the response with `ok: false`.\n      const graphqlError = graphqlErrorMessage(response.body);\n      if (graphqlError) {\n        if (failsafe) return { ...response, ok: false, error: graphqlError };\n        throw new Error(graphqlError);\n      }\n      return { ...response, ok: true };\n      // === END JARVIS PATCH ===\n    } catch (error) {\n      // A refused address fails the step as itself, even with \"No Error on Failure\".\n      const refused = egressRefusalIn(error);\n      if (refused) throw refused;\n      // Jarvis: a failure reads as a sentence, and a continued one keeps the success fields.\n      const failure = httpFailureOf(error);\n      if (!failure) throw error;\n      const message = describeHttpFailure(failure, { url, timeoutSeconds: timeout });\n      if (failsafe) {\n        return continuedFailure(failure, message);\n      }\n\n      throw new Error(message);\n    }\n  },"],
  ],
  // Jarvis: what a plain-language HTTP failure reads off the error (runtime/http-failure.ts).
  "packages/pieces/common/src/lib/http/core/http-error.ts": [
    ["  private readonly status: number;\n  private readonly responseBody: unknown;\n\n  constructor(private readonly requestBody: unknown, err: AxiosError) {",
      "  private readonly status: number;\n  private readonly responseBody: unknown;\n  // === JARVIS PATCH: what a plain-language failure needs (runtime/http-failure.ts) ===\n  // `status` is 500 when nothing answered, so a timeout reads as a server\n  // error; these say whether a response came back and what the transport said.\n  readonly hasResponse: boolean;\n  readonly code: string | undefined;\n  readonly responseHeaders: unknown;\n  // === END JARVIS PATCH ===\n\n  constructor(private readonly requestBody: unknown, err: AxiosError) {"],
    ["    this.status = status;\n    this.responseBody = responseBody;\n  }\n",
      "    this.status = status;\n    this.responseBody = responseBody;\n    // === JARVIS PATCH: see above ===\n    this.hasResponse = err?.response !== undefined && err?.response !== null;\n    this.code = typeof err?.code === 'string' ? err.code : undefined;\n    // Not enumerable: the client logs this error, and a header can carry a cookie.\n    Object.defineProperty(this, 'responseHeaders', { value: err?.response?.headers, enumerable: false });\n    // === END JARVIS PATCH ===\n  }\n"],
  ],
  // Convert JSON to CSV keeps every column, not only the first row's. Registered so a
  // vendor sync re-applies it; `core-csv-piece.test.ts` covers it.
  "packages/pieces/core/csv/src/lib/actions/convert-json-to-csv.ts": [
    [
      "    return stringify(flattened, {\n      header: true,\n      delimiter: delimiter_type,\n    });",
      '    // === JARVIS PATCH: the header is every key of every row ===\n' +
      '    // Upstream took the header from the first row, so a column only a later row\n' +
      '    // had was dropped, with its values, and the step still succeeded. Keys are\n' +
      '    // listed in first-seen order; a row without a key gets an empty cell.\n' +
      '    // Cells are read as own properties and handed over by position: given an\n' +
      '    // object row, csv-stringify resolves a column like `tags.0` as a path, so a\n' +
      '    // row whose `tags` is the string "foo" would get "f", and a row without\n' +
      '    // `toString` would read the prototype\'s function and fail the step.\n' +
      '    const isRow = (row: unknown): row is Record<string, unknown> =>\n' +
      '      row !== null && typeof row === \'object\' && !Array.isArray(row);\n' +
      '    const columns = [...new Set(flattened.flatMap((row) => (isRow(row) ? Object.keys(row) : [])))];\n' +
      '    if (columns.length > 0) {\n' +
      '      const cells = flattened.map((row) =>\n' +
      '        isRow(row) ? columns.map((key) => (Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined)) : row,\n' +
      '      );\n' +
      '      return stringify(cells, {\n' +
      '        header: true,\n' +
      '        delimiter: delimiter_type,\n' +
      '        columns,\n' +
      '      });\n' +
      '    }\n' +
      '    return stringify(flattened, {\n' +
      '      header: true,\n' +
      '      delimiter: delimiter_type,\n' +
      '    });\n' +
      '    // === END JARVIS PATCH ==='
    ],
  ],
  // Image Helper: Compress accepts its own dropdown values, and a crop outside the
  // image fails in plain words. Registered so a vendor sync re-applies them;
  // `core-image-piece.test.ts` covers them.
  "packages/pieces/core/image-helper/src/lib/actions/compress-image.actions.ts": [
    ["    image.quality(context.propsValue.quality);",
      "    // === JARVIS PATCH: the Quality dropdown's own values work ===\n    // A saved flow or the editor hands the dropdown value over as text (\"60\"),\n    // and the image library rejects anything that is not a number type.\n    const quality = Number(context.propsValue.quality);\n    if (\n      String(context.propsValue.quality).trim() === '' ||\n      !Number.isFinite(quality) ||\n      quality < 0 ||\n      quality > 100\n    ) {\n      throw new Error(\n        'Quality must be a number from 0 to 100. Pick High Quality or Lossy Quality.'\n      );\n    }\n    image.quality(quality);\n    // === END JARVIS PATCH ==="],
  ],
  "packages/pieces/core/image-helper/src/lib/actions/crop-image.action.ts": [
    ["    await image.crop(\n      context.propsValue.left,\n      context.propsValue.top,\n      context.propsValue.width,\n      context.propsValue.height\n    );\n",
      "    // === JARVIS PATCH: a crop outside the image says so in plain words ===\n    // Upstream let the image library fail with a raw \"offset is out of range\".\n    // The library rounds each value before it crops, so check the rounded ones.\n    const { left, top, width, height } = context.propsValue;\n    const x = Math.round(left);\n    const y = Math.round(top);\n    const w = Math.round(width);\n    const h = Math.round(height);\n    if (\n      ![left, top, width, height].every(Number.isFinite) ||\n      x < 0 ||\n      y < 0 ||\n      w < 1 ||\n      h < 1 ||\n      x + w > image.getWidth() ||\n      y + h > image.getHeight()\n    ) {\n      throw new Error(\n        `The crop area does not fit inside the image. The image is ${image.getWidth()} by ${image.getHeight()} pixels, so Left and Top must be 0 or more, Width and Height must be at least 1, and Left plus Width and Top plus Height must stay within the image.`\n      );\n    }\n    // === END JARVIS PATCH ===\n    await image.crop(\n      context.propsValue.left,\n      context.propsValue.top,\n      context.propsValue.width,\n      context.propsValue.height\n    );\n"],
  ],
  "packages/pieces/core/sftp/src/lib/common.ts": [
    ["        rejectUnauthorized: !(allow_unauthorized_certificates ?? false),\n      }",
      "        rejectUnauthorized: !(allow_unauthorized_certificates ?? false),\n        ...servername,\n      }"],
    ["  } else {\n    const ftpClient = new FTPClient();\n    await ftpClient.access({",
      "  } else {\n    // Jarvis (#961): a PASV reply names the host for the data connection, so a\n    // server could send it to any address, past the guard (and an FTP bounce).\n    // With allowSeparateTransferHost off, basic-ftp connects data sockets to\n    // the control connection's address, the one the guard checked; EPSV names\n    // only a port anyway. 30000 is basic-ftp's default timeout.\n    const ftpClient = new FTPClient(30000, { allowSeparateTransferHost: false });\n    await ftpClient.access({"],
    ["  const { protocol, host, port, allow_unauthorized_certificates, allow_anonymous_login, username, password, privateKey, algorithm } = auth;\n  const protocolBackwardCompatibility = await getProtocolBackwardCompatibility(protocol);\n  if (protocolBackwardCompatibility === 'sftp') {\n    const sftp = new Client();",
      "  const { protocol, host, port, allow_unauthorized_certificates, allow_anonymous_login, username, password, privateKey, algorithm } = auth;\n  const protocolBackwardCompatibility = await getProtocolBackwardCompatibility(protocol);\n  // === JARVIS PATCH (#961): the server passes the egress guard ===\n  // The host is resolved once, every address is checked against this\n  // install's policy, and the client connects to the checked address, never\n  // resolving the name itself. FTPS keeps the name as its TLS servername, so\n  // the certificate is still checked against it.\n  const name = String(auth.host ?? '').trim();\n  const host = await resolveGuardedAddress(name, egressPolicyFromEnv(), {\n    label: `${protocolBackwardCompatibility.toUpperCase()} connection`,\n  });\n  const servername = isIP(name.replace(/^\\[(.*)\\]$/u, '$1')) === 0 ? { servername: name } : {};\n  // === END JARVIS PATCH ===\n  if (protocolBackwardCompatibility === 'sftp') {\n    const sftp = new Client();"],
    ["export async function getClient<T extends Client | FTPClient>(auth: { protocol: string | undefined, host: string, port: number, allow_unauthorized_certificates: boolean | undefined, allow_anonymous_login: boolean | undefined, username: string, password: string | undefined, privateKey: string | undefined, algorithm: ServerHostKeyAlgorithm[] | string[] | undefined }): Promise<T> {\n  const { protocol, host, port, allow_unauthorized_certificates, allow_anonymous_login, username, password, privateKey, algorithm } = auth;\n  const protocolBackwardCompatibility = await getProtocolBackwardCompatibility(protocol);",
      "export async function getClient<T extends Client | FTPClient>(auth: { protocol: string | undefined, host: string, port: number, allow_unauthorized_certificates: boolean | undefined, allow_anonymous_login: boolean | undefined, username: string, password: string | undefined, privateKey: string | undefined, algorithm: ServerHostKeyAlgorithm[] | string[] | undefined }): Promise<T> {\n  const { protocol, port, allow_unauthorized_certificates, allow_anonymous_login, username, password, privateKey, algorithm } = auth;\n  const protocolBackwardCompatibility = await getProtocolBackwardCompatibility(protocol);"],
    ["import { Client as FTPClient } from 'basic-ftp';\n",
      "import { Client as FTPClient } from 'basic-ftp';\nimport { isIP } from 'node:net';\n// Jarvis (#961): the workflow egress guard.\nimport { egressPolicyFromEnv, resolveGuardedAddress } from '../../../../../../../runtime/http-egress';\n"],
  ],
  "packages/pieces/core/sftp/src/index.ts": [
    ["  ],\n  triggers: [newOrModifiedFile],\n});",
      "  ],\n  // Jarvis (#961): the polling trigger is not loaded. A trigger runs outside\n  // the effect boundary, where nothing governs or guards its connection.\n  triggers: [],\n});"],
    ["import { readFileContent } from './lib/actions/read-file';\nimport { newOrModifiedFile } from './lib/triggers/new-modified-file';\nimport { deleteFolderAction } from './lib/actions/delete-folder';",
      "import { readFileContent } from './lib/actions/read-file';\nimport { deleteFolderAction } from './lib/actions/delete-folder';"],
  ],
  "packages/pieces/core/pdf/src/index.ts": [
    ["    extractText,\n    convertToImage,\n    textToPdf,",
      "    extractText,\n    // Jarvis (#961): \"Convert to Image\" is not loaded; it runs pdftoppm in a\n    // shell outside the run (see lib/actions/convert-to-image.ts).\n    textToPdf,"],
    ["import { extractText } from './lib/actions/extract-text';\nimport { convertToImage } from './lib/actions/convert-to-image';\nimport { textToPdf } from './lib/actions/text-to-pdf';",
      "import { extractText } from './lib/actions/extract-text';\nimport { textToPdf } from './lib/actions/text-to-pdf';"],
  ],
  "packages/pieces/core/crypto/src/lib/actions/generate-password.ts": [
    ["    for (let i = 0; i < length; i++) {\n      const randomIndex = Math.floor(Math.random() * charset.length);\n      password += charset[randomIndex];",
      "    for (let i = 0; i < length; i++) {\n      // Jarvis (#961): a password from a CSPRNG, not Math.random().\n      const randomIndex = randomInt(charset.length);\n      password += charset[randomIndex];"],
    ["import {\n  Property,",
      "import { randomInt } from 'node:crypto';\nimport {\n  Property,"],
  ],
  // #961: a file property's URL is fetched through the egress guard, before
  // Authority is asked, rather than by a plain fetch of a flow-chosen URL.
  "packages/server/engine/src/lib/variables/processors/file.ts": [
    ["import { ProcessorFn } from './types'\n",
      "import { ProcessorFn } from './types'\nimport axios from 'axios'\n// Jarvis (#961): a file URL is fetched through the HTTP step's egress guard.\nimport { egressPolicyFromEnv, egressRefusalIn, guardedFileDownload } from '../../../../../../../../runtime/http-egress'\n"],
    ["    catch (e) {\n        console.error(e)\n        return null\n    }",
      "    catch (e) {\n        // Jarvis (#961): a refused address fails the step naming the rule.\n        const refused = egressRefusalIn(e)\n        if (refused) throw refused\n        console.error(e)\n        return null\n    }"],
    ["async function handleUrlFile(path: string): Promise<ApFile | null> {\n    const fileResponse = await fetch(path)\n\n    const filename = getFileName(path, fileResponse.headers.get('content-disposition'), fileResponse.headers.get('content-type') ?? undefined) ?? 'unknown'\n    const extension = filename.split('.').length > 1 ? filename.split('.').pop() : undefined\n\n    return new ApFile(\n        filename,\n        Buffer.from(await fileResponse.arrayBuffer()),\n        extension,\n    )\n}",
      "async function handleUrlFile(path: string): Promise<ApFile | null> {\n    // Jarvis (#961): resolved, checked and connected to through the egress\n    // guard, redirects included; never a plain fetch of a flow-chosen URL.\n    const fileResponse = await guardedFileDownload(axios, path, egressPolicyFromEnv())\n    const header = (name: string): string | null => {\n        const value = fileResponse.headers[name]\n        return typeof value === 'string' ? value : null\n    }\n\n    const filename = getFileName(path, header('content-disposition'), header('content-type') ?? undefined) ?? 'unknown'\n    const extension = filename.split('.').length > 1 ? filename.split('.').pop() : undefined\n\n    return new ApFile(\n        filename,\n        fileResponse.data,\n        extension,\n    )\n}"],
    // Keep invoice stored-file transport and polling patches on vendor refresh.
    ["// Jarvis (#961): a file URL is fetched through the HTTP step's egress guard.\nimport { egressPolicyFromEnv, egressRefusalIn, guardedFileDownload } from '../../../../../../../../runtime/http-egress'\n\nexport const fileProcessor: ProcessorFn = async (_property, urlOrBase64) => {\n    if (isNil(urlOrBase64) || !isString(urlOrBase64)) {\n        return null\n    }\n", "// Jarvis (#961): a file URL is fetched through the HTTP step's egress guard.\nimport { egressPolicyFromEnv, egressRefusalIn, guardedFileDownload } from '../../../../../../../../runtime/http-egress'\n\nexport const fileProcessor: ProcessorFn = async (_property, urlOrBase64, fileContext) => {\n    if (isNil(urlOrBase64) || !isString(urlOrBase64)) {\n        return null\n    }\n"],
    ["        if (!isNil(file)) {\n            return file\n        }\n        return await handleUrlFile(urlOrBase64)\n    }\n    catch (e) {\n        // Jarvis (#961): a refused address fails the step naming the rule.\n", "        if (!isNil(file)) {\n            return file\n        }\n        return await handleUrlFile(urlOrBase64, fileContext)\n    }\n    catch (e) {\n        // Jarvis (#961): a refused address fails the step naming the rule.\n"],
    ["    )\n}\n\nasync function handleUrlFile(path: string): Promise<ApFile | null> {\n    // Jarvis (#961): resolved, checked and connected to through the egress\n    // guard, redirects included; never a plain fetch of a flow-chosen URL.\n    const fileResponse = await guardedFileDownload(axios, path, egressPolicyFromEnv())\n    const header = (name: string): string | null => {\n        const value = fileResponse.headers[name]\n        return typeof value === 'string' ? value : null\n    }\n\n    const filename = getFileName(path, header('content-disposition'), header('content-type') ?? undefined) ?? 'unknown'\n    const extension = filename.split('.').length > 1 ? filename.split('.').pop() : undefined\n\n    return new ApFile(\n        filename,\n        fileResponse.data,\n        extension,\n    )\n}\n", "    )\n}\n\nasync function handleUrlFile(path: string, context?: { apiUrl: string; engineToken: string }): Promise<ApFile | null> {\n    // Only a stored-file path receives the engine credential, never a caller URL.\n    const stored = /^\\/v1\\/step-files\\/[A-Za-z0-9_-]+$/.test(path)\n    if (stored && !context) throw new Error('Stored file requires the workflow context')\n    const url = stored ? new URL(path.slice(1), context!.apiUrl).toString() : path\n    let data: Buffer\n    let header: (name: string) => string | null\n    if (stored) {\n        const response = await fetch(url, { headers: { Authorization: 'Bearer ' + context!.engineToken }, redirect: 'error' })\n        if (!response.ok) throw new Error('File download failed: ' + response.status)\n        data = Buffer.from(await response.arrayBuffer())\n        header = (name) => response.headers.get(name)\n    } else {\n        // Caller URLs retain main's checked DNS, connection and redirect policy.\n        const response = await guardedFileDownload(axios, path, egressPolicyFromEnv())\n        data = response.data\n        header = (name) => typeof response.headers[name] === 'string' ? response.headers[name] : null\n    }\n    const filename = getFileName(url, header('content-disposition'), header('content-type') ?? undefined) ?? 'unknown'\n    const extension = filename.split('.').length > 1 ? filename.split('.').pop() : undefined\n\n    return new ApFile(\n        filename,\n        data,\n        extension,\n    )\n}\n"],
    // #1153: a file field's URL reaches only the hosts on the flow's read list.
    ["import { egressPolicyFromEnv, egressRefusalIn, guardedFileDownload } from '../../../../../../../../runtime/http-egress'\n", "import { EgressRefusedError, egressPolicyFromEnv, egressRefusalIn, guardedFileDownload } from '../../../../../../../../runtime/http-egress'\n"],
    ["        // Caller URLs retain main's checked DNS, connection and redirect policy.\n        const response = await guardedFileDownload(axios, path, egressPolicyFromEnv())\n", "        // Caller URLs retain main's checked DNS, connection and redirect policy.\n        // Jarvis (#1153): a file field is fetched while the step's props are\n        // resolved, before Authority is asked, so it reaches only the hosts on\n        // the flow's read list, redirects included.\n        if (!context) throw new EgressRefusedError('File download refused: there is no workflow to check its read list against')\n        let hosts: unknown\n        let status = 'unreachable'\n        try {\n            const list = await fetch(new URL('v1/jarvis/read-hosts', context.apiUrl).toString(), { headers: { Authorization: 'Bearer ' + context.engineToken }, redirect: 'error' })\n            status = String(list.status)\n            hosts = list.ok ? ((await list.json()) as { hosts?: unknown }).hosts : undefined\n        }\n        catch { hosts = undefined }\n        if (!Array.isArray(hosts) || !hosts.every((h) => typeof h === 'string')) throw new EgressRefusedError('File download refused: the workflow read list could not be read (' + status + ')')\n        const response = await guardedFileDownload(axios, path, egressPolicyFromEnv(), { readHosts: hosts as string[] })\n"],
  ],
  'packages/server/engine/src/lib/helper/trigger-helper.ts': [
    ["import { isValidCron } from 'cron-validator'", "import { validateCronExpression } from '../../../../../../../../lib/cron-scheduler'"],
    ['                if (!isValidCron(request.cronExpression)) {', '                try {\n                    validateCronExpression(request.cronExpression)\n                } catch {'],
    // Keep invoice stored-file transport and polling patches on vendor refresh.
    ["                await pieceTrigger.onEnable(context)\n                return {\n                    listeners: appListeners,\n                    scheduleOptions: pieceTrigger.type === TriggerStrategy.POLLING ? scheduleOptions : undefined,\n                }\n            }\n            case TriggerHookType.RENEW: {\n", "                await pieceTrigger.onEnable(context)\n                return {\n                    listeners: appListeners,\n                    // Community polling triggers may rely on the host's default cadence:\n                    // every 5 minutes. Preserve explicit schedules; never leave an enabled\n                    // poller inert.\n                    scheduleOptions: pieceTrigger.type === TriggerStrategy.POLLING ? scheduleOptions ?? {\n                        type: TriggerSourceScheduleType.CRON_EXPRESSION,\n                        cronExpression: '*/5 * * * *',\n                        // timezone intentionally omitted: Jarvis's configured zone applies.\n                    } as ScheduleOptions : undefined,\n                }\n            }\n            case TriggerHookType.RENEW: {\n"],
    ["        executionState: FlowExecutorContext.empty(),\n    })\n\n    const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators(resolvedInput, pieceTrigger.props, piece.auth, pieceTrigger.requireAuth, propertySettings)\n\n    if (Object.keys(errors).length > 0) {\n        throw new Error(JSON.stringify(errors, null, 2))\n", "        executionState: FlowExecutorContext.empty(),\n    })\n\n    const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators(resolvedInput, pieceTrigger.props, piece.auth, pieceTrigger.requireAuth, propertySettings, { apiUrl, engineToken })\n\n    if (Object.keys(errors).length > 0) {\n        throw new Error(JSON.stringify(errors, null, 2))\n"],
  ],
  'packages/server/engine/src/lib/variables/props-resolver.ts': [
    ['        return result ?? \'\'\n    }))',
      "        if (result === undefined) throw new Error('Workflow reference resolved to an absent value; supply a value or an explicit fallback')\n        return result\n    }))"],
    ["        console.warn('[evalInScope] Error evaluating variable', resultError)\n        return ''",
      '        // Jarvis: an unsupported expression must stop the step before any effect.\n        throw resultError'],
  ],
  'packages/server/engine/src/lib/variables/props-processor.ts': [
    ["import { getAuthPropertyForValue,",
      "import { resolvedInputIssues } from '../../../../../../../runtime/resolved-input-guard'\nimport { getAuthPropertyForValue,"],
    ['        return { processedInput, errors }',
      '        Object.assign(errors, resolvedInputIssues(processedInput, props, requireAuth, !!auth, propertySettings, resolvedInput))\n        return { processedInput, errors }'],
    // Keep invoice stored-file transport and polling patches on vendor refresh.
    ["        auth: PieceAuthProperty | PieceAuthProperty[] | undefined,\n        requireAuth: boolean,\n        propertySettings: Record<string, PropertySettings>,\n    ): Promise<{ processedInput: StaticPropsValue<PiecePropertyMap>, errors: PropsValidationError }> => {\n        let dynamaicPropertiesSchema: Record<string, InputPropertyMap> | undefined = undefined\n        if (Object.keys(propertySettings).length > 0) {\n", "        auth: PieceAuthProperty | PieceAuthProperty[] | undefined,\n        requireAuth: boolean,\n        propertySettings: Record<string, PropertySettings>,\n        fileContext?: { apiUrl: string; engineToken: string },\n    ): Promise<{ processedInput: StaticPropsValue<PiecePropertyMap>, errors: PropsValidationError }> => {\n        let dynamaicPropertiesSchema: Record<string, InputPropertyMap> | undefined = undefined\n        if (Object.keys(propertySettings).length > 0) {\n"],
    ["                    undefined,\n                    false,\n                    {},\n                )\n                processedInput[AUTHENTICATION_PROPERTY_NAME] = authProcessedInput\n                if (Object.keys(authErrors).length > 0) {\n", "                    undefined,\n                    false,\n                    {},\n                    fileContext,\n                )\n                processedInput[AUTHENTICATION_PROPERTY_NAME] = authProcessedInput\n                if (Object.keys(authErrors).length > 0) {\n"],
    ["                    undefined,\n                    false,\n                    {},\n                )\n                processedInput[key] = itemProcessedInput\n                if (Object.keys(itemErrors).length > 0) {\n", "                    undefined,\n                    false,\n                    {},\n                    fileContext,\n                )\n                processedInput[key] = itemProcessedInput\n                if (Object.keys(itemErrors).length > 0) {\n"],
    ["                        undefined,\n                        false,\n                        {},\n                    )\n                    processedArray.push(itemProcessedInput)\n                    processedErrors.push(itemErrors)\n", "                        undefined,\n                        false,\n                        {},\n                        fileContext,\n                    )\n                    processedArray.push(itemProcessedInput)\n                    processedErrors.push(itemErrors)\n"],
    ["            }\n            const processor = processors[property.type]\n            if (processor) {\n                processedInput[key] = await processor(property, processedInput[key])\n            }\n\n            const shouldValidate = key !== AUTHENTICATION_PROPERTY_NAME && property.type !== PropertyType.MARKDOWN\n", "            }\n            const processor = processors[property.type]\n            if (processor) {\n                processedInput[key] = await processor(property, processedInput[key], fileContext)\n            }\n\n            const shouldValidate = key !== AUTHENTICATION_PROPERTY_NAME && property.type !== PropertyType.MARKDOWN\n"],
  ],
  'packages/server/engine/src/lib/handler/router-executor.ts': [
    ["import { LATEST_CONTEXT_VERSION } from '@activepieces/pieces-framework'",
      "import { LATEST_CONTEXT_VERSION } from '@activepieces/pieces-framework'\nimport { withPresenceFallbacks } from '../../../../../../../runtime/router-presence'"],
    [`        const { censoredInput, resolvedInput } = await constants.getPropsResolver(LATEST_CONTEXT_VERSION).resolve<RouterActionSettings>({
            unresolvedInput: {
                ...action.settings,
            },
            executionState,
        })`,
      `        const resolver = constants.getPropsResolver(LATEST_CONTEXT_VERSION)
        const settings = withPresenceFallbacks(action.settings) as RouterActionSettings
        // Resolve metadata first, leaving condition operands untouched until
        // their AND/OR group actually needs them. A presence guard must be
        // able to stop an absent comparison before strict input resolution.
        const { censoredInput, resolvedInput } = await resolver.resolve<RouterActionSettings>({
            unresolvedInput: {
                ...settings,
                branches: settings.branches.map(branch => branch.branchType === BranchExecutionType.CONDITION
                    ? { ...branch, conditions: [] } : branch),
            },
            executionState,
        })
        for (const [index, branch] of settings.branches.entries()) {
            if (branch.branchType !== BranchExecutionType.CONDITION) continue
            const resolvedGroups: BranchCondition[][] = []
            const censoredGroups: BranchCondition[][] = []
            resolvedInput.branches[index] = { ...resolvedInput.branches[index], branchType: BranchExecutionType.CONDITION, conditions: resolvedGroups }
            const censoredSettings = censoredInput as RouterActionSettings
            censoredSettings.branches[index] = { ...censoredSettings.branches[index], branchType: BranchExecutionType.CONDITION, conditions: censoredGroups }
            for (const group of branch.conditions) {
                const resolvedGroup: BranchCondition[] = []
                const censoredGroup: BranchCondition[] = []
                resolvedGroups.push(resolvedGroup)
                censoredGroups.push(censoredGroup)
                let matched = true
                for (const condition of group) {
                    const result = await resolver.resolve<BranchCondition>({ unresolvedInput: condition, executionState })
                    resolvedGroup.push(result.resolvedInput)
                    censoredGroup.push(result.censoredInput as BranchCondition)
                    matched = evaluateConditions([[result.resolvedInput]])
                    if (!matched) break
                }
                if (matched) break
            }
            // FIRST_MATCH must not resolve operands in later branches. Their
            // condition lists remain empty in the recorded input.
            if (resolvedInput.executionType === RouterExecutionType.EXECUTE_FIRST_MATCH && evaluateConditions(resolvedGroups)) break
        }
        // Each retained group is its evaluated prefix. The existing boolean
        // evaluator yields the same result; logs contain only evaluated data.`],
    // #735: "starts with" has one meaning under both spellings, and an operator
    // the switch does not implement fails the step instead of staying true.
    // Registered here so a vendor sync re-applies it: readiness accepts
    // TEXT_STARTS_WITH only because the engine reads it as TEXT_START_WITH.
    ['            switch (castedCondition.operator) {',
      `            // === JARVIS PATCH: one meaning for "starts with", and no silent match ===
            // The enum's VALUE for starts-with is TEXT_START_WITH (what the dashboard
            // saves); its KEY name, TEXT_STARTS_WITH, is what composed workflows write.
            // Without a case for the key name, the condition fell through this switch
            // and stayed true, so "starts with" matched every input.
            const operator = (castedCondition.operator as string) === 'TEXT_STARTS_WITH'
                ? BranchOperator.TEXT_STARTS_WITH : castedCondition.operator
            // === END JARVIS PATCH ===
            switch (operator) {`],
    [`                case BranchOperator.DOES_NOT_EXIST:
                    andGroup = andGroup && (castedCondition.firstValue === undefined || castedCondition.firstValue === null || castedCondition.firstValue === '')
                    break
`,
      `                case BranchOperator.DOES_NOT_EXIST:
                    andGroup = andGroup && (castedCondition.firstValue === undefined || castedCondition.firstValue === null || castedCondition.firstValue === '')
                    break
                // === JARVIS PATCH: an operator this switch does not implement fails the step instead of matching ===
                default:
                    throw new EngineGenericError('UnsupportedOperatorError', \`Router condition operator \${String(operator)} is not supported\`)
                // === END JARVIS PATCH ===
`],
  ],
  "packages/server/engine/src/lib/handler/piece-executor.ts": [
    ["import { ActionContext, backwardCompatabilityContextUtils, ", "import { helpScoutEngineProps } from \"../../../../../../../runtime/managed-help-scout-inputs\"\nimport { zoomEngineProps } from \"../../../../../../../runtime/managed-zoom-inputs\"\nimport { gitlabEngineProps } from \"../../../../../../../runtime/managed-gitlab-inputs\"\nimport { pipedriveEngineProps } from \"../../../../../../../runtime/managed-pipedrive-inputs\"\nimport { wrikeEngineProps } from \"../../../../../../../runtime/managed-wrike-inputs\"\nimport { mondayEngineProps } from \"../../../../../../../runtime/managed-monday-inputs\"\nimport { webflowEngineProps } from \"../../../../../../../runtime/managed-webflow-inputs\"\nimport { ActionContext, backwardCompatabilityContextUtils, "],
    ["\n        stepOutput.input = censoredInput\n\n        const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators(resolvedInput, pieceAction.props, piece.auth, pieceAction.requireAuth, action.settings.propertySettings)\n        if (Object.keys(errors).length > 0) {\n            throw new Error(JSON.stringify(errors, null, 2))\n        }\n", "\n        stepOutput.input = censoredInput\n\n        const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators(resolvedInput, helpScoutEngineProps(action.settings.pieceName, action.settings.actionName, resolvedInput) ?? zoomEngineProps(action.settings.pieceName, action.settings.actionName, resolvedInput) ?? gitlabEngineProps(action.settings.pieceName, action.settings.actionName, resolvedInput) ?? pipedriveEngineProps(action.settings.pieceName, action.settings.actionName, resolvedInput) ?? wrikeEngineProps(action.settings.pieceName, action.settings.actionName, resolvedInput) ?? webflowEngineProps(action.settings.pieceName, action.settings.actionName, resolvedInput) ?? mondayEngineProps(action.settings.pieceName, action.settings.actionName, resolvedInput) ?? pieceAction.props, piece.auth, pieceAction.requireAuth, action.settings.propertySettings, { apiUrl: constants.internalApiUrl, engineToken: constants.engineToken })\n        if (Object.keys(errors).length > 0) {\n            throw new Error(JSON.stringify(errors, null, 2))\n        }\n"],
    ["import { continueIfFailureHandler, runWithExponentialBackoff } from '../helper/error-handling'", "import { continuableFailure } from '../../../../../../../runtime/piece-effect-guard'\nimport { continueIfFailureHandler, refusedDispatches, runWithExponentialBackoff } from '../helper/error-handling'"],
    ["const executeAction: ActionHandler<PieceAction> = async ({ action, executionState, constants }) => {\n    const stepStartTime = performance.now()", "const executeAction: ActionHandler<PieceAction> = async ({ action, executionState, constants }) => {\n    const stepStartTime = performance.now()\n    // Jarvis: whether the dispatch check refused this step, and whether it let\n    // it run (see refusedDispatches and continuableFailure).\n    let dispatchRefused = false\n    let dispatched = false"],
    ["        const governance = await authorizePieceDispatch(dispatchParams)\n", "        const governance = await authorizePieceDispatch(dispatchParams).catch((error: unknown) => {\n            // === JARVIS PATCH: a refused dispatch is never continued past ===\n            dispatchRefused = true\n            // === END JARVIS PATCH ===\n            throw error\n        })\n        dispatched = true\n"],
    ["        return executionState\n            .upsertStep(action.name, failedStepOutput)\n            .setVerdict({\n                status: FlowRunStatus.FAILED, failedStep: {\n                    name: action.name,\n                    displayName: action.displayName,\n                    message: utils.formatError(executionStateError),\n                },\n            })\n    }", "        const failedContext = executionState\n            .upsertStep(action.name, failedStepOutput)\n            .setVerdict({\n                status: FlowRunStatus.FAILED, failedStep: {\n                    name: action.name,\n                    displayName: action.displayName,\n                    message: utils.formatError(executionStateError),\n                },\n            })\n        // === JARVIS PATCH: a refused dispatch is never continued past ===\n        // A Jarvis step that heard a refusal from inside its run is one too.\n        if (dispatchRefused || (dispatched && !continuableFailure(action.settings.pieceName, executionStateError))) refusedDispatches.add(failedContext)\n        return failedContext\n        // === END JARVIS PATCH ===\n    }"],
  ],
  "packages/server/engine/src/lib/handler/code-executor.ts": [
    ["import { continueIfFailureHandler, runWithExponentialBackoff } from '../helper/error-handling'", "import { continueIfFailureHandler, refusedDispatches, runWithExponentialBackoff } from '../helper/error-handling'"],
    ["const executeAction: ActionHandler<CodeAction> = async ({ action, executionState, constants }) => {\n    const stepStartTime = performance.now()", "const executeAction: ActionHandler<CodeAction> = async ({ action, executionState, constants }) => {\n    const stepStartTime = performance.now()\n    // Jarvis: set when the dispatch check refused this step (see refusedDispatches).\n    let dispatchRefused = false"],
    ["            input: {},\n        })\n        if ('dispatch' in admission", "            input: {},\n        }).catch((error: unknown) => {\n            // === JARVIS PATCH: a refused dispatch is never continued past ===\n            dispatchRefused = true\n            // === END JARVIS PATCH ===\n            throw error\n        })\n        if ('dispatch' in admission"],
    ["        return executionState\n            .upsertStep(action.name, failedStepOutput)\n            .setVerdict({ status: FlowRunStatus.FAILED, failedStep: {\n                name: action.name,\n                displayName: action.displayName,\n                message: utils.formatError(executionStateError),\n            } })\n    }", "        const failedContext = executionState\n            .upsertStep(action.name, failedStepOutput)\n            .setVerdict({ status: FlowRunStatus.FAILED, failedStep: {\n                name: action.name,\n                displayName: action.displayName,\n                message: utils.formatError(executionStateError),\n            } })\n        // === JARVIS PATCH: a refused dispatch is never continued past ===\n        if (dispatchRefused) refusedDispatches.add(failedContext)\n        return failedContext\n        // === END JARVIS PATCH ===\n    }"],
  ],
  "packages/server/engine/src/lib/helper/error-handling.ts": [
    ["export async function continueIfFailureHandler(", "// === JARVIS PATCH: a refused dispatch is never continued past ===\n// A step the daemon would not admit or authorize (denied, held for Kill, not\n// approved) did not run. \"Continue on failure\" is for a step that ran and\n// failed; it must not turn a refusal of Authority into a step to move past.\n// The executors add the failed context they return when the refusal came from\n// the dispatch check or, for a step that asks Jarvis from inside its run (a\n// Jarvis piece, an approval), from there (piece-effect-guard continuableFailure).\nexport const refusedDispatches = new WeakSet<FlowExecutorContext>()\n// === END JARVIS PATCH ===\n\nexport async function continueIfFailureHandler("],
    ["        continueOnFailure &&\n        isNil(constants.stepNameToTest)\n    ) {", "        continueOnFailure &&\n        !refusedDispatches.has(executionState) &&\n        isNil(constants.stepNameToTest)\n    ) {"],
  ],
  "packages/server/engine/src/lib/variables/processors/types.ts": [
    ["export type ProcessorFn<INPUT = any, OUTPUT = any> = (\n    property: PieceProperty,\n    value: INPUT,\n) => OUTPUT\n", "export type ProcessorFn<INPUT = any, OUTPUT = any> = (\n    property: PieceProperty,\n    value: INPUT,\n    fileContext?: { apiUrl: string; engineToken: string },\n) => OUTPUT\n"],
  ],
  // F-06: date-helper rejects an expression it cannot read, and "Use Current Time"
  // needs no time. `core-date-helper-piece.test.ts` covers both.
  "packages/pieces/core/date-helper/src/lib/actions/next-day-of-week.ts": [
    ['    await propsValidation.validateZod(context.propsValue, {\n      time: z.string().regex(/^\\d\\d:\\d\\d$/),\n    });',
      '    // === JARVIS PATCH: "Use Current Time" does not need a time to be given ===\n    await propsValidation.validateZod(context.propsValue, {\n      ...(context.propsValue.currentTime === true ? {} : { time: z.string().regex(/^\\d\\d:\\d\\d$/) }),\n    });\n    // === END JARVIS PATCH ==='],
    ['\'The time that you would like to get the date and time of. This must be in 24h format.\',',
      '\'The time that you would like to get the date and time of, as HH:mm in 24h format, for example 09:30. Not used when "Use Current Time" is checked.\','],
  ],
  "packages/pieces/core/date-helper/src/lib/actions/next-day-of-year.ts": [
    ['    await propsValidation.validateZod(context.propsValue, {\n      day: z.number().min(1).max(31),\n      time: z.string().regex(/^\\d\\d:\\d\\d$/),\n    });',
      '    // === JARVIS PATCH: "Use Current Time" does not need a time to be given ===\n    await propsValidation.validateZod(context.propsValue, {\n      day: z.number().min(1).max(31),\n      ...(context.propsValue.currentTime === true ? {} : { time: z.string().regex(/^\\d\\d:\\d\\d$/) }),\n    });\n    // === END JARVIS PATCH ==='],
    ['\'The time that you would like to get the date and time of. This must be in 24h format.\',',
      '\'The time that you would like to get the date and time of, as HH:mm in 24h format, for example 09:30. Not used when "Use Current Time" is checked.\','],
  ],
  "packages/pieces/core/date-helper/src/lib/actions/first-day-of-prior-month.ts": [
    ['    await propsValidation.validateZod(context.propsValue, {\n      time: z.string().regex(/^\\d\\d:\\d\\d$/),\n    });',
      '    // === JARVIS PATCH: "Use Current Time" does not need a time to be given ===\n    await propsValidation.validateZod(context.propsValue, {\n      ...(context.propsValue.currentTime === true ? {} : { time: z.string().regex(/^\\d\\d:\\d\\d$/) }),\n    });\n    // === END JARVIS PATCH ==='],
    ['\'The time that you would like to get the date and time of. This must be in 24h format.\',',
      '\'The time that you would like to get the date and time of, as HH:mm in 24h format, for example 09:30. Not used when "Use Current Time" is checked.\','],
  ],
  "packages/pieces/core/date-helper/src/lib/actions/last-day-of-prior-month.ts": [
    ['    await propsValidation.validateZod(context.propsValue, {\n      time: z.string().regex(/^\\d\\d:\\d\\d$/),\n    });',
      '    // === JARVIS PATCH: "Use Current Time" does not need a time to be given ===\n    await propsValidation.validateZod(context.propsValue, {\n      ...(context.propsValue.currentTime === true ? {} : { time: z.string().regex(/^\\d\\d:\\d\\d$/) }),\n    });\n    // === END JARVIS PATCH ==='],
    ['\'The time that you would like to get the date and time of. This must be in 24h format.\',',
      '\'The time that you would like to get the date and time of, as HH:mm in 24h format, for example 09:30. Not used when "Use Current Time" is checked.\','],
  ],
  // Date Helper: every date-reading action parses through runtime/date-parse.ts,
  // an instant in the zone setting (or UTC), not a wall clock in the daemon's zone.
  "packages/pieces/core/date-helper/src/lib/common/index.ts": [
    ["import duration from 'dayjs/plugin/duration';", "import duration from 'dayjs/plugin/duration';\nimport { parseDateInstant } from '../../../../../../../../runtime/date-parse';"],
    ["export function parseDate(date: string, format: string): dayjs.Dayjs {\n  const correctedFormat = getCorrectedFormat(format);\n  \n  // Try strict parsing with the provided format\n  let djs = apDayjs(date, correctedFormat, true);\n  \n  // If strict parsing fails, try lenient parsing (useful for formats that native parser handles well)\n  if (!djs.isValid()) {\n    djs = apDayjs(date, correctedFormat, false);\n  }\n  \n  // If still invalid, try without format (native parser fallback)\n  if (!djs.isValid()) {\n    djs = apDayjs(date);\n  }\n  \n  if (!djs.isValid()) {\n    throw new Error(`Failed to parse the date: ${date} with format: ${correctedFormat}`);\n  }\n  return djs;\n}\n", "// === JARVIS PATCH: one instant-based parser for every Date Helper action ===\n// The upstream parser read the text in the process zone, accepted text that\n// did not match the format, and rolled impossible dates over. The parse lives\n// in runtime/date-parse.ts (see its header for the rules). `zone` is where a\n// wall time with no offset is read; actions without a zone setting read UTC.\nexport function parseDate(date: string, format: string, zone = 'UTC'): dayjs.Dayjs {\n  // Always a UTC-mode value: its parts are UTC, and `.tz()` on it converts the real instant.\n  return apDayjs.utc(parseDateInstant(date, getCorrectedFormat(format), zone));\n}\n\n/** Format an instant. `X` is formatted from the instant: the upstream plugin reads a shifted clock for a zoned value. */\nexport function formatDate(date: dayjs.Dayjs, format: string): string {\n  return format === 'X' ? String(date.unix()) : date.format(format);\n}\n// === END JARVIS PATCH ===\n"],
  ],
  "packages/pieces/core/date-helper/src/lib/actions/format-date.ts": [
    ["  getCorrectedFormat,\n} from '../common';", "  getCorrectedFormat,\n  formatDate,\n} from '../common';"],
    ["  const parsedDate = parseDate(inputDate, inputFormat);\n  \n  return parsedDate.tz(inputTimeZone, true).tz(outputTimeZone).format(outputFormat);\n}", "  // Jarvis: the input is read as an instant (an offset in the text wins over the\n  // From Time Zone), then shown in the To Time Zone.\n  const parsedDate = parseDate(inputDate, inputFormat, inputTimeZone);\n\n  return formatDate(parsedDate.tz(outputTimeZone), outputFormat);\n}"],
  ],
  "packages/pieces/core/date-helper/src/lib/actions/add-subtract-date.ts": [
    ["  parseDate,\n", "  parseDate,\n  formatDate,\n"],
    ["let dayjsDate = timeZone ? apDayjs(date).tz(timeZone) : apDayjs(date);", "// Jarvis: without a zone the date is worked in UTC, not the daemon's own zone.\n  let dayjsDate = timeZone ? apDayjs(date).tz(timeZone) : apDayjs.utc(date);"],
    ["return { result: AfterDate.tz(timeZone).format(outputFormat) };", "return { result: formatDate(AfterDate.tz(timeZone), outputFormat) };"],
    ["return { result: AfterDate.format(outputFormat) };", "return { result: formatDate(AfterDate, outputFormat) };"],
    // #1355: the expression must be readable, and a result outside the date range fails.
    ["import { propsValidation } from '@activepieces/pieces-common';\n",
      "import { propsValidation } from '@activepieces/pieces-common';\nimport { quote } from '../../../../../../../../runtime/date-parse';\n"],
    ["function addSubtractTime(date: Date, expression: string, timeZone?: string): dayjs.Dayjs {\n",
      "function addSubtractTime(date: Date, expression: string, timeZone?: string): dayjs.Dayjs {\n  // === JARVIS PATCH: an expression that is not one or more \"+/- number unit\" terms fails ===\n  // Anything else used to be skipped term by term, so \"banana\" changed nothing\n  // and a misspelt unit was ignored, while the step reported success. Any\n  // whitespace is dropped (the upstream line below only drops spaces and line\n  // breaks), and the refusal quotes a short one-line cut, as date-parse does.\n  const given = String(expression ?? '');\n  expression = given.replace(/\\s/g, '');\n  if (!/^(?:[+-]*\\d+(?:year|month|day|hour|minute|second)s?)+$/i.test(expression)) {\n    throw new Error(\n      `The expression ${quote(given)} could not be read. Use terms of a sign, a number and a unit, such as \"+ 1 day\" or \"+ 1 year - 3 month\". The units are year, month, day, hour, minute and second.`\n    );\n  }\n  // \"+ {{n}} day\" with a negative n reads \"+-3day\": a run of signs is one sign.\n  expression = expression.replace(/[+-]{2,}/g, (signs) => (signs.split('-').length % 2 === 0 ? '-' : '+'));\n  // === END JARVIS PATCH ===\n"],
    ["  return dayjsDate;\n}",
      "  // === JARVIS PATCH: a result outside the range a date can hold fails ===\n  if (!dayjsDate.isValid()) {\n    throw new Error('The expression moves the date outside the range a date can hold. Use a smaller number.');\n  }\n  // === END JARVIS PATCH ===\n  return dayjsDate;\n}"],
  ],
} as const;

export function applyExpressionPatch(source: string, replacements: readonly (readonly [string, string])[]): string {
  let result = source.replace(/\r\n/g, '\n');
  for (const [before, after] of replacements) {
    if (result.split(before).length !== 2) throw new Error('Expression boundary patch must match exactly once; review upstream changes');
    result = result.replace(before, () => after);
  }
  return result;
}
