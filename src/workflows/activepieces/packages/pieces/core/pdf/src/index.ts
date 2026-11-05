import { createPiece, PieceAuth } from '@activepieces/pieces-framework';
import { PieceCategory } from '@activepieces/shared';
import { extractText } from './lib/actions/extract-text';
import { textToPdf } from './lib/actions/text-to-pdf';
import { imageToPdf } from './lib/actions/image-to-pdf';
import { pdfPageCount } from './lib/actions/pdf-page-count';
import { extractPdfPages } from './lib/actions/extract-pdf-pages';
import { mergePdfs } from './lib/actions/merge-pdfs';
import { addTextToPdf } from './lib/actions/add-text-to-pdf';

export const PDF = createPiece({
  displayName: 'PDF',
  auth: PieceAuth.None(),
  minimumSupportedRelease: '0.34.2',
  logoUrl: 'https://cdn.activepieces.com/pieces/pdf.svg',
  authors: [
    'nyamkamunhjin',
    'abuaboud',
    'AbdulTheActivepiecer',
    'jmgb27',
    'danielpoonwj',
    'bertrandong',
  ],
  categories: [PieceCategory.CORE],
  actions: [
    extractText,
    // Jarvis (#961): "Convert to Image" is not loaded; it runs pdftoppm in a
    // shell outside the run (see lib/actions/convert-to-image.ts).
    textToPdf,
    imageToPdf,
    pdfPageCount,
    extractPdfPages,
    mergePdfs,
    addTextToPdf
  ],
  triggers: [],
});
