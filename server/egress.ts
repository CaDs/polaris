import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Outbound calls to model providers carry API keys, so they all go through providerFetch (SPEC "Provider egress"):
// - http(s) only, no credentials in the URL (keys go in headers, never in a URL that ends up in logs);
// - never to link-local, unspecified or multicast addresses (cloud metadata endpoints live there);
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
const isNever = (a: string) => never.check(plain(a), family(plain(a)));
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

// The full policy, with the addresses the host resolves to now (a name can point anywhere). Cached per origin briefly.
const checked = new Map<string, number>();
const CHECK_TTL = 60_000;
export async function checkEndpoint(raw: string) {
  const u = checkUrl(raw);
  if ((checked.get(u.origin) ?? 0) > Date.now()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    throw new EgressError(`cannot resolve ${host}`);
  }
  const bad = addrs.find(isNever);
  if (bad) throw new EgressError(`${host} resolves to ${bad}, a link-local, multicast or unspecified address: refused`);
  if (u.protocol === "http:" && !allowHttp() && addrs.some((a) => !isLocal(a)))
    throw new EgressError(`${host} resolves to a public address: plain http would send the key unencrypted, use https (or set POLARIS_ALLOW_HTTP_PROVIDERS=1)`);
  checked.set(u.origin, Date.now() + CHECK_TTL);
  return u;
}

// fetch for provider calls: the policy above, no redirects, and a deadline for the response headers (the body keeps
// streaming under the caller's own signal). Policy failures are EgressError, never worth a retry.
export async function providerFetch(url: string, init: RequestInit = {}, headersTimeoutMs = 120_000) {
  const u = await checkEndpoint(url);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), headersTimeoutMs);
  try {
    return await fetch(url, { ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal });
  } catch (e) {
    if (init.signal?.aborted) throw e;
    if (deadline.signal.aborted) throw new EgressError(`${u.origin} sent no response within ${Math.round(headersTimeoutMs / 1000)} s`);
    if (/redirect/i.test(String((e as { cause?: unknown }).cause ?? ""))) throw new EgressError(`${u.origin} answered with a redirect: refused (the key would follow it)`);
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
