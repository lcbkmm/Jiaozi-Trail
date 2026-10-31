export class DomainError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function insist(condition, code, message, status = 400) {
  if (!condition) throw new DomainError(code, message, status);
}
export const shanghaiDay = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
