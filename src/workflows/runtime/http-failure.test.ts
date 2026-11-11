import { describe, expect, test } from 'bun:test';
import { describeHttpFailure } from './http-failure';

const say = (status: number, body: unknown) => describeHttpFailure({ hasResponse: true, status, body }, { url: 'https://api.example.com/x' });

describe('a failed request whose answer is a web page', () => {
  test('names the page by its title, not its markup', () => {
    const page = '<!doctype html><html lang=en><head><meta charset=utf-8><link rel=icon href=data:,><meta name=viewport content="width=device-width"><title>Example &amp; Domain</title><style>html{color-scheme:light dark}</style></head><body><div><h1>Example Domain</h1></div></body></html>';
    expect(say(404, page)).toBe('The server answered 404 Not Found. It sent a web page titled "Example & Domain".');
  });

  test('without a title, quotes the text a reader would see, not tags, styles or scripts', () => {
    const page = '<html><head><style>body{margin:0}</style><script>var secret=1</script></head><body><!-- hidden --><h1>Service   unavailable</h1><p>Try again &lt;soon&gt;.</p></body></html>';
    const said = say(503, page);
    expect(said).toBe('The server answered 503 Service Unavailable. It sent a web page that said: "Service unavailable Try again <soon>."');
    expect(said).not.toMatch(/margin|var secret|hidden/);
  });

  test('a page with no visible text is just a web page; a long one is cut', () => {
    expect(say(500, '<html><head><title></title></head><body></body></html>')).toBe('The server answered 500 Internal Server Error. It sent a web page.');
    expect(say(500, `<html><body><p>${'word '.repeat(500)}</p></body></html>`).length).toBeLessThan(450);
  });

  test('a credential inside the page is redacted like any other body', () => {
    const said = say(401, '<html><body>token=abcdefghijklmnopqrstuvwxyz0123456789</body></html>');
    expect(said).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  test('JSON and plain text are quoted as before', () => {
    expect(say(404, 'No such widget')).toBe('The server answered 404 Not Found. It said: "No such widget"');
    expect(say(400, { error: 'bad <b>input</b>' })).toBe('The server answered 400 Bad Request. It said: "{\'error\':\'bad <b>input</b>\'}"');
    expect(say(400, 'a < b and <c is fine')).toContain('It said: "a < b and <c is fine"');
  });
});
