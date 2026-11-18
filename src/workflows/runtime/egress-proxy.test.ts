import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect as netConnect, type Socket } from "node:net";
import { decideDestination, EGRESS_REFUSED_HEADER, parseTarget, rewriteHead, startEgressProxy, type EgressProxy } from "./egress-proxy";

/** 93.184.215.14 stands in for a public server; the proxy really connects to a local fixture. */
const PUBLIC = "93.184.215.14";
const NAMES: Record<string, string[]> = {
  "public.example": [PUBLIC],
  "metadata.example": ["169.254.169.254"],
  "mixed.example": [PUBLIC, "10.0.0.5"],
  "lan.example": ["192.168.1.20"],
  localhost: ["127.0.0.1", "::1"],
};
const resolve = async (host: string) => {
  const found = NAMES[host];
  if (!found) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return found.map((address) => ({ address, family: 4 }));
};
const own = () => new Set<string>(["192.0.2.99"]);

let fixture: ReturnType<typeof Bun.serve>;
let proxy: EgressProxy;
let sandboxApi: ReturnType<typeof Bun.serve>;
const connected: string[] = [];

beforeAll(async () => {
  fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new Response(`fixture saw ${new URL(req.url).pathname} host=${req.headers.get("host")}`) });
  sandboxApi = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("sandbox api") });
  proxy = await startEgressProxy({
    policy: "public-only",
    allowLocal: [{ host: "127.0.0.1", port: sandboxApi.port! }],
    own,
    resolve,
    log: () => {},
    // Every checked destination lands on the fixture; what matters is what was checked.
    connect: (address, port) => {
      connected.push(`${address}:${port}`);
      return netConnect({ host: "127.0.0.1", port: address === "127.0.0.1" ? port : fixture.port! });
    },
  });
});

afterAll(async () => {
  await proxy.close();
  fixture.stop(true);
  sandboxApi.stop(true);
});

/** Send raw bytes to the proxy and read until it closes or `until` matches. */
function raw(text: string, until?: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock: Socket = netConnect({ host: "127.0.0.1", port: proxy.port }, () => sock.write(text));
    let out = "";
    sock.on("data", (d) => {
      out += d.toString("latin1");
      if (until?.test(out)) { sock.destroy(); resolve(out); }
    });
    sock.on("close", () => resolve(out));
    sock.on("error", reject);
    setTimeout(() => { sock.destroy(); resolve(out); }, 5_000);
  });
}

describe("egress proxy", () => {
  test("refuses the metadata address, by literal and by name, for CONNECT and plain http", async () => {
    connected.length = 0;
    for (const request of [
      "CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: 169.254.169.254:443\r\n\r\n",
      "GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n",
      "CONNECT metadata.example:443 HTTP/1.1\r\n\r\n",
      "GET http://[fd00:ec2::254]/latest/ HTTP/1.1\r\n\r\n",
      "GET http://100.100.100.200/latest/ HTTP/1.1\r\n\r\n",
    ]) {
      const reply = await raw(request);
      expect(reply).toStartWith("HTTP/1.1 403 Forbidden");
      expect(reply).toContain(`${EGRESS_REFUSED_HEADER}: refused`);
    }
    expect(connected).toEqual([]);
  });

  test("refuses loopback, the machine's own addresses, a private address on hosted, and a name with any bad address", async () => {
    connected.length = 0;
    for (const target of ["127.0.0.1:3142", "localhost:3142", "192.0.2.99:80", "lan.example:443", "mixed.example:443", "[::1]:80"]) {
      expect(await raw(`CONNECT ${target} HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 403");
    }
    expect(connected).toEqual([]);
  });

  test("allows a public destination, connecting to the address it checked", async () => {
    connected.length = 0;
    const plain = await raw("GET http://public.example/hello?x=1 HTTP/1.1\r\nHost: public.example\r\nProxy-Connection: keep-alive\r\n\r\n", /fixture saw/);
    expect(plain).toStartWith("HTTP/1.1 200");
    expect(plain).toContain("fixture saw /hello host=public.example");
    const tunnel = await raw("CONNECT public.example:443 HTTP/1.1\r\n\r\nGET /tunnelled HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\n\r\n", /fixture saw/);
    expect(tunnel).toStartWith("HTTP/1.1 200 Connection Established");
    expect(tunnel).toContain("fixture saw /tunnelled");
    expect(connected).toEqual([`${PUBLIC}:80`, `${PUBLIC}:443`]);
  });

  test("Bun's fetch goes through it, and a refusal reads as the proxy's", async () => {
    const ok = await fetch("http://public.example/via-fetch", { proxy: proxy.url });
    expect(await ok.text()).toContain("fixture saw /via-fetch");
    const refused = await fetch("http://169.254.169.254/latest/meta-data/", { proxy: proxy.url });
    expect(refused.status).toBe(403);
    expect(refused.headers.get(EGRESS_REFUSED_HEADER)).toBe("refused");
  });

  test("the sandbox API is the one local destination, on its own port", async () => {
    const reply = await raw(`GET http://127.0.0.1:${sandboxApi.port}/v1/x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`, /sandbox api/);
    expect(reply).toContain("sandbox api");
    expect(await raw(`GET http://127.0.0.1:${sandboxApi.port! + 1}/ HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 403");
  });

  test("malformed requests and other schemes are refused without connecting", async () => {
    connected.length = 0;
    expect(await raw("GET https://public.example/ HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 501");
    expect(await raw("GET /relative HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 501");
    expect(await raw("CONNECT public.example HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 400");
    expect(await raw("NONSENSE\r\n\r\n")).toStartWith("HTTP/1.1 400");
    expect(await raw("GET http://nowhere.example/ HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 502");
    expect(connected).toEqual([]);
  });
});

describe("egress proxy pieces", () => {
  test("private-allowed reaches the LAN, never link-local or loopback", async () => {
    const opts = { policy: "private-allowed" as const, resolve, own };
    expect(await decideDestination("lan.example", 443, opts)).toBe("192.168.1.20");
    await expect(decideDestination("metadata.example", 80, opts)).rejects.toThrow("not a destination");
    await expect(decideDestination("127.0.0.1", 80, opts)).rejects.toThrow("not a destination");
  });

  test("targets and heads", () => {
    expect(parseTarget("CONNECT", "[2001:db8::1]:443")).toEqual({ host: "2001:db8::1", port: 443, path: "" });
    expect(parseTarget("CONNECT", "host:99999")).toBeNull();
    expect(parseTarget("GET", "http://user:pw@host/")).toBeNull();
    expect(parseTarget("GET", "http://host:8080/a?b")).toEqual({ host: "host", port: 8080, path: "/a?b" });
    expect(rewriteHead("GET", "/a", "HTTP/1.1", ["Host: h", "Proxy-Authorization: x", "Connection: keep-alive", "Accept: */*"]))
      .toBe("GET /a HTTP/1.1\r\nHost: h\r\nAccept: */*\r\nConnection: close\r\n\r\n");
  });
});
