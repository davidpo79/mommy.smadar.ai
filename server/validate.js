export class HttpError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const bad = (code, details) => new HttpError(400, code, details);

export function asName(value, { required = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw bad('name_required');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) throw bad('name_required');
  if (name.length > 80) throw bad('name_too_long');
  return name;
}

export function asBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw bad('invalid_boolean');
}

export function asRate(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 100000) throw bad('invalid_rate');
  return Math.round(num * 100) / 100;
}

export function asMinute(value, field) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0 || num > 1439) throw bad(`invalid_${field}`);
  return num;
}

export function asDay(value) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0 || num > 6) throw bad('invalid_day');
  return num;
}

export function asText(value, fallback = '', max = 2000) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw bad('invalid_text');
  if (value.length > max) throw bad('text_too_long');
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asUuid(value, { nullable = false } = {}) {
  if ((value === null || value === '' || value === undefined) && nullable) return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw bad('invalid_id');
  return value;
}

export function asVersion(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) throw bad('invalid_version');
  return num;
}

export function asChecklistText(value) {
  if (typeof value !== 'string') throw bad('text_required');
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) throw bad('text_required');
  if (text.length > 300) throw bad('text_too_long');
  return text;
}
