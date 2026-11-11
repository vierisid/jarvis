import { Property, createAction } from '@activepieces/pieces-framework';
import jimp from 'jimp';

export const compressImage = createAction({
  name: 'compress_image',
  description: 'Compresses an image',
  displayName: 'Compresses an image',
  props: {
    image: Property.File({
      displayName: 'Image',
      required: true,
    }),
    quality: Property.StaticDropdown({
      displayName: 'Quality',
      description:
        'Specifies the quality of the image after compression (0-100).',
      required: true,
      options: {
        options: [
          { label: 'High Quality', value: 90 },
          { label: 'Lossy Quality', value: 60 },
        ],
      },
    }),
    format: Property.StaticDropdown({
      displayName: 'Format',
      description: 'Specifies the format of the image after compression.',
      required: true,
      options: {
        options: [
          { label: 'JPG', value: 'jpg' },
          { label: 'PNG', value: 'png' },
        ],
      },
    }),
    resultFileName: Property.ShortText({
      displayName: 'Result File Name',
      description:
        'Specifies the output file name for the result image (without extension).',
      required: false,
    }),
  },
  async run(context) {
    const image = await jimp.read(context.propsValue.image.data);

    // === JARVIS PATCH: the Quality dropdown's own values work ===
    // A saved flow or the editor hands the dropdown value over as text ("60"),
    // and the image library rejects anything that is not a number type.
    const quality = Number(context.propsValue.quality);
    if (
      String(context.propsValue.quality).trim() === '' ||
      !Number.isFinite(quality) ||
      quality < 0 ||
      quality > 100
    ) {
      throw new Error(
        'Quality must be a number from 0 to 100. Pick High Quality or Lossy Quality.'
      );
    }
    image.quality(quality);
    // === END JARVIS PATCH ===

    const imageBuffer = await image.getBufferAsync(image.getMIME());

    const imageReference = await context.files.write({
      fileName:
        (context.propsValue.resultFileName ?? 'image') +
        '.' +
        context.propsValue.format,
      data: imageBuffer,
    });

    return imageReference;
  },
});
