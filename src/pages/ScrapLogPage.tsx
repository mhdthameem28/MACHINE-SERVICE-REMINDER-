import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { formatDateTime, formatNumber } from '../lib/format';
import { ColumnDef, DataTable } from '../components/DataTable';

interface ScrapLogRow {
  id: number;
  batchId: string;
  materialId: number;
  materialCode: string;
  materialName: string;
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
  loggedByEmail: string;
}

interface StageScrapSummary {
  stageId: number;
  stageName: string;
  stageSequence: number;
  incidentCount: number;
  totalRejected: number;
  totalProcessed: number;
}

interface ScrapLogPageProps {
  onOpenBatch: (batchId: string) => void;
}

export const ScrapLogPage: React.FC<ScrapLogPageProps> = ({ onOpenBatch }) => {
  const { apiFetch } = useAuth();
  const [logs, setLogs] = useState<ScrapLogRow[]>([]);
  const [stageSummary, setStageSummary] = useState<StageScrapSummary[]>([]);
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<StageScrapSummary | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    apiFetch<{ logs: ScrapLogRow[]; stageSummary: StageScrapSummary[] }>('/api/scrap-logs')
      .then((res) => {
        if (mounted) {
          setLogs(res.logs);
          setStageSummary(res.stageSummary);
          setError(null);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load scrap log');
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [apiFetch]);

  const filteredLogs = useMemo(() => {
    if (stageFilter === 'all') return logs;
    return logs.filter((l) => String(l.stageId) === stageFilter);
  }, [logs, stageFilter]);

  const totalRejectedAll = stageSummary.reduce((sum, s) => sum + s.totalRejected, 0);

  const selectedStageReasonBreakdown = useMemo(() => {
    if (!selectedStage) return [];
    const reasonTotals = new Map<string, number>();
    for (const log of logs) {
      if (log.stageId !== selectedStage.stageId) continue;
      const label = log.reason?.trim() || 'Unspecified Reason';
      reasonTotals.set(label, (reasonTotals.get(label) ?? 0) + log.quantityRejected);
    }
    return Array.from(reasonTotals.entries())
      .map(([reason, qty]) => ({ reason, qty }))
      .sort((a, b) => b.qty - a.qty);
  }, [logs, selectedStage]);

  const columns: ColumnDef<ScrapLogRow>[] = [
    {
      key: 'id',
      label: 'Log #',
      numeric: true,
      render: (r) => <span className="font-mono text-xs text-slate-500">#{r.id}</span>,
    },
    {
      key: 'batchId',
      label: 'Batch ID',
      render: (r) => (
        <span className="font-mono text-xs font-semibold text-indigo-600 hover:underline">
          {r.batchId}
        </span>
      ),
    },
    {
      key: 'materialName',
      label: 'Raw Material',
      render: (r) => (
        <div>
          <span className="font-mono text-xs text-slate-500 mr-1.5">{r.materialCode}</span>
          <span className="text-slate-900">{r.materialName}</span>
        </div>
      ),
    },
    {
      key: 'partName',
      label: 'Part Name',
      render: (r) =>
        r.partName ? (
          <span className="font-medium text-slate-900">{r.partName}</span>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        ),
    },
    {
      key: 'stageSequence',
      label: 'Stage',
      render: (r) => (
        <span className="inline-flex items-center gap-1.5 text-slate-900 font-medium whitespace-nowrap">
          <span className="font-mono text-xs text-slate-500">
            {String(r.stageSequence).padStart(2, '0')}
          </span>
          <span>{r.stageName}</span>
        </span>
      ),
    },
    {
      key: 'quantityProcessed',
      label: 'Processed',
      numeric: true,
      render: (r) => `${formatNumber(r.quantityProcessed)} pcs`,
    },
    {
      key: 'quantityRejected',
      label: 'Rejected',
      numeric: true,
      render: (r) => (
        <span className="font-semibold text-red-700">
          {formatNumber(r.quantityRejected)} pcs
        </span>
      ),
    },
    {
      key: 'quantityGood',
      label: 'Good Out',
      numeric: true,
      render: (r) => (
        <span className="font-semibold text-emerald-700">
          {formatNumber(r.quantityGood)} pcs
        </span>
      ),
    },
    {
      key: 'reason',
      label: 'Rejection Reason',
      render: (r) => <span className="text-xs text-slate-700">{r.reason || '—'}</span>,
    },
    {
      key: 'loggedByName',
      label: 'Logged By',
      render: (r) => <span className="text-slate-700">{r.loggedByName}</span>,
    },
    {
      key: 'loggedAt',
      label: 'Logged At',
      render: (r) => (
        <span className="font-mono text-xs text-slate-500 tabular-nums whitespace-nowrap">
          {formatDateTime(r.loggedAt)}
        </span>
      ),
    },
  ];

  if (loading) {
    return <div className="h-96 bg-white border border-slate-200 rounded-2xl shadow-sm animate-pulse" />;
  }

  if (error) {
    return (
      <div className="p-4 bg-white border border-red-200 rounded-2xl shadow-sm text-sm text-red-700">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Scrap Inventory &amp; Rejection Log
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Audit defective pieces rejected across Laser Cutting, Bending, Machining, and subsequent stages.
        </p>
      </div>

      {/* Stage Waste Breakdown Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white border border-red-200 rounded-2xl shadow-sm p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-red-700">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>Total Pieces Scrapped</span>
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-red-700">
            {formatNumber(totalRejectedAll)}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Across {logs.length} rejection event{logs.length === 1 ? '' : 's'}
          </div>
        </div>

        {stageSummary.map((st) => (
          <button
            key={st.stageId}
            type="button"
            onClick={() => setSelectedStage(st)}
            className="text-left bg-white border border-slate-200 rounded-2xl shadow-sm p-4 cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
          >
            <div className="text-xs font-mono text-slate-500">
              Stage {String(st.stageSequence).padStart(2, '0')}
            </div>
            <div className="text-sm font-semibold text-slate-900 truncate mt-0.5">
              {st.stageName}
            </div>
            <div className="mt-2 text-xl font-bold font-mono tabular-nums text-slate-900">
              {formatNumber(st.totalRejected)}{' '}
              <span className="text-xs font-normal text-slate-500">pcs rejected</span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {st.incidentCount} rejection incident{st.incidentCount === 1 ? '' : 's'}
            </div>
          </button>
        ))}
      </div>

      {/* Stage Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-white border border-slate-200 rounded-xl shadow-sm w-fit">
        <button
          type="button"
          onClick={() => setStageFilter('all')}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
            stageFilter === 'all'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          All Stages ({logs.length})
        </button>
        {stageSummary.map((st) => (
          <button
            key={st.stageId}
            type="button"
            onClick={() => setStageFilter(String(st.stageId))}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
              stageFilter === String(st.stageId)
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            {String(st.stageSequence).padStart(2, '0')}. {st.stageName} ({st.incidentCount})
          </button>
        ))}
      </div>

      <DataTable
        data={filteredLogs}
        columns={columns}
        keyField={(r) => r.id}
        searchPlaceholder="Search by Batch ID, material, part name, or rejection reason..."
        searchFilter={(r, q) =>
          r.batchId.toLowerCase().includes(q) ||
          r.materialCode.toLowerCase().includes(q) ||
          r.materialName.toLowerCase().includes(q) ||
          (r.partName ?? '').toLowerCase().includes(q) ||
          (r.reason ?? '').toLowerCase().includes(q)
        }
        onRowClick={(r) => onOpenBatch(r.batchId)}
        emptyTitle="No scrap or rejections recorded"
        emptyDescription="When operators log defective pieces during stage advancement, they appear here."
        emptyAction={
          <div className="inline-flex items-center gap-1.5 text-xs text-slate-500">
            <Trash2 className="w-4 h-4" />
            <span>Zero waste logged for this filter</span>
          </div>
        }
      />

      {/* Stage Rejection Summary Modal */}
      {selectedStage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50"
          onClick={() => setSelectedStage(null)}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-mono text-slate-500">
                  Stage {String(selectedStage.stageSequence).padStart(2, '0')}
                </div>
                <h3 className="text-base font-bold tracking-tight text-slate-900">
                  {selectedStage.stageName} — Scrap Summary
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedStage(null)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  <div className="text-xs font-medium text-slate-500">Total Processed</div>
                  <div className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
                    {formatNumber(selectedStage.totalProcessed)}{' '}
                    <span className="text-xs font-normal text-slate-500">pcs</span>
                  </div>
                </div>
                <div className="p-3 bg-red-50/70 border border-red-200 rounded-xl">
                  <div className="text-xs font-medium text-red-700">Total Rejected</div>
                  <div className="mt-1 text-xl font-bold font-mono tabular-nums text-red-700">
                    {formatNumber(selectedStage.totalRejected)}{' '}
                    <span className="text-xs font-normal text-red-600">pcs</span>
                  </div>
                </div>
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-700 mb-2">
                  Rejection Reasons Breakdown
                </div>
                {selectedStageReasonBreakdown.length === 0 ? (
                  <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-500 text-center">
                    No rejections recorded at {selectedStage.stageName}.
                  </div>
                ) : (
                  <div className="border border-slate-200 rounded-xl divide-y divide-slate-200 max-h-60 overflow-y-auto">
                    {selectedStageReasonBreakdown.map((item) => (
                      <div
                        key={item.reason}
                        className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs"
                      >
                        <span className="font-medium text-slate-800">{item.reason}</span>
                        <span className="font-mono font-semibold tabular-nums text-red-700 whitespace-nowrap">
                          {formatNumber(item.qty)} pcs
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setStageFilter(String(selectedStage.stageId));
                  setSelectedStage(null);
                }}
                className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
              >
                Filter log to this stage
              </button>
              <button
                type="button"
                onClick={() => setSelectedStage(null)}
                className="px-4 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
