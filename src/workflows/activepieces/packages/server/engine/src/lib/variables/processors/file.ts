import { ApFile } from '@activepieces/pieces-framework'
import { isBase64, isNil, isString } from '@activepieces/shared'
import mime from 'mime-types'
import { ProcessorFn } from './types'
import axios from 'axios'
// Jarvis (#961): a file URL is fetched through the HTTP step's egress guard.
import { EgressRefusedError, MAX_RESPONSE_BYTES, egressPolicyFromEnv, egressRefusalIn, guardedFileDownload } from '../../../../../../../../runtime/http-egress'

export const fileProcessor: ProcessorFn = async (_property, rawValue, fileContext) => {
    // === JARVIS PATCH (file chaining): one place that accepts every file shape ===
    // A file field takes what Jarvis's own steps produce: the bare step-file
    // path, the { fileName, url } object Create file returns, a data URL, or a
    // { filename, base64 } object. Anything else fails the step in plain words
    // rather than as "required input is missing".
    const shaped = jarvisFileShape(rawValue)
    if (shaped === null) {
        return null
    }
    if (typeof shaped !== 'string') {
        return shaped
    }
    const urlOrBase64 = shaped
    // === END JARVIS PATCH ===
    try {
        const file = handleBase64File(urlOrBase64)
        if (!isNil(file)) {
            return file
        }
        return await handleUrlFile(urlOrBase64, fileContext)
    }
    catch (e) {
        // Jarvis (#961): a refused address fails the step naming the rule.
        const refused = egressRefusalIn(e)
        if (refused) throw refused
        console.error(e)
        return null
    }
}

// === JARVIS PATCH (file chaining) ===
const NOT_A_FILE = 'This field needs a file from an earlier step, such as the output of Create file.'
const MAX_FILE_MESSAGE = 'This file is too large for a step to carry (the limit is about 7 MiB).'
const STEP_FILE_PATH = /^\/v1\/step-files\/[A-Za-z0-9_-]+$/

function describeGot(value: unknown): string {
    if (typeof value === 'string') return 'text'
    if (typeof value === 'number') return 'a number'
    if (typeof value === 'boolean') return 'true or false'
    if (Array.isArray(value)) return 'a list'
    return 'something that is not a file'
}

function notAFile(value: unknown): Error {
    return new Error(NOT_A_FILE + ' It got ' + describeGot(value) + ' instead.')
}

/** Decodes base64 held to the download cap; never echoes the value. */
function decodeBase64(text: string): Buffer {
    const encoded = text.replace(/\s+/g, '')
    // base64 carries 3 bytes in 4 characters
    if (encoded.length > Math.ceil(MAX_RESPONSE_BYTES / 3) * 4) throw new Error(MAX_FILE_MESSAGE)
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('The base64 text in this field is not valid base64.')
    return Buffer.from(encoded, 'base64')
}

/**
 * A data URL is decoded here, whatever its media type or parameters, so it
 * never reaches the URL download (which would refuse it as an unlisted host).
 */
function dataUrlFile(value: string): ApFile {
    if (value.length > Math.ceil(MAX_RESPONSE_BYTES / 3) * 4 + 256) throw new Error(MAX_FILE_MESSAGE)
    const comma = value.indexOf(',')
    const params = comma === -1 ? [] : value.slice('data:'.length, comma).split(';')
    if (comma === -1 || !params.slice(1).some((p) => p.trim().toLowerCase() === 'base64')) {
        throw new Error('A data URL in a file field must be base64 (data:<type>;base64,...).')
    }
    const extension = mime.extension(params[0].trim()) || 'bin'
    return new ApFile('unknown.' + extension, decodeBase64(value.slice(comma + 1)), extension)
}

/** A string that names a file: a step-file path, an http(s) URL or a data URL. */
function stringFileShape(value: string): string | ApFile | null {
    if (value.trim() === '') return null
    // Judged exactly as given: a padded or newline-ended path is not a step
    // file, so it never earns the engine credential.
    if (value.startsWith('data:')) return dataUrlFile(value)
    if (STEP_FILE_PATH.test(value) || /^https?:\/\/\S+$/i.test(value)) return value
    throw notAFile(value)
}

function jarvisFileShape(value: unknown): string | ApFile | null {
    if (isNil(value)) return null
    if (isString(value)) return stringFileShape(value)
    if (typeof value !== 'object' || Array.isArray(value)) throw notAFile(value)
    const record = value as Record<string, unknown>
    // Create file returns { fileName, url }.
    if (isString(record.url) && record.url.trim() !== '') return stringFileShape(record.url)
    const name = [record.filename, record.fileName, record.name].find((n): n is string => isString(n) && n.trim() !== '')
    if (isString(record.base64) && name !== undefined) {
        const data = decodeBase64(record.base64.replace(/^data:[^,]*;base64,/, ''))
        const extension = name.includes('.') ? name.split('.').pop() : undefined
        return new ApFile(name, data, extension)
    }
    throw new Error(NOT_A_FILE + ' It got an object with no file in it instead.')
}
// === END JARVIS PATCH ===

function handleBase64File(propertyValue: string): ApFile | null {
    if (!isBase64(propertyValue, { allowMime: true })) {
        return null
    }
    const matches = propertyValue.match(/^data:([A-Za-z-+/]+);base64,(.+)$/) // example match: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAQMAAAAlPW0iAAAABlBMVEUAAAD///+l2Z/dAAAAM0lEQVR4nGP4/5/h/1+G/58ZDrAz3D/McH8yw83NDDeNGe4Ug9C9zwz3gVLMDA/A6P9/AFGGFyjOXZtQAAAAAElFTkSuQmCC
    if (!matches || matches?.length !== 3) {
        return null
    }
    const base64 = matches[2]
    const extension = mime.extension(matches[1]) || 'bin'
    return new ApFile(
        `unknown.${extension}`,
        Buffer.from(base64, 'base64'),
        extension,
    )
}

async function handleUrlFile(path: string, context?: { apiUrl: string; engineToken: string }): Promise<ApFile | null> {
    // Only a stored-file path receives the engine credential, never a caller URL.
    const stored = /^\/v1\/step-files\/[A-Za-z0-9_-]+$/.test(path)
    if (stored && !context) throw new Error('Stored file requires the workflow context')
    const url = stored ? new URL(path.slice(1), context!.apiUrl).toString() : path
    let data: Buffer
    let header: (name: string) => string | null
    if (stored) {
        const response = await fetch(url, { headers: { Authorization: 'Bearer ' + context!.engineToken }, redirect: 'error' })
        if (!response.ok) throw new Error('File download failed: ' + response.status)
        data = Buffer.from(await response.arrayBuffer())
        header = (name) => response.headers.get(name)
    } else {
        // Caller URLs retain main's checked DNS, connection and redirect policy.
        // Jarvis (#1153): a file field is fetched while the step's props are
        // resolved, before Authority is asked, so it reaches only the hosts on
        // the flow's read list, redirects included.
        if (!context) throw new EgressRefusedError('File download refused: there is no workflow to check its read list against')
        let hosts: unknown
        let status = 'unreachable'
        try {
            const list = await fetch(new URL('v1/jarvis/read-hosts', context.apiUrl).toString(), { headers: { Authorization: 'Bearer ' + context.engineToken }, redirect: 'error' })
            status = String(list.status)
            hosts = list.ok ? ((await list.json()) as { hosts?: unknown }).hosts : undefined
        }
        catch { hosts = undefined }
        if (!Array.isArray(hosts) || !hosts.every((h) => typeof h === 'string')) throw new EgressRefusedError('File download refused: the workflow read list could not be read (' + status + ')')
        const response = await guardedFileDownload(axios, path, egressPolicyFromEnv(), { readHosts: hosts as string[] })
        data = response.data
        header = (name) => typeof response.headers[name] === 'string' ? response.headers[name] : null
    }
    const filename = getFileName(url, header('content-disposition'), header('content-type') ?? undefined) ?? 'unknown'
    const extension = filename.split('.').length > 1 ? filename.split('.').pop() : undefined

    return new ApFile(
        filename,
        data,
        extension,
    )
}


function getFileName(path: string, disposition: string | null, mimeType: string | undefined): string | null {
    const url = new URL(path)
    if (isNil(disposition)) {
        const fileNameFromUrl = url.pathname.includes('/') && url.pathname.split('/').pop()?.includes('.') ? url.pathname.split('/').pop() : null
        if (!isNil(fileNameFromUrl)) {
            return fileNameFromUrl
        }
        const resolvedExtension = mimeType ? mime.extension(mimeType) : null
        return `unknown.${resolvedExtension ?? 'bin'}`
    }
    const utf8FilenameRegex = /filename\*=UTF-8''([\w%\-.]+)(?:; ?|$)/i
    if (utf8FilenameRegex.test(disposition)) {
        const result = utf8FilenameRegex.exec(disposition)
        if (result && result.length > 1) {
            return decodeURIComponent(result[1])
        }
    }
    // prevent ReDos attacks by anchoring the ascii regex to string start and
    // slicing off everything before 'filename='
    const filenameStart = disposition.toLowerCase().indexOf('filename=')
    const asciiFilenameRegex = /^filename=(["']?)(.*?[^\\])\1(?:; ?|$)/i

    if (filenameStart >= 0) {
        const partialDisposition = disposition.slice(filenameStart)
        const matches = asciiFilenameRegex.exec(partialDisposition)
        if (matches != null && matches[2]) {
            return matches[2]
        }
    }
    return null
}