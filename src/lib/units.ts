export const MATERIAL_UNITS = [
  'kg',
  'sheets',
  'rods',
  'qty',
  'meters',
  'liters',
] as const;

export type MaterialUnit = (typeof MATERIAL_UNITS)[number];

export const RECEIVE_STOCK_UNITS = [
  'kg',
  'sheets',
  'pcs',
  'liters',
  'meters',
  'qty',
] as const;

export type ReceiveStockUnit = (typeof RECEIVE_STOCK_UNITS)[number];

const ALLOWED_MOVEMENT_UNITS = new Set<string>([
  ...RECEIVE_STOCK_UNITS,
  ...MATERIAL_UNITS,
]);

const UNIT_ALIASES: Record<string, MaterialUnit> = {
  kg: 'kg',
  kgs: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  sheet: 'sheets',
  sheets: 'sheets',
  rod: 'rods',
  rods: 'rods',
  qty: 'qty',
  pcs: 'qty',
  pc: 'qty',
  piece: 'qty',
  pieces: 'qty',
  unit: 'qty',
  units: 'qty',
  m: 'meters',
  meter: 'meters',
  meters: 'meters',
  metre: 'meters',
  metres: 'meters',
  l: 'liters',
  liter: 'liters',
  liters: 'liters',
  litre: 'liters',
  litres: 'liters',
};

export function isValidMaterialUnit(value: string): value is MaterialUnit {
  return (MATERIAL_UNITS as readonly string[]).includes(value);
}

export function normalizeMaterialUnit(raw: unknown): MaterialUnit | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  return UNIT_ALIASES[cleaned] ?? null;
}

export function normalizeReceiveUnit(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  if (ALLOWED_MOVEMENT_UNITS.has(cleaned)) return cleaned;
  return UNIT_ALIASES[cleaned] ?? null;
}
