import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  Clock,
  FileText,
  Layers,
  Package,
  UserCheck,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { canAdvanceBatch } from '../lib/roles';
import { formatDateTime, formatNumber, formatWithUnit } from '../lib/format';

interface ScrapEntry {
  id: number;
  stageId: number;
  stageName: string;
  stageSequence: number;
  partName: string | null;
  quantityProcessed: number;
  quantityRejected: number;
  quantityGood: number;
  reason: string | null;
  loggedAt: string;
  loggedByName: string;
}

interface BatchDetailData {
  batch: {
    id: string;
    materialId: number;
    materialCode: string;
    materialName: string;
    materialUnit: string;
    currentStageId: number;
    stageName: string;
    stageSequence: number;
    quantity: number;
    partName: string | null;
    piecesQuantity: number | null;
    supplierName: string | null;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    bendingInchargeName: string | null;
    machiningInchargeName: string | null;
    note: string | null;
    createdAt: string;
    createdByName: string;
    createdByEmail: string;
  };
  history: {
    id: number;
    stageId: number;
    stageName: string;
    stageSequence: number;
    qtyIn: number | null;
    qtyRejected: number;
    qtyOut: number | null;
    rejectionReason: string | null;
    movedAt: string;
    movedByName: string;
    movedByEmail: string;
    supplierName: string | null;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    inchargeName: string | null;
    note: string | null;
  }[];
  scrapEntries?: ScrapEntry[];
  activeStages: {
    id: number;
    name: string;
    sequence: number;
    active: boolean;
  }[];
  nextStage: {
    id: number;
    name: string;
    sequence: number;
  } | null;
  requiresPartAssignment: boolean;
  knownPartNames: string[];
}

interface BatchDetailPageProps {
  batchId: string;
  onBack: () => void;
  onOpenBatch?: (batchId: string) => void;
}

export const BatchDetailPage: React.FC<BatchDetailPageProps> = ({
  batchId,
  onBack,
  onOpenBatch,
}) => {
  const { user, apiFetch } = useAuth();
  const [data, setData] = useState<BatchDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [advancing, setAdvancing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [remainingBatchLink, setRemainingBatchLink] = useState<{
    id: string;
    quantity: number;
  } | null>(null);

  // Advance Stage Modal state
  const [promptOpen, setPromptOpen] = useState(false);
  const [partNameInput, setPartNameInput] = useState('');
  const [issuedInput, setIssuedInput] = useState('');
  const [supplierNameInput, setSupplierNameInput] = useState('');
  const [invoiceNumberInput, setInvoiceNumberInput] = useState('');
  const [invoiceDateInput, setInvoiceDateInput] = useState('');
  const [bendingInchargeInput, setBendingInchargeInput] = useState('');
  const [machiningInchargeInput, setMachiningInchargeInput] = useState('');
  const [processedInput, setProcessedInput] = useState('');
  const [rejectedInput, setRejectedInput] = useState('0');
  const [rejectionReasonInput, setRejectionReasonInput] = useState('');
  const [promptError, setPromptError] = useState<string | null>(null);
  const [selectedTimelineStage, setSelectedTimelineStage] = useState<{
    id: number;
    name: string;
    sequence: number;
    active: boolean;
  } | null>(null);

  const loadBatch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<BatchDetailData>(`/api/batches/${encodeURIComponent(batchId)}`);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load batch details');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, batchId]);

  useEffect(() => {
    loadBatch();
  }, [loadBatch]);

  const openAdvanceModal = () => {
    if (!data?.nextStage) return;
    setPromptError(null);
    setPartNameInput(data.batch.partName ?? '');
    setIssuedInput(String(data.batch.quantity));
    setSupplierNameInput(data.batch.supplierName ?? '');
    setInvoiceNumberInput(data.batch.invoiceNumber ?? '');
    setInvoiceDateInput(data.batch.invoiceDate ?? '');
    setBendingInchargeInput(data.batch.bendingInchargeName ?? '');
    setMachiningInchargeInput(data.batch.machiningInchargeName ?? '');
    setProcessedInput(
      data.batch.piecesQuantity !== null ? String(data.batch.piecesQuantity) : ''
    );
    setRejectedInput('0');
    setRejectionReasonInput('');
    setPromptOpen(true);
  };

  const handleConfirmAdvance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data?.nextStage) return;
    setPromptError(null);

    if (data.requiresPartAssignment) {
      const trimmedPart = partNameInput.trim();
      if (!trimmedPart) {
        setPromptError('Please enter or select an Assigned Part Name.');
        return;
      }

      const issuedNum = Number(issuedInput);
      if (!Number.isFinite(issuedNum) || issuedNum <= 0) {
        setPromptError('Quantity Issued must be a positive number.');
        return;
      }
      if (issuedNum > data.batch.quantity + 1e-6) {
        setPromptError(
          `Quantity Issued (${formatWithUnit(issuedNum, data.batch.materialUnit)}) cannot exceed available quantity (${formatWithUnit(data.batch.quantity, data.batch.materialUnit)}).`
        );
        return;
      }

      setAdvancing(true);
      setError(null);
      setFeedback(null);
      setRemainingBatchLink(null);
      try {
        const res = await apiFetch<{
          fromStage: { name: string };
          toStage: { name: string };
          issuedQuantity: number;
          remainingQuantity: number;
          remainingBatch: { id: string; quantity: number } | null;
          reorderAlertTriggered: boolean;
        }>(`/api/batches/${encodeURIComponent(batchId)}/advance`, {
          method: 'POST',
          body: JSON.stringify({
            note: note.trim() || undefined,
            partName: trimmedPart,
            quantityIssued: issuedNum,
            supplierName: supplierNameInput.trim() || undefined,
            invoiceNumber: invoiceNumberInput.trim() || undefined,
            invoiceDate: invoiceDateInput.trim() || undefined,
          }),
        });

        setPromptOpen(false);
        setPartNameInput('');
        setIssuedInput('');
        setSupplierNameInput('');
        setInvoiceNumberInput('');
        setInvoiceDateInput('');
        setNote('');

        if (res.remainingBatch) {
          setRemainingBatchLink({
            id: res.remainingBatch.id,
            quantity: res.remainingBatch.quantity,
          });
        }

        const splitText = res.remainingBatch
          ? ` Remaining ${formatWithUnit(res.remainingQuantity, data.batch.materialUnit)} kept in ${res.fromStage.name} as ${res.remainingBatch.id}.`
          : '';
        setFeedback(
          `Issued ${formatWithUnit(res.issuedQuantity, data.batch.materialUnit)} to ${res.toStage.name} (Part: ${trimmedPart}).${splitText}${
            res.reorderAlertTriggered ? ' Reorder alert triggered.' : ''
          }`
        );
        await loadBatch();
      } catch (err) {
        setPromptError(err instanceof Error ? err.message : 'Failed to advance stage');
      } finally {
        setAdvancing(false);
      }
      return;
    }

    const processedNum = Number(processedInput);
    const rejectedNum = Number(rejectedInput === '' ? 0 : rejectedInput);

    if (!Number.isInteger(processedNum) || processedNum <= 0) {
      setPromptError('Quantity Processed must be a whole number (1 or greater).');
      return;
    }
    if (!Number.isInteger(rejectedNum) || rejectedNum < 0) {
      setPromptError('Quantity Rejected must be a non-negative whole number (0 or greater).');
      return;
    }
    if (rejectedNum > processedNum) {
      setPromptError(
        `Quantity Rejected (${rejectedNum}) cannot exceed Quantity Processed (${processedNum}).`
      );
      return;
    }

    const isBendingStep = data.batch.stageSequence === 2;
    const isMachiningStep = data.batch.stageSequence === 3;
    if (isBendingStep && !bendingInchargeInput.trim()) {
      setPromptError('Bending Incharge Name is required when advancing from Laser Cutting to Bending.');
      return;
    }

    setAdvancing(true);
    setError(null);
    setFeedback(null);
    setRemainingBatchLink(null);
    try {
      const res = await apiFetch<{
        fromStage: { name: string };
        toStage: { name: string };
        goodQuantity: number;
        quantityRejected: number;
        reorderAlertTriggered: boolean;
      }>(`/api/batches/${encodeURIComponent(batchId)}/advance`, {
        method: 'POST',
        body: JSON.stringify({
          note: note.trim() || undefined,
          quantityProcessed: processedNum,
          quantityRejected: rejectedNum,
          rejectionReason: rejectionReasonInput.trim() || undefined,
          ...(isBendingStep
            ? { bendingInchargeName: bendingInchargeInput.trim() }
            : {}),
          ...(isMachiningStep
            ? { machiningInchargeName: machiningInchargeInput.trim() || undefined }
            : {}),
        }),
      });

      setPromptOpen(false);
      setPartNameInput('');
      setBendingInchargeInput('');
      setMachiningInchargeInput('');
      setProcessedInput('');
      setRejectedInput('0');
      setRejectionReasonInput('');
      setNote('');

      const rejectNote =
        res.quantityRejected > 0
          ? ` (${res.goodQuantity} good pcs moved forward, ${res.quantityRejected} rejected logged to scrap)`
          : ` (${res.goodQuantity} good pcs moved forward)`;

      setFeedback(
        `Batch advanced from ${res.fromStage.name} to ${res.toStage.name}${rejectNote}.${
          res.reorderAlertTriggered ? ' Reorder alert triggered.' : ''
        }`
      );
      await loadBatch();
    } catch (err) {
      setPromptError(err instanceof Error ? err.message : 'Failed to advance stage');
    } finally {
      setAdvancing(false);
    }
  };

  if (loading) {
    return <div className="h-96 bg-white border border-slate-200 rounded-2xl shadow-sm animate-pulse" />;
  }

  if (error && !data) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to Batches</span>
        </button>
        <div className="p-4 bg-white border border-red-200 rounded-2xl shadow-sm text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const {
    batch,
    history,
    scrapEntries = [],
    activeStages,
    nextStage,
    requiresPartAssignment,
    knownPartNames,
  } = data;
  const userCanAdvance = user ? canAdvanceBatch(user.role) : false;
  const totalBatchRejected = scrapEntries.reduce(
    (sum, s) => sum + s.quantityRejected,
    0
  );

  const parsedIssued = Number(issuedInput);
  const validIssued =
    issuedInput.trim() !== '' &&
    Number.isFinite(parsedIssued) &&
    parsedIssued > 0 &&
    parsedIssued <= batch.quantity + 1e-6;
  const computedRemainingQty =
    issuedInput.trim() !== '' && Number.isFinite(parsedIssued)
      ? Math.max(0, Number((batch.quantity - parsedIssued).toFixed(4)))
      : null;

  const parsedProcessed = Number(processedInput);
  const parsedRejected = Number(rejectedInput === '' ? 0 : rejectedInput);
  const validMath =
    processedInput.trim() !== '' &&
    Number.isInteger(parsedProcessed) &&
    parsedProcessed > 0 &&
    Number.isInteger(parsedRejected) &&
    parsedRejected >= 0;
  const computedGoodQty = validMath ? parsedProcessed - parsedRejected : null;

  const formatHistoryQtyIn = (h: BatchDetailData['history'][number]) => {
    if (h.qtyIn === null) return '—';
    if (h.stageSequence === 2 && h.qtyOut === null) {
      return formatWithUnit(h.qtyIn, batch.materialUnit);
    }
    return `${formatNumber(h.qtyIn)} pcs`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 mb-2"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Batches</span>
          </button>
          <h1 className="text-2xl font-bold tracking-tight font-mono text-slate-900">{batch.id}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>Created by {batch.createdByName}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{formatDateTime(batch.createdAt)}</span>
            {batch.note && (
              <>
                <span aria-hidden="true">·</span>
                <span>Note: {batch.note}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Batch Raw Material -> Cut Part Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <Package className="w-3.5 h-3.5 text-slate-400" />
            <span>Original Raw Material</span>
          </div>
          <div className="mt-2 text-sm font-semibold text-slate-900">
            <span className="font-mono text-xs text-slate-500 mr-1.5">{batch.materialCode}</span>
            {batch.materialName}
          </div>
          <div className="mt-1 font-mono text-xs text-slate-600 tabular-nums">
            Batch Raw Quantity: {formatWithUnit(batch.quantity, batch.materialUnit)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <Layers className="w-3.5 h-3.5 text-slate-400" />
            <span>Assigned Part Name</span>
          </div>
          <div className="mt-2 text-sm font-semibold text-slate-900">
            {batch.partName ? (
              batch.partName
            ) : (
              <span className="text-slate-400 font-normal">
                Pending — assigned at Laser Cutting
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {batch.partName
              ? 'Carried automatically across subsequent stages'
              : 'Prompted when advancing from Stage 01 to Stage 02'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
          <div className="text-xs font-medium text-slate-500">Current Good Pieces</div>
          <div className="mt-2 flex items-baseline gap-3">
            <span className="text-xl font-bold font-mono tabular-nums text-slate-900">
              {batch.piecesQuantity !== null ? `${formatNumber(batch.piecesQuantity)} pcs` : '—'}
            </span>
            {totalBatchRejected > 0 && (
              <span className="text-xs font-mono font-semibold text-red-700">
                ({formatNumber(totalBatchRejected)} pcs rejected)
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Current stage: {String(batch.stageSequence).padStart(2, '0')}. {batch.stageName}
          </div>
        </div>
      </div>

      {/* Supplier & Process Incharge Traceability Summary */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
        <div className="text-xs font-semibold text-slate-800 mb-3">
          Supplier &amp; Operator Traceability
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
          <div className="flex items-start gap-2.5">
            <Building2 className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
            <div>
              <div className="text-slate-500">Supplier Name</div>
              <div className="mt-0.5 font-semibold text-slate-900">
                {batch.supplierName || <span className="text-slate-400 font-normal">Not recorded</span>}
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2.5">
            <FileText className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
            <div>
              <div className="text-slate-500">Invoice Number &amp; Date</div>
              <div className="mt-0.5 font-semibold text-slate-900 font-mono">
                {batch.invoiceNumber || batch.invoiceDate ? (
                  <>
                    {batch.invoiceNumber || '—'}
                    {batch.invoiceDate ? (
                      <span className="ml-1.5 font-normal text-slate-500">
                        ({batch.invoiceDate})
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="font-sans text-slate-400 font-normal">Not recorded</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2.5">
            <UserCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <div className="text-slate-500">Bending Incharge</div>
              <div className="mt-0.5 font-semibold text-slate-900">
                {batch.bendingInchargeName || (
                  <span className="text-slate-400 font-normal">Pending Stage 03</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2.5">
            <Wrench className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <div className="text-slate-500">Machining Incharge</div>
              <div className="mt-0.5 font-semibold text-slate-900">
                {batch.machiningInchargeName || (
                  <span className="text-slate-400 font-normal">Pending Stage 04</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {feedback && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-emerald-900">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <span>{feedback}</span>
          </div>
          {remainingBatchLink && onOpenBatch && (
            <button
              type="button"
              onClick={() => onOpenBatch(remainingBatchLink.id)}
              className="px-2.5 py-1 bg-white border border-emerald-300 rounded-lg text-xs font-mono font-semibold text-emerald-800 hover:bg-emerald-100 inline-flex items-center gap-1"
            >
              <span>Open {remainingBatchLink.id}</span>
              <ArrowRight className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl flex items-center gap-2 text-xs text-red-800">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Visual Stage Progression Timeline */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <div>
            <h3 className="text-base font-bold tracking-tight text-slate-900">Production Stage Timeline</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Current stage:{' '}
              <span className="font-semibold text-slate-900">
                {String(batch.stageSequence).padStart(2, '0')}. {batch.stageName}
              </span>
            </p>
          </div>

          {userCanAdvance && nextStage && (
            <button
              type="button"
              onClick={openAdvanceModal}
              disabled={advancing}
              className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
            >
              <span>
                {advancing ? 'Advancing...' : `Advance to ${nextStage.name}`}
              </span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}

          {!nextStage && (
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 text-xs font-semibold">
              <CheckCircle2 className="w-4 h-4" />
              <span>Final active stage reached</span>
            </div>
          )}
        </div>

        {/* Stepper */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {activeStages.map((st) => {
            const historyEntry = history.find((h) => h.stageId === st.id);
            const isCurrent = batch.currentStageId === st.id;
            const isCompleted = st.sequence < batch.stageSequence || (isCurrent && !nextStage);

            return (
              <button
                key={st.id}
                type="button"
                onClick={() => setSelectedTimelineStage(st)}
                className={`text-left border rounded-xl p-3.5 cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 ${
                  isCurrent
                    ? 'border-indigo-500 bg-slate-900 text-white shadow-sm hover:bg-slate-800'
                    : isCompleted || historyEntry
                    ? 'border-emerald-200 bg-emerald-50/50 text-slate-900 hover:border-emerald-300 hover:bg-emerald-50/80'
                    : 'border-slate-200 bg-slate-50/70 text-slate-500 hover:border-slate-300 hover:bg-slate-100/80'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`font-mono text-xs ${
                      isCurrent ? 'text-indigo-300' : 'text-slate-500'
                    }`}
                  >
                    Stage {String(st.sequence).padStart(2, '0')}
                  </span>
                  {isCurrent ? (
                    <Clock className="w-3.5 h-3.5 text-indigo-300 shrink-0" />
                  ) : historyEntry ? (
                    <Check className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
                  ) : null}
                </div>
                <div className="mt-1 text-sm font-semibold truncate">{st.name}</div>
                <div
                  className={`mt-2 text-xs font-mono tabular-nums ${
                    isCurrent ? 'text-slate-300' : 'text-slate-500'
                  }`}
                >
                  {historyEntry ? formatDateTime(historyEntry.movedAt) : 'Pending'}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Full Stage History Table */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-base font-bold tracking-tight text-slate-900">Stage Transition History</h3>
          <span className="text-xs text-slate-500">
            Tracks pieces received, rejected, and good output per transition
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="px-4 py-3">Sequence</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3 text-right">Qty In</th>
                <th className="px-4 py-3 text-right">Qty Rejected</th>
                <th className="px-4 py-3 text-right">Qty Out</th>
                <th className="px-4 py-3">Timestamp (UTC)</th>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Traceability / Incharge</th>
                <th className="px-4 py-3">Note / Rejection Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {history.map((h) => (
                <tr key={h.id} className="border-b border-slate-200 hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs tabular-nums text-slate-600">
                    {String(h.stageSequence).padStart(2, '0')}
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-900 whitespace-nowrap">
                    {h.stageName}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-slate-700 whitespace-nowrap">
                    {formatHistoryQtyIn(h)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                    {h.qtyRejected > 0 ? (
                      <span className="font-semibold text-red-700">
                        {formatNumber(h.qtyRejected)} pcs
                      </span>
                    ) : (
                      <span className="text-slate-400">0</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                    {h.qtyOut !== null ? (
                      <span className="font-semibold text-emerald-700">
                        {formatNumber(h.qtyOut)} pcs
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs tabular-nums text-slate-700 whitespace-nowrap">
                    {formatDateTime(h.movedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-slate-900">{h.movedByName}</div>
                    <div className="text-xs text-slate-500">{h.movedByEmail}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-700 whitespace-nowrap">
                    {h.supplierName || h.invoiceNumber || h.invoiceDate ? (
                      <div className="space-y-0.5">
                        {h.supplierName && (
                          <div>
                            <span className="text-slate-500">Supplier: </span>
                            <span className="font-medium text-slate-900">{h.supplierName}</span>
                          </div>
                        )}
                        {(h.invoiceNumber || h.invoiceDate) && (
                          <div className="font-mono text-[11px] text-slate-600">
                            {h.invoiceNumber ? `Inv: ${h.invoiceNumber}` : 'Inv: —'}
                            {h.invoiceDate ? ` · ${h.invoiceDate}` : ''}
                          </div>
                        )}
                      </div>
                    ) : h.inchargeName ? (
                      <div>
                        <span className="text-slate-500">
                          {h.stageSequence === 3
                            ? 'Bending Incharge: '
                            : h.stageSequence === 4
                            ? 'Machining Incharge: '
                            : 'Incharge: '}
                        </span>
                        <span className="font-medium text-slate-900">{h.inchargeName}</span>
                      </div>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    <div>{h.note || '—'}</div>
                    {h.rejectionReason && (
                      <div className="mt-1 text-red-700 font-medium">
                        Rejection reason: {h.rejectionReason}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Batch Scrap / Rejection Log Summary (if any defects occurred on this batch) */}
      {scrapEntries.length > 0 && (
        <div className="bg-white border border-red-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="px-5 py-3.5 border-b border-red-200 bg-red-50/70 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" />
              <h3 className="text-sm font-semibold text-red-900">
                Scrap &amp; Rejection Log for {batch.id}
              </h3>
            </div>
            <span className="text-xs font-mono font-semibold text-red-800">
              Total Rejected: {formatNumber(totalBatchRejected)} pcs
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="px-4 py-2.5">Stage</th>
                  <th className="px-4 py-2.5 text-right">Processed</th>
                  <th className="px-4 py-2.5 text-right">Rejected</th>
                  <th className="px-4 py-2.5 text-right">Good Output</th>
                  <th className="px-4 py-2.5">Reason</th>
                  <th className="px-4 py-2.5">Logged By</th>
                  <th className="px-4 py-2.5">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {scrapEntries.map((s) => (
                  <tr key={s.id} className="border-b border-slate-200 hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-medium text-slate-900">
                      {String(s.stageSequence).padStart(2, '0')}. {s.stageName}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700">
                      {formatNumber(s.quantityProcessed)} pcs
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-red-700">
                      {formatNumber(s.quantityRejected)} pcs
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-emerald-700">
                      {formatNumber(s.quantityGood)} pcs
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">{s.reason || '—'}</td>
                    <td className="px-4 py-2.5 text-slate-600">{s.loggedByName}</td>
                    <td className="px-4 py-2.5 font-mono tabular-nums text-slate-500">
                      {formatDateTime(s.loggedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Advance Stage Modal (Stage 01 -> 02 Quantity Issued + Part Name, OR Stage 02+ Piece Yield & Rejection) */}
      {promptOpen && nextStage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
          <div className="w-full max-w-lg bg-white border border-slate-200 rounded-2xl shadow-xl overflow-hidden max-h-[92vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-bold tracking-tight text-slate-900">
                  {requiresPartAssignment
                    ? `Issue Material & Advance to ${nextStage.name}`
                    : `Advance Stage: ${batch.stageName} → ${nextStage.name}`}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Batch <span className="font-mono font-medium text-slate-800">{batch.id}</span> ·{' '}
                  {batch.materialName} ({formatWithUnit(batch.quantity, batch.materialUnit)})
                  {batch.partName ? ` · ${batch.partName}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPromptOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmAdvance} className="p-6 space-y-4 overflow-y-auto">
              {promptError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2 text-xs text-red-800">
                  <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                  <span>{promptError}</span>
                </div>
              )}

              {requiresPartAssignment ? (
                <>
                  {knownPartNames.length > 0 && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1.5">
                        Select Previously Used Part Name (optional)
                      </label>
                      <select
                        value={knownPartNames.includes(partNameInput) ? partNameInput : ''}
                        onChange={(e) => {
                          if (e.target.value) {
                            setPartNameInput(e.target.value);
                          }
                        }}
                        className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                      >
                        <option value="">
                          -- Choose an existing part or type a new one below --
                        </option>
                        {knownPartNames.map((pn) => (
                          <option key={pn} value={pn}>
                            {pn}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">
                      Assigned Part Name <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="text"
                      value={partNameInput}
                      onChange={(e) => setPartNameInput(e.target.value)}
                      placeholder="e.g., Clavicle Superior Lateral Plate Left 1-12 Hole"
                      required
                      autoFocus
                      className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <label className="block text-xs font-medium text-slate-600">
                        Quantity Issued ({batch.materialUnit}){' '}
                        <span className="text-red-600">*</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => setIssuedInput(String(batch.quantity))}
                        className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
                      >
                        Use full ({formatWithUnit(batch.quantity, batch.materialUnit)})
                      </button>
                    </div>
                    <input
                      type="number"
                      min="0.0001"
                      max={batch.quantity}
                      step="any"
                      value={issuedInput}
                      onChange={(e) => setIssuedInput(e.target.value)}
                      placeholder={String(batch.quantity)}
                      required
                      className="w-full px-3.5 py-2.5 text-sm font-normal tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                    />
                    <div className="mt-1 text-[11px] text-slate-500 font-mono">
                      Available in {batch.stageName}: {formatWithUnit(batch.quantity, batch.materialUnit)}
                    </div>
                  </div>

                  <div
                    className={`p-3 rounded-xl border flex items-center justify-between gap-3 text-xs ${
                      issuedInput.trim() !== '' && !validIssued
                        ? 'bg-red-50 border-red-200 text-red-800'
                        : computedRemainingQty !== null && computedRemainingQty > 1e-6
                        ? 'bg-amber-50/70 border-amber-200 text-amber-900'
                        : 'bg-slate-50 border-slate-200 text-slate-700'
                    }`}
                  >
                    <div>
                      <div className="font-semibold">
                        {issuedInput.trim() !== '' && !validIssued
                          ? 'Invalid Issue Quantity'
                          : computedRemainingQty !== null && computedRemainingQty > 1e-6
                          ? `Remaining Balance Kept in ${batch.stageName}`
                          : `Full Batch Issued to ${nextStage.name}`}
                      </div>
                      <div className="text-[11px] opacity-85 mt-0.5">
                        {issuedInput.trim() !== '' && !validIssued
                          ? `Enter a quantity greater than 0 and up to ${formatWithUnit(batch.quantity, batch.materialUnit)}.`
                          : computedRemainingQty !== null && computedRemainingQty > 1e-6
                          ? 'A separate Stage 01 batch will be created for the remaining quantity.'
                          : 'Entire available batch balance will move to cutting.'}
                      </div>
                    </div>
                    <div className="text-base font-bold font-mono tabular-nums shrink-0">
                      {issuedInput.trim() !== '' && validIssued && computedRemainingQty !== null
                        ? computedRemainingQty > 1e-6
                          ? formatWithUnit(computedRemainingQty, batch.materialUnit)
                          : `0 ${batch.materialUnit}`
                        : '—'}
                    </div>
                  </div>

                  {/* Stage 01 -> 02 Supplier & Invoice Traceability */}
                  <div className="pt-3 border-t border-slate-200 space-y-3">
                    <div className="text-xs font-semibold text-slate-800">
                      Supplier &amp; Invoice Traceability
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1.5">
                        Supplier Name
                      </label>
                      <input
                        type="text"
                        value={supplierNameInput}
                        onChange={(e) => setSupplierNameInput(e.target.value)}
                        placeholder="e.g., Jindal Stainless Steel Ltd."
                        className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                      />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1.5">
                          Invoice Number
                        </label>
                        <input
                          type="text"
                          value={invoiceNumberInput}
                          onChange={(e) => setInvoiceNumberInput(e.target.value)}
                          placeholder="e.g., INV-2026-0412"
                          className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1.5">
                          Invoice Date
                        </label>
                        <input
                          type="date"
                          value={invoiceDateInput}
                          onChange={(e) => setInvoiceDateInput(e.target.value)}
                          className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                        />
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1.5">
                        Quantity Processed (pcs) <span className="text-red-600">*</span>
                      </label>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={processedInput}
                        onChange={(e) => setProcessedInput(e.target.value)}
                        placeholder="e.g., 24"
                        required
                        autoFocus
                        className="w-full px-3.5 py-2.5 text-sm font-normal tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                      />
                      {batch.piecesQuantity !== null ? (
                        <div className="mt-1 text-[11px] text-slate-500 font-mono">
                          Arrived at {batch.stageName}: {formatNumber(batch.piecesQuantity)} pcs
                        </div>
                      ) : (
                        <div className="mt-1 text-[11px] text-slate-500 font-mono">
                          Raw material issued: {formatWithUnit(batch.quantity, batch.materialUnit)}
                        </div>
                      )}
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1.5">
                        Quantity Rejected (pcs) <span className="text-red-600">*</span>
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={rejectedInput}
                        onChange={(e) => setRejectedInput(e.target.value)}
                        placeholder="0"
                        required
                        className="w-full px-3.5 py-2.5 text-sm font-normal tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                      />
                      <div className="mt-1 text-[11px] text-slate-500">
                        Defective pieces logged to Scrap Log
                      </div>
                    </div>
                  </div>

                  {/* Calculated Good Quantity Output Box */}
                  <div
                    className={`p-3 rounded-xl border flex items-center justify-between text-xs ${
                      computedGoodQty !== null && computedGoodQty < 0
                        ? 'bg-red-50 border-red-200 text-red-800'
                        : 'bg-slate-50 border-slate-200 text-slate-700'
                    }`}
                  >
                    <div>
                      <div className="font-semibold text-slate-900">
                        Good Quantity Advancing to {nextStage.name}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Good Qty = Quantity Processed − Quantity Rejected
                      </div>
                    </div>
                    <div
                      className={`text-lg font-bold font-mono tabular-nums ${
                        computedGoodQty === null
                          ? 'text-slate-400'
                          : computedGoodQty < 0
                          ? 'text-red-700'
                          : 'text-emerald-700'
                      }`}
                    >
                      {computedGoodQty !== null ? `${formatNumber(computedGoodQty)} pcs` : '—'}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">
                      Rejection Reason (optional)
                    </label>
                    <input
                      type="text"
                      value={rejectionReasonInput}
                      onChange={(e) => setRejectionReasonInput(e.target.value)}
                      placeholder="e.g., Bend angle out of tolerance, tool chatter, edge burr"
                      className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                    />
                  </div>

                  {batch.stageSequence === 2 && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1.5">
                        Bending Incharge Name <span className="text-red-600">*</span>
                      </label>
                      <input
                        type="text"
                        value={bendingInchargeInput}
                        onChange={(e) => setBendingInchargeInput(e.target.value)}
                        placeholder="Enter operator name in charge of bending"
                        required
                        className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                      />
                    </div>
                  )}

                  {batch.stageSequence === 3 && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1.5">
                        Machining Incharge Name
                      </label>
                      <input
                        type="text"
                        value={machiningInchargeInput}
                        onChange={(e) => setMachiningInchargeInput(e.target.value)}
                        placeholder="Enter operator name in charge of machining"
                        className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                      />
                    </div>
                  )}
                </>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  Transition Note (optional)
                </label>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Operator remarks, machine ID, or inspection notes"
                  className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                />
              </div>

              <div className="pt-3 flex items-center justify-end gap-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setPromptOpen(false)}
                  disabled={advancing}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    advancing ||
                    (requiresPartAssignment
                      ? !validIssued
                      : computedGoodQty !== null && computedGoodQty < 0)
                  }
                  className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm disabled:opacity-50 inline-flex items-center gap-1.5 transition-colors"
                >
                  <span>
                    {advancing ? 'Advancing...' : `Confirm & Advance to ${nextStage.name}`}
                  </span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Timeline Stage Detail Modal */}
      {selectedTimelineStage && (() => {
        const entry = history.find((h) => h.stageId === selectedTimelineStage.id);
        const stageScrapEntries = scrapEntries.filter(
          (s) => s.stageId === selectedTimelineStage.id
        );
        const isCurrentStage = batch.currentStageId === selectedTimelineStage.id;

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50"
            onClick={() => setSelectedTimelineStage(null)}
          >
            <div
              className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-mono text-slate-500">
                    Stage {String(selectedTimelineStage.sequence).padStart(2, '0')} · {batch.id}
                  </div>
                  <h3 className="text-base font-bold tracking-tight text-slate-900">
                    {selectedTimelineStage.name}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedTimelineStage(null)}
                  className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
                  aria-label="Close modal"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-6 space-y-4">
                {!entry ? (
                  <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 text-center">
                    {isCurrentStage
                      ? 'This batch is currently at this stage.'
                      : 'Pending — this batch has not reached this stage yet.'}
                  </div>
                ) : (
                  <>
                    <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-500">Processed By</span>
                        <span className="font-semibold text-slate-900">{entry.movedByName}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-500">Email</span>
                        <span className="font-mono text-slate-600">{entry.movedByEmail}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-500">Timestamp (UTC)</span>
                        <span className="font-mono tabular-nums text-slate-800">
                          {formatDateTime(entry.movedAt)}
                        </span>
                      </div>
                      {entry.supplierName && (
                        <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-200/80">
                          <span className="text-slate-500">Supplier Name</span>
                          <span className="font-semibold text-slate-900">{entry.supplierName}</span>
                        </div>
                      )}
                      {entry.invoiceNumber && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-slate-500">Invoice Number</span>
                          <span className="font-mono text-slate-800">{entry.invoiceNumber}</span>
                        </div>
                      )}
                      {entry.invoiceDate && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-slate-500">Invoice Date</span>
                          <span className="font-mono text-slate-800">{entry.invoiceDate}</span>
                        </div>
                      )}
                      {entry.inchargeName && (
                        <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-200/80">
                          <span className="text-slate-500">
                            {selectedTimelineStage.sequence === 3
                              ? 'Bending Incharge'
                              : selectedTimelineStage.sequence === 4
                              ? 'Machining Incharge'
                              : 'Incharge Name'}
                          </span>
                          <span className="font-semibold text-slate-900">{entry.inchargeName}</span>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="p-3 bg-slate-50 border border-slate-200 rounded-md">
                        <div className="text-[11px] font-medium text-slate-500">Qty In</div>
                        <div className="mt-1 text-base font-bold font-mono tabular-nums text-slate-900">
                          {entry.qtyIn !== null
                            ? formatHistoryQtyIn(entry)
                            : selectedTimelineStage.sequence === 1
                            ? formatWithUnit(batch.quantity, batch.materialUnit)
                            : '—'}
                        </div>
                      </div>
                      <div className="p-3 bg-red-50/70 border border-red-200 rounded-md">
                        <div className="text-[11px] font-medium text-red-700">Qty Rejected</div>
                        <div className="mt-1 text-base font-bold font-mono tabular-nums text-red-700">
                          {formatNumber(entry.qtyRejected)} pcs
                        </div>
                      </div>
                      <div className="p-3 bg-emerald-50/70 border border-emerald-200 rounded-md">
                        <div className="text-[11px] font-medium text-emerald-700">Qty Out</div>
                        <div className="mt-1 text-base font-bold font-mono tabular-nums text-emerald-700">
                          {entry.qtyOut !== null ? `${formatNumber(entry.qtyOut)} pcs` : '—'}
                        </div>
                      </div>
                    </div>

                    {(entry.qtyRejected > 0 || entry.rejectionReason) && (
                      <div className="p-3 bg-red-50/60 border border-red-200 rounded-md text-xs">
                        <div className="font-semibold text-red-900">Rejection Reason</div>
                        <div className="mt-0.5 text-red-800">
                          {entry.rejectionReason || 'No reason specified'}
                        </div>
                      </div>
                    )}

                    {stageScrapEntries.length > 0 && (
                      <div className="p-3 bg-amber-50/60 border border-amber-200 rounded-md text-xs space-y-1.5">
                        <div className="font-semibold text-amber-900">
                          Rejections Recorded Leaving {selectedTimelineStage.name}
                        </div>
                        {stageScrapEntries.map((s) => (
                          <div
                            key={s.id}
                            className="flex items-center justify-between gap-2 text-amber-900"
                          >
                            <span>{s.reason || 'Unspecified reason'}</span>
                            <span className="font-mono font-semibold tabular-nums">
                              {formatNumber(s.quantityRejected)} pcs
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {entry.note && (
                      <div className="p-3 bg-slate-50 border border-slate-200 rounded-md text-xs">
                        <div className="font-semibold text-slate-700">Note</div>
                        <div className="mt-0.5 text-slate-600">{entry.note}</div>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => setSelectedTimelineStage(null)}
                  className="px-4 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
