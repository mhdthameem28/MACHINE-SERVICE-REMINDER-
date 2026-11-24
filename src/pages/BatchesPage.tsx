import React, { useEffect, useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { formatDateTime, formatNumber, formatWithUnit } from '../lib/format';
import { ColumnDef, DataTable } from '../components/DataTable';

interface BatchRow {
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
  note: string | null;
  createdAt: string;
  createdBy: number;
  createdByName: string;
  createdByEmail: string;
}

interface StageRow {
  id: number;
  name: string;
  sequence: number;
  active: boolean;
}

interface BatchesPageProps {
  onOpenBatch: (batchId: string) => void;
}

export const BatchesPage: React.FC<BatchesPageProps> = ({ onOpenBatch }) => {
  const { apiFetch } = useAuth();
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [stages, setStages] = useState<StageRow[]>([]);
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    apiFetch<{ batches: BatchRow[]; activeStages: StageRow[] }>('/api/batches')
      .then((res) => {
        if (mounted) {
          setBatches(res.batches);
          setStages(res.activeStages);
          setError(null);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load batches');
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [apiFetch]);

  const filteredBatches = useMemo(() => {
    if (stageFilter === 'all') return batches;
    return batches.filter((b) => String(b.currentStageId) === stageFilter);
  }, [batches, stageFilter]);

  const columns: ColumnDef<BatchRow>[] = [
    {
      key: 'id',
      label: 'Batch ID',
      render: (r) => <span className="font-mono text-xs font-semibold text-slate-900">{r.id}</span>,
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
      sortValue: (r) => r.partName ?? '',
      render: (r) =>
        r.partName ? (
          <span className="font-medium text-slate-900">{r.partName}</span>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        ),
    },
    {
      key: 'quantity',
      label: 'Raw Qty',
      numeric: true,
      render: (r) => formatWithUnit(r.quantity, r.materialUnit),
    },
    {
      key: 'piecesQuantity',
      label: 'Pieces',
      numeric: true,
      sortValue: (r) => r.piecesQuantity ?? 0,
      render: (r) =>
        r.piecesQuantity !== null ? (
          <span className="font-mono text-slate-900">{formatNumber(r.piecesQuantity)} pcs</span>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        ),
    },
    {
      key: 'stageSequence',
      label: 'Current Stage',
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
      key: 'createdByName',
      label: 'Created By',
      render: (r) => (
        <div>
          <div className="text-slate-800">{r.createdByName}</div>
          <div className="text-xs text-slate-500">{r.createdByEmail}</div>
        </div>
      ),
    },
    {
      key: 'createdAt',
      label: 'Created Date',
      render: (r) => (
        <span className="font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
          {formatDateTime(r.createdAt)}
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
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Production Batches</h1>
          <p className="text-sm text-slate-500 mt-1">
            Track each batch from raw material receipt through laser cutting, bending, and machining.
          </p>
        </div>
      </div>

      {/* Dynamic stage filter tabs driven from stages table */}
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
          All Stages ({batches.length})
        </button>
        {stages.map((st) => {
          const count = batches.filter((b) => b.currentStageId === st.id).length;
          return (
            <button
              key={st.id}
              type="button"
              onClick={() => setStageFilter(String(st.id))}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                stageFilter === String(st.id)
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              {String(st.sequence).padStart(2, '0')}. {st.name} ({count})
            </button>
          );
        })}
      </div>

      <DataTable
        data={filteredBatches}
        columns={columns}
        keyField={(r) => r.id}
        searchPlaceholder="Search by Batch ID, raw material, part name, or creator..."
        searchFilter={(r, q) =>
          r.id.toLowerCase().includes(q) ||
          r.materialCode.toLowerCase().includes(q) ||
          r.materialName.toLowerCase().includes(q) ||
          (r.partName ?? '').toLowerCase().includes(q) ||
          r.createdByName.toLowerCase().includes(q)
        }
        onRowClick={(r) => onOpenBatch(r.id)}
        emptyTitle="No batches match this view"
        emptyDescription="Batches are created automatically when raw materials are received."
        emptyAction={
          <div className="inline-flex items-center gap-1.5 text-xs text-slate-500">
            <Layers className="w-4 h-4" />
            <span>Try switching stage filters above</span>
          </div>
        }
      />
    </div>
  );
};
