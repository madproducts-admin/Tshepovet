import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

/**
 * Webhook targets are chosen by customers, so a delivery must never reach anything that is
 * not the public internet: not this box's own services (the API, Redis, PostgreSQL and every
 * other app listen on loopback), not the hosting network, not cloud metadata addresses.
 *
 * Two checks, both needed:
 *  - when an endpoint is saved (assertPublicWebhookUrl), so the customer is told at once;
 *  - when a delivery connects (guardedWebhookFetch), against the address actually dialled,
 *    so a hostname that later re-resolves to a private address (DNS rebinding) is refused.
 */

// Two lists, never one: Node's BlockList checks an IPv4 address against IPv4-mapped IPv6
// rules as well, so ::ffff:0:0/96 in a shared list would block every IPv4 address.
const BLOCKED4 = new net.BlockList();
const BLOCKED6 = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
] as const) {
  BLOCKED4.addSubnet(net4, prefix, 'ipv4');
}
for (const [net6, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::ffff:0:0', 96], // IPv4-mapped: would smuggle any IPv4 address past the list above
  ['64:ff9b::', 96], // NAT64: the same
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments (Teredo, ORCHID, ...)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4: embeds an IPv4 address
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED6.addSubnet(net6, prefix, 'ipv6');
}

/** True only for a public unicast address that is not on the extra deny list. */
export function isPublicAddress(ip: string, deny: ReadonlySet<string> = new Set()): boolean {
  const family = net.isIP(ip);
  if (!family) return false;
  if (deny.has(ip)) return false;
  return family === 4 ? !BLOCKED4.check(ip, 'ipv4') : !BLOCKED6.check(ip, 'ipv6');
}

export function parseDenyList(csv: string): Set<string> {
  return new Set(
    csv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => net.isIP(s)),
  );
}

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];

/**
 * Why this URL cannot be a webhook endpoint, or null when it can. Resolves the hostname: it
 * must exist and every address it has must be public.
 */
export async function webhookUrlProblem(raw: string, deny: ReadonlySet<string> = new Set()): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'Enter a full URL, starting with https://';
  }
  if (u.protocol !== 'https:') return 'Webhook URLs must use https://';
  if (u.username || u.password) return 'Put credentials in your receiver, not in the URL.';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) return isPublicAddress(host, deny) ? null : 'That address is not on the public internet.';
  if (host === 'localhost' || !host.includes('.') || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) {
    return 'Use a hostname on the public internet.';
  }
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    return `${host} could not be found. Check the hostname.`;
  }
  if (!addresses.length) return `${host} could not be found. Check the hostname.`;
  if (addresses.some((a) => !isPublicAddress(a.address, deny))) return `${host} resolves to an address that is not on the public internet.`;
  return null;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** A dns.lookup that only ever returns public addresses (for net/https `lookup`). */
export function publicOnlyLookup(deny: ReadonlySet<string>) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const ok = (addresses as dns.LookupAddress[]).filter((a) => isPublicAddress(a.address, deny));
      if (!ok.length) {
        const e: NodeJS.ErrnoException = new Error(`${hostname} does not resolve to a public address`);
        e.code = 'EBLOCKED';
        return callback(e, []);
      }
      if (options.all) return callback(null, ok);
      return callback(null, ok[0]!.address, ok[0]!.family);
    });
  };
}

export type WebhookFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect?: string; signal?: AbortSignal }) => Promise<{ status: number }>;

/**
 * POSTs a webhook over HTTPS to a public address only. Resolves with the status code as soon
 * as the response headers arrive (the body is never read), never follows a redirect, and
 * gives up after 10 seconds.
 */
export function guardedWebhookFetch(denyCsv = ''): WebhookFetch {
  const deny = parseDenyList(denyCsv);
  const lookup = publicOnlyLookup(deny);
  return (url, init) =>
    new Promise((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return reject(new Error('invalid webhook URL'));
      }
      if (u.protocol !== 'https:') return reject(new Error('webhook URLs must use https'));
      // An IP literal skips DNS (and so the guarded lookup): check it here.
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(host) && !isPublicAddress(host, deny)) return reject(new Error('webhook target is not a public address'));

      const req = https.request(u, { method: 'POST', headers: init.headers, lookup: lookup as never, timeout: 10_000 }, (res) => {
        resolve({ status: res.statusCode ?? 0 });
        res.destroy();
      });
      req.on('timeout', () => req.destroy(new Error('no response within 10 seconds')));
      req.on('error', reject);
      init.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
      req.end(init.body);
    });
}
