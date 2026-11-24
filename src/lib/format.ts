export function formatNumber(val: number | string | null | undefined, maxDecimals = 3): string {
  if (val === null || val === undefined || val === '') return '0';
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num)) return String(val);
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
}

export function sanitizeDisplayUnit(unit?: string): string {
  if (!unit) return '';
  const trimmed = unit.trim();
  const match = trimmed.match(/^[\d.,\s]+([a-zA-Z]+)$/);
  if (match && match[1]) {
    return match[1].toLowerCase();
  }
  return trimmed;
}

export function formatWithUnit(val: number | string | null | undefined, unit?: string): string {
  const numStr = formatNumber(val);
  const cleanUnit = sanitizeDisplayUnit(unit);
  return cleanUnit ? `${numStr} ${cleanUnit}` : numStr;
}

export function formatDate(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return d.toISOString().slice(0, 10);
}

export function formatDateTime(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

export function todayInputValue(): string {
  return new Date().toISOString().slice(0, 10);
}
