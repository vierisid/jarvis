import { spawn } from 'node:child_process'
import { evaluateWorkflowExpression } from '../../../../../../../../runtime/safe-expression'
import { sanitizedEnv } from '../../../../../../../../../util/subprocess-env'
import type { CodeSandbox } from '../../core/code/code-sandbox-common'

const CODE_RUNNER_SCRIPT = `
// Jarvis: the engine that started this step is its only reader. When it is
// gone (killed, out of memory, crashed) the IPC channel closes, and the step
// goes with it rather than running on with init as its parent. The runtime
// also signals the engine's whole process group (spawn.ts), which covers a
// kill; this covers an engine that died by itself.
process.on('disconnect', () => process.exit(1))

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
    const text = String(e.message)
    const m = /Cannot find (?:package|module) '([^']+)'(?: from '([^']*)')?/.exec(text)
    if (!m || m[1].startsWith('.') || m[1].startsWith('/')) return e
    // The requiring file, which decides whether this is really a missing
    // DECLARATION or just a missing file inside a package that IS installed.
    // Two message shapes, and which one you get depends on the runtime: Bun
    // 1.3.x writes "from '<path>'", while Bun 1.4.x and Node write a
    // "Require stack:" block whose first entry is the requiring file. Reading
    // only the first shape made every 1.4.x error look like a missing
    // declaration, because the path was never recovered and both exemptions
    // below are conditional on having it. CI caught this on the first run
    // after the image and CI converged on Bun 1.4.2.
    const stack = /(?:^|\\n)Require stack:\\n[ \\t]*-[ \\t]*(.+)/.exec(text)
    const from = m[2] || (stack ? stack[1].trim() : '')
    if (from && /[\\\\/]node_modules[\\\\/]/.test(from)) return e
    const parts = m[1].split('/')
    const name = m[1].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    if (from && isInstalledAbove(require('path').dirname(from), name)) return e
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

/**
 * Jarvis (#863): the Bun config the CODE child must run with, as argv. The
 * engine is spawned with `--config=<empty file>` (spawnEngine, spawn.ts), and
 * the child gets that same argument. Only that spelling, with a non-empty
 * value, replaces the cwd `bunfig.toml`: `--config <path>`, `-c` and
 * `--config=` all leave it read (measured). With none to forward -- this module
 * run outside a spawned engine, as unit tests do -- POSIX gets `/dev/null`,
 * which Bun reads as an empty config (measured, 1.3.8 and 1.4.2). Windows has
 * no such path, so it refuses rather than run the step with the cwd config.
 */
export function codeChildConfigArgs(execArgv: readonly string[] = process.execArgv, platform: string = process.platform): string[] {
    const own = execArgv.filter(a => a.startsWith('--config='))
    const last = own[own.length - 1]
    if (last !== undefined && last.length > '--config='.length) return [last]
    if (platform !== 'win32') return ['--config=/dev/null']
    throw new Error('CODE step refused: the engine was not started with --config=<empty bunfig>, so the step would read a bunfig.toml from its working directory (#863).')
}

/**
 * Jarvis: what a CODE step's child may take from this machine. A step is
 * granted code, not unlimited resources, and three of them were unbounded.
 *
 * Memory: the child runs with an address-space ceiling (`ulimit -v`, 2 GiB by
 * default; the daemon's `JARVIS_CODE_STEP_MEMORY_MB` reaches the engine as
 * `AP_CODE_STEP_MEMORY_MB` to change it, `0` to remove it). An
 * allocation past it fails inside the step as an out-of-memory error instead of
 * taking the machine's RAM; the step then fails with a plain message. Enforced
 * on Linux. macOS ignores the limit and Windows has no `sh`, so there the step
 * runs without a ceiling (the 10-minute flow timeout still applies).
 *
 * Output: the step's console output is copied into the daemon log only up to
 * 64 KiB per stream, then a single note says how much was left out; the copy
 * kept for a failure message is the last 64 KiB. Wall clock: the flow timeout,
 * unchanged. A step that calls fetch without a timeout waits as long as the
 * peer lets it.
 */
export const CODE_STEP_MEMORY_MB_DEFAULT = 2048
/** One run keeps at most 10 MB of step data (the engine's own cap); a single step result past it can only fail the run. */
export const CODE_STEP_OUTPUT_MAX_MB = 10
export const CODE_STEP_LOG_MIRROR_BYTES = 64 * 1024
export const CODE_STEP_CAPTURE_CHARS = 64 * 1024
const OMITTED_EARLIER = '[earlier output omitted] '

export function codeStepMemoryCeilingMb(env: Record<string, string | undefined> = process.env, platform: string = process.platform): number | null {
    if (platform === 'win32') return null
    const raw = env.AP_CODE_STEP_MEMORY_MB?.trim()
    const mb = raw === undefined || raw === '' || !Number.isFinite(Number(raw)) ? CODE_STEP_MEMORY_MB_DEFAULT : Number(raw)
    return mb >= 1 ? Math.floor(mb) : null
}

/** A step's result as the run would keep it, in bytes. */
export function resultBytes(result: unknown): number {
    return Buffer.byteLength(JSON.stringify(result ?? null))
}

/** What a person reads when a step returned more than a run can hold. */
export function oversizedResultMessage(bytes: number): string {
    const mb = Math.round(bytes / (1024 * 1024) * 10) / 10
    return `This CODE step returned ${mb} MB of data, more than a run can keep (${CODE_STEP_OUTPUT_MAX_MB} MB). Return less from the step, for example a summary or a count instead of every record.`
}

/**
 * `command args` run under `ulimit -v <mb>`; a shell that cannot set the limit runs it anyway. The shell
 * exports its own PWD, OLDPWD and `_`, which the step's sanitized environment must not carry, so they are
 * unset on the way through.
 */
export function withMemoryCeiling(command: string, args: string[], mb: number): [string, string[]] {
    return ['/bin/sh', ['-c', 'ulimit -v "$1" 2>/dev/null; shift; exec env -u PWD -u OLDPWD -u _ "$@"', 'sh', String(mb * 1024), command, ...args]]
}

/** The last CODE_STEP_CAPTURE_CHARS of a stream, marked when something before them was dropped. */
export function keepTail(previous: string, text: string): string {
    const all = previous + text
    return all.length <= CODE_STEP_CAPTURE_CHARS + OMITTED_EARLIER.length ? all : OMITTED_EARLIER + all.slice(-CODE_STEP_CAPTURE_CHARS)
}

/** Copies a stream to the log until its budget is spent, then says once what is being left out. */
export function boundedMirror(write: (line: string) => void, budget: number = CODE_STEP_LOG_MIRROR_BYTES): { push(data: Buffer): void, finish(): void } {
    let shown = 0
    let dropped = 0
    return {
        push(data) {
            const room = budget - shown
            if (room > 0) {
                const part = data.length <= room ? data : data.subarray(0, room)
                shown += part.length
                write(part.toString().trimEnd())
                if (part.length < data.length) {
                    dropped += data.length - part.length
                    write(`[CODE step output is only copied to this log up to ${Math.floor(budget / 1024)} KiB per stream; the rest is not shown]`)
                }
            }
            else dropped += data.length
        },
        finish() {
            if (dropped > 0) write(`[${dropped} bytes of CODE step output were not copied to this log]`)
        },
    }
}

async function runInChildProcess({ codeFilePath, inputs }: { codeFilePath: string, inputs: Record<string, unknown> }): Promise<unknown> {
    return new Promise((resolve, reject) => {
        // Jarvis (#837): `--no-install`, because a step file has no `node_modules`
        // above it unless the daemon installed its declared dependencies there
        // (code-materialize.ts), and with none Bun AUTO-INSTALLS any bare name the
        // code requires: fetches the latest version from the npm registry and runs
        // it. Measured with `is-number`, into an empty install cache. Bun-only:
        // under Node there is no auto-install and the flag would be rejected.
        //
        // Jarvis (#863): and the engine's own `--config=<empty bunfig>`, so a
        // `bunfig.toml` in the cwd this child inherits is never read: its
        // `preload` would run before the step, as code nothing pins. And
        // `--no-env-file`, so a `.env` there cannot add variables to the
        // sanitized env below (a proxy for every request the step makes).
        const args = process.versions.bun ? [...codeChildConfigArgs(), '--no-env-file', '--no-install', '--eval', CODE_RUNNER_SCRIPT] : ['--eval', CODE_RUNNER_SCRIPT]
        // Jarvis: the memory ceiling, and failure messages that say so.
        const memoryMb = codeStepMemoryCeilingMb()
        const [command, spawnArgs] = memoryMb === null ? [process.execPath, args] : withMemoryCeiling(process.execPath, args, memoryMb)
        const buildError = (parts: { message: string | undefined, stdout: string, stderr: string }): Error => buildCodeError({ ...parts, memoryMb })
        const child = spawn(command, spawnArgs, {
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
        // Jarvis: a step that prints without end must not fill the daemon log or this process's memory.
        const mirrorStdout = boundedMirror((line) => console.log(line))
        const mirrorStderr = boundedMirror((line) => console.error(line))

        child.stdout?.on('data', (data: Buffer) => {
            capturedStdout = keepTail(capturedStdout, data.toString())
            mirrorStdout.push(data)
        })

        child.stderr?.on('data', (data: Buffer) => {
            capturedStderr = keepTail(capturedStderr, data.toString())
            mirrorStderr.push(data)
        })
        child.on('close', () => { mirrorStdout.finish(); mirrorStderr.finish() })

        let settled = false

        child.on('message', (msg: { success: boolean, result?: unknown, error?: string }) => {
            if (settled) return
            settled = true
            if (msg.success) {
                // Jarvis: a result past the run's data cap would end the whole run with an engine code; say it here, at the step.
                const bytes = resultBytes(msg.result)
                if (bytes > CODE_STEP_OUTPUT_MAX_MB * 1024 * 1024) reject(new Error(oversizedResultMessage(bytes)))
                else resolve(msg.result)
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

function buildCodeError({ message, stdout, stderr, memoryMb }: { message: string | undefined, stdout: string, stderr: string, memoryMb: number | null }): Error {
    const parts: string[] = [message ?? 'Code execution failed']
    // Jarvis: an allocation past the ceiling reads as the machine's own words ("Out of memory", a signal); say what happened.
    if (memoryMb !== null && /out of memory|ENOMEM|allocation failed|SIGABRT|SIGKILL|SIGSEGV/i.test(`${message ?? ''}\n${stderr}`)) {
        parts.unshift(`This CODE step ran out of memory: a step may use up to ${memoryMb} MB. Process less data at a time, or ask the person who runs Jarvis to raise JARVIS_CODE_STEP_MEMORY_MB. `)
    }
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
