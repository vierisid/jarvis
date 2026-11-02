import { ApFile } from '@activepieces/pieces-framework'
import { isBase64, isNil, isString } from '@activepieces/shared'
import mime from 'mime-types'
import { ProcessorFn } from './types'
import axios from 'axios'
// Jarvis (#961): a file URL is fetched through the HTTP step's egress guard.
import { egressPolicyFromEnv, egressRefusalIn, guardedFileDownload } from '../../../../../../../../runtime/http-egress'

export const fileProcessor: ProcessorFn = async (_property, urlOrBase64, fileContext) => {
    if (isNil(urlOrBase64) || !isString(urlOrBase64)) {
        return null
    }
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
        const response = await guardedFileDownload(axios, path, egressPolicyFromEnv())
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