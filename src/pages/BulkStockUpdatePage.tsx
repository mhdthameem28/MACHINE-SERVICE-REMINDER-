import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  RotateCcw,
  UploadCloud,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { formatNumber, formatWithUnit, todayInputValue } from '../lib/format';
import type { MaterialStockRow, PartStockRow } from './DashboardPage';

export interface BulkStockUpdateResponse {
  movementType: 'receipt' | 'adjustment';
  updatedCount: number;
  materialUpdatedCount: number;
  partUpdatedCount: number;
  updatedItems: {
    itemCode: string;
    productName: string;
    entityType: 'material' | 'part';
    quantity: number;
    unit: string;
    newStock: number;
    batchId: string | null;
  }[];
  skippedRows: {
    rowNumber: number;
    itemCode: string;
    reason: string;
  }[];
  reorderAlertCount: number;
}

interface ParsedStockRow {
  rowNumber: number;
  itemCode: string;
  quantity: number | null;
  rawQuantity: string;
  matchedType: 'material' | 'part' | null;
  matchedName: string | null;
  matchedCurrentStock: number | null;
  matchedDefaultUnit: string | null;
  status: 'ready' | 'not_found' | 'invalid';
  reason?: string;
}

function normalizeHeaderKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function pickField(row: Record<string, unknown>, aliases: string[]): unknown {
  for (const [k, v] of Object.entries(row)) {
    if (aliases.includes(normalizeHeaderKey(k))) {
      return v;
    }
  }
  return undefined;
}

export const BulkStockUpdatePage: React.FC = () => {
  const { apiFetch } = useAuth();
  const [materials, setMaterials] = useState<MaterialStockRow[]>([]);
  const [parts, setParts] = useState<PartStockRow[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);

  const [movementType, setMovementType] = useState<'receipt' | 'adjustment'>('receipt');
  const [movementDate, setMovementDate] = useState(todayInputValue());
  const [fileName, setFileName] = useState<string | null>(null);
  const [rawJsonRows, setRawJsonRows] = useState<Record<string, unknown>[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<BulkStockUpdateResponse | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoadingItems(true);
    try {
      const [matRes, partRes] = await Promise.all([
        apiFetch<{ materials: MaterialStockRow[] }>('/api/materials'),
        apiFetch<{ parts: PartStockRow[] }>('/api/parts'),
      ]);
      setMaterials(matRes.materials ?? []);
      setParts(partRes.parts ?? []);
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : 'Failed to load materials and parts catalog'
      );
    } finally {
      setLoadingItems(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const materialMap = useMemo(
    () => new Map(materials.map((m) => [m.code.trim().toUpperCase(), m])),
    [materials]
  );

  const partMap = useMemo(
    () => new Map(parts.map((p) => [p.code.trim().toUpperCase(), p])),
    [parts]
  );

  const parsedRows = useMemo<ParsedStockRow[]>(() => {
    if (rawJsonRows.length === 0) return [];
    return rawJsonRows.map((raw, idx) => {
      const rowNumber = idx + 1;
      const codeRaw = pickField(raw, ['itemcode', 'code', 'sku', 'materialcode', 'partcode']);
      const qtyRaw = pickField(raw, ['quantity', 'qty', 'amount', 'stock']);

      const itemCode = String(codeRaw ?? '').trim().toUpperCase();
      const rawQtyStr = String(qtyRaw ?? '').trim();
      const parsedQty = rawQtyStr === '' ? NaN : Number(qtyRaw);

      const matchedMat = itemCode ? materialMap.get(itemCode) : undefined;
      const matchedPart = itemCode && !matchedMat ? partMap.get(itemCode) : undefined;

      const matchedType: 'material' | 'part' | null = matchedMat
        ? 'material'
        : matchedPart
        ? 'part'
        : null;
      const matchedName = matchedMat?.name ?? matchedPart?.name ?? null;
      const matchedCurrentStock =
        matchedMat?.currentStock ?? matchedPart?.currentStock ?? null;
      const matchedDefaultUnit = matchedMat?.unit ?? matchedPart?.unit ?? null;

      if (!itemCode) {
        return {
          rowNumber,
          itemCode: '',
          quantity: Number.isFinite(parsedQty) ? parsedQty : null,
          rawQuantity: rawQtyStr,
          matchedType: null,
          matchedName: null,
          matchedCurrentStock: null,
          matchedDefaultUnit: null,
          status: 'invalid',
          reason: 'Missing Item Code',
        };
      }

      if (!matchedType) {
        return {
          rowNumber,
          itemCode,
          quantity: Number.isFinite(parsedQty) ? parsedQty : null,
          rawQuantity: rawQtyStr,
          matchedType: null,
          matchedName: null,
          matchedCurrentStock: null,
          matchedDefaultUnit: null,
          status: 'not_found',
          reason: 'Item Code not found in system (will be skipped)',
        };
      }

      if (!Number.isFinite(parsedQty)) {
        return {
          rowNumber,
          itemCode,
          quantity: null,
          rawQuantity: rawQtyStr,
          matchedType,
          matchedName,
          matchedCurrentStock,
          matchedDefaultUnit,
          status: 'invalid',
          reason: 'Invalid Quantity',
        };
      }

      if (movementType === 'receipt' && parsedQty <= 0) {
        return {
          rowNumber,
          itemCode,
          quantity: parsedQty,
          rawQuantity: rawQtyStr,
          matchedType,
          matchedName,
          matchedCurrentStock,
          matchedDefaultUnit,
          status: 'invalid',
          reason: 'Receipt quantity must be > 0',
        };
      }

      if (movementType === 'adjustment' && parsedQty === 0) {
        return {
          rowNumber,
          itemCode,
          quantity: parsedQty,
          rawQuantity: rawQtyStr,
          matchedType,
          matchedName,
          matchedCurrentStock,
          matchedDefaultUnit,
          status: 'invalid',
          reason: 'Adjustment quantity cannot be 0',
        };
      }

      if (
        movementType === 'adjustment' &&
        matchedCurrentStock !== null &&
        Number((matchedCurrentStock + parsedQty).toFixed(4)) < 0
      ) {
        return {
          rowNumber,
          itemCode,
          quantity: parsedQty,
          rawQuantity: rawQtyStr,
          matchedType,
          matchedName,
          matchedCurrentStock,
          matchedDefaultUnit,
          status: 'invalid',
          reason: `Would drop stock below 0 (current: ${formatNumber(matchedCurrentStock)})`,
        };
      }

      return {
        rowNumber,
        itemCode,
        quantity: parsedQty,
        rawQuantity: rawQtyStr,
        matchedType,
        matchedName,
        matchedCurrentStock,
        matchedDefaultUnit,
        status: 'ready',
      };
    });
  }, [rawJsonRows, materialMap, partMap, movementType]);

  const handleFileChange = async (file: File | undefined) => {
    if (!file) return;
    setParseError(null);
    setSubmitResult(null);
    setFileName(file.name);

    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });
      const firstSheetName = wb.SheetNames[0];
      if (!firstSheetName) {
        setParseError('The uploaded file contains no worksheets.');
        setRawJsonRows([]);
        return;
      }

      const sheet = wb.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: '',
      });

      if (rows.length === 0) {
        setParseError('No data rows found in the uploaded file.');
        setRawJsonRows([]);
        return;
      }

      setRawJsonRows(rows);
    } catch {
      setParseError('Could not read this file. Please upload a valid .csv or .xlsx file.');
      setRawJsonRows([]);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      handleFileChange(droppedFile);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const downloadTemplate = (format: 'csv' | 'xlsx') => {
    const templateRows: (string | number)[][] = [['Item Code', 'Quantity']];

    const sampleMaterials = materials.slice(0, 2);
    const sampleParts = parts.slice(0, 2);

    if (sampleMaterials.length > 0 || sampleParts.length > 0) {
      for (const m of sampleMaterials) {
        templateRows.push([m.code, 25]);
      }
      for (const p of sampleParts) {
        templateRows.push([p.code, 50]);
      }
    } else {
      templateRows.push(['MAT-SS304', 100], ['PRT-001', 50]);
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(templateRows);
    XLSX.utils.book_append_sheet(wb, ws, 'Bulk Stock Update');

    if (format === 'csv') {
      const csv = XLSX.utils.sheet_to_csv(ws);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'bulk-stock-update-template.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } else {
      XLSX.writeFile(wb, 'bulk-stock-update-template.xlsx');
    }
  };

  const resetUpload = () => {
    setFileName(null);
    setRawJsonRows([]);
    setParseError(null);
    setSubmitResult(null);
  };

  const readyRows = parsedRows.filter((r) => r.status === 'ready');
  const notFoundRows = parsedRows.filter((r) => r.status === 'not_found');
  const invalidRows = parsedRows.filter((r) => r.status === 'invalid');

  const canSubmit = parsedRows.length > 0 && readyRows.length > 0 && !submitting;

  const handleApplyUpdate = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setParseError(null);
    try {
      const payloadRows = parsedRows.map((r) => ({
        rowNumber: r.rowNumber,
        itemCode: r.itemCode,
        quantity: r.quantity ?? NaN,
      }));

      const res = await apiFetch<BulkStockUpdateResponse>('/api/stock/bulk-update', {
        method: 'POST',
        body: JSON.stringify({
          rows: payloadRows,
          movementType,
          movementDate,
        }),
      });

      setSubmitResult(res);
      await loadCatalog();
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Bulk stock update failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Bulk Stock Update</h1>
          <p className="text-sm text-slate-500 mt-1">
            Upload a CSV or Excel sheet with two columns (Item Code and Quantity) to update Raw
            Material and Cut Part balances at once.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => downloadTemplate('csv')}
            className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50/50 shadow-sm inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download Template (CSV)</span>
          </button>
          <button
            type="button"
            onClick={() => downloadTemplate('xlsx')}
            className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50/50 shadow-sm inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>Download Template (Excel)</span>
          </button>
        </div>
      </div>

      {/* Configuration + Drag-and-Drop Card */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 sm:p-8 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-200">
          <div className="text-xs text-slate-600">
            Template format:{' '}
            <span className="font-semibold text-slate-900">Item Code</span> and{' '}
            <span className="font-semibold text-slate-900">Quantity</span> only (no names or units).
          </div>
          <div className="text-xs text-slate-500">
            Ledger Note: <span className="font-medium text-slate-700">Bulk Stock Update Upload</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              Stock Movement Type
            </label>
            <div className="flex p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => {
                  setMovementType('receipt');
                  setSubmitResult(null);
                }}
                className={`flex-1 py-2 text-xs font-medium rounded-md transition-colors ${
                  movementType === 'receipt'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Receipt (+)
              </button>
              <button
                type="button"
                onClick={() => {
                  setMovementType('adjustment');
                  setSubmitResult(null);
                }}
                className={`flex-1 py-2 text-xs font-medium rounded-md transition-colors ${
                  movementType === 'adjustment'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Adjustment (±)
              </button>
            </div>
            <p className="text-[11px] text-slate-500 mt-1.5">
              {movementType === 'receipt'
                ? 'Adds incoming stock (creates Stage 01 batches for Raw Materials).'
                : 'Records positive or negative adjustments in each item ledger.'}
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              Movement Date
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

        {/* Large Drag-and-Drop File Upload Area */}
        <label
          onDragEnter={handleDragOver}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`flex flex-col items-center justify-center min-h-[210px] border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all ${
            isDragging
              ? 'border-indigo-500 bg-indigo-50/70 ring-4 ring-indigo-500/10'
              : 'border-slate-300 bg-slate-50/60 hover:border-indigo-500 hover:bg-indigo-50/30'
          }`}
        >
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={(e) => {
              handleFileChange(e.target.files?.[0]);
              e.target.value = '';
            }}
            className="hidden"
          />
          <div
            className={`w-12 h-12 rounded-xl flex items-center justify-center mb-3 transition-colors ${
              isDragging ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-indigo-600 shadow-sm'
            }`}
          >
            <UploadCloud className="w-6 h-6" />
          </div>
          <div className="text-sm font-semibold text-slate-900">
            {loadingItems
              ? 'Loading materials and parts catalog...'
              : fileName
              ? `Selected file: ${fileName}`
              : 'Drag and drop your CSV or Excel file here'}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {fileName
              ? 'Drop a new file or click anywhere here to replace it'
              : 'or click to browse (.csv, .xlsx, .xls) — columns: Item Code, Quantity'}
          </div>
        </label>

        {parseError && (
          <div className="p-3.5 bg-red-50 border border-red-200 rounded-xl flex items-start gap-2 text-xs text-red-800">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <span>{parseError}</span>
          </div>
        )}
      </div>

      {/* Post-Upload Execution Summary */}
      {submitResult && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Bulk Stock Update Completed ({submitResult.updatedCount} item
                  {submitResult.updatedCount === 1 ? '' : 's'} updated)
                </h3>
                <p className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                  Raw Materials: {submitResult.materialUpdatedCount} · Cut Parts:{' '}
                  {submitResult.partUpdatedCount} · Note: &ldquo;Bulk Stock Update Upload&rdquo;
                  {submitResult.reorderAlertCount > 0
                    ? ` · ${submitResult.reorderAlertCount} reorder alert(s) triggered`
                    : ''}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={resetUpload}
              className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Upload Another File</span>
            </button>
          </div>

          {submitResult.skippedRows.length > 0 && (
            <div className="p-4 bg-amber-50 border border-amber-300 rounded-xl space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-900">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                <span>
                  Failed / Skipped Item Codes Summary ({submitResult.skippedRows.length} row
                  {submitResult.skippedRows.length === 1 ? '' : 's'})
                </span>
              </div>
              <div className="text-xs text-amber-900">
                Codes skipped:{' '}
                <span className="font-mono font-semibold">
                  {submitResult.skippedRows.map((s) => s.itemCode).join(', ')}
                </span>
              </div>
              <ul className="text-[11px] text-amber-800 space-y-0.5 list-disc pl-4">
                {submitResult.skippedRows.map((s) => (
                  <li key={`${s.rowNumber}-${s.itemCode}`}>
                    Row {s.rowNumber} (<span className="font-mono font-semibold">{s.itemCode}</span>):{' '}
                    {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {submitResult.updatedItems.length > 0 && (
            <div className="border border-slate-200 rounded-xl overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                  <tr>
                    <th className="px-3.5 py-2.5">Item Code</th>
                    <th className="px-3.5 py-2.5">Item Name</th>
                    <th className="px-3.5 py-2.5">Ledger</th>
                    <th className="px-3.5 py-2.5 text-right">Movement Qty</th>
                    <th className="px-3.5 py-2.5 text-right">New Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {submitResult.updatedItems.map((item, i) => (
                    <tr key={`${item.itemCode}-${i}`} className="hover:bg-slate-50">
                      <td className="px-3.5 py-2.5 font-mono font-semibold text-slate-900">
                        {item.itemCode}
                      </td>
                      <td className="px-3.5 py-2.5 text-slate-800">{item.productName}</td>
                      <td className="px-3.5 py-2.5">
                        {item.entityType === 'material' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                            Raw Material
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-violet-50 text-violet-700 border border-violet-200">
                            Cut Part
                          </span>
                        )}
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono tabular-nums font-semibold text-slate-900">
                        {formatWithUnit(item.quantity, item.unit)}
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono tabular-nums font-semibold text-emerald-700">
                        {formatWithUnit(item.newStock, item.unit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Live Preview & Submit Card */}
      {parsedRows.length > 0 && !submitResult && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Upload Preview</h3>
              <div className="flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums mt-1">
                <span className="text-emerald-700 font-semibold">
                  {readyRows.length} matched &amp; ready
                </span>
                {notFoundRows.length > 0 && (
                  <span className="text-amber-700 font-semibold">
                    {notFoundRows.length} unknown code{notFoundRows.length === 1 ? '' : 's'} (will
                    skip)
                  </span>
                )}
                {invalidRows.length > 0 && (
                  <span className="text-rose-700 font-semibold">
                    {invalidRows.length} invalid (will skip)
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={resetUpload}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Clear
              </button>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={handleApplyUpdate}
                className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap transition-colors"
              >
                {submitting
                  ? 'Updating Stock...'
                  : `Apply Stock Update (${readyRows.length} Item${
                      readyRows.length === 1 ? '' : 's'
                    })`}
              </button>
            </div>
          </div>

          {(notFoundRows.length > 0 || invalidRows.length > 0) && (
            <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2 text-xs text-amber-900">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                {notFoundRows.length > 0 && (
                  <div>
                    <span className="font-semibold">Failed / Unknown Item Code(s):</span>{' '}
                    <span className="font-mono font-semibold">
                      {notFoundRows.map((r) => r.itemCode).join(', ')}
                    </span>
                    . These do not exist in Materials or Parts Master and will be skipped.
                  </div>
                )}
                {invalidRows.length > 0 && (
                  <div>
                    <span className="font-semibold">Invalid row(s) that will be skipped:</span>{' '}
                    {invalidRows
                      .map((r) => `Row ${r.rowNumber} (${r.itemCode || 'blank'}: ${r.reason})`)
                      .join('; ')}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="border border-slate-200 rounded-xl overflow-x-auto max-h-96">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                <tr>
                  <th className="px-3.5 py-2.5">#</th>
                  <th className="px-3.5 py-2.5">Item Code</th>
                  <th className="px-3.5 py-2.5">Matched Item</th>
                  <th className="px-3.5 py-2.5">Ledger Target</th>
                  <th className="px-3.5 py-2.5 text-right">Quantity</th>
                  <th className="px-3.5 py-2.5">Unit</th>
                  <th className="px-3.5 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {parsedRows.map((row) => (
                  <tr
                    key={row.rowNumber}
                    className={
                      row.status === 'invalid'
                        ? 'bg-rose-50/60'
                        : row.status === 'not_found'
                        ? 'bg-amber-50/50'
                        : 'hover:bg-slate-50'
                    }
                  >
                    <td className="px-3.5 py-2.5 font-mono tabular-nums text-slate-500">
                      {row.rowNumber}
                    </td>
                    <td className="px-3.5 py-2.5 font-mono font-semibold text-slate-900">
                      {row.itemCode || '—'}
                    </td>
                    <td className="px-3.5 py-2.5 text-slate-800">{row.matchedName || '—'}</td>
                    <td className="px-3.5 py-2.5">
                      {row.matchedType === 'material' ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                          Raw Material
                        </span>
                      ) : row.matchedType === 'part' ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-violet-50 text-violet-700 border border-violet-200">
                          Cut Part
                        </span>
                      ) : (
                        <span className="text-amber-700 font-medium">Not Found</span>
                      )}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono tabular-nums font-semibold text-slate-900">
                      {row.quantity !== null ? formatNumber(row.quantity) : row.rawQuantity || '—'}
                    </td>
                    <td className="px-3.5 py-2.5 font-mono text-slate-600">
                      {row.matchedDefaultUnit || '—'}
                    </td>
                    <td className="px-3.5 py-2.5">
                      {row.status === 'ready' ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Ready</span>
                        </span>
                      ) : row.status === 'not_found' ? (
                        <span className="text-amber-700 font-medium">{row.reason}</span>
                      ) : (
                        <span className="text-rose-700 font-medium">{row.reason}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
