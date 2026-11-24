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
  | 'batch-movement'
  | 'scrap-log'
  | 'raw-material-movement'
  | 'cut-pieces-movement';

const REPORT_TABS: { id: ReportType; label: string }[] = [
  { id: 'current-stock', label: 'Current Stock' },
  { id: 'reorder-level', label: 'Reorder Level' },
  { id: 'opening-stock', label: 'Opening Stock Entered' },
  { id: 'stock-adjusted', label: 'Stock Adjusted' },
  { id: 'sent-to-cutting', label: 'Total Sent to Cutting' },
  { id: 'batch-movement', label: 'Batch Movement' },
  { id: 'scrap-log', label: 'Scrap & Rejections' },
  { id: 'raw-material-movement', label: 'Raw Material Movement Report' },
  { id: 'cut-pieces-movement', label: 'Cut Pieces Movement Report' },
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
  const [materialOrPartFilter, setMaterialOrPartFilter] = useState('');
  const [userId, setUserId] = useState('');

  const [materials, setMaterials] = useState<{ id: number; code: string; name: string }[]>([]);
  const [parts, setParts] = useState<{ id: number; code: string; name: string }[]>([]);
  const [knownPartNames, setKnownPartNames] = useState<string[]>([]);
  const [users, setUsers] = useState<{ id: number; name: string; email: string }[]>([]);

  const [report, setReport] = useState<ReportApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<{ materials: { id: number; code: string; name: string }[] }>('/api/materials'),
      apiFetch<{ parts: { id: number; code: string; name: string }[] }>('/api/parts'),
      apiFetch<{ knownPartNames?: string[] }>('/api/batches'),
      apiFetch<{ users: { id: number; name: string; email: string }[] }>('/api/users/directory'),
    ])
      .then(([matRes, partRes, batchRes, usrRes]) => {
        setMaterials(matRes.materials);
        setParts(partRes.parts ?? []);
        setKnownPartNames(batchRes.knownPartNames ?? []);
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
    if (materialOrPartFilter) {
      if (materialOrPartFilter.startsWith('part:')) {
        params.set('partId', materialOrPartFilter.slice(5));
      } else if (materialOrPartFilter.startsWith('partName:')) {
        params.set('partName', materialOrPartFilter.slice(9));
      } else if (materialOrPartFilter.startsWith('mat:')) {
        params.set('materialId', materialOrPartFilter.slice(4));
      } else {
        params.set('materialId', materialOrPartFilter);
      }
    }
    if (userId) params.set('userId', userId);
    return params.toString();
  }, [startDate, endDate, materialOrPartFilter, userId]);

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

  const handleTabChange = (nextTab: ReportType) => {
    if (nextTab !== 'cut-pieces-movement' && materialOrPartFilter.startsWith('part')) {
      setMaterialOrPartFilter('');
    }
    setActiveReport(nextTab);
  };

  const partNamesNotInMaster = knownPartNames.filter(
    (kn) => !parts.some((p) => p.name.trim().toLowerCase() === kn.trim().toLowerCase())
  );

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
          if ((c.key === 'quantityRejected' || c.key === 'qtyRejected') && val > 0) {
            return <span className="text-red-700 font-semibold">{formatNumber(val)}</span>;
          }
          if (c.key === 'qtyIn' && val > 0) {
            return <span className="text-emerald-700 font-medium">+{formatNumber(val)}</span>;
          }
          if (c.key === 'qtyOut' && val > 0) {
            return <span className="text-red-700 font-medium">-{formatNumber(val)}</span>;
          }
          if (c.key === 'balance') {
            return <span className="font-semibold text-slate-900">{formatNumber(val)}</span>;
          }
          if (c.key === 'quantityGood') {
            return <span className="text-emerald-700 font-semibold">{formatNumber(val)}</span>;
          }
          return formatNumber(val);
        }
        if (c.key === 'movementType') {
          const badge = String(val ?? '—');
          if (badge === 'Receipt' || badge === 'Produced') {
            return (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200 whitespace-nowrap">
                {badge}
              </span>
            );
          }
          if (badge === 'Issue' || badge === 'Rejected') {
            return (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800 border border-red-200 whitespace-nowrap">
                {badge}
              </span>
            );
          }
          return (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200 whitespace-nowrap">
              {badge}
            </span>
          );
        }
        if (c.key === 'status' && val === 'Below Reorder') {
          return (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800 border border-red-200 whitespace-nowrap">
              {String(val)}
            </span>
          );
        }
        if (c.key === 'status' && val === 'Healthy') {
          return (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200 whitespace-nowrap">
              {String(val)}
            </span>
          );
        }
        if (c.key === 'code' || c.key === 'partCode' || c.key === 'batchId') {
          return <span className="font-mono text-xs font-medium text-slate-900">{String(val ?? '—')}</span>;
        }
        return String(val ?? '—');
      },
    }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Operational Reports</h1>
          <p className="text-sm text-slate-500 mt-1">
            Exports use the exact same query and active filters as the table below.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleExport('csv')}
            disabled={exporting !== null || loading}
            className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap shadow-sm"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{exporting === 'csv' ? 'Exporting...' : 'Export CSV'}</span>
          </button>
          <button
            type="button"
            onClick={() => handleExport('xlsx')}
            disabled={exporting !== null || loading}
            className="px-3.5 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>{exporting === 'xlsx' ? 'Exporting...' : 'Export XLSX'}</span>
          </button>
        </div>
      </div>

      {/* Report Selector Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-white border border-slate-200 rounded-xl shadow-sm w-fit">
        {REPORT_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => handleTabChange(tab.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
              activeReport === tab.id
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Shared Filters */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1.5">Start Date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full px-3 py-2 text-xs font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1.5">End Date</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full px-3 py-2 text-xs font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1.5">
            {activeReport === 'cut-pieces-movement' ? 'Material / Part' : 'Material'}
          </label>
          <select
            value={materialOrPartFilter}
            onChange={(e) => setMaterialOrPartFilter(e.target.value)}
            className="w-full px-3 py-2 text-xs font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
          >
            <option value="">
              {activeReport === 'cut-pieces-movement' ? 'All Parts & Materials' : 'All Materials'}
            </option>
            {activeReport === 'cut-pieces-movement' && (parts.length > 0 || partNamesNotInMaster.length > 0) && (
              <optgroup label="Cut Parts">
                {parts.map((p) => (
                  <option key={`p-${p.id}`} value={`part:${p.id}`}>
                    {p.code} — {p.name}
                  </option>
                ))}
                {partNamesNotInMaster.map((pn) => (
                  <option key={`pn-${pn}`} value={`partName:${pn}`}>
                    {pn}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label={activeReport === 'cut-pieces-movement' ? 'Raw Materials' : 'Materials'}>
              {materials.map((m) => (
                <option key={`m-${m.id}`} value={`mat:${m.id}`}>
                  {m.code} — {m.name}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1.5">User</label>
          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="w-full px-3 py-2 text-xs font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
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
              setMaterialOrPartFilter('');
              setUserId('');
            }}
            className="w-full px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center justify-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Filters</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3.5 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">
          {error}
        </div>
      )}

      {/* Report Summary Strip */}
      {report && report.summary.length > 0 && (
        <div className="flex flex-wrap items-center gap-6 px-5 py-3.5 bg-white border border-slate-200 rounded-2xl shadow-sm text-xs">
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
        <div className="h-80 bg-white border border-slate-200 rounded-2xl shadow-sm animate-pulse" />
      ) : (
        <DataTable
          data={report?.rows ?? []}
          columns={tableColumns}
          keyField={(row) =>
            `${row.movementId ?? ''}-${row.batchId ?? ''}-${row.code ?? ''}-${row.partCode ?? ''}-${row.stageSequence ?? ''}-${row.movedAt ?? ''}-${row.date ?? ''}-${Math.random()}`
          }
          hideSearch
          emptyTitle="No rows match these filters"
          emptyDescription="Adjust date range, material/part, or user filters above."
        />
      )}
    </div>
  );
};
