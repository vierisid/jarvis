/**
 * Keeps TLS certificate verification on inside the engine, whatever piece code
 * does to the environment.
 *
 * THE BUG. The FetchHttpClient bundled into published Activepieces pieces
 * (piece-gmail 0.18.x, piece-google-calendar 0.13.x, piece-google-drive 0.13.x,
 * piece-google-sheets 0.19.x) and the AxiosHttpClient in the published
 * `@activepieces/pieces-common` (which piece-notion, piece-telegram-bot,
 * piece-apify and others install as a dependency) both run
 *
 *     process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
 *
 * at the top of `sendRequest`, on every request. That is not scoped to the one
 * request: it turns certificate verification off for EVERY later HTTPS
 * connection the process makes, including the managed Google bearer tokens
 * other pieces send, until the process exits. Pooled engines live across runs,
 * so one Gmail step exposes the rest of the engine's life to a network MITM.
 * The vendored copy of the axios client has the line stripped at sync time
 * (STRIP_LINES in scripts/sync-activepieces.ts), but installed piece bundles
 * carry their own copies and cannot be patched by hand.
 *
 * MEASURED (Bun 1.3.8 and 1.4.2, self-signed local HTTPS server): writing "0"
 * at run time makes both `fetch` and `node:https` accept the bad certificate.
 *
 * THE GUARD, two layers, prepended to the bundle so it runs before any piece
 * module is imported:
 *   1. `process.env` is replaced by a Proxy over the real env object that
 *      drops writes, definitions and deletes of NODE_TLS_REJECT_UNAUTHORIZED,
 *      reads it as absent, and logs the first dropped write once. Writes are
 *      dropped silently (the trap returns true) rather than refused, because
 *      the piece bundles are strict-mode code and a refused write would throw
 *      inside `sendRequest` and fail the request. Every other variable reads
 *      and writes through unchanged. The `env` property is then made
 *      non-writable and non-configurable so piece code cannot swap it back.
 *   2. `fetch` defaults `tls.rejectUnauthorized` to true when the caller did
 *      not choose. `Bun.env` is the same real env object and cannot be
 *      replaced (it is read-only), and on Bun 1.4.2 a write through it still
 *      disables verification for `fetch` (measured; `node:https` reads the
 *      Proxy and stays safe). An explicit `rejectUnauthorized: true` overrides
 *      the env var on 1.4.2. On 1.3.8 the explicit option is ignored, but there
 *      a write through `Bun.env` does not reach `fetch` either (measured). A
 *      caller that explicitly passes `tls: { rejectUnauthorized: false }` keeps
 *      its choice: that is scoped to its own request, not the whole process.
 *
 * CUSTOM CAs are unaffected: NODE_EXTRA_CA_CERTS / SSL_CERT_FILE add trust
 * anchors and verification against them is still verification.
 *
 * Plain JS in a string because it is a banner (see ENGINE_ESBUILD_CONFIG in
 * build.ts); the banner is hashed into the bundle key, so editing this
 * rebuilds every cached engine.
 */

/** The variable piece code writes to turn verification off. */
export const TLS_REJECT_ENV = "NODE_TLS_REJECT_UNAUTHORIZED";

export const ENGINE_TLS_GUARD_SHIM = `(() => {
  var KEY = ${JSON.stringify(TLS_REJECT_ENV)};
  var real = process.env;
  try { delete real[KEY]; } catch (e) {}
  var warned = false;
  var drop = function () {
    if (!warned) {
      warned = true;
      try {
        process.stderr.write("[engine] ignored an attempt to set " + KEY + "; TLS certificate verification stays on\\n");
      } catch (e) {}
    }
    return true;
  };
  var guarded = new Proxy(real, {
    get: function (t, p) { return p === KEY ? undefined : Reflect.get(t, p); },
    set: function (t, p, v) { return p === KEY ? drop() : Reflect.set(t, p, v); },
    defineProperty: function (t, p, d) { return p === KEY ? drop() : Reflect.defineProperty(t, p, d); },
    deleteProperty: function (t, p) { return p === KEY ? true : Reflect.deleteProperty(t, p); },
    has: function (t, p) { return p === KEY ? false : Reflect.has(t, p); },
    getOwnPropertyDescriptor: function (t, p) { return p === KEY ? undefined : Reflect.getOwnPropertyDescriptor(t, p); },
  });
  Object.defineProperty(process, "env", { value: guarded, writable: false, configurable: false, enumerable: true });

  var nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function") return;
  var verifiedFetch = function fetch(input, init) {
    var tls = init != null ? init.tls : undefined;
    if (tls != null && tls.rejectUnauthorized !== undefined) return nativeFetch(input, init);
    var withTls = Object.assign({}, tls, { rejectUnauthorized: true });
    // Inherit from the caller's init rather than copying it, so getters and
    // prototype members (a class instance used as init) still reach fetch.
    var next = init != null && typeof init === "object"
      ? Object.create(init, { tls: { value: withTls, enumerable: true, writable: true, configurable: true } })
      : { tls: withTls };
    return nativeFetch(input, next);
  };
  Object.getOwnPropertyNames(nativeFetch).forEach(function (name) {
    if (name === "length" || name === "name" || name === "prototype" || name === "caller" || name === "arguments") return;
    try { Object.defineProperty(verifiedFetch, name, Object.getOwnPropertyDescriptor(nativeFetch, name)); } catch (e) {}
  });
  globalThis.fetch = verifiedFetch;
})();`;
