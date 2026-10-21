import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

// Outbound calls to model providers carry API keys, so they all go through providerFetch (SPEC "Provider egress"):
// - http(s) only, no credentials in the URL (keys go in headers, never in a URL that ends up in logs);
// - never to link-local, unspecified or multicast addresses (cloud metadata endpoints live there), judged on the address
//   actually dialled (a name that resolves differently the second time cannot rebind to one);
// - plain http only to this machine or a private network: a key in cleartext over the internet is a leaked key
//   (POLARIS_ALLOW_HTTP_PROVIDERS=1 overrides, for a trusted network the address check cannot see);
// - redirects are refused, so a key is never replayed to another host;
// - no response headers within the timeout = failure, and error bodies are read up to ERROR_BODY_MAX only.
// TLS verification is Node's default; index.ts refuses NODE_TLS_REJECT_UNAUTHORIZED=0 (NODE_EXTRA_CA_CERTS adds a CA).

export class EgressError extends Error {}

const never = new BlockList();
never.addSubnet("0.0.0.0", 8);
never.addSubnet("169.254.0.0", 16); // link-local: 169.254.169.254 and friends
never.addSubnet("224.0.0.0", 4);
never.addAddress("100.100.100.200"); // Alibaba Cloud metadata
never.addAddress("::", "ipv6");
never.addSubnet("fe80::", 10, "ipv6");
never.addSubnet("ff00::", 8, "ipv6");
never.addAddress("fd00:ec2::254", "ipv6"); // AWS metadata over IPv6
never.addAddress("fd20:ce::254", "ipv6"); // GCP metadata over IPv6
never.addSubnet("fec0::", 10, "ipv6"); // deprecated site-local
never.addSubnet("192.0.0.0", 24);
never.addAddress("168.63.129.16"); // Azure wire server

const local = new BlockList(); // where plain http is acceptable
local.addSubnet("127.0.0.0", 8);
local.addSubnet("10.0.0.0", 8);
local.addSubnet("172.16.0.0", 12);
local.addSubnet("192.168.0.0", 16);
local.addSubnet("100.64.0.0", 10); // CGNAT / tailnets
local.addAddress("::1", "ipv6");
local.addSubnet("fc00::", 7, "ipv6");

// ::ffff:169.254.169.254 is the IPv4 address in disguise.
const plain = (a: string) => (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(a) ? a.slice(7) : a);
const family = (a: string) => (isIP(a) === 6 ? "ipv6" : "ipv4");
// The IPv4 address hiding in a NAT64 (64:ff9b::/96), 6to4 (2002::/16) or IPv4-compatible (::/96) IPv6 address.
function embedded(a: string) {
  if (isIP(a) !== 6) return undefined;
  const [head, tail = ""] = new URL(`http://[${a}]`).hostname.slice(1, -1).split("::"); // the URL parser writes dotted tails as hex
  const groups = (x: string) => x.split(":").filter(Boolean).map((g) => parseInt(g, 16));
  const h = groups(head), t = groups(tail);
  const w = [...h, ...Array(8 - h.length - t.length).fill(0), ...t];
  const v4 = (x: number, y: number) => `${x >> 8}.${x & 255}.${y >> 8}.${y & 255}`;
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => !x)) return v4(w[6], w[7]);
  if (w[0] === 0x2002) return v4(w[1], w[2]);
  if (w.slice(0, 6).every((x) => !x) && w[6]) return v4(w[6], w[7]);
}
const isNever = (a: string) => never.check(plain(a), family(plain(a))) || ((e) => !!e && never.check(e, "ipv4"))(embedded(plain(a)));
const isLocal = (a: string) => local.check(plain(a), family(plain(a)));
// A host name that can only mean this machine or the local network (docker service names, mDNS, .internal).
const localName = (h: string) => h === "localhost" || h.endsWith(".localhost") || !h.includes(".") || /\.(local|internal|lan|home\.arpa)$/.test(h);

// How long a local model may take to answer (headers, or a one-off request): Ollama swapping a 120B model in is ~45 s, and
// prefilling a 60k-token prompt can take minutes. Hosted providers keep providerFetch's 120 s.
export const LOCAL_MODEL_TIMEOUT = 600_000;
// A base URL on this machine or the local network, by its host alone (no DNS).
export function isLocalUrl(raw: string) {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return isIP(host) ? isLocal(host) : localName(host);
  } catch {
    return false;
  }
}

// The parts of the policy that need no DNS: for validating a base URL when it is saved.
export function checkUrl(raw: string): URL {
  // A ? or # would swallow the path Polaris appends, letting the base URL choose the request path.
  if (/[?#]/.test(raw)) throw new EgressError("base URL must not contain a query string or fragment");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new EgressError("base URL must be an http(s) URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new EgressError("base URL must be an http(s) URL");
  if (u.username || u.password) throw new EgressError("base URL must not contain credentials: put the key in the API key field");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) && isNever(host)) throw new EgressError(`${host} is a link-local, multicast or unspecified address (cloud metadata lives there): refused`);
  if (u.protocol === "http:" && !allowHttp() && !(isIP(host) ? isLocal(host) : localName(host)))
    throw new EgressError(`plain http to ${host} would send the key unencrypted over the internet: use https (or set POLARIS_ALLOW_HTTP_PROVIDERS=1 for a trusted network)`);
  return u;
}
const allowHttp = () => process.env.POLARIS_ALLOW_HTTP_PROVIDERS === "1";

// The lookup every provider connection dials through: the same address policy, judged on the addresses the socket will
// actually use (a check made earlier, and cached, could be rebound by a TTL-0 DNS answer). `resolve` is for tests.
export function guardedLookup(protocol: string, resolve: typeof dnsLookup = dnsLookup) {
  return (host: string, opts: { all?: boolean; family?: number }, cb: (err: Error | null, addr?: any, family?: number) => void) =>
    resolve(host, { family: opts.family, all: true, verbatim: true }, (err, list) => {
      const addrs = (list as unknown as { address: string; family: number }[] | undefined) ?? [];
      if (err || !addrs.length) return cb(new EgressError(`cannot resolve ${host}`));
      const bad = addrs.find((a) => isNever(a.address));
      if (bad) return cb(new EgressError(`${host} resolves to ${bad.address}, a link-local, multicast or unspecified address: refused`));
      if (protocol === "http:" && !allowHttp() && addrs.some((a) => !isLocal(a.address)))
        return cb(new EgressError(`${host} resolves to a public address: plain http would send the key unencrypted, use https (or set POLARIS_ALLOW_HTTP_PROVIDERS=1)`));
      opts.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
    });
}

// fetch for provider calls: the policy above, no redirects, and a deadline for the response headers (the body keeps
// streaming under the caller's own signal). Policy failures are EgressError, never worth a retry. It speaks node:http
// rather than fetch because fetch offers no hook on the address it dials. ponytail: string bodies only (all callers send JSON).
export async function providerFetch(url: string, init: RequestInit = {}, headersTimeoutMs = 120_000) {
  const u = checkUrl(url);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), headersTimeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
  try {
    return await new Promise<Response>((resolve, reject) => {
      const req = (u.protocol === "https:" ? https : http).request(u, { method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)), lookup: guardedLookup(u.protocol) as any, signal }, (res) => {
        clearTimeout(timer);
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) return res.destroy(), reject(new EgressError(`${u.origin} answered with a redirect: refused (the key would follow it)`));
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const x of [v ?? []].flat()) headers.append(k, x);
        resolve(new Response([101, 204, 205, 304].includes(status) ? null : (Readable.toWeb(res) as ReadableStream), { status, statusText: res.statusMessage, headers }));
      });
      req.on("error", reject);
      req.end(init.body as string | undefined);
    });
  } catch (e) {
    if (init.signal?.aborted) throw e;
    if (deadline.signal.aborted) throw new EgressError(`${u.origin} sent no response within ${Math.round(headersTimeoutMs / 1000)} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// An error body, at most `max` bytes (a misbehaving endpoint must not make us buffer megabytes).
export const ERROR_BODY_MAX = 64 * 1024;
export async function cappedText(res: Response, max = ERROR_BODY_MAX) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

// Common key and token shapes, and any known secret, replaced before text reaches events, transcripts, the UI or a
// model prompt. Provider error bodies sometimes echo the key they were sent.
const SECRET = /\b(sk-[\w-]{16,}|ghp_\w{20,}|github_pat_\w{20,}|xox[abp]-[\w-]{10,}|AKIA[0-9A-Z]{16})\b|(Bearer\s+)[\w.~+/-]{12,}=*/g;
export function scrub(s: string, secrets: string[] = []) {
  let out = s.replace(SECRET, (_m, _key, bearer) => (bearer ? `${bearer}[redacted]` : "[redacted]"));
  for (const k of secrets) if (k.length >= 6) out = out.split(k).join("[redacted]");
  return out;
}
