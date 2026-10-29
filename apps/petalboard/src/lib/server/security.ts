import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(pin.normalize('NFKC'), salt, KEY_LENGTH, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });

  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPin(pin: string, hash: string): boolean {
  const [saltHex, keyHex] = hash.split(':');
  if (!saltHex || !keyHex) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const existing = Buffer.from(keyHex, 'hex');
  const computed = scryptSync(pin.normalize('NFKC'), salt, existing.length, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });

  return timingSafeEqual(existing, computed);
}
