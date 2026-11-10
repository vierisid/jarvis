import { Property, createAction } from '@activepieces/pieces-framework';
import { Converter, Flavor } from 'showdown';
import { propsValidation } from '@activepieces/pieces-common';
import { z, type ZodTypeAny } from 'zod';
import { JSDOM } from 'jsdom';

// === JARVIS PATCH (F-09): the HTML is an allowlist-sanitised fragment ===
// Markdown may carry raw HTML. Left as is, a <script>, an on* handler or a
// javascript: link in the input is in the output, and the output may be shown
// in a page or an email. The fragment is parsed (never run) and rebuilt from an
// allowlist of tags and attributes.
const SAFE_TAGS = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'kbd', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul']);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'noscript', 'template', 'svg', 'math', 'title', 'head', 'form', 'textarea', 'select', 'button', 'audio', 'video']);
const SAFE_ATTRS = new Set(['align', 'alt', 'checked', 'class', 'colspan', 'disabled', 'height', 'href', 'id', 'rel', 'rowspan', 'src', 'start', 'target', 'title', 'type', 'width']);
const SAFE_URL = /^(?:https?:|mailto:|tel:|[^a-z]|[a-z0-9+.-]*(?:[/?#]|$))/i;

function sanitizeHtml(html: string): string {
  const { document } = new JSDOM(`<!doctype html><body>${html}`).window;
  const walk = (parent: Element): void => {
    for (const el of Array.from(parent.children)) {
      const tag = el.tagName.toLowerCase();
      if (DROP_WITH_CONTENT.has(tag)) {
        el.remove();
        continue;
      }
      walk(el);
      if (!SAFE_TAGS.has(tag)) {
        el.replaceWith(...Array.from(el.childNodes));
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        // Control characters and spaces are ignored inside a URL scheme by browsers.
        const url = attr.value.replace(/[\u0000-\u0020\u007f-\u009f]+/g, '');
        if (!SAFE_ATTRS.has(name) || ((name === 'href' || name === 'src') && !SAFE_URL.test(url))) el.removeAttribute(attr.name);
      }
      if (tag === 'input' && el.getAttribute('type') !== 'checkbox') el.remove();
      else if (el.hasAttribute('target')) el.setAttribute('rel', 'noopener noreferrer');
    }
  };
  walk(document.body);
  return document.body.innerHTML;
}
// === END JARVIS PATCH ===

export const markdownToHTML = createAction({
  name: 'markdown_to_html',
  displayName: 'Markdown to HTML',
  description: 'Convert markdown to HTML',
  errorHandlingOptions: {
    continueOnFailure: {
      hide: true,
    },
    retryOnFailure: {
      hide: true,
    },
  },
  props: {
    markdown: Property.LongText({
      displayName: 'Markdown Content',
      description: 'The markdown to convert to HTML',
      required: true,
    }),
    flavor: Property.StaticDropdown({
      displayName: 'Flavor of Markdown',
      description: 'The flavor of markdown use during conversion',
      required: true,
      defaultValue: 'github',
      options: {
        options: [
          { label: 'Default', value: 'vanilla' },
          { label: 'Original', value: 'original' },
          { label: 'GitHub', value: 'github' },
        ],
      },
    }),
    headerLevelStart: Property.Number({
      displayName: 'Minimum Header Level',
      description: 'The minimum header level to use during conversion',
      required: true,
      defaultValue: 1,
    }),
    tables: Property.Checkbox({
      displayName: 'Support Tables',
      description: 'Whether to support tables during conversion',
      required: true,
      defaultValue: true,
    }),
    noHeaderId: Property.Checkbox({
      displayName: 'No Header ID',
      description: 'Whether to add an ID to headers during conversion',
      required: true,
      defaultValue: false,
    }),
    simpleLineBreaks: Property.Checkbox({
      displayName: 'Simple Line Breaks',
      description:
        'Parses line breaks as &lt;br&gt;, without needing 2 spaces at the end of the line',
      required: true,
      defaultValue: false,
    }),
    openLinksInNewWindow: Property.Checkbox({
      displayName: 'Open Links in New Window',
      required: true,
      defaultValue: false,
    }),
  },
  run: async (context) => {
    const validationSchema: Record<string, ZodTypeAny> = {
      headerLevelStart: z.number().min(1).max(6),
    };
    await propsValidation.validateZod(context.propsValue, validationSchema);

    const converter = new Converter({
      headerLevelStart: context.propsValue.headerLevelStart,
      omitExtraWLInCodeBlocks: true,
      noHeaderId: context.propsValue.noHeaderId,
      tables: context.propsValue.tables,
      simpleLineBreaks: context.propsValue.simpleLineBreaks,
      openLinksInNewWindow: context.propsValue.openLinksInNewWindow,
    });
    console.log('noHeaderId', context.propsValue.noHeaderId);
    converter.setFlavor(context.propsValue.flavor as Flavor);
    // Jarvis (F-09): see sanitizeHtml above.
    return sanitizeHtml(converter.makeHtml(context.propsValue.markdown));
  },
});
