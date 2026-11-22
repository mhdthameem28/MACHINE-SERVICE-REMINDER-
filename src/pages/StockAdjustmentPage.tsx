import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { formatWithUnit, todayInputValue } from '../lib/format';
import { MaterialStockRow } from './DashboardPage';

const ADJUSTMENT_REASONS = [
  'Physical Count Correction',
  'Material Damage',
  'Scrap / Offcut Loss',
  'Supplier Return',
  'Quality Rejection',
  'Other',
];

export const StockAdjustmentPage: React.FC = () => {
  const { apiFetch } = useAuth();
  const [materials, setMaterials] = useState<MaterialStockRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [materialId, setMaterialId] = useState('');
  const [direction, setDirection] = useState<'decrease' | 'increase'>('decrease');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState(ADJUSTMENT_REASONS[0]);
  const [customReason, setCustomReason] = useState('');
  const [movementDate, setMovementDate] = useState(todayInputValue());
  const [note, setNote] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const loadMaterials = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ materials: MaterialStockRow[] }>('/api/materials');
      setMaterials(res.materials);
      if (!materialId && res.materials.length > 0) {
        setMaterialId(String(res.materials[0].id));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load materials');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMaterials();
  }, []);

  const selectedMaterial = materials.find((m) => String(m.id) === materialId) ?? null;
  const parsedAmt = Number(amount);
  const signedQty =
    Number.isFinite(parsedAmt) && parsedAmt > 0
      ? direction === 'decrease'
        ? -parsedAmt
        : parsedAmt
      : 0;
  const projectedStock = selectedMaterial
    ? Number((selectedMaterial.currentStock + signedQty).toFixed(4))
    : 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    if (!selectedMaterial) {
      setError('Please select a material.');
      return;
    }
    if (!Number.isFinite(parsedAmt) || parsedAmt <= 0) {
      setError('Adjustment amount must be greater than zero.');
      return;
    }
    if (projectedStock < 0) {
      setError(
        `Adjustment would make stock negative (${formatWithUnit(projectedStock, selectedMaterial.unit)}).`
      );
      return;
    }

    const finalReason = reason === 'Other' ? customReason.trim() : reason;
    if (!finalReason) {
      setError('Please provide an adjustment reason.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<{
        previousStock: number;
        currentStock: number;
        reorderAlertTriggered: boolean;
      }>('/api/stock/adjust', {
        method: 'POST',
        body: JSON.stringify({
          materialId: selectedMaterial.id,
          quantity: signedQty,
          reason: finalReason,
          movementDate,
          note: note.trim() || undefined,
        }),
      });

      setSuccessMsg(
        `Stock adjusted for ${selectedMaterial.code}: ${formatWithUnit(
          res.previousStock,
          selectedMaterial.unit
        )} → ${formatWithUnit(res.currentStock, selectedMaterial.unit)}${
          res.reorderAlertTriggered ? ' (Reorder alert dispatched)' : ''
        }.`
      );
      setAmount('');
      setNote('');
      setCustomReason('');
      await loadMaterials();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record adjustment');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="h-80 bg-white border border-slate-200 rounded-lg animate-pulse" />;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Stock Adjustment</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Record positive or negative ledger corrections with an audited reason.
        </p>
      </div>

      {successMsg && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-2 text-xs font-medium text-emerald-900">
          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {error && (
        <div className="p-3 rounded-md bg-red-50 border border-red-200 flex items-start gap-2 text-xs text-red-800">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="bg-white border border-slate-200 rounded-lg p-6 space-y-5"
      >
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1.5">
            Material
          </label>
          <select
            value={materialId}
            onChange={(e) => setMaterialId(e.target.value)}
            required
            className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-slate-400"
          >
            {materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code} — {m.name} (Current: {formatWithUnit(m.currentStock, m.unit)})
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Direction
            </label>
            <div className="flex p-1 bg-slate-100 rounded-md">
              <button
                type="button"
                onClick={() => setDirection('decrease')}
                className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${
                  direction === 'decrease'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Deduct (−)
              </button>
              <button
                type="button"
                onClick={() => setDirection('increase')}
                className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${
                  direction === 'increase'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Add (+)
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Quantity {selectedMaterial ? `(${selectedMaterial.unit})` : ''}
            </label>
            <input
              type="number"
              step="any"
              min="0.001"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              required
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-slate-400"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Adjustment Date
            </label>
            <input
              type="date"
              value={movementDate}
              onChange={(e) => setMovementDate(e.target.value)}
              required
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-slate-400"
            />
          </div>
        </div>

        {selectedMaterial && (
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-md flex flex-wrap items-center justify-between gap-4 text-xs font-mono tabular-nums">
            <span className="text-slate-600">
              Current Stock: {formatWithUnit(selectedMaterial.currentStock, selectedMaterial.unit)}
            </span>
            <span
              className={`font-semibold ${
                projectedStock < 0
                  ? 'text-red-700'
                  : projectedStock <= selectedMaterial.reorderLevel
                  ? 'text-amber-700'
                  : 'text-slate-900'
              }`}
            >
              Projected Balance: {formatWithUnit(projectedStock, selectedMaterial.unit)}
            </span>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1.5">
            Reason
          </label>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-slate-400"
          >
            {ADJUSTMENT_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        {reason === 'Other' && (
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Specify Reason
            </label>
            <input
              type="text"
              value={customReason}
              onChange={(e) => setCustomReason(e.target.value)}
              required
              placeholder="Enter adjustment reason"
              className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-slate-400"
            />
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1.5">
            Notes (optional)
          </label>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Audit count sheet reference, damage details, etc."
            className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-slate-400"
          />
        </div>

        <div className="pt-2 flex items-center justify-end">
          <button
            type="submit"
            disabled={submitting || !selectedMaterial}
            className="px-5 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {submitting ? 'Saving Adjustment...' : 'Record Adjustment'}
          </button>
        </div>
      </form>
    </div>
  );
};
