export class ControlError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.name = 'ControlError'; this.code = code; this.status = status;
  }
}
export function requireValue(condition, code, message, status) {
  if (!condition) throw new ControlError(code, message, status);
}
