import { createAction, Property } from '@activepieces/pieces-framework';
import js2xml from 'json2xml';

// === JARVIS PATCH (F-12): only valid XML names become tags and attributes ===
// json2xml writes every key as a tag name as it is, so "1 bad key" or "@id"
// produced XML no parser accepts. Such a key now fails the step, naming it.
// A name starts with a letter, "_" or ":" and continues with letters, digits,
// "-", "_", ".", ":" (any non-ASCII letter counts as a letter).
const XML_NAME = /^[A-Za-z_:\u00C0-\uFFFF][A-Za-z0-9_:.\-\u00B7\u00C0-\uFFFF]*$/;

function assertXmlNames(value: unknown, attributesKey: string, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => assertXmlNames(item, attributesKey, path));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key !== attributesKey && !XML_NAME.test(key)) {
      throw new Error(
        `"${key}"${path ? ` (inside "${path}")` : ''} cannot be used as an XML tag name. Names must start with a letter or _ and contain only letters, digits, - _ . or :. Rename the key.`
      );
    }
    if (key === attributesKey && child !== null && typeof child === 'object' && !Array.isArray(child)) {
      for (const attribute of Object.keys(child)) {
        if (!XML_NAME.test(attribute)) {
          throw new Error(
            `"${attribute}" (an attribute of "${path || key}") cannot be used as an XML attribute name. Names must start with a letter or _ and contain only letters, digits, - _ . or :. Rename the key.`
          );
        }
      }
    } else {
      assertXmlNames(child, attributesKey, key);
    }
  }
}
// === END JARVIS PATCH ===

export const convertJsonToXml = createAction({
  name: 'convert-json-to-xml',
  displayName: 'Convert JSON to XML',
  description: 'Convert JSON to XML',
  props: {
    json: Property.Json({
      displayName: 'JSON',
      required: true,
    }),
    attributes_key: Property.ShortText({
      displayName: 'Attribute field',
      description: "Field to add your tag's attributes",
      required: false,
    }),
    header: Property.Checkbox({
      displayName: 'Header',
      description: 'Add XML header',
      required: false,
    }),
  },
  async run(context) {
    const { json } = context.propsValue;

    const attributes_key = context.propsValue.attributes_key
      ? context.propsValue.attributes_key
      : 'attr';
    const header = context.propsValue.header
      ? context.propsValue.header
      : false;

    const data = JSON.parse(JSON.stringify(json));
    // Jarvis (F-12)
    assertXmlNames(data, attributes_key, '');
    return js2xml(data, { attributes_key, header });
  },
});
