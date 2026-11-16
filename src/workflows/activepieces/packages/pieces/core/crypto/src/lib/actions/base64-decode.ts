import { Property, createAction } from '@activepieces/pieces-framework';

export const base64Decode = createAction({
  name: 'base64-decode',
  displayName: 'Base64 Decode',
  description:'Converts base64 text back to plain text.',
  props: {
    text: Property.ShortText({
      displayName: 'Text',
      description: 'The text to be decoded.',
      required: true,
    }),
  },
  async run(context) {
    // Jarvis (F-13): Buffer.from(..., 'base64') skips anything that is not
    // base64 and returns whatever is left. Text that is not base64 fails the
    // step instead. Standard and URL-safe alphabets are accepted, padding is
    // optional, and line breaks around or inside it are ignored. A space inside is
    // not base64, so "hello world" fails.
    const text = context.propsValue.text.trim().replace(/[\r\n]+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text) || text.replace(/=+$/, '').length % 4 === 1) {
      throw new Error('The text is not valid base64. Check that it was produced by a base64 encoder and has no extra characters.');
    }
    return Buffer.from(text, 'base64').toString();
  },
});
