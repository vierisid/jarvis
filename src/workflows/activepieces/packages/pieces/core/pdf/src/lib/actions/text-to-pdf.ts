import { createAction, Property } from '@activepieces/pieces-framework';
import { PDFDocument, PDFFont, StandardFonts } from 'pdf-lib';

// === JARVIS PATCH (F-18): characters the PDF font cannot show ===
// The built-in PDF fonts cover Western European text only. An emoji or Chinese
// or Japanese text used to fail with "WinAnsi cannot encode ..." from the PDF
// library. Now it fails in plain words, or, when the author opts in, each such
// character is printed as "?".
function unsupportedCharacters(font: PDFFont, text: string): string[] {
  const supported = new Set(font.getCharacterSet());
  return Array.from(new Set(Array.from(text).filter((ch) => !supported.has(ch.codePointAt(0)!))));
}
// Up to five of them, on one line: a control, format or combining character
// (a line break, a bidi override, an emoji joiner) is shown as its U+ code.
function describeCharacters(chars: string[]): string {
  const shown = chars.slice(0, 5).map((ch) => /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(ch) ? `"${ch}"` : `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
  return chars.length > 5 ? `${shown.join(', ')} and ${chars.length - 5} more` : shown.join(', ');
}
// A mark, joiner, variation selector or skin tone that belongs to a character
// already printed as ? is dropped rather than printed as another ?.
function replaceCharacters(text: string, bad: Set<string>): string {
  return Array.from(text).map((ch) => (!bad.has(ch) ? ch : /^[\p{M}\p{Cf}\p{Emoji_Modifier}]$/u.test(ch) ? '' : '?')).join('');
}
// === END JARVIS PATCH ===

export const textToPdf = createAction({
  name: 'textToPdf',
  displayName: 'Text to PDF',
  description: 'Convert text to PDF',
  props: {
    text: Property.LongText({
      displayName: 'text',
      description: 'Enter text to convert',
      required: true,
    }),
    // Jarvis (F-18)
    replaceUnsupportedCharacters: Property.Checkbox({
      displayName: 'Replace characters the PDF cannot show',
      description:
        'The PDF font shows Western European text only, not emoji, Chinese, Japanese or other scripts. Off: the step fails on such a character. On: each one is printed as a ?.',
      required: false,
      defaultValue: false,
    }),
  },
  errorHandlingOptions: {
    continueOnFailure: {
      defaultValue: false,
    },
    retryOnFailure: {
      hide: true,
    },
  },
  async run(context) {
    // Jarvis (F-18): line breaks and tabs the font cannot draw become plain ones,
    // and an accent typed as a separate mark is joined to its letter.
    let text = context.propsValue.text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');

    const pageSize: [number, number] = [595, 842]; // Standard A4 size
    const margin = 50;
    const topMargin = 70;
    const fontSize = 12;
    const lineSpacing = 5;
    const paragraphSpacing = 8;
    const fontType: StandardFonts = StandardFonts.Helvetica;

    try {
      const pdfDoc = await PDFDocument.create();
      let page = pdfDoc.addPage(pageSize);
      const { width, height } = page.getSize();

      const font = await pdfDoc.embedFont(fontType);

      // Jarvis (F-18)
      const unsupported = unsupportedCharacters(font, text.replace(/\n/g, ''));
      if (unsupported.length > 0) {
        if (!context.propsValue.replaceUnsupportedCharacters) {
          throw new Error(
            `The PDF font cannot show some characters (found ${describeCharacters(unsupported)}): it shows Western European text only, not emoji, Chinese, Japanese or other scripts. Remove them, or turn on "Replace characters the PDF cannot show" to print a ? in their place.`
          );
        }
        text = replaceCharacters(text, new Set(unsupported));
      }

      const lineHeight = font.heightAtSize(fontSize) + lineSpacing;
      const maxWidth = width - margin * 2;

      const paragraphs = text.split('\n');
      let yPosition = height - topMargin;

      paragraphs.forEach((paragraph) => {
        const words = paragraph.split(' ');
        let line = '';

        words.forEach((word) => {
          const testLine = line + word + ' ';
          const testLineWidth = font.widthOfTextAtSize(testLine, fontSize);

          if (testLineWidth > maxWidth) {
            page.drawText(line.trim(), {
              x: margin,
              y: yPosition,
              size: fontSize,
              font,
            });
            line = word + ' ';
            yPosition -= lineHeight;

            if (yPosition < margin + lineHeight) {
              page = pdfDoc.addPage(pageSize);
              yPosition = height - topMargin;
            }
          } else {
            line = testLine;
          }
        });

        if (line.trim()) {
          page.drawText(line.trim(), {
            x: margin,
            y: yPosition,
            size: fontSize,
            font,
          });
          yPosition -= lineHeight;
        }

        yPosition -= paragraphSpacing;

        if (yPosition < margin + lineHeight) {
          page = pdfDoc.addPage(pageSize);
          yPosition = height - topMargin;
        }
      });

      const pdfBytes = await pdfDoc.save();
      const base64Pdf = Buffer.from(pdfBytes).toString('base64');

      return context.files.write({
        data: Buffer.from(base64Pdf, 'base64'),
        fileName: 'text.pdf',
      });
    } catch (error) {
      throw new Error(`Failed to convert text to PDF: ${(error as Error).message}`);
    }
  },
});
