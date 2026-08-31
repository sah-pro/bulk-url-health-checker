import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * SSRF protection for arbitrary user-supplied URLs.
 * Every hostname is resolved before a request is made and every redirect
 * target is validated again. Private, loopback, link-local, benchmark,
 * multicast, unspecified and otherwise reserved address ranges are rejected.
 *
 * DNS rebinding remains a limitation of the platform fetch stack because the
 * validation lookup and the eventual socket lookup are separate operations.
 * Redirect validation closes the common redirect-based SSRF path; the README
 * documents the residual DNS-rebinding boundary honestly.
 */

function ipv4Parts(address: string): [number, number, number, number] | null {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return true;
  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function parseIpv4MappedIpv6(address: string): string | null {
  const lower = address.toLowerCase();
  if (!lower.includes(':')) return null;

  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return ipv4Parts(dotted[1]!) ? dotted[1]! : null;

  const parts = lower.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const expanded = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (expanded.length !== 8 || expanded.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  if (expanded.slice(0, 5).some((group) => group !== '0') || expanded[5] !== 'ffff') return null;

  const high = Number.parseInt(expanded[6]!, 16);
  const low = Number.parseInt(expanded[7]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isPrivateOrReservedIp(address: string): boolean {
  const version = net.isIP(address);
  if (version === 0) return true;

  if (version === 4) return isPrivateOrReservedIpv4(address);

  const mapped = parseIpv4MappedIpv6(address);
  if (mapped) return isPrivateOrReservedIpv4(mapped);

  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

export class SsrfBlockedError extends Error {}

/** Throws SsrfBlockedError if the hostname resolves to a disallowed address. */
export async function assertNotPrivateTarget(hostname: string): Promise<void> {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');

  if (net.isIP(normalizedHostname) !== 0) {
    if (isPrivateOrReservedIp(normalizedHostname)) {
      throw new SsrfBlockedError(`Target IP ${hostname} is private/reserved.`);
    }
    return;
  }

  if (normalizedHostname === 'localhost' || normalizedHostname.endsWith('.localhost')) {
    throw new SsrfBlockedError('localhost is not an allowed target.');
  }

  let addresses: string[];
  try {
    const results = await dns.lookup(normalizedHostname, { all: true });
    addresses = results.map((result) => result.address);
  } catch {
    throw new SsrfBlockedError(`DNS resolution failed for ${hostname}.`);
  }

  if (addresses.length === 0 || addresses.some(isPrivateOrReservedIp)) {
    const blocked = addresses.find(isPrivateOrReservedIp);
    throw new SsrfBlockedError(
      blocked
        ? `${hostname} resolves to private/reserved address ${blocked}.`
        : `${hostname} did not resolve to a valid address.`,
    );
  }
}
