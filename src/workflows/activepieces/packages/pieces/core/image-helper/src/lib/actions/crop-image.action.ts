import { Property, createAction } from '@activepieces/pieces-framework';
import jimp from 'jimp';

export const cropImage = createAction({
  name: 'crop_image',
  description: 'Crops an image',
  displayName: 'Crop an image',
  props: {
    image: Property.File({
      displayName: 'Image',
      required: true,
    }),
    left: Property.Number({
      displayName: 'Left',
      description:
        'Specifies the horizontal position, indicating where the cropping starts from the left side of the image.',
      required: true,
    }),
    top: Property.Number({
      displayName: 'Top',
      description:
        'Represents the vertical position, indicating the starting point from the top of the image.',
      required: true,
    }),
    width: Property.Number({
      displayName: 'Width',
      description: 'Determines the horizontal size of the cropped area.',
      required: true,
    }),
    height: Property.Number({
      displayName: 'Height',
      description: 'Determines the vertical size of the cropped area.',
      required: true,
    }),
    resultFileName: Property.ShortText({
      displayName: 'Result File Name',
      description:
        'Specifies the output file name for the cropped image (without extension).',
      required: false,
    }),
  },
  async run(context) {
    const image = await jimp.read(context.propsValue.image.data);
    // === JARVIS PATCH: a crop outside the image says so in plain words ===
    // Upstream let the image library fail with a raw "offset is out of range".
    // The library rounds each value before it crops, so check the rounded ones.
    const { left, top, width, height } = context.propsValue;
    const x = Math.round(left);
    const y = Math.round(top);
    const w = Math.round(width);
    const h = Math.round(height);
    if (
      ![left, top, width, height].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      w < 1 ||
      h < 1 ||
      x + w > image.getWidth() ||
      y + h > image.getHeight()
    ) {
      throw new Error(
        `The crop area does not fit inside the image. The image is ${image.getWidth()} by ${image.getHeight()} pixels, so Left and Top must be 0 or more, Width and Height must be at least 1, and Left plus Width and Top plus Height must stay within the image.`
      );
    }
    // === END JARVIS PATCH ===
    await image.crop(
      context.propsValue.left,
      context.propsValue.top,
      context.propsValue.width,
      context.propsValue.height
    );

    const imageBuffer = await image.getBufferAsync(image.getMIME());

    const fileName =
      (context.propsValue.resultFileName ?? 'image') +
      '.' +
      image.getExtension();

    const imageReference = await context.files.write({
      fileName: fileName,
      data: imageBuffer,
    });

    return imageReference;
  },
});
