// getRandomValues also works during HTTP LAN previews; randomUUID requires HTTPS.
export function newId(): string {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = bytes[6] & 15 | 64;
  bytes[8] = bytes[8] & 63 | 128;
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
