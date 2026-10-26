/** Exact replacements fail a vendor sync if the supported expression boundary drifts. */
export const expressionPatches = {
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
      "import axios from 'axios';\n// Jarvis (#961): the egress guard and the one method rule the daemon judges by.\nimport { egressGuardedAxios, egressPolicyFromEnv, egressRefusalIn } from '../../../../../../../../runtime/http-egress';\nimport { httpRequestIsRead } from '../../../../../../../../runtime/piece-effects';"],
    ["    const apiRequest = async () => {\n      if (use_proxy) {\n        const proxySettings = context.propsValue.proxy_settings;\n        assertNotNullOrUndefined(proxySettings, 'Proxy Settings');\n        assertNotNullOrUndefined(proxySettings['proxy_host'], 'Proxy Host');\n        assertNotNullOrUndefined(proxySettings['proxy_port'], 'Proxy Port');\n        let proxyUrl;\n\n        if (proxySettings.proxy_username && proxySettings.proxy_password) {\n          proxyUrl = `http://${proxySettings.proxy_username}:${proxySettings.proxy_password}@${proxySettings.proxy_host}:${proxySettings.proxy_port}`;\n        } else {\n          proxyUrl = `http://${proxySettings.proxy_host}:${proxySettings.proxy_port}`;\n        }\n\n        const httpsAgent = new HttpsProxyAgent(proxyUrl);\n        const axiosClient = axios.create({\n          httpsAgent,\n        });\n\n        return await httpClient.sendRequest(request, axiosClient);\n      }\n      return await httpClient.sendRequest(request);\n    };\n\n    let attempts = 0;\n\n    while (attempts < 3) {",
      "    // === JARVIS PATCH (#961): every connection passes the egress guard ===\n    // Each hop is resolved once, checked against this install's policy and\n    // connected to at the checked address (runtime/http-egress.ts). A proxy\n    // would pick the address itself, so the step refuses one rather than run\n    // unguarded.\n    const apiRequest = async () => {\n      if (use_proxy) {\n        throw new Error('Jarvis does not send HTTP steps through a proxy: the address check would not apply. Turn off \"Use Proxy\".');\n      }\n      return await httpClient.sendRequest(request, egressGuardedAxios(axios, egressPolicyFromEnv(), { read: httpRequestIsRead({ method, body }) }) as never);\n    };\n\n    let attempts = 0;\n    // Only a read (a GET or HEAD with no body) is tried again by the step\n    // itself. Anything else may have reached the server whatever the error\n    // says, so it is sent\n    // once (Q-07); \"Retry on ...\" still decides whether a 5xx or 4xx fails the\n    // step or continues it.\n    const maxAttempts = httpRequestIsRead({ method, body }) ? 3 : 1;\n    // === END JARVIS PATCH ===\n\n    while (attempts < maxAttempts) {"],
    ["      } catch (error) {\n        attempts++;\n",
      "      } catch (error) {\n        // Jarvis (#961): a refused address fails the step as itself; it is\n        // never retried or continued past as if the server had answered.\n        const refused = egressRefusalIn(error);\n        if (refused) throw refused;\n        attempts++;\n"],
    ["          case 'retry_all': {\n            if (attempts < 3) continue;",
      "          case 'retry_all': {\n            if (attempts < maxAttempts) continue;"],
    ["              if (attempts < 3) continue;\n              throw error; // after 3 tries, throw",
      "              if (attempts < maxAttempts) continue;\n              throw error; // after 3 tries, throw"],
    ["            if (attempts < 3) continue;\n            throw error;\n          case 'continue_none':",
      "            if (attempts < maxAttempts) continue;\n            throw error;\n          case 'continue_none':"],
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
  ],
  'packages/server/engine/src/lib/helper/trigger-helper.ts': [
    ["import { isValidCron } from 'cron-validator'", "import { validateCronExpression } from '../../../../../../../../lib/cron-scheduler'"],
    ['                if (!isValidCron(request.cronExpression)) {', '                try {\n                    validateCronExpression(request.cronExpression)\n                } catch {'],
    // Keep invoice stored-file transport and polling patches on vendor refresh.
    ["                await pieceTrigger.onEnable(context)\n                return {\n                    listeners: appListeners,\n                    scheduleOptions: pieceTrigger.type === TriggerStrategy.POLLING ? scheduleOptions : undefined,\n                }\n            }\n            case TriggerHookType.RENEW: {\n", "                await pieceTrigger.onEnable(context)\n                return {\n                    listeners: appListeners,\n                    // Community polling triggers may rely on the host's default cadence.\n                    // Preserve explicit schedules; never leave an enabled poller inert.\n                    scheduleOptions: pieceTrigger.type === TriggerStrategy.POLLING ? scheduleOptions ?? {\n                        type: TriggerSourceScheduleType.CRON_EXPRESSION,\n                        cronExpression: '* * * * *',\n                        timezone: 'UTC',\n                    } : undefined,\n                }\n            }\n            case TriggerHookType.RENEW: {\n"],
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
    ["\n        stepOutput.input = censoredInput\n\n        const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators(resolvedInput, pieceAction.props, piece.auth, pieceAction.requireAuth, action.settings.propertySettings)\n        if (Object.keys(errors).length > 0) {\n            throw new Error(JSON.stringify(errors, null, 2))\n        }\n", "\n        stepOutput.input = censoredInput\n\n        const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators(resolvedInput, pieceAction.props, piece.auth, pieceAction.requireAuth, action.settings.propertySettings, { apiUrl: constants.internalApiUrl, engineToken: constants.engineToken })\n        if (Object.keys(errors).length > 0) {\n            throw new Error(JSON.stringify(errors, null, 2))\n        }\n"],
  ],
  "packages/server/engine/src/lib/variables/processors/types.ts": [
    ["export type ProcessorFn<INPUT = any, OUTPUT = any> = (\n    property: PieceProperty,\n    value: INPUT,\n) => OUTPUT\n", "export type ProcessorFn<INPUT = any, OUTPUT = any> = (\n    property: PieceProperty,\n    value: INPUT,\n    fileContext?: { apiUrl: string; engineToken: string },\n) => OUTPUT\n"],
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
