import { createAction, Property } from '@activepieces/pieces-framework';
import { PDFDocument, rgb, StandardFonts, PDFFont, degrees } from 'pdf-lib';

// === JARVIS PATCH (F-18): characters the PDF font cannot show ===
// Up to five of them, on one line: a control, format or combining character
// (a line break, a bidi override, an emoji joiner) is shown as its U+ code.
function describeCharacters(chars: string[]): string {
  const shown = chars.slice(0, 5).map((ch) => /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(ch) ? `"${ch}"` : `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
  return chars.length > 5 ? `${shown.join(', ')} and ${chars.length - 5} more` : shown.join(', ');
}
// === END JARVIS PATCH ===

const fontOptions = Object.entries(StandardFonts).map(([key, value]) => {
  const formattedLabel = key.replace(/([A-Z])/g, ' $1').trim();
  return { label: formattedLabel, value: value };
});

export const addTextToPdf = createAction({
  name: 'addTextToPdf',
  displayName: 'Add Text to PDF',
  description: 'Stamps one or more text strings at exact pixel distances from the top-left corner.',
  props: {
    file: Property.File({
      displayName: 'PDF File or URL',
      required: true,
    }),
    textItems: Property.Array({
      displayName: 'Text Items to Insert',
      description: 'Add each piece of text you want to stamp.',
      required: true,
      properties: {
        text: Property.LongText({
          displayName: 'Text',
          required: true,
        }),
        applyToAllPages: Property.Checkbox({
          displayName: 'Apply to all pages?',
          description: 'If checked, this text is stamped on every page.',
          required: false,
          defaultValue: false,
        }),
        pageNumber: Property.Number({
          displayName: 'Page Number',
          description: 'Which page to stamp? (Leave blank or ignore if applying to all pages)',
          required: false,
					defaultValue: 1,
        }),
        distanceFromLeft: Property.Number({
          displayName: 'Distance from Left Edge (in pixels)',
					description: '0 is the far left edge of the page. Standard A4 width is about 595 pts.',
          required: true,
        }),
        distanceFromTop: Property.Number({
          displayName: 'Distance from Top Edge (in pixels)',
					description: '0 is the very top edge of the page. Standard A4 height is about 842 pts.',
          required: true,
        }),
        font: Property.StaticDropdown({
          displayName: 'Font',
          description: 'Select the exact font variant for this text item.',
          required: true,
          defaultValue: StandardFonts.Helvetica,
          options: {
            options: fontOptions,
          },
        }),
        fontSize: Property.Number({
          displayName: 'Font Size',
          // Jarvis (F-18): optional; 11 when left empty (see run).
          required: false,
          defaultValue: 11,
        }),
        lineSpacing: Property.Number({
          displayName: 'Line Spacing',
          description: 'The vertical spacing multiplier between lines. (Examples: 1.0 = Single, 1.15 = Standard, 2.0 = Double)',
          required: false,
          defaultValue: 1.15,
        }),
      },
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
    try {
      const file = context.propsValue.file;
      const textItems = context.propsValue.textItems as Array<{
        text: string;
        applyToAllPages?: boolean;
        pageNumber?: number;
        distanceFromLeft: number;
        distanceFromTop: number;
        font: StandardFonts;
        fontSize?: number;
        lineSpacing?: number;
      }>;

      const pdfDoc = await PDFDocument.load(file.data as any); 
      const pages = pdfDoc.getPages();
      const totalPages = pages.length;

      const embeddedFonts: Record<string, PDFFont> = {};

      for (const item of textItems) {
				// Jarvis (F-18): an accent typed as a separate mark is joined to its letter, and a tab becomes spaces.
				const cleanText = item.text.normalize('NFC').replace(/\r\n|\r/g, '\n').replace(/\t/g, '    ');
        const lines = cleanText.split('\n');
        // Jarvis (F-18): the sample quoted in an error stays on one line and never splits a character.
        const cleanTextSample = Array.from(cleanText).slice(0, 15).join('').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ');
        const lineSpacing = item.lineSpacing ?? 1.15;
        // Jarvis (F-18): the Font Size is not required; it is 11 when left empty, as its default says.
        const fontSize = item.fontSize ?? 11;

        if (lineSpacing <= 0) {
          throw new Error(
            `Line Spacing must be a positive number greater than 0. You provided ${lineSpacing} for text "${cleanTextSample}..."`
          );
        }

				if (fontSize <= 0) {
					throw new Error(
						`Font Size must be a positive number greater than 0. You provided ${fontSize} for text "${cleanTextSample}..."`
					);
				}

        const actualLineHeight = fontSize * lineSpacing;

        const fontEnum = item.font;
        if (!embeddedFonts[fontEnum]) {
          embeddedFonts[fontEnum] = await pdfDoc.embedFont(fontEnum);
        }
        const font = embeddedFonts[fontEnum];

        // Jarvis (F-18): the built-in PDF fonts show Western European text only
        // (Symbol and ZapfDingbats: their own symbols only).
        const supported = new Set(font.getCharacterSet());
        const unsupported = Array.from(new Set(Array.from(cleanText.replace(/\n/g, '')).filter((ch) => !supported.has(ch.codePointAt(0)!))));
        if (unsupported.length > 0) {
          const scope = fontEnum === StandardFonts.Symbol || fontEnum === StandardFonts.ZapfDingbats
            ? 'it has its own symbols only, so pick another font for ordinary text'
            : 'it shows Western European text only, not emoji, Chinese, Japanese or other scripts';
          throw new Error(
            `The ${fontEnum} PDF font cannot show some characters (found ${describeCharacters(unsupported)}) in "${cleanTextSample}...": ${scope}. Remove them.`
          );
        }

        const maxTextWidth = Math.max(
          ...lines.map(line => font.widthOfTextAtSize(line, fontSize))
        );

        const targetPages = [];
        
        if (item.applyToAllPages) {
          targetPages.push(...pages);
        } else {
					if (item.pageNumber === undefined) {
						throw new Error(
							`Page Number is required when "Apply to all pages?" is not checked for text "${cleanTextSample}...".`
						);
					}
          const pageIndex = Number(item.pageNumber) - 1;
          
          if (pageIndex < 0 || pageIndex >= totalPages) {
            throw new Error(
              `You requested Page ${item.pageNumber} for text "${cleanTextSample}...", but this document only has ${totalPages} page(s).`
            );
          }
          targetPages.push(pages[pageIndex]);
        }

        for (const targetPage of targetPages) {
          const { width, height } = targetPage.getSize();
          const rotationAngle = ((targetPage.getRotation()?.angle ?? 0) % 360 + 360) % 360;

          const isLandscape = rotationAngle === 90 || rotationAngle === 270;
          const vWidth = isLandscape ? height : width;
          const vHeight = isLandscape ? width : height;

          const vX = item.distanceFromLeft;
          const vY = vHeight - item.distanceFromTop;
          
          // Check Left Edge
          if (vX < 0 || vX > vWidth) {
            throw new Error(
              `The Left distance (${item.distanceFromLeft}pts) for "${cleanTextSample}..." is outside the page width. Current PDF's max width is ${Math.round(vWidth)}pts.`
            );
          }

          // Check Right Edge (Long text running off the right edge)
          if (vX + maxTextWidth > vWidth) {
              throw new Error(
                `The text "${cleanTextSample}..." is too long and runs off the right edge. Reduce the Left distance or font size.`
              );
          }

          // Check Top Edge
          if (vY < 0 || vY > vHeight) {
            throw new Error(
              `The Top distance (${item.distanceFromTop}pts) for "${cleanTextSample}..." is outside the page height. Current PDF's max height is ${Math.round(vHeight)}pts.`
            );
          }

          // Check multi-line overflow along the axis that lines stack on after page rotation:
          // 0°   → lines stack downward  → check vY - (n-1)*lineHeight >= 0
          // 90°  → lines stack leftward  → check vX - (n-1)*lineHeight >= 0
          // 180° → lines stack upward    → check vY + (n-1)*lineHeight <= vHeight
          // 270° → lines stack rightward → check vX + (n-1)*lineHeight <= vWidth
          const lineOverflow = (lines.length - 1) * actualLineHeight;
          if (rotationAngle === 90) {
            if (vX - lineOverflow < 0) {
              throw new Error(
                `The text "${cleanTextSample}..." contains too many lines and runs off the left edge of the page. Reduce the Left distance, Font Size, or Line Spacing.`
              );
            }
          } else if (rotationAngle === 180) {
            if (vY + lineOverflow > vHeight) {
              throw new Error(
                `The text "${cleanTextSample}..." contains too many lines and runs off the top of the page. Reduce the Top distance, Font Size, or Line Spacing.`
              );
            }
          } else if (rotationAngle === 270) {
            if (vX + lineOverflow > vWidth) {
              throw new Error(
                `The text "${cleanTextSample}..." contains too many lines and runs off the right edge of the page. Reduce the Left distance, Font Size, or Line Spacing.`
              );
            }
          } else {
            // 0° — lines stack downward
            if (vY - lineOverflow < 0) {
              throw new Error(
                `The text "${cleanTextSample}..." contains too many lines and runs off the bottom of the page. Reduce the Top distance, Font Size, or Line Spacing.`
              );
            }
          }

          // Map Visual coordinates back to Intrinsic coordinates for pdf-lib
          let iX = vX;
          let iY = vY;
          let textRotation = 0;

          if (rotationAngle === 90) {
            iX = vHeight - vY; 
            iY = vX;
            textRotation = 90;
          } else if (rotationAngle === 180) {
            iX = vWidth - vX;
            iY = vHeight - vY;
            textRotation = 180;
          } else if (rotationAngle === 270) {
            iX = vY;
            iY = vWidth - vX;
            textRotation = -90;
          }

          targetPage.drawText(cleanText, {
            x: iX,
            y: iY,
            size: fontSize,
            font: font,
            color: rgb(0, 0, 0),
            lineHeight: actualLineHeight,
            rotate: degrees(textRotation),
          });
        }
      }

      const pdfBytes = await pdfDoc.save();
      const base64Pdf = Buffer.from(pdfBytes).toString('base64');

      return context.files.write({
        data: Buffer.from(base64Pdf, 'base64'),
        fileName: `stamped_${file.filename}`,
      });
    } catch (error) {
      throw new Error(`Failed to add text to PDF: ${(error as Error).message}`);
    }
  },
});