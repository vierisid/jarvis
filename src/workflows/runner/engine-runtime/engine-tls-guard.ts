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
 * THE GUARD, prepended to the bundle so it runs before any piece module is
 * imported:
 *   1. `process.env` is replaced by a Proxy over the real env object that
 *      drops writes, definitions and deletes of NODE_TLS_REJECT_UNAUTHORIZED,
 *      reads it as absent, and logs the first dropped write once. Writes are
 *      dropped silently (the trap returns true) rather than refused, because
 *      the piece bundles are strict-mode code and a refused write would throw
 *      inside `sendRequest` and fail the request. Every other variable reads
 *      and writes through unchanged. The `env` property is then made
 *      non-writable and non-configurable so piece code cannot swap it back.
 *   2. `fetch` and the global `WebSocket` force `tls.rejectUnauthorized` to
 *      true unless the caller passed exactly `false`. This covers `Bun.env`:
 *      it is the same real env object (writable; only the `Bun.env` property
 *      itself cannot be replaced), and a write through it bypasses the Proxy.
 *      Measured without the guard, on both 1.3.8 and 1.4.2: after
 *      `Bun.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` a plain `fetch` and a
 *      plain `new WebSocket("wss://...")` accept the bad certificate, while
 *      the same call with `tls: { rejectUnauthorized: true }` rejects it. So
 *      the explicit option is honoured on both versions, and it is what
 *      protects these paths. (With the Proxy in place, 1.3.8 no longer sees a
 *      `Bun.env` write from fetch or WebSocket either; 1.4.2 still does.)
 *      `node:https` and `node:tls` read the Proxy and stay safe. Only the
 *      boolean `false` counts as an opt-out: null, 0 or "" would otherwise
 *      reach Bun as "not chosen" and fall back to the env var. A caller that
 *      passes `rejectUnauthorized: false` keeps its choice, scoped to its own
 *      request.
 *   3. `https.globalAgent.options.rejectUnauthorized` reads true and drops
 *      writes (logged once). Its options are merged into every default-agent
 *      `node:https` request, which is also what axios's http adapter uses
 *      under Bun, so a write there was process-wide (measured on 1.3.8 and
 *      1.4.2). The getter is non-enumerable so a request's own
 *      `rejectUnauthorized: false` still wins, `options` cannot be replaced,
 *      and a replacement `https.globalAgent` is locked the same way. The lock
 *      fails closed: it goes on a fresh copy of the options, and a
 *      replacement whose `options` cannot be redefined is refused. An agent
 *      a caller builds itself, `new https.Agent({ rejectUnauthorized: false })`,
 *      is a per-agent choice and is left alone; `new https.Agent()` verifies.
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
  var warned = {};
  var drop = function (what) {
    if (!warned[what]) {
      warned[what] = true;
      try {
        process.stderr.write("[engine] ignored an attempt to set " + what + "; TLS certificate verification stays on\\n");
      } catch (e) {}
    }
    return true;
  };
  var dropEnv = function () { return drop(KEY); };
  var guarded = new Proxy(real, {
    get: function (t, p) { return p === KEY ? undefined : Reflect.get(t, p); },
    set: function (t, p, v) { return p === KEY ? dropEnv() : Reflect.set(t, p, v); },
    defineProperty: function (t, p, d) { return p === KEY ? dropEnv() : Reflect.defineProperty(t, p, d); },
    deleteProperty: function (t, p) { return p === KEY ? true : Reflect.deleteProperty(t, p); },
    has: function (t, p) { return p === KEY ? false : Reflect.has(t, p); },
    getOwnPropertyDescriptor: function (t, p) { return p === KEY ? undefined : Reflect.getOwnPropertyDescriptor(t, p); },
  });
  Object.defineProperty(process, "env", { value: guarded, writable: false, configurable: false, enumerable: true });

  // Only the boolean false is an explicit opt-out. null, 0, "" and the like
  // would otherwise reach Bun as "not chosen" and fall back to the env var.
  var verifyUnless = function (tls) {
    var optOut = tls != null && tls.rejectUnauthorized === false;
    return Object.assign({}, tls, { rejectUnauthorized: !optOut });
  };

  // https.globalAgent: its options are merged into every default-agent
  // request (node:https, and axios's http adapter), so a write of
  // rejectUnauthorized there is process-wide. The getter is non-enumerable
  // so a request's own rejectUnauthorized: false still wins over it.
  try {
    var https = require("node:https");
    // Fails closed: returns the locked agent, or null when it cannot be
    // locked. The lock goes on a fresh plain copy of the options, never the
    // caller's object, which may be frozen, shared or a Proxy that swallows
    // defines; the read-back catches an agent that ignores the define.
    var lockAgent = function (agent) {
      if (agent == null || (typeof agent !== "object" && typeof agent !== "function")) return null;
      try {
        var src = agent.options;
        var opts = Object.assign({}, src != null && typeof src === "object" ? src : {});
        Object.defineProperty(opts, "rejectUnauthorized", {
          get: function () { return true; },
          set: function () { drop("https.globalAgent.options.rejectUnauthorized"); },
          enumerable: false, configurable: false,
        });
        Object.defineProperty(agent, "options", { value: opts, writable: false, configurable: false, enumerable: true });
        if (agent.options !== opts || opts.rejectUnauthorized !== true) return null;
        return agent;
      } catch (e) {
        return null;
      }
    };
    var current = lockAgent(https.globalAgent) || lockAgent(new https.Agent()) || https.globalAgent;
    Object.defineProperty(https, "globalAgent", {
      get: function () { return current; },
      // Replacing the global agent (a proxy library does) is allowed, but the
      // replacement verifies too; one that cannot be locked is refused.
      set: function (agent) {
        var locked = lockAgent(agent);
        if (locked) current = locked;
        else drop("https.globalAgent (replacement refused)");
      },
      enumerable: true, configurable: false,
    });
  } catch (e) {}

  // WebSocket takes the same tls option as fetch and, without it, follows a
  // Bun.env write of the variable (measured on 1.3.8 and 1.4.2).
  var NativeWebSocket = globalThis.WebSocket;
  if (typeof NativeWebSocket === "function") {
    var VerifiedWebSocket = class WebSocket extends NativeWebSocket {
      constructor(url, second) {
        var opts;
        if (second == null) opts = {};
        else if (typeof second === "string") opts = { protocols: [second] };
        else if (Array.isArray(second)) opts = { protocols: second };
        else if (typeof second[Symbol.iterator] === "function") opts = { protocols: Array.from(second) };
        else if (typeof second !== "object" && typeof second !== "function") opts = {};
        // Copy every own property, non-enumerable ones too: Bun reads own
        // properties of the options (headers, protocols, proxy), measured,
        // and not inherited ones, so Object.create would drop them.
        else {
          var own = Object.getOwnPropertyDescriptors(second);
          delete own.tls;
          opts = Object.defineProperties({}, own);
          opts.tls = second.tls;
        }
        opts.tls = verifyUnless(opts.tls);
        super(url, opts);
      }
    };
    globalThis.WebSocket = VerifiedWebSocket;
  }

  var nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function") return;
  var verifiedFetch = function fetch(input, init) {
    var withTls = verifyUnless(init != null ? init.tls : undefined);
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
