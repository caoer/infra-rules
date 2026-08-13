/**
 * IPv4 CIDR math on unsigned 32-bit integers. Zero dependencies by decision
 * D16 (spike evidence on the u2-cidr-validate task card, 2026-08-13): both
 * candidate libraries answered containment/overlap correctly, but neither
 * rejects a non-canonical base ("10.20.1.7/14"), so the canonicality check
 * below had to be written either way — and the whole v4-only surface is four
 * pure functions.
 *
 * Callers feed these functions zod-validated strings (`z.ipv4()` /
 * `z.cidrv4()`); malformed input throws TypeError as a programmer-error
 * guard, never as a validation surface.
 */

export interface Cidr {
  /** Base address exactly as written, host bits intact. */
  base: number;
  /** Network address: base with host bits cleared. */
  network: number;
  /** Prefix length, 0-32. */
  prefix: number;
  /** Netmask as uint32. */
  mask: number;
}

/** Dotted-quad IPv4 → unsigned 32-bit integer. */
export function ipToUint32(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new TypeError(`not an IPv4 address: "${ip}"`);
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== part) {
      throw new TypeError(`not an IPv4 address: "${ip}"`);
    }
    value = value * 256 + octet;
  }
  return value;
}

/** Unsigned 32-bit integer → dotted-quad IPv4. */
export function uint32ToIp(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    ".",
  );
}

/** Netmask for a prefix length. JS shift counts are mod 32, so /0 is guarded. */
export function maskForPrefix(prefix: number): number {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new TypeError(`not an IPv4 prefix length: ${prefix}`);
  }
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

export function parseCidr(cidr: string): Cidr {
  const slash = cidr.indexOf("/");
  if (slash === -1) throw new TypeError(`not CIDR notation: "${cidr}"`);
  const base = ipToUint32(cidr.slice(0, slash));
  const prefixText = cidr.slice(slash + 1);
  const prefix = Number(prefixText);
  if (String(prefix) !== prefixText) throw new TypeError(`not CIDR notation: "${cidr}"`);
  const mask = maskForPrefix(prefix);
  return { base, network: (base & mask) >>> 0, prefix, mask };
}

/**
 * True when the written base has host bits set ("10.20.1.7/14"). Both spiked
 * libraries and `z.cidrv4()` accept such a value silently and mask it away;
 * the integrity layer treats it as a violation instead, because the author
 * either meant a different range or misread this one.
 */
export function hasHostBits(cidr: string): boolean {
  const parsed = parseCidr(cidr);
  return parsed.base !== parsed.network;
}

/** Canonical form of a CIDR: network address + prefix, host bits cleared. */
export function canonicalCidr(cidr: string): string {
  const parsed = parseCidr(cidr);
  return `${uint32ToIp(parsed.network)}/${parsed.prefix}`;
}

/** Is `ip` inside `cidr`? */
export function cidrContainsIp(cidr: string, ip: string): boolean {
  const parsed = parseCidr(cidr);
  return ((ipToUint32(ip) & parsed.mask) >>> 0) === parsed.network;
}

/**
 * Do two CIDR ranges share any address? CIDR blocks are laminar — nested or
 * disjoint, partial overlap cannot exist — so this reduces to comparing both
 * network addresses under the shorter prefix's mask.
 */
export function cidrsOverlap(a: string, b: string): boolean {
  const ca = parseCidr(a);
  const cb = parseCidr(b);
  const mask = ca.prefix <= cb.prefix ? ca.mask : cb.mask;
  return ((ca.network & mask) >>> 0) === ((cb.network & mask) >>> 0);
}
