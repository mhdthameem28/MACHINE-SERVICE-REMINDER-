import React, { useCallback, useEffect, useState } from 'react';
import { Download, FileSpreadsheet, RotateCcw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ColumnDef, DataTable } from '../components/DataTable';
import { formatNumber } from '../lib/format';

type ReportType =
  | 'current-stock'
  | 'reorder-level'
  | 'opening-stock'
  | 'stock-adjusted'
  | 'sent-to-cutting'
  | 'batch-movement';

const REPORT_TABS: { id: ReportType; label: string }[] = [
  { id: 'current-stock', label: 'Current Stock' },
  { id: 'reorder-level', label: 'Reorder Level' },
  { id: 'opening-stock', label: 'Opening Stock Entered' },
  { id: 'stock-adjusted', label: 'Stock Adjusted' },
  { id: 'sent-to-cutting', label: 'Total Sent to Cutting' },
  { id: 'batch-movement', label: 'Batch Movement' },
];

interface ReportApiResponse {
  type: ReportType;
  title: string;
  columns: { key: string; label: string; numeric?: boolean }[];
  rows: Record<string, string | number | boolean | null>[];
  summary: { label: string; value: string }[];
}

export const ReportsPage: React.FC = () => {
  const { apiFetch, downloadFile } = useAuth();
  const [activeReport, setActiveReport] = useState<ReportType>('current-stock');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [userId, setUserId] = useState('');

  const [materials, setMaterials] = useState<{ id: number; code: string; name: string }[]>([]);
  const [users, setUsers] = useState<{ id: number; name: string; email: string }[]>([]);

  const [report, setReport] = useState<ReportApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<{ materials: { id: number; code: string; name: string }[] }>('/api/materials'),
      apiFetch<{ users: { id: number; name: string; email: string }[] }>('/api/users/directory'),
    ])
      .then(([matRes, usrRes]) => {
        setMaterials(matRes.materials);
        setUsers(usrRes.users);
      })
      .catch(() => {
        // Non-fatal if filter dropdowns fail
      });
  }, [apiFetch]);

  const buildQueryString = useCallback(() => {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (materialId) params.set('materialId', materialId);
    if (userId) params.set('userId', userId);
    return params.toString();
  }, [startDate, endDate, materialId, userId]);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = buildQueryString();
      const url = `/api/reports/${activeReport}${qs ? `?${qs}` : ''}`;
      const res = await apiFetch<ReportApiResponse>(url);
      setReport(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, activeReport, buildQueryString]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  const handleExport = async (format: 'csv' | 'xlsx') => {
    setExporting(format);
    setError(null);
    try {
      const qs = buildQueryString();
      const url = `/api/reports/${activeReport}/export?format=${format}${qs ? `&${qs}` : ''}`;
      await downloadFile(url, `${activeReport}.${format}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to export ${format.toUpperCase()}`);
    } finally {
      setExporting(null);
    }
  };

  const tableColumns: ColumnDef<Record<string, string | number | boolean | null>>[] =
    (report?.columns ?? []).map((c) => ({
      key: c.key,
      label: c.label,
      numeric: c.numeric,
      render: (row) => {
        const val = row[c.key];
        if (c.numeric && typeof val === 'number') {
          if (c.key === 'adjustment' && val > 0) {
            return <span className="text-emerald-700 font-medium">+{formatNumber(val)}</span>;
          }
          if (c.key === 'adjustment' && val < 0) {
            return <span className="text-red-700 font-medium">{formatNumber(val)}</span>;
          }
          return formatNumber(val);
        }
        if (c.key === 'status' && val === 'Below Reorder') {
          return <span className="text-red-700 font-medium">{String(val)}</span>;
        }
        if (c.key === 'status' && val === 'Healthy') {
          return <span className="text-emerald-700 font-medium">{String(val)}</span>;
        }
        if (c.key === 'code' || c.key === 'batchId') {
          return <span className="font-mono text-xs font-medium text-slate-900">{String(val ?? '—')}</span>;
        }
        return String(val ?? '—');
      },
    }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Operational Reports</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Exports use the exact same query and active filters as the table below.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleExport('csv')}
            disabled={exporting !== null || loading}
            className="px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{exporting === 'csv' ? 'Exporting...' : 'Export CSV'}</span>
          </button>
          <button
            type="button"
            onClick={() => handleExport('xlsx')}
            disabled={exporting !== null || loading}
            className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>{exporting === 'xlsx' ? 'Exporting...' : 'Export XLSX'}</span>
          </button>
        </div>
      </div>

      {/* Report Selector Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {REPORT_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveReport(tab.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeReport === tab.id
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Shared Filters */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Start Date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">End Date</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Material</label>
          <select
            value={materialId}
            onChange={(e) => setMaterialId(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15"
          >
            <option value="">All Materials</option>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code} — {m.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">User</label>
          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15"
          >
            <option value="">All Users</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        </div>
        <div>
          <button
            type="button"
            onClick={() => {
              setStartDate('');
              setEndDate('');
              setMaterialId('');
              setUserId('');
            }}
            className="w-full px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-md hover:bg-slate-200 inline-flex items-center justify-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Filters</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
          {error}
        </div>
      )}

      {/* Report Summary Strip */}
      {report && report.summary.length > 0 && (
        <div className="flex flex-wrap items-center gap-6 px-4 py-3 bg-white border border-slate-200 rounded-lg text-xs">
          <span className="font-semibold text-slate-900">{report.title}</span>
          {report.summary.map((s) => (
            <div key={s.label} className="flex items-center gap-1.5">
              <span className="text-slate-500">{s.label}:</span>
              <span className="font-mono font-semibold tabular-nums text-slate-900">
                {s.value}
              </span>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="h-80 bg-white border border-slate-200 rounded-lg animate-pulse" />
      ) : (
        <DataTable
          data={report?.rows ?? []}
          columns={tableColumns}
          keyField={(row) =>
            `${row.movementId ?? ''}-${row.batchId ?? ''}-${row.code ?? ''}-${row.stageSequence ?? ''}-${row.movedAt ?? ''}-${Math.random()}`
          }
          hideSearch
          emptyTitle="No rows match these filters"
          emptyDescription="Adjust date range, material, or user filters above."
        />
      )}
    </div>
  );
};
