import { createAction, Property } from '@activepieces/pieces-framework';
import js2xml from 'json2xml';

// === JARVIS PATCH (F-12): only valid XML names become tags and attributes ===
// json2xml writes every key as a tag name as it is, so "1 bad key" or "@id"
// produced XML no parser accepts. Such a key now fails the step, naming it.
// A name follows the XML 1.0 Name rule: it starts with a letter, "_" or ":"
// and continues with letters, digits, "-", "_", ".", ":" (non-ASCII letters
// as the rule lists them).
const XML_NAME_START = 'A-Za-z_:\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const XML_NAME = new RegExp(`^[${XML_NAME_START}][${XML_NAME_START}0-9.\\-\\u00B7\\u0300-\\u036F\\u203F\\u2040]*$`, 'u');
// Characters XML 1.0 cannot carry at all, not even as a character reference.
const NOT_XML_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
const RULE = 'Names must start with a letter or _ and contain only letters, digits, - _ . or :. Rename the key.';

/** A key as an error names it: quoted and escaped, and cut short when long. */
function shown(name: string): string {
  return JSON.stringify(name.length > 60 ? `${name.slice(0, 60)}...` : name);
}

function assertXmlText(value: string, where: string): void {
  if (NOT_XML_TEXT.test(value)) {
    throw new Error(`The value of ${where} has a control character XML cannot hold. Remove it before converting.`);
  }
}

/**
 * Checks names and text, and escapes attribute values in place: json2xml
 * escapes element text but writes an attribute value as it is, so a value
 * holding `"` and `<` could close the attribute and add elements of its own.
 */
function prepareXml(value: unknown, attributesKey: string, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => prepareXml(item, attributesKey, path));
    return;
  }
  if (typeof value === 'string') {
    assertXmlText(value, path ? shown(path) : 'the JSON');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key !== attributesKey) {
      if (!XML_NAME.test(key)) {
        throw new Error(`${shown(key)}${path ? ` (inside ${shown(path)})` : ''} cannot be used as an XML tag name. ${RULE}`);
      }
      prepareXml(child, attributesKey, key);
      continue;
    }
    if (child === null || child === undefined || child === false || child === 0 || child === '') continue;
    if (typeof child !== 'object' || Array.isArray(child)) {
      throw new Error(`The attribute field ${shown(key)}${path ? ` of ${shown(path)}` : ''} must be an object of attribute names and values.`);
    }
    const attributes = child as Record<string, unknown>;
    for (const [attribute, attributeValue] of Object.entries(attributes)) {
      if (!XML_NAME.test(attribute)) {
        throw new Error(`${shown(attribute)} (an attribute of ${shown(path || key)}) cannot be used as an XML attribute name. ${RULE}`);
      }
      if (attributeValue !== null && typeof attributeValue === 'object') {
        throw new Error(`The attribute ${shown(attribute)} of ${shown(path || key)} must be text, a number or true/false, not a list or an object.`);
      }
      const text = String(attributeValue);
      assertXmlText(text, `the attribute ${shown(attribute)}`);
      attributes[attribute] = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
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
    prepareXml(data, attributes_key, '');
    return js2xml(data, { attributes_key, header });
  },
});
