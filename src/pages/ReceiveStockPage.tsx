import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, Info } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { formatWithUnit, todayInputValue } from '../lib/format';
import { MaterialStockRow } from './DashboardPage';

interface MaterialWithOpening extends MaterialStockRow {
  hasMovements: boolean;
}

interface StageRow {
  id: number;
  name: string;
  sequence: number;
  active: boolean;
}

interface ReceiveStockPageProps {
  initialMaterialId?: number;
  onOpenBatch: (batchId: string) => void;
}

export const ReceiveStockPage: React.FC<ReceiveStockPageProps> = ({
  initialMaterialId,
  onOpenBatch,
}) => {
  const { apiFetch } = useAuth();
  const [materials, setMaterials] = useState<MaterialWithOpening[]>([]);
  const [stages, setStages] = useState<StageRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [materialId, setMaterialId] = useState<string>(
    initialMaterialId ? String(initialMaterialId) : ''
  );
  const [quantity, setQuantity] = useState('');
  const [movementDate, setMovementDate] = useState(todayInputValue());
  const [sendToLaserCutting, setSendToLaserCutting] = useState(false);
  const [note, setNote] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receiptResult, setReceiptResult] = useState<{
    batchId: string;
    isOpening: boolean;
    stageName: string;
    currentStock: number;
    unit: string;
    reorderAlertTriggered: boolean;
  } | null>(null);

  const loadReferenceData = async () => {
    setLoading(true);
    try {
      const [matRes, stageRes] = await Promise.all([
        apiFetch<{ materials: MaterialWithOpening[] }>('/api/materials'),
        apiFetch<{ stages: StageRow[] }>('/api/stages'),
      ]);
      setMaterials(matRes.materials);
      setStages(stageRes.stages.filter((s) => s.active).sort((a, b) => a.sequence - b.sequence));
      if (!materialId && matRes.materials.length > 0) {
        setMaterialId(
          initialMaterialId ? String(initialMaterialId) : String(matRes.materials[0].id)
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load materials');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReferenceData();
  }, []);

  const selectedMaterial = materials.find((m) => String(m.id) === materialId) ?? null;
  const stage1 = stages[0];
  const stage2 = stages[1];
  const isOpeningPreview = selectedMaterial ? !selectedMaterial.hasMovements : false;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setReceiptResult(null);

    const qtyNum = Number(quantity);
    if (!selectedMaterial) {
      setError('Please select a material.');
      return;
    }
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      setError('Please enter a valid positive quantity.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<{
        batch: { id: string };
        isOpening: boolean;
        currentStage: { name: string };
        currentStock: number;
        material: { unit: string };
        reorderAlertTriggered: boolean;
      }>('/api/stock/receive', {
        method: 'POST',
        body: JSON.stringify({
          materialId: selectedMaterial.id,
          quantity: qtyNum,
          movementDate,
          sendToLaserCutting,
          note: note.trim() || undefined,
        }),
      });

      setReceiptResult({
        batchId: res.batch.id,
        isOpening: res.isOpening,
        stageName: res.currentStage.name,
        currentStock: res.currentStock,
        unit: res.material.unit,
        reorderAlertTriggered: res.reorderAlertTriggered,
      });
      setQuantity('');
      setNote('');
      setSendToLaserCutting(false);
      await loadReferenceData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to receive stock');
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
        <h2 className="text-lg font-semibold text-slate-900">Receive Raw Material</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Record incoming stock, automatically tag first-time opening stock, and create a tracked production batch.
        </p>
      </div>

      {receiptResult && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
              <CheckCircle2 className="w-4 h-4 text-emerald-700" />
              <span>Stock Received &amp; Batch Created</span>
            </div>
            <button
              type="button"
              onClick={() => onOpenBatch(receiptResult.batchId)}
              className="text-xs font-medium text-emerald-900 underline underline-offset-2 inline-flex items-center gap-1"
            >
              <span>Open {receiptResult.batchId}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="text-xs text-emerald-800 space-y-0.5 font-mono tabular-nums">
            <div>
              Batch ID: {receiptResult.batchId} · Current Stage: {receiptResult.stageName}
              {receiptResult.isOpening ? ' · Flagged as Opening Stock' : ''}
            </div>
            <div>
              Updated Raw Stock Balance: {formatWithUnit(receiptResult.currentStock, receiptResult.unit)}
              {receiptResult.reorderAlertTriggered ? ' · Reorder alert dispatched' : ''}
            </div>
          </div>
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
            Raw Material
          </label>
          <select
            value={materialId}
            onChange={(e) => setMaterialId(e.target.value)}
            required
            className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-slate-400"
          >
            {materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code} — {m.name} ({m.unit})
              </option>
            ))}
          </select>

          {selectedMaterial && (
            <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-slate-600 font-mono tabular-nums">
              <span>
                Current Stock: {formatWithUnit(selectedMaterial.currentStock, selectedMaterial.unit)}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Reorder Level: {formatWithUnit(selectedMaterial.reorderLevel, selectedMaterial.unit)}
              </span>
            </div>
          )}

          {isOpeningPreview && (
            <div className="mt-3 p-3 rounded-md bg-amber-50 border border-amber-200 flex items-start gap-2 text-xs text-amber-900">
              <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
              <span>
                No prior movements found for this material. This receipt will automatically be flagged as{' '}
                <strong>Opening Stock</strong>.
              </span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Quantity {selectedMaterial ? `(${selectedMaterial.unit})` : ''}
            </label>
            <input
              type="number"
              step="any"
              min="0.001"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="0.00"
              required
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-slate-400"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Receipt Date
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

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1.5">
            Reference Note (optional)
          </label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Supplier invoice, heat number, or delivery challan"
            className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-slate-400"
          />
        </div>

        {stage2 && (
          <div className="pt-2 border-t border-slate-200">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={sendToLaserCutting}
                onChange={(e) => setSendToLaserCutting(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              <div>
                <div className="text-sm font-medium text-slate-900">
                  Send to {stage2.name} now?
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Creates the batch at {stage1?.name ?? 'Stage 01'} and immediately advances it to{' '}
                  {stage2.name} with matching timestamp and user stamp, issuing the quantity from raw stock.
                </div>
              </div>
            </label>
          </div>
        )}

        <div className="pt-2 flex items-center justify-end gap-3">
          <button
            type="submit"
            disabled={submitting || !selectedMaterial}
            className="px-5 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {submitting ? 'Recording Receipt...' : 'Record Stock Receipt'}
          </button>
        </div>
      </form>
    </div>
  );
};
