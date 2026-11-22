import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, PackagePlus } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { canReceiveOrAdjustStock } from '../lib/roles';
import { formatDate, formatNumber, formatWithUnit } from '../lib/format';
import { ColumnDef, DataTable } from '../components/DataTable';

export interface MaterialStockRow {
  id: number;
  code: string;
  name: string;
  unit: string;
  reorderLevel: number;
  reorderAlertSent: boolean;
  active: boolean;
  receipts: number;
  issues: number;
  adjustments: number;
  currentStock: number;
  isBelowReorder: boolean;
  lastMovementDate: string | null;
}

interface RecentBatchRow {
  id: string;
  quantity: number;
  createdAt: string;
  materialCode: string;
  materialName: string;
  materialUnit: string;
  stageName: string;
  stageSequence: number;
  createdByName: string;
}

interface StageDistributionRow {
  stageId: number;
  stageName: string;
  sequence: number;
  batchCount: number;
}

interface DashboardResponse {
  materials: MaterialStockRow[];
  belowReorderMaterials: MaterialStockRow[];
  stageDistribution: StageDistributionRow[];
  recentBatches: RecentBatchRow[];
  unreadNotifications: number;
}

interface DashboardPageProps {
  onNavigate: (page: string, params?: { batchId?: string; materialId?: number }) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ onNavigate }) => {
  const { user, apiFetch } = useAuth();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    apiFetch<DashboardResponse>('/api/dashboard')
      .then((res) => {
        if (mounted) {
          setData(res);
          setError(null);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load dashboard');
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [apiFetch]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-white border border-slate-200 rounded-lg animate-pulse" />
          ))}
        </div>
        <div className="h-72 bg-white border border-slate-200 rounded-lg animate-pulse" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 bg-white border border-red-200 rounded-lg text-sm text-red-700">
        {error || 'Unable to load dashboard data.'}
      </div>
    );
  }

  const totalBatches = data.stageDistribution.reduce((acc, s) => acc + s.batchCount, 0);
  const canReceive = user ? canReceiveOrAdjustStock(user.role) : false;

  const stockColumns: ColumnDef<MaterialStockRow>[] = [
    {
      key: 'code',
      label: 'Code',
      render: (r) => <span className="font-mono text-xs font-medium text-slate-900">{r.code}</span>,
    },
    { key: 'name', label: 'Material' },
    {
      key: 'receipts',
      label: 'Receipts',
      numeric: true,
      render: (r) => formatWithUnit(r.receipts, r.unit),
    },
    {
      key: 'issues',
      label: 'Issued',
      numeric: true,
      render: (r) => formatWithUnit(r.issues, r.unit),
    },
    {
      key: 'adjustments',
      label: 'Adjustments',
      numeric: true,
      render: (r) => formatWithUnit(r.adjustments, r.unit),
    },
    {
      key: 'currentStock',
      label: 'Current Stock',
      numeric: true,
      render: (r) => (
        <span className={r.isBelowReorder ? 'font-semibold text-red-700' : 'font-semibold text-slate-900'}>
          {formatWithUnit(r.currentStock, r.unit)}
        </span>
      ),
    },
    {
      key: 'reorderLevel',
      label: 'Reorder Level',
      numeric: true,
      render: (r) => formatWithUnit(r.reorderLevel, r.unit),
    },
    {
      key: 'isBelowReorder',
      label: 'Status',
      sortValue: (r) => (r.isBelowReorder ? 0 : 1),
      render: (r) =>
        r.isBelowReorder ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>Below Reorder</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span>Healthy</span>
          </span>
        ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* 4-Column KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-500">Active Materials</div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900">
            {data.materials.length}
          </div>
          <div className="mt-1 text-xs text-slate-500">Tracked in raw ledger</div>
        </div>

        <div
          className={`border rounded-lg p-4 ${
            data.belowReorderMaterials.length > 0
              ? 'bg-red-50/50 border-red-200'
              : 'bg-white border-slate-200'
          }`}
        >
          <div className="text-xs font-medium text-slate-600">Below Reorder Level</div>
          <div
            className={`mt-2 text-2xl font-bold font-mono tabular-nums ${
              data.belowReorderMaterials.length > 0 ? 'text-red-700' : 'text-slate-900'
            }`}
          >
            {data.belowReorderMaterials.length}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {data.belowReorderMaterials.length > 0
              ? 'Requires stock replenishment'
              : 'All materials above threshold'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-500">Tracked Batches</div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900">
            {totalBatches}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Across {data.stageDistribution.length} active stages
          </div>
        </div>

        <button
          type="button"
          onClick={() => onNavigate('notifications')}
          className="text-left bg-white border border-slate-200 rounded-lg p-4 hover:border-slate-300 transition-colors"
        >
          <div className="text-xs font-medium text-slate-500">Unread Notifications</div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900">
            {data.unreadNotifications}
          </div>
          <div className="mt-1 text-xs text-slate-600 inline-flex items-center gap-1">
            <span>View inbox</span>
            <ArrowRight className="w-3 h-3" />
          </div>
        </button>
      </div>

      {/* Stage Pipeline Overview */}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-900">Production Stage Pipeline</h2>
          <button
            type="button"
            onClick={() => onNavigate('batches')}
            className="text-xs font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
          >
            <span>All batches</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          {data.stageDistribution.map((st) => (
            <div
              key={st.stageId}
              className="border border-slate-200 rounded-md px-3 py-2.5 bg-slate-50/40"
            >
              <div className="text-xs text-slate-500 font-mono tabular-nums">
                Stage {String(st.sequence).padStart(2, '0')}
              </div>
              <div className="text-sm font-medium text-slate-900 truncate mt-0.5">
                {st.stageName}
              </div>
              <div className="mt-1.5 text-lg font-bold font-mono tabular-nums text-slate-900">
                {st.batchCount}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Reorder Attention Table (only if any below reorder) */}
      {data.belowReorderMaterials.length > 0 && (
        <div className="bg-white border border-red-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-red-200 bg-red-50/70 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" />
              <h2 className="text-sm font-semibold text-red-900">
                Materials At or Below Reorder Level
              </h2>
            </div>
            {canReceive && (
              <button
                type="button"
                onClick={() => onNavigate('receive')}
                className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <PackagePlus className="w-3.5 h-3.5" />
                <span>Receive Stock</span>
              </button>
            )}
          </div>
          <div className="divide-y divide-slate-200">
            {data.belowReorderMaterials.map((m) => (
              <div
                key={m.id}
                className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-sm"
              >
                <div>
                  <span className="font-mono text-xs font-semibold text-slate-900 mr-2">
                    {m.code}
                  </span>
                  <span className="font-medium text-slate-900">{m.name}</span>
                </div>
                <div className="flex items-center gap-6 font-mono tabular-nums text-xs">
                  <span className="text-red-700 font-semibold">
                    Stock: {formatWithUnit(m.currentStock, m.unit)}
                  </span>
                  <span className="text-slate-500">
                    Reorder at: {formatWithUnit(m.reorderLevel, m.unit)}
                  </span>
                  {canReceive && (
                    <button
                      type="button"
                      onClick={() => onNavigate('receive', { materialId: m.id })}
                      className="font-sans font-medium text-slate-900 underline underline-offset-2 hover:text-slate-700"
                    >
                      Replenish
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live Ledger Stock Overview */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Current Stock Ledger Overview</h2>
            <p className="text-xs text-slate-500">
              Computed live from receipts, stage issues, and stock adjustments
            </p>
          </div>
          {canReceive && (
            <button
              type="button"
              onClick={() => onNavigate('receive')}
              className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              Receive Material
            </button>
          )}
        </div>

        <DataTable
          data={data.materials}
          columns={stockColumns}
          keyField={(r) => r.id}
          searchPlaceholder="Search by material code or name..."
          searchFilter={(r, q) =>
            r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
          }
          rowClassName={(r) => (r.isBelowReorder ? 'bg-red-50/40' : '')}
          emptyTitle="No active materials"
          emptyDescription="Add materials in Settings to start tracking stock."
        />
      </div>

      {/* Recent Batch Activity */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Recent Batch Activity</h2>
          <button
            type="button"
            onClick={() => onNavigate('batches')}
            className="text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            View all
          </button>
        </div>
        {data.recentBatches.length === 0 ? (
          <div className="px-6 py-10 text-center text-xs text-slate-500">
            No batches created yet. Receive raw material to generate the first batch.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                  <th className="px-4 py-2.5">Batch ID</th>
                  <th className="px-4 py-2.5">Material</th>
                  <th className="px-4 py-2.5 text-right">Quantity</th>
                  <th className="px-4 py-2.5">Current Stage</th>
                  <th className="px-4 py-2.5">Created By</th>
                  <th className="px-4 py-2.5">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {data.recentBatches.map((b) => (
                  <tr
                    key={b.id}
                    onClick={() => onNavigate('batch-detail', { batchId: b.id })}
                    className="hover:bg-slate-50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-2.5 font-mono text-xs font-semibold text-slate-900">
                      {b.id}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="font-mono text-xs text-slate-500 mr-1.5">
                        {b.materialCode}
                      </span>
                      <span className="text-slate-900">{b.materialName}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      {formatNumber(b.quantity)} {b.materialUnit}
                    </td>
                    <td className="px-4 py-2.5 text-slate-800">
                      <span className="font-mono text-xs text-slate-500 mr-1.5">
                        {String(b.stageSequence).padStart(2, '0')}
                      </span>
                      <span>{b.stageName}</span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{b.createdByName}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500 tabular-nums">
                      {formatDate(b.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
