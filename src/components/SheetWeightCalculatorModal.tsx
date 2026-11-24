import React, { useState } from 'react';
import { Calculator, Check, Copy, RotateCcw, X } from 'lucide-react';

interface SheetWeightCalculatorModalProps {
  open: boolean;
  onClose: () => void;
}

const DENSITY_PRESETS = [
  { label: 'MS (7.85)', value: '7.85' },
  { label: 'SS (7.93)', value: '7.93' },
  { label: 'SS 316L (7.98)', value: '7.98' },
  { label: 'Ti (4.50)', value: '4.5' },
];

function formatKg(val: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(val);
}

export const SheetWeightCalculatorModal: React.FC<SheetWeightCalculatorModalProps> = ({
  open,
  onClose,
}) => {
  const [lengthMm, setLengthMm] = useState('');
  const [widthMm, setWidthMm] = useState('');
  const [thicknessMm, setThicknessMm] = useState('');
  const [density, setDensity] = useState('7.85');
  const [quantity, setQuantity] = useState('1');
  const [copiedField, setCopiedField] = useState<'sheet' | 'total' | null>(null);

  if (!open) return null;

  const l = Number(lengthMm);
  const w = Number(widthMm);
  const t = Number(thicknessMm);
  const d = Number(density);
  const q = Number(quantity);

  const hasSheetInputs =
    lengthMm.trim() !== '' &&
    widthMm.trim() !== '' &&
    thicknessMm.trim() !== '' &&
    density.trim() !== '' &&
    Number.isFinite(l) &&
    Number.isFinite(w) &&
    Number.isFinite(t) &&
    Number.isFinite(d) &&
    l > 0 &&
    w > 0 &&
    t > 0 &&
    d > 0;

  const weightPerSheet = hasSheetInputs ? (l * w * t * d) / 1_000_000 : null;
  const hasQty = quantity.trim() !== '' && Number.isFinite(q) && q > 0;
  const totalWeight = weightPerSheet !== null && hasQty ? weightPerSheet * q : null;

  const handleReset = () => {
    setLengthMm('');
    setWidthMm('');
    setThicknessMm('');
    setDensity('7.85');
    setQuantity('1');
    setCopiedField(null);
  };

  const handleCopy = async (val: number, field: 'sheet' | 'total') => {
    try {
      await navigator.clipboard.writeText(String(Number(val.toFixed(4))));
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1800);
    } catch {
      // Clipboard API unavailable in restricted context
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-600 flex items-center justify-center shrink-0">
              <Calculator className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold tracking-tight text-slate-900">
                Sheet Weight Calculator
              </h3>
              <p className="text-[11px] text-slate-500">
                Helper tool — read the weight below to enter into Receive Stock
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-200/60 transition-colors"
            aria-label="Close calculator"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                Length (mm)
              </label>
              <input
                type="number"
                step="any"
                min="0"
                value={lengthMm}
                onChange={(e) => setLengthMm(e.target.value)}
                placeholder="e.g., 2500"
                autoFocus
                className="w-full px-3.5 py-2.5 text-sm font-normal tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                Width (mm)
              </label>
              <input
                type="number"
                step="any"
                min="0"
                value={widthMm}
                onChange={(e) => setWidthMm(e.target.value)}
                placeholder="e.g., 1250"
                className="w-full px-3.5 py-2.5 text-sm font-normal tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                Thickness (mm)
              </label>
              <input
                type="number"
                step="any"
                min="0"
                value={thicknessMm}
                onChange={(e) => setThicknessMm(e.target.value)}
                placeholder="e.g., 2"
                className="w-full px-3.5 py-2.5 text-sm font-normal tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                Quantity (Sheets)
              </label>
              <input
                type="number"
                step="any"
                min="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="e.g., 10"
                className="w-full px-3.5 py-2.5 text-sm font-normal tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
              />
            </div>
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <label className="text-xs font-medium text-slate-600">
                Density (g/cm³)
              </label>
              <div className="flex flex-wrap items-center gap-1">
                {DENSITY_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => setDensity(preset.value)}
                    className={`px-2 py-0.5 text-[10px] rounded-md border transition-colors ${
                      density === preset.value
                        ? 'bg-indigo-50 border-indigo-300 text-indigo-600 font-semibold'
                        : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <input
              type="number"
              step="any"
              min="0"
              value={density}
              onChange={(e) => setDensity(e.target.value)}
              placeholder="e.g., 7.85 for MS, 7.93 for SS"
              className="w-full px-3.5 py-2.5 text-sm font-normal tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
            />
          </div>

          {/* Live Results Panel */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 divide-y divide-slate-200 overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-slate-600">Weight per Sheet</div>
                <div className="text-[11px] font-mono text-slate-400">
                  (L × W × T × D) / 1,000,000
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold font-mono tabular-nums text-slate-900">
                  {weightPerSheet !== null ? `${formatKg(weightPerSheet)} kg` : '—'}
                </span>
                {weightPerSheet !== null && (
                  <button
                    type="button"
                    onClick={() => handleCopy(weightPerSheet, 'sheet')}
                    title="Copy weight per sheet"
                    className="p-1 text-slate-400 hover:text-slate-700 rounded hover:bg-slate-200/70 transition-colors"
                  >
                    {copiedField === 'sheet' ? (
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                )}
              </div>
            </div>

            <div className="px-4 py-3.5 bg-indigo-50/70 flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-slate-900">Total Weight</div>
                <div className="text-[11px] font-mono text-slate-500">
                  Weight per Sheet × Quantity
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold font-mono tabular-nums text-indigo-600">
                  {totalWeight !== null ? `${formatKg(totalWeight)} kg` : '—'}
                </span>
                {totalWeight !== null && (
                  <button
                    type="button"
                    onClick={() => handleCopy(totalWeight, 'total')}
                    title="Copy total weight"
                    className="p-1 text-indigo-600 hover:text-indigo-700 rounded hover:bg-indigo-100 transition-colors"
                  >
                    {copiedField === 'total' ? (
                      <Check className="w-4 h-4 text-emerald-600" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleReset}
            className="px-3.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1.5 rounded-lg hover:bg-slate-200/60 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
