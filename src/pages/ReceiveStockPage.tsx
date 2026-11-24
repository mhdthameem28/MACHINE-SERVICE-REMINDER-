import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Calculator,
  CheckCircle2,
  Info,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { formatWithUnit, todayInputValue } from '../lib/format';
import { RECEIVE_STOCK_UNITS } from '../lib/units';
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
  onOpenCalculator?: () => void;
}

export const ReceiveStockPage: React.FC<ReceiveStockPageProps> = ({
  initialMaterialId,
  onOpenBatch,
  onOpenCalculator,
}) => {
  const { apiFetch } = useAuth();
  const [materials, setMaterials] = useState<MaterialWithOpening[]>([]);
  const [stages, setStages] = useState<StageRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [materialId, setMaterialId] = useState<string>(
    initialMaterialId ? String(initialMaterialId) : ''
  );
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<string>('kg');
  const [movementDate, setMovementDate] = useState(todayInputValue());
  const [sendToLaserCutting, setSendToLaserCutting] = useState(false);
  const [partName, setPartName] = useState('');
  const [piecesQuantity, setPiecesQuantity] = useState('');
  const [knownPartNames, setKnownPartNames] = useState<string[]>([]);
  const [note, setNote] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receiptResult, setReceiptResult] = useState<{
    batchId: string;
    receivedQuantity: number;
    receivedUnit: string;
    isOpening: boolean;
    stageName: string;
    currentStock: number;
    materialUnit: string;
    reorderAlertTriggered: boolean;
  } | null>(null);

  const loadReferenceData = async () => {
    setLoading(true);
    try {
      const [matRes, stageRes, partRes] = await Promise.all([
        apiFetch<{ materials: MaterialWithOpening[] }>('/api/materials'),
        apiFetch<{ stages: StageRow[] }>('/api/stages'),
        apiFetch<{ partNames: string[] }>('/api/part-names').catch(() => ({ partNames: [] })),
      ]);
      setMaterials(matRes.materials);
      setStages(stageRes.stages.filter((s) => s.active).sort((a, b) => a.sequence - b.sequence));
      setKnownPartNames(partRes.partNames ?? []);
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

  useEffect(() => {
    if (selectedMaterial) {
      const defaultUnit = (RECEIVE_STOCK_UNITS as readonly string[]).includes(
        selectedMaterial.unit
      )
        ? selectedMaterial.unit
        : 'kg';
      setUnit(defaultUnit);
    }
  }, [selectedMaterial?.id]);

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

    const piecesNum = Number(piecesQuantity);
    if (sendToLaserCutting) {
      if (!partName.trim()) {
        setError('Please enter or select a Part Name when dispatching directly to Laser Cutting.');
        return;
      }
      if (!Number.isInteger(piecesNum) || piecesNum <= 0) {
        setError('Please enter a valid whole number of pieces produced (1 or greater).');
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<{
        batch: { id: string; quantity: number };
        isOpening: boolean;
        currentStage: { name: string };
        currentStock: number;
        unit?: string;
        material: { unit: string };
        reorderAlertTriggered: boolean;
      }>('/api/stock/receive', {
        method: 'POST',
        body: JSON.stringify({
          materialId: selectedMaterial.id,
          quantity: qtyNum,
          unit,
          movementDate,
          sendToLaserCutting,
          partName: sendToLaserCutting ? partName.trim() : undefined,
          piecesQuantity: sendToLaserCutting ? piecesNum : undefined,
          note: note.trim() || undefined,
        }),
      });

      setReceiptResult({
        batchId: res.batch.id,
        receivedQuantity: qtyNum,
        receivedUnit: res.unit ?? unit,
        isOpening: res.isOpening,
        stageName: res.currentStage.name,
        currentStock: res.currentStock,
        materialUnit: res.material.unit,
        reorderAlertTriggered: res.reorderAlertTriggered,
      });
      setQuantity('');
      setNote('');
      setPartName('');
      setPiecesQuantity('');
      setSendToLaserCutting(false);
      await loadReferenceData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to receive stock');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="h-80 bg-white border border-slate-200 rounded-2xl shadow-sm animate-pulse" />;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Receive Raw Material
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Record incoming stock, automatically tag first-time opening stock, and create a tracked production batch.
          </p>
        </div>
        {onOpenCalculator && (
          <button
            type="button"
            onClick={onOpenCalculator}
            className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50/50 shadow-sm transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <Calculator className="w-3.5 h-3.5" />
            <span>Sheet Weight Calculator</span>
          </button>
        )}
      </div>

      {receiptResult && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl space-y-2">
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
              Batch ID: {receiptResult.batchId} · Received:{' '}
              {formatWithUnit(receiptResult.receivedQuantity, receiptResult.receivedUnit)} · Current Stage:{' '}
              {receiptResult.stageName}
              {receiptResult.isOpening ? ' · Flagged as Opening Stock' : ''}
            </div>
            <div>
              Updated Raw Stock Balance:{' '}
              {formatWithUnit(receiptResult.currentStock, receiptResult.materialUnit)}
              {receiptResult.reorderAlertTriggered ? ' · Reorder alert dispatched' : ''}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2 text-xs text-red-800">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 sm:p-8 space-y-5"
      >
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1.5">
            Raw Material
          </label>
          <select
            value={materialId}
            onChange={(e) => setMaterialId(e.target.value)}
            required
            className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
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
            <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200 flex items-start gap-2 text-xs text-amber-900">
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
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              Quantity
            </label>
            <div className="flex items-center bg-white border border-slate-300 rounded-lg overflow-hidden transition-colors focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20">
              <input
                type="number"
                step="any"
                min="0.001"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="0.00"
                required
                className="flex-1 min-w-0 px-3.5 py-2.5 text-sm font-normal tabular-nums text-slate-900 bg-transparent border-0 focus:outline-none focus:ring-0"
              />
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                aria-label="Unit of measurement"
                className="self-stretch px-3 py-2.5 text-sm font-normal text-slate-700 bg-transparent border-l border-slate-200 hover:bg-slate-50/70 focus:outline-none focus:ring-0 cursor-pointer shrink-0"
              >
                {RECEIVE_STOCK_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              Receipt Date
            </label>
            <input
              type="date"
              value={movementDate}
              onChange={(e) => setMovementDate(e.target.value)}
              required
              className="w-full px-3.5 py-2.5 text-sm font-normal tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1.5">
            Reference Note (optional)
          </label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Supplier invoice, heat number, or delivery challan"
            className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
          />
        </div>

        {stage2 && (
          <div className="pt-2 border-t border-slate-200 space-y-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={sendToLaserCutting}
                onChange={(e) => setSendToLaserCutting(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
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

            {sendToLaserCutting && (
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                {knownPartNames.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">
                      Select Previously Used Part Name (optional)
                    </label>
                    <select
                      value={knownPartNames.includes(partName) ? partName : ''}
                      onChange={(e) => {
                        if (e.target.value) setPartName(e.target.value);
                      }}
                      className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                    >
                      <option value="">-- Choose an existing part or type a new one below --</option>
                      {knownPartNames.map((pn) => (
                        <option key={pn} value={pn}>
                          {pn}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">
                      Part Name <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="text"
                      value={partName}
                      onChange={(e) => setPartName(e.target.value)}
                      placeholder="e.g., Clavicle Superior Lateral Plate Left 1-12 Hole"
                      required={sendToLaserCutting}
                      className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">
                      Quantity of Pieces <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={piecesQuantity}
                      onChange={(e) => setPiecesQuantity(e.target.value)}
                      placeholder="e.g., 24"
                      required={sendToLaserCutting}
                      className="w-full px-3.5 py-2.5 text-sm font-normal tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="pt-2 flex justify-end">
          <button
            type="submit"
            disabled={submitting || !selectedMaterial}
            className="px-5 py-2.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {submitting ? 'Recording Receipt...' : 'Record Stock Receipt'}
          </button>
        </div>
      </form>
    </div>
  );
};
