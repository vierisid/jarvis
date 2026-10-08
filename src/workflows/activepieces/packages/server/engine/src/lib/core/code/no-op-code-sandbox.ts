import { spawn } from 'node:child_process'
import { evaluateWorkflowExpression } from '../../../../../../../../runtime/safe-expression'
import { sanitizedEnv } from '../../../../../../../../../util/subprocess-env'
import type { CodeSandbox } from '../../core/code/code-sandbox-common'

const CODE_RUNNER_SCRIPT = `
process.once('message', async function(msg) {
    let settled = false

    const inspect = require('util').inspect

    process.on('unhandledRejection', (reason) => {
        if (settled) return
        settled = true
        process.send({ success: false, error: inspect(undeclaredPackageError(reason)) }, () => process.exit(1))
    })

    process.on('uncaughtException', (err) => {
        if (settled) return
        settled = true
        process.send({ success: false, error: inspect(undeclaredPackageError(err)) }, () => process.exit(1))
    })

    try {
        const mod = require(msg.codeFilePath)
        const result = await mod.code(msg.inputs)

        // Yield to the event loop so unhandledRejection fires before we send success
        await new Promise(resolve => setImmediate(resolve))

        if (settled) return
        settled = true
        process.send({ success: true, result: JSON.parse(JSON.stringify(result ?? null)) }, () => process.exit(0))
    } catch(e) {
        if (settled) return
        settled = true
        process.send({ success: false, error: inspect(undeclaredPackageError(e)) }, () => process.exit(0))
    }
})

// Jarvis (#837): with auto-install off, a bare name the step did not declare is
// a MODULE_NOT_FOUND. Say which package and what to do, instead of leaving the
// author to guess that the registry was never consulted. Only for a require made
// by the step itself, and only for a package that is not installed where the
// step would find it: one made from inside an installed package, or a missing
// file inside an installed package, is not a missing declaration. The original
// error is kept either way.
function undeclaredPackageError(e) {
    if (!e || (e.code !== 'MODULE_NOT_FOUND' && e.code !== 'ERR_MODULE_NOT_FOUND')) return e
    const m = /Cannot find (?:package|module) '([^']+)'(?: from '([^']*)')?/.exec(String(e.message))
    if (!m || m[1].startsWith('.') || m[1].startsWith('/')) return e
    if (m[2] && /[\\\\/]node_modules[\\\\/]/.test(m[2])) return e
    const parts = m[1].split('/')
    const name = m[1].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    if (m[2] && isInstalledAbove(require('path').dirname(m[2]), name)) return e
    const err = new Error('CODE step requires package "' + name + '", which its package.json does not declare. ' +
        'Add it to "dependencies" in the package.json of the step; packages are never fetched from the registry at run time. (' +
        String(e.message) + ')')
    err.code = e.code
    return err
}

function isInstalledAbove(dir, name) {
    const path = require('path')
    const fs = require('fs')
    for (let d = dir; ; d = path.dirname(d)) {
        if (fs.existsSync(path.join(d, 'node_modules', name))) return true
        if (path.dirname(d) === d) return false
    }
}
`

async function runInChildProcess({ codeFilePath, inputs }: { codeFilePath: string, inputs: Record<string, unknown> }): Promise<unknown> {
    return new Promise((resolve, reject) => {
        // Jarvis (#837): `--no-install`, because a step file has no `node_modules`
        // above it unless the daemon installed its declared dependencies there
        // (code-materialize.ts), and with none Bun AUTO-INSTALLS any bare name the
        // code requires: fetches the latest version from the npm registry and runs
        // it. Measured with `is-number`, into an empty install cache. Bun-only:
        // under Node there is no auto-install and the flag would be rejected.
        const args = process.versions.bun ? ['--no-install', '--eval', CODE_RUNNER_SCRIPT] : ['--eval', CODE_RUNNER_SCRIPT]
        const child = spawn(process.execPath, args, {
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            // Jarvis: this child runs a CODE step, i.e. workflow-authored code.
            // Inheriting would hand it the engine's own env: SANDBOX_ID (what
            // the daemon's worker RPC accepts an engine connection on), the WS
            // port, and the reaper's JARVIS_ENGINE_* markers. This is env
            // hygiene, not isolation: at the same uid the child can still read
            // /proc/<engine pid>/environ, and up the parent chain the daemon's
            // /proc/<pid>/environ, which holds every secret it started with.
            env: sanitizedEnv(),
        })

        let capturedStdout = ''
        let capturedStderr = ''

        child.stdout?.on('data', (data: Buffer) => {
            const text = data.toString()
            capturedStdout += text
            console.log(text.trimEnd())
        })

        child.stderr?.on('data', (data: Buffer) => {
            const text = data.toString()
            capturedStderr += text
            console.error(text.trimEnd())
        })

        let settled = false

        child.on('message', (msg: { success: boolean, result?: unknown, error?: string }) => {
            if (settled) return
            settled = true
            if (msg.success) {
                resolve(msg.result)
            }
            else {
                reject(buildError({ message: msg.error, stdout: capturedStdout, stderr: capturedStderr }))
            }
        })

        child.on('close', (code, signal) => {
            if (settled) return
            settled = true
            reject(buildError({ message: `Code process exited with code ${code} and signal ${signal}`, stdout: capturedStdout, stderr: capturedStderr }))
        })

        child.on('error', (error) => {
            if (settled) return
            settled = true
            reject(buildError({ message: error.message, stdout: capturedStdout, stderr: capturedStderr }))
        })

        child.send({ codeFilePath, inputs })
    })
}

function buildError({ message, stdout, stderr }: { message: string | undefined, stdout: string, stderr: string }): Error {
    const parts: string[] = [message ?? 'Code execution failed']
    if (stdout.trim()) {
        parts.push(`\n--- stdout ---\n${stdout.trim()}`)
    }
    if (stderr.trim()) {
        parts.push(`\n--- stderr ---\n${stderr.trim()}`)
    }
    return new Error(parts.join(''))
}

export const noOpCodeSandbox: CodeSandbox = {
    async runCodeModule({ codeFilePath, inputs }) {
        return runInChildProcess({ codeFilePath, inputs })
    },

    async runScript({ script, scriptContext }) {
        // Jarvis: expressions may read data, never execute arbitrary code or callbacks.
        return evaluateWorkflowExpression(script, scriptContext)
    },
}
