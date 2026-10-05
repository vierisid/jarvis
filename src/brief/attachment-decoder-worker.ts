import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { ATTACHMENT_LIMITS as limits } from './attachment-contracts';

/** No paths, URLs, scripts, OCR, actions or model calls are accepted by this worker. */
self.onmessage = async (event: MessageEvent<{ bytes: Uint8Array; mediaType: string }>) => {
  try {
    const bytes = Buffer.from(event.data.bytes), mediaType = event.data.mediaType;
    let text: string | null = null;
    if (mediaType === 'image/png') {
      if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') throw Error();
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      // pngjs's interlaced inflater has no output bound; refuse that format.
      if (!width || !height || width * height > limits.imagePixels || bytes[28] !== 0) throw Error();
      PNG.sync.read(bytes, { checkCRC: true });
    } else if (mediaType === 'image/jpeg') {
      if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw Error();
      jpeg.decode(bytes, { maxResolutionInMP: limits.imagePixels / 1_000_000, maxMemoryUsageInMB: 96, tolerantDecoding: false });
    } else if (mediaType === 'application/pdf') {
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw Error();
      const { getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(bytes), {
        useSystemFonts: false, disableFontFace: true,
        useWorkerFetch: false, stopAtErrors: true, verbosity: 0,
      });
      try {
        if (pdf.numPages > limits.pdfPages) throw Error();
        text = '';
        for (let page = 1; page <= pdf.numPages; page++) {
          const content = await (await pdf.getPage(page)).getTextContent();
          for (const item of content.items) if ('str' in item) {
            text += item.str + ('hasEOL' in item && item.hasEOL ? '\n' : ' ');
            if (text.length > limits.textChars) throw Error();
          }
          text += '\n';
        }
        if (!text.trim()) throw Error(); // No invented OCR for scanned-only PDFs.
      } finally { await pdf.loadingTask.destroy(); }
    } else {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!text.trim() || text.length > limits.textChars || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw Error();
    }
    self.postMessage({ ok: true, text });
  } catch { self.postMessage({ ok: false }); }
};
