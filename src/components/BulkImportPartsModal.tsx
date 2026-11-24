import React, { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Upload,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { MATERIAL_UNITS, MaterialUnit, normalizeMaterialUnit } from '../lib/units';

interface BulkImportPartsModalProps {
  existingCodes: string[];
  onClose: () => void;
  onImported: (summary: {
    insertedCount: number;
    openingStockCount: number;
    reorderAlertCount: number;
    skippedCodes: string[];
  }) => void;
}

interface ParsedPartRow {
  rowNumber: number;
  code: string;
  name: string;
  rawUnit: string;
  unit: MaterialUnit | null;
  reorderLevel: number;
  qty: number;
  status: 'ready' | 'exists' | 'duplicate' | 'invalid';
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

export const BulkImportPartsModal: React.FC<BulkImportPartsModalProps> = ({
  existingCodes,
  onClose,
  onImported,
}) => {
  const { apiFetch } = useAuth();
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedPartRow[]>([]);
  const [skipExisting, setSkipExisting] = useState(true);
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const existingSet = useMemo(
    () => new Set(existingCodes.map((c) => c.trim().toUpperCase())),
    [existingCodes]
  );

  const handleFileChange = async (file: File | undefined) => {
    if (!file) return;
    setParseError(null);
    setFileName(file.name);

    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });
      const firstSheetName = wb.SheetNames[0];
      if (!firstSheetName) {
        setParseError('The uploaded file contains no worksheets.');
        setParsedRows([]);
        return;
      }

      const sheet = wb.Sheets[firstSheetName];
      const rawJson = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: '',
      });

      if (rawJson.length === 0) {
        setParseError('No data rows found in the uploaded file.');
        setParsedRows([]);
        return;
      }

      const seenInFile = new Set<string>();
      const rows: ParsedPartRow[] = rawJson.map((raw, idx) => {
        const rowNumber = idx + 1;
        const codeRaw = pickField(raw, ['partcode', 'code', 'sku', 'itemcode']);
        const nameRaw = pickField(raw, ['partname', 'name', 'description', 'itemname']);
        const unitRaw = pickField(raw, ['unit', 'uom', 'unitofmeasure']);
        const reorderRaw = pickField(raw, [
          'reorderlevel',
          'reorder',
          'minstock',
          'threshold',
        ]);
        const qtyRaw = pickField(raw, [
          'qty',
          'openingstock',
          'openingqty',
          'quantity',
          'stock',
          'qtyopeningstock',
        ]);

        const code = String(codeRaw ?? '').trim().toUpperCase();
        const name = String(nameRaw ?? '').trim();
        const rawUnitStr = String(unitRaw ?? 'qty').trim() || 'qty';
        const normalizedUnit = normalizeMaterialUnit(rawUnitStr);
        const reorderNum =
          reorderRaw === '' || reorderRaw === null || reorderRaw === undefined
            ? 0
            : Number(reorderRaw);
        const qtyNum =
          qtyRaw === '' || qtyRaw === null || qtyRaw === undefined ? 0 : Number(qtyRaw);

        if (!code) {
          return {
            rowNumber,
            code,
            name,
            rawUnit: rawUnitStr,
            unit: normalizedUnit,
            reorderLevel: Number.isFinite(reorderNum) ? reorderNum : 0,
            qty: Number.isFinite(qtyNum) ? qtyNum : 0,
            status: 'invalid',
            reason: 'Missing Part Code',
          };
        }
        if (!name) {
          return {
            rowNumber,
            code,
            name,
            rawUnit: rawUnitStr,
            unit: normalizedUnit,
            reorderLevel: Number.isFinite(reorderNum) ? reorderNum : 0,
            qty: Number.isFinite(qtyNum) ? qtyNum : 0,
            status: 'invalid',
            reason: 'Missing Part Name',
          };
        }
        if (!normalizedUnit) {
          return {
            rowNumber,
            code,
            name,
            rawUnit: rawUnitStr,
            unit: null,
            reorderLevel: Number.isFinite(reorderNum) ? reorderNum : 0,
            qty: Number.isFinite(qtyNum) ? qtyNum : 0,
            status: 'invalid',
            reason: `Invalid unit "${rawUnitStr}" (allowed: ${MATERIAL_UNITS.join(', ')})`,
          };
        }
        if (!Number.isFinite(reorderNum) || reorderNum < 0) {
          return {
            rowNumber,
            code,
            name,
            rawUnit: rawUnitStr,
            unit: normalizedUnit,
            reorderLevel: 0,
            qty: Number.isFinite(qtyNum) ? qtyNum : 0,
            status: 'invalid',
            reason: 'Reorder Level must be >= 0',
          };
        }
        if (!Number.isFinite(qtyNum) || qtyNum < 0) {
          return {
            rowNumber,
            code,
            name,
            rawUnit: rawUnitStr,
            unit: normalizedUnit,
            reorderLevel: reorderNum,
            qty: 0,
            status: 'invalid',
            reason: 'Qty (Opening Stock) must be >= 0',
          };
        }
        if (seenInFile.has(code)) {
          return {
            rowNumber,
            code,
            name,
            rawUnit: rawUnitStr,
            unit: normalizedUnit,
            reorderLevel: reorderNum,
            qty: qtyNum,
            status: 'duplicate',
            reason: 'Duplicate Part Code in file',
          };
        }

        seenInFile.add(code);

        if (existingSet.has(code)) {
          return {
            rowNumber,
            code,
            name,
            rawUnit: rawUnitStr,
            unit: normalizedUnit,
            reorderLevel: reorderNum,
            qty: qtyNum,
            status: 'exists',
            reason: 'Part Code already exists in database',
          };
        }

        return {
          rowNumber,
          code,
          name,
          rawUnit: rawUnitStr,
          unit: normalizedUnit,
          reorderLevel: reorderNum,
          qty: qtyNum,
          status: 'ready',
        };
      });

      setParsedRows(rows);
    } catch {
      setParseError('Could not read this file. Please upload a valid .csv or .xlsx spreadsheet.');
      setParsedRows([]);
    }
  };

  const downloadTemplate = (format: 'csv' | 'xlsx') => {
    const sampleRows = [
      ['Part Code', 'Part Name', 'Unit', 'Reorder Level', 'Qty'],
      ['PART-CLAV-L12', 'Clavicle Superior Lateral Plate Left 1-12 Hole', 'qty', 20, 45],
      ['PART-CLAV-R12', 'Clavicle Superior Lateral Plate Right 1-12 Hole', 'qty', 15, 30],
      ['PART-RAD-D06', 'Distal Radius Volar Locking Plate 6 Hole', 'qty', 25, 60],
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sampleRows);
    XLSX.utils.book_append_sheet(wb, ws, 'PartsMaster');

    if (format === 'csv') {
      const csv = XLSX.utils.sheet_to_csv(ws);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'parts-master-import-template.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } else {
      XLSX.writeFile(wb, 'parts-master-import-template.xlsx');
    }
  };

  const readyRows = parsedRows.filter((r) => r.status === 'ready');
  const existingRows = parsedRows.filter((r) => r.status === 'exists');
  const errorRows = parsedRows.filter(
    (r) => r.status === 'invalid' || r.status === 'duplicate'
  );

  const canImport =
    parsedRows.length > 0 &&
    errorRows.length === 0 &&
    readyRows.length > 0 &&
    (skipExisting || existingRows.length === 0);

  const handleImport = async () => {
    if (!canImport) return;
    setSubmitting(true);
    setParseError(null);
    try {
      const payloadRows = parsedRows
        .filter((r) => r.status === 'ready' || (!skipExisting && r.status === 'exists'))
        .map((r) => ({
          code: r.code,
          name: r.name,
          unit: r.unit,
          reorderLevel: r.reorderLevel,
          qty: r.qty,
        }));

      const res = await apiFetch<{
        insertedCount: number;
        openingStockCount: number;
        reorderAlertCount?: number;
        skippedCodes: string[];
      }>('/api/settings/parts/bulk-import', {
        method: 'POST',
        body: JSON.stringify({ rows: payloadRows, skipExisting }),
      });

      onImported({
        insertedCount: res.insertedCount,
        openingStockCount: res.openingStockCount ?? 0,
        reorderAlertCount: res.reorderAlertCount ?? 0,
        skippedCodes: res.skippedCodes,
      });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Bulk import failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden shadow-xl">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-bold tracking-tight text-slate-900">
              Bulk Import Parts Master (Cut Pieces)
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Columns: Part Code, Part Name, Unit, Reorder Level, Qty (Opening Stock). Rows with Qty &gt; 0 automatically create Opening Stock ledger entries.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-xl p-3.5">
            <div className="text-xs text-slate-600">
              Allowed units:{' '}
              <span className="font-medium text-slate-900">
                {MATERIAL_UNITS.join(', ')}
              </span>{' '}
              (pcs / pieces normalize to qty)
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => downloadTemplate('csv')}
                className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download Sample Template (CSV)</span>
              </button>
              <button
                type="button"
                onClick={() => downloadTemplate('xlsx')}
                className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5 transition-colors"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>Download Sample Template (Excel)</span>
              </button>
            </div>
          </div>

          <label className="block border border-dashed border-slate-300 rounded-xl p-6 text-center cursor-pointer hover:border-indigo-500 hover:bg-indigo-50/30 transition-colors">
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => handleFileChange(e.target.files?.[0])}
              className="hidden"
            />
            <Upload className="w-6 h-6 text-slate-500 mx-auto mb-2" />
            <div className="text-sm font-medium text-slate-900">
              {fileName ? `Selected: ${fileName}` : 'Click to choose a .csv or .xlsx file'}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Supports Excel workbooks (.xlsx, .xls) and comma-separated files (.csv)
            </div>
          </label>

          {parseError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md flex items-start gap-2 text-xs text-red-800">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{parseError}</span>
            </div>
          )}

          {parsedRows.length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex flex-wrap items-center gap-4 font-mono tabular-nums">
                  <span className="text-emerald-700 font-semibold">
                    {readyRows.length} ready
                  </span>
                  {existingRows.length > 0 && (
                    <span className="text-amber-700 font-semibold">
                      {existingRows.length} already exist
                    </span>
                  )}
                  {errorRows.length > 0 && (
                    <span className="text-red-700 font-semibold">
                      {errorRows.length} invalid
                    </span>
                  )}
                </div>

                {existingRows.length > 0 && (
                  <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={skipExisting}
                      onChange={(e) => setSkipExisting(e.target.checked)}
                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span>Skip existing part codes</span>
                  </label>
                )}
              </div>

              <div className="border border-slate-200 rounded-xl overflow-x-auto max-h-64">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-slate-600 text-xs font-semibold">
                    <tr>
                      <th className="px-3 py-2.5">#</th>
                      <th className="px-3 py-2.5">Part Code</th>
                      <th className="px-3 py-2.5">Part Name</th>
                      <th className="px-3 py-2.5">Unit</th>
                      <th className="px-3 py-2.5 text-right">Reorder Level</th>
                      <th className="px-3 py-2.5 text-right">Qty (Opening)</th>
                      <th className="px-3 py-2.5">Validation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {parsedRows.map((row) => (
                      <tr
                        key={row.rowNumber}
                        className={
                          row.status === 'invalid' || row.status === 'duplicate'
                            ? 'bg-red-50/60 hover:bg-red-50'
                            : row.status === 'exists'
                            ? 'bg-amber-50/40 hover:bg-amber-50/70'
                            : 'hover:bg-slate-50'
                        }
                      >
                        <td className="px-3 py-2 font-mono tabular-nums text-slate-500">
                          {row.rowNumber}
                        </td>
                        <td className="px-3 py-2 font-mono font-semibold text-slate-900">
                          {row.code || '—'}
                        </td>
                        <td className="px-3 py-2 text-slate-800">{row.name || '—'}</td>
                        <td className="px-3 py-2 font-mono text-slate-700">
                          {row.unit ?? row.rawUnit ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-800">
                          {row.reorderLevel}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold text-slate-900">
                          {row.qty}
                        </td>
                        <td className="px-3 py-2">
                          {row.status === 'ready' ? (
                            <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Ready</span>
                            </span>
                          ) : row.status === 'exists' ? (
                            <span className="text-amber-700 font-medium">
                              {skipExisting ? 'Will skip (exists)' : 'Conflict (exists)'}
                            </span>
                          ) : (
                            <span className="text-red-700 font-medium">{row.reason}</span>
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

        <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canImport || submitting}
            onClick={handleImport}
            className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap transition-colors"
          >
            {submitting
              ? 'Importing...'
              : `Import ${readyRows.length} Part${readyRows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
};
