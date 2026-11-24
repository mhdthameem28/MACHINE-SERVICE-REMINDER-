import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cog,
  Flame,
  Layers,
  PackageCheck,
  PackagePlus,
  Scissors,
  ShieldAlert,
  Warehouse,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
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

export interface PartStockRow {
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
  partName: string | null;
  piecesQuantity: number | null;
  createdAt: string;
  materialCode: string;
  materialName: string;
  materialUnit: string;
  stageName: string;
  stageSequence: number;
  createdByName: string;
}

interface StageUnitTotal {
  unit: string;
  total: number;
}

interface StageDistributionRow {
  stageId: number;
  stageName: string;
  sequence: number;
  batchCount: number;
  totalPieces?: number;
  totalRawQuantity?: number;
  unitTotals?: StageUnitTotal[];
}

interface ProductionTimePoint {
  date: string;
  label: string;
  goodPieces: number;
  rejectedPieces: number;
  transitions: number;
}

interface RejectionByStageRow {
  stageId: number;
  stageName: string;
  sequence: number;
  rejectedPieces: number;
  incidentCount: number;
}

interface TopCutPartRow {
  partName: string;
  totalPieces: number;
  batchCount: number;
  rawQuantity: number;
}

interface ExecutiveSummary {
  batchesCreated: number;
  completedBatches: number;
  inProcessBatches: number;
  totalRejectedPieces: number;
  productionOverTime: ProductionTimePoint[];
  rejectionsByStage: RejectionByStageRow[];
  topCutPartsProduced: TopCutPartRow[];
}

interface DashboardResponse {
  materials: MaterialStockRow[];
  parts: PartStockRow[];
  belowReorderMaterials: MaterialStockRow[];
  belowReorderParts?: PartStockRow[];
  stageDistribution: StageDistributionRow[];
  recentBatches: RecentBatchRow[];
  unreadNotifications: number;
  executiveSummary?: ExecutiveSummary;
}

interface DashboardPageProps {
  onNavigate: (page: string, params?: { batchId?: string; materialId?: number }) => void;
}

const REJECTION_STAGE_COLORS = [
  '#f97316', // Orange
  '#8b5cf6', // Purple
  '#ef4444', // Red
  '#eab308', // Amber
  '#06b6d4', // Cyan
];

const TOP_PART_COLORS = [
  '#4F46E5', // Indigo
  '#0ea5e9', // Sky
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#8b5cf6', // Violet
];

const HEALTH_COLORS = {
  healthy: '#10b981',
  below: '#ef4444',
};

interface ProductionTooltipProps {
  active?: boolean;
  payload?: { payload?: ProductionTimePoint }[];
}

const ProductionVolumeTooltip: React.FC<ProductionTooltipProps> = ({ active, payload }) => {
  if (!active || !payload || payload.length === 0) return null;
  const pt = payload[0]?.payload;
  if (!pt) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg px-3 py-2 text-xs">
      <div className="font-semibold text-slate-900">{pt.label}</div>
      <div className="text-[11px] font-mono text-slate-400">{pt.date}</div>
      <div className="mt-1.5 space-y-0.5">
        <div className="flex items-center justify-between gap-4">
          <span className="text-slate-600">Good Pieces:</span>
          <span className="font-mono tabular-nums font-semibold text-indigo-600">
            {formatNumber(pt.goodPieces)} pcs
          </span>
        </div>
        {pt.rejectedPieces > 0 && (
          <div className="flex items-center justify-between gap-4">
            <span className="text-slate-600">Rejected:</span>
            <span className="font-mono tabular-nums font-semibold text-rose-600">
              {formatNumber(pt.rejectedPieces)} pcs
            </span>
          </div>
        )}
        <div className="flex items-center justify-between gap-4">
          <span className="text-slate-600">Stage Outputs:</span>
          <span className="font-mono tabular-nums text-slate-800">{pt.transitions}</span>
        </div>
      </div>
    </div>
  );
};

interface RejectionTooltipProps {
  active?: boolean;
  payload?: { payload?: RejectionByStageRow }[];
}

const RejectionStageTooltip: React.FC<RejectionTooltipProps> = ({ active, payload }) => {
  if (!active || !payload || payload.length === 0) return null;
  const item = payload[0]?.payload;
  if (!item) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg px-3 py-2 text-xs">
      <div className="font-semibold text-slate-900">
        Stage {String(item.sequence).padStart(2, '0')} · {item.stageName}
      </div>
      <div className="mt-1 font-mono tabular-nums font-semibold text-rose-600">
        {formatNumber(item.rejectedPieces)} pcs rejected
      </div>
      <div className="text-[11px] text-slate-500 mt-0.5">
        {item.incidentCount} {item.incidentCount === 1 ? 'scrap log' : 'scrap logs'}
      </div>
    </div>
  );
};

interface TopPartChartItem extends TopCutPartRow {
  displayValue: number;
  metricUnit: 'pcs' | 'batches';
}

interface TopPartTooltipProps {
  active?: boolean;
  payload?: { payload?: TopPartChartItem }[];
}

const TopPartTooltip: React.FC<TopPartTooltipProps> = ({ active, payload }) => {
  if (!active || !payload || payload.length === 0) return null;
  const item = payload[0]?.payload;
  if (!item) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg px-3 py-2 text-xs">
      <div className="font-semibold text-slate-900">{item.partName}</div>
      <div className="mt-1 space-y-0.5">
        <div className="flex items-center justify-between gap-4">
          <span className="text-slate-600">Cut Pieces:</span>
          <span className="font-mono tabular-nums font-semibold text-indigo-600">
            {formatNumber(item.totalPieces)} pcs
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-slate-600">Batches:</span>
          <span className="font-mono tabular-nums text-slate-800">{item.batchCount}</span>
        </div>
      </div>
    </div>
  );
};

interface StockHealthTooltipProps {
  active?: boolean;
  payload?: { payload?: { name: string; value: number; detail?: string } }[];
}

const StockHealthTooltip: React.FC<StockHealthTooltipProps> = ({ active, payload }) => {
  if (!active || !payload || payload.length === 0) return null;
  const item = payload[0]?.payload;
  if (!item) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg px-3 py-2 text-xs">
      <div className="font-semibold text-slate-900">{item.name}</div>
      <div className="mt-0.5 font-mono tabular-nums font-semibold text-slate-700">
        {item.value} {item.value === 1 ? 'item' : 'items'}
      </div>
      {item.detail && <div className="text-[11px] text-slate-500 mt-0.5">{item.detail}</div>}
    </div>
  );
};

function formatStageStockSubtext(stage: StageDistributionRow | undefined, isRawStage: boolean): string {
  if (!stage || stage.batchCount === 0) {
    return '0 batches currently queued';
  }
  if (!isRawStage && (stage.totalPieces ?? 0) > 0) {
    return `${formatNumber(stage.totalPieces ?? 0)} pcs across ${stage.batchCount} ${
      stage.batchCount === 1 ? 'batch' : 'batches'
    }`;
  }
  const units = stage.unitTotals ?? [];
  if (units.length > 0) {
    const formatted = units
      .slice(0, 2)
      .map((u) => `${formatNumber(u.total)} ${u.unit}`)
      .join(' · ');
    return units.length > 2 ? `${formatted} +${units.length - 2} more` : formatted;
  }
  return `${formatNumber(stage.totalRawQuantity ?? 0)} units in stage`;
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
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div
              key={i}
              className="h-[116px] bg-white border border-slate-200 rounded-xl shadow-sm animate-pulse"
            />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-8 h-80 bg-white border border-slate-200 rounded-2xl shadow-sm animate-pulse" />
          <div className="lg:col-span-4 h-80 bg-white border border-slate-200 rounded-2xl shadow-sm animate-pulse" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-7 h-72 bg-white border border-slate-200 rounded-2xl shadow-sm animate-pulse" />
          <div className="lg:col-span-5 h-72 bg-white border border-slate-200 rounded-2xl shadow-sm animate-pulse" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 bg-white border border-red-200 rounded-2xl shadow-sm text-sm text-red-700">
        {error || 'Unable to load dashboard data.'}
      </div>
    );
  }

  const canReceive = user ? canReceiveOrAdjustStock(user.role) : false;

  const stageBySequence = new Map<number, StageDistributionRow>(
    data.stageDistribution.map((s) => [s.sequence, s])
  );

  const stage1 = stageBySequence.get(1);
  const stage2 = stageBySequence.get(2);
  const stage3 = stageBySequence.get(3);
  const stage4 = stageBySequence.get(4);

  const exec: ExecutiveSummary = data.executiveSummary ?? {
    batchesCreated: data.stageDistribution.reduce((acc, s) => acc + s.batchCount, 0),
    completedBatches: stage4?.batchCount ?? 0,
    inProcessBatches:
      (stage1?.batchCount ?? 0) + (stage2?.batchCount ?? 0) + (stage3?.batchCount ?? 0),
    totalRejectedPieces: 0,
    productionOverTime: [],
    rejectionsByStage: [],
    topCutPartsProduced: [],
  };

  const completionPct =
    exec.batchesCreated > 0
      ? Math.round((exec.completedBatches / exec.batchesCreated) * 100)
      : 0;

  const totalGoodPieces30d = exec.productionOverTime.reduce(
    (sum, pt) => sum + pt.goodPieces,
    0
  );
  const hasAnyProduction30d = exec.productionOverTime.some((pt) => pt.goodPieces > 0);

  const anyTopPartHasPieces = exec.topCutPartsProduced.some((p) => p.totalPieces > 0);
  const topPartsChartData: TopPartChartItem[] = exec.topCutPartsProduced.map((p) => ({
    ...p,
    displayValue: anyTopPartHasPieces ? p.totalPieces : p.batchCount,
    metricUnit: anyTopPartHasPieces ? 'pcs' : 'batches',
  }));

  const belowReorderParts =
    data.belowReorderParts ?? (data.parts ?? []).filter((p) => p.isBelowReorder);
  const totalBelowReorder =
    data.belowReorderMaterials.length + belowReorderParts.length;

  const healthyMaterialsCount = Math.max(
    0,
    data.materials.length - data.belowReorderMaterials.length
  );
  const healthyPartsCount = Math.max(
    0,
    (data.parts?.length ?? 0) - belowReorderParts.length
  );
  const totalHealthyItems = healthyMaterialsCount + healthyPartsCount;
  const totalTrackedItems = totalHealthyItems + totalBelowReorder;
  const healthyPct =
    totalTrackedItems > 0
      ? Math.round((totalHealthyItems / totalTrackedItems) * 100)
      : 100;

  const stockHealthChartData =
    totalTrackedItems > 0
      ? [
          {
            name: 'Healthy Stock',
            value: totalHealthyItems,
            color: HEALTH_COLORS.healthy,
            detail: `${healthyMaterialsCount} material(s), ${healthyPartsCount} part(s)`,
          },
          {
            name: 'Below Reorder Level',
            value: totalBelowReorder,
            color: HEALTH_COLORS.below,
            detail: `${data.belowReorderMaterials.length} material(s), ${belowReorderParts.length} part(s)`,
          },
        ]
      : [];

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
        <span className={r.isBelowReorder ? 'font-semibold text-rose-600' : 'font-semibold text-slate-900'}>
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
          <span className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-600 border border-rose-200/90 shadow-[0_1px_2px_rgba(244,63,94,0.08)] whitespace-nowrap">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>Below Reorder</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-600 border border-emerald-200/90 shadow-[0_1px_2px_rgba(16,185,129,0.08)] whitespace-nowrap">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span>Healthy</span>
          </span>
        ),
    },
  ];

  const partStockColumns: ColumnDef<PartStockRow>[] = [
    {
      key: 'code',
      label: 'Part Code',
      render: (r) => <span className="font-mono text-xs font-medium text-slate-900">{r.code}</span>,
    },
    { key: 'name', label: 'Part Name' },
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
        <span className={r.isBelowReorder ? 'font-semibold text-rose-600' : 'font-semibold text-slate-900'}>
          {formatWithUnit(r.currentStock, r.unit)}
        </span>
      ),
    },
    {
      key: 'reorderLevel',
      label: 'Reorder Level',
      numeric: true,
      render: (r) => formatWithUnit(r.reorderLevel ?? 0, r.unit),
    },
    {
      key: 'isBelowReorder',
      label: 'Status',
      sortValue: (r) => (r.isBelowReorder ? 0 : 1),
      render: (r) =>
        r.isBelowReorder ? (
          <span className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-600 border border-rose-200/90 shadow-[0_1px_2px_rgba(244,63,94,0.08)] whitespace-nowrap">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>Below Reorder</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-600 border border-emerald-200/90 shadow-[0_1px_2px_rgba(16,185,129,0.08)] whitespace-nowrap">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span>Healthy</span>
          </span>
        ),
    },
  ];

  const stageCards = [
    {
      key: 'stage-01',
      title: `Plans / Stock in ${stage1?.stageName ?? 'Raw Material'}`,
      stageLabel: 'Stage 01',
      stage: stage1,
      isRaw: true,
      icon: Warehouse,
      cardClass:
        'bg-white border-slate-200 hover:border-sky-300 hover:shadow-md',
      titleClass: 'text-slate-600',
      iconWrapClass: 'bg-sky-50 text-sky-600 border border-sky-200/70',
      badgeClass: 'bg-sky-50 text-sky-700 border border-sky-200/80',
    },
    {
      key: 'stage-02',
      title: `Plans / Stock in ${stage2?.stageName ?? 'Laser Cutting'}`,
      stageLabel: 'Stage 02',
      stage: stage2,
      isRaw: false,
      icon: Flame,
      cardClass:
        'bg-white border-slate-200 hover:border-orange-300 hover:shadow-md',
      titleClass: 'text-slate-600',
      iconWrapClass: 'bg-orange-50 text-orange-600 border border-orange-200/70',
      badgeClass: 'bg-orange-50 text-orange-700 border border-orange-200/80',
    },
    {
      key: 'stage-03',
      title: `Plans / Stock in ${stage3?.stageName ?? 'Bending'}`,
      stageLabel: 'Stage 03',
      stage: stage3,
      isRaw: false,
      icon: Scissors,
      cardClass:
        'bg-white border-slate-200 hover:border-violet-300 hover:shadow-md',
      titleClass: 'text-slate-600',
      iconWrapClass: 'bg-violet-50 text-violet-600 border border-violet-200/70',
      badgeClass: 'bg-violet-50 text-violet-700 border border-violet-200/80',
    },
    {
      key: 'stage-04',
      title: `Plans / Stock in ${stage4?.stageName ?? 'Machining'}`,
      stageLabel: 'Stage 04',
      stage: stage4,
      isRaw: false,
      icon: Cog,
      cardClass:
        'bg-white border-slate-200 hover:border-teal-300 hover:shadow-md',
      titleClass: 'text-slate-600',
      iconWrapClass: 'bg-teal-50 text-teal-600 border border-teal-200/70',
      badgeClass: 'bg-teal-50 text-teal-700 border border-teal-200/80',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Executive Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Operations Dashboard
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Real-time production throughput, departmental rejections, and inventory health across all stages.
          </p>
        </div>
        {canReceive && (
          <button
            type="button"
            onClick={() => onNavigate('receive')}
            className="px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm inline-flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
          >
            <PackagePlus className="w-4 h-4" />
            <span>Receive Stock</span>
          </button>
        )}
      </div>

      {/* Top Executive KPI Grid (4 Columns x 2 Rows) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* 1. Batches Created (Total) */}
        <button
          type="button"
          onClick={() => onNavigate('batches')}
          className="text-left bg-white border border-slate-200 rounded-xl shadow-sm p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="text-xs font-medium text-slate-600">Batches Created (Total)</div>
            <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 border border-indigo-200/70 flex items-center justify-center shrink-0">
              <Layers className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900">
            {formatNumber(exec.batchesCreated)}
          </div>
          <div className="mt-1 text-xs text-slate-500 flex items-center justify-between gap-2">
            <span>All production batches</span>
            <ArrowRight className="w-3 h-3 text-indigo-600 shrink-0" />
          </div>
        </button>

        {/* 2. Completed Batches (Reached Stage 04) */}
        <button
          type="button"
          onClick={() => onNavigate('batches')}
          className="text-left bg-white border border-slate-200 rounded-xl shadow-sm p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-md"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="text-xs font-medium text-slate-600">Completed Batches</div>
            <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 border border-emerald-200/70 flex items-center justify-center shrink-0">
              <PackageCheck className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono tabular-nums text-emerald-700">
              {formatNumber(exec.completedBatches)}
            </span>
            <span className="text-xs font-mono tabular-nums font-semibold text-emerald-600">
              ({completionPct}%)
            </span>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Reached Stage 04 ({stage4?.stageName ?? 'Machining'})
          </div>
        </button>

        {/* 3. In Process (Stages 01, 02, or 03) */}
        <button
          type="button"
          onClick={() => onNavigate('batches')}
          className="text-left bg-white border border-slate-200 rounded-xl shadow-sm p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-amber-300 hover:shadow-md"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="text-xs font-medium text-slate-600">In Process</div>
            <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-600 border border-amber-200/70 flex items-center justify-center shrink-0">
              <Activity className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900">
            {formatNumber(exec.inProcessBatches)}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Active across Stages 01, 02 &amp; 03
          </div>
        </button>

        {/* 4. Total Rejected Pieces */}
        <button
          type="button"
          onClick={() => onNavigate('scrap')}
          className="text-left bg-white border border-slate-200 rounded-xl shadow-sm p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-rose-300 hover:shadow-md"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="text-xs font-medium text-slate-600">Total Rejected Pieces</div>
            <div className="w-8 h-8 rounded-lg bg-rose-50 text-rose-600 border border-rose-200/70 flex items-center justify-center shrink-0">
              <ShieldAlert className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-rose-600">
            {formatNumber(exec.totalRejectedPieces)}
          </div>
          <div className="mt-1 text-xs text-slate-500 flex items-center justify-between gap-2">
            <span>Logged scrap across stages</span>
            <ArrowRight className="w-3 h-3 text-rose-600 shrink-0" />
          </div>
        </button>

        {/* 5–8. Plans / Stock in Stages 01–04 */}
        {stageCards.map((card) => {
          const Icon = card.icon;
          const batchCount = card.stage?.batchCount ?? 0;
          const subtext = formatStageStockSubtext(card.stage, card.isRaw);
          return (
            <button
              key={card.key}
              type="button"
              onClick={() => onNavigate('batches')}
              className={`text-left border rounded-xl shadow-sm p-4 transition-all duration-200 hover:-translate-y-0.5 ${card.cardClass}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold font-mono tabular-nums ${card.badgeClass}`}
                  >
                    {card.stageLabel}
                  </span>
                  <div className={`mt-1.5 text-xs font-medium ${card.titleClass}`}>
                    {card.title}
                  </div>
                </div>
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${card.iconWrapClass}`}
                >
                  <Icon className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="text-2xl font-bold font-mono tabular-nums text-slate-900">
                  {formatNumber(batchCount)}
                </span>
                <span className="text-xs font-medium text-slate-500">
                  {batchCount === 1 ? 'batch' : 'batches'}
                </span>
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums text-slate-500 truncate" title={subtext}>
                {subtext}
              </div>
            </button>
          );
        })}
      </div>

      {/* Executive Charts Row 1: Production Volume Over Time (Line) + Rejections By Stage (Donut) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* Production Chart (30-Day Line Chart) */}
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-2xl shadow-sm saas-card-hover p-6 flex flex-col justify-between">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-base font-bold tracking-tight text-slate-900">
                Production Volume Over Time
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Good pieces produced daily over the last 30 days
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-600 border border-indigo-200 font-mono tabular-nums">
                {formatNumber(totalGoodPieces30d)} pcs (30d)
              </span>
            </div>
          </div>

          <div className="relative w-full h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={exec.productionOverTime}
                margin={{ top: 10, right: 16, left: -10, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  axisLine={{ stroke: '#e2e8f0' }}
                  tickLine={false}
                  interval={4}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<ProductionVolumeTooltip />} />
                <Line
                  type="monotone"
                  dataKey="goodPieces"
                  name="Good Pieces"
                  stroke="#4F46E5"
                  strokeWidth={2.5}
                  dot={{ r: 2.5, fill: '#4F46E5', strokeWidth: 0 }}
                  activeDot={{ r: 5, fill: '#4F46E5', stroke: '#ffffff', strokeWidth: 2 }}
                  isAnimationActive={true}
                  animationDuration={750}
                />
              </LineChart>
            </ResponsiveContainer>
            {!hasAnyProduction30d && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-xs text-slate-500 shadow-sm">
                  No good pieces output recorded in the last 30 days yet
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Rejection Chart (Donut Chart) */}
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-2xl shadow-sm saas-card-hover p-6 flex flex-col justify-between">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-bold tracking-tight text-slate-900">Rejections By Stage</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Scrap pieces grouped by department
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('scrap')}
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <span>Scrap log</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {exec.rejectionsByStage.length === 0 ? (
            <div className="flex-1 min-h-[220px] flex flex-col items-center justify-center text-center px-4">
              <div className="w-10 h-10 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mb-2">
                <CheckCircle2 className="w-5 h-5" />
              </div>
              <p className="text-xs font-semibold text-slate-700">Zero rejections logged</p>
              <p className="text-[11px] text-slate-400 mt-1">
                Department breakdown will appear here when stage scrap is recorded.
              </p>
            </div>
          ) : (
            <>
              <div className="relative w-full h-48 my-2">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={exec.rejectionsByStage}
                      dataKey="rejectedPieces"
                      nameKey="stageName"
                      cx="50%"
                      cy="50%"
                      innerRadius={52}
                      outerRadius={78}
                      paddingAngle={exec.rejectionsByStage.length > 1 ? 4 : 0}
                      cornerRadius={6}
                      stroke="none"
                      isAnimationActive={true}
                      animationDuration={800}
                    >
                      {exec.rejectionsByStage.map((entry, idx) => (
                        <Cell
                          key={entry.stageId}
                          fill={REJECTION_STAGE_COLORS[idx % REJECTION_STAGE_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip content={<RejectionStageTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-xl font-bold font-mono tabular-nums text-rose-600">
                    {formatNumber(exec.totalRejectedPieces)}
                  </span>
                  <span className="text-[11px] font-medium text-slate-500">Rejected pcs</span>
                </div>
              </div>

              <div className="space-y-1.5 pt-3 border-t border-slate-100">
                {exec.rejectionsByStage.map((entry, idx) => {
                  const color = REJECTION_STAGE_COLORS[idx % REJECTION_STAGE_COLORS.length];
                  return (
                    <div
                      key={entry.stageId}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <span className="text-slate-700 font-medium truncate">
                          {entry.stageName}
                        </span>
                      </div>
                      <span className="font-mono tabular-nums font-semibold text-slate-900 shrink-0">
                        {formatNumber(entry.rejectedPieces)} pcs
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Executive Charts Row 2: Top Cut Parts Produced (Horizontal Bar) + Stock Health Donut */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* Production By Type (Horizontal Bar Chart) */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-2xl shadow-sm saas-card-hover p-6 flex flex-col justify-between">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-base font-bold tracking-tight text-slate-900">Top Cut Parts Produced</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {anyTopPartHasPieces || topPartsChartData.length === 0
                  ? 'Top 5 part names ranked by cut piece output'
                  : 'Top 5 part names currently assigned across batches'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('batches')}
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <span>All batches</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {topPartsChartData.length === 0 ? (
            <div className="flex-1 min-h-[220px] flex flex-col items-center justify-center text-center px-4">
              <p className="text-xs font-medium text-slate-600">
                No cut parts assigned to batches yet.
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                Advance raw material batches to Laser Cutting with a part name to populate this chart.
              </p>
            </div>
          ) : (
            <div className="w-full h-60">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  layout="vertical"
                  data={topPartsChartData}
                  margin={{ top: 4, right: 24, left: 8, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                  <XAxis
                    type="number"
                    allowDecimals={false}
                    tick={{ fill: '#64748b', fontSize: 11 }}
                    axisLine={{ stroke: '#e2e8f0' }}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="partName"
                    width={136}
                    tick={{ fill: '#334155', fontSize: 12, fontWeight: 500 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(val: string) =>
                      val.length > 18 ? `${val.slice(0, 17)}…` : val
                    }
                  />
                  <Tooltip
                    content={<TopPartTooltip />}
                    cursor={{ fill: 'rgba(241, 245, 249, 0.7)' }}
                  />
                  <Bar
                    dataKey="displayValue"
                    radius={[0, 8, 8, 0]}
                    maxBarSize={28}
                    isAnimationActive={true}
                    animationDuration={750}
                  >
                    {topPartsChartData.map((entry, idx) => (
                      <Cell
                        key={entry.partName}
                        fill={TOP_PART_COLORS[idx % TOP_PART_COLORS.length]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Stock Health Donut Chart */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl shadow-sm saas-card-hover p-6 flex flex-col justify-between">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-bold tracking-tight text-slate-900">Stock Health</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Healthy stock vs. items below reorder threshold
              </p>
            </div>
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap border ${
                totalBelowReorder > 0
                  ? 'bg-amber-50 text-amber-700 border-amber-200'
                  : 'bg-emerald-50 text-emerald-600 border-emerald-200'
              }`}
            >
              {totalBelowReorder > 0 ? `${totalBelowReorder} Need Attention` : 'All Healthy'}
            </span>
          </div>

          {totalTrackedItems === 0 ? (
            <div className="flex-1 min-h-[220px] flex flex-col items-center justify-center text-center px-4">
              <p className="text-xs font-medium text-slate-600">
                No active materials or cut parts tracked yet.
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                Add items in Settings to visualize overall stock health.
              </p>
            </div>
          ) : (
            <>
              <div className="relative w-full h-44 my-2">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={stockHealthChartData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={52}
                      outerRadius={76}
                      paddingAngle={totalHealthyItems > 0 && totalBelowReorder > 0 ? 4 : 0}
                      cornerRadius={6}
                      stroke="none"
                      isAnimationActive={true}
                      animationDuration={800}
                    >
                      {stockHealthChartData.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<StockHealthTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-xl font-bold font-mono tabular-nums text-slate-900">
                    {healthyPct}%
                  </span>
                  <span className="text-[11px] font-medium text-slate-500">Healthy</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-3 border-t border-slate-100">
                <div className="p-2.5 rounded-lg bg-emerald-50/60 border border-emerald-200/70">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: HEALTH_COLORS.healthy }}
                    />
                    <span className="text-xs font-semibold text-emerald-900">Healthy Stock</span>
                  </div>
                  <div className="mt-1 text-lg font-bold font-mono tabular-nums text-emerald-700">
                    {totalHealthyItems}
                  </div>
                  <div className="text-[11px] text-emerald-700/80">
                    {healthyMaterialsCount} mat · {healthyPartsCount} parts
                  </div>
                </div>

                <div className="p-2.5 rounded-lg bg-rose-50/60 border border-rose-200/70">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: HEALTH_COLORS.below }}
                    />
                    <span className="text-xs font-semibold text-rose-900">Below Reorder</span>
                  </div>
                  <div className="mt-1 text-lg font-bold font-mono tabular-nums text-rose-600">
                    {totalBelowReorder}
                  </div>
                  <div className="text-[11px] text-rose-700/80">
                    {data.belowReorderMaterials.length} mat · {belowReorderParts.length} parts
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Reorder Attention Table (only if any below reorder) */}
      {data.belowReorderMaterials.length > 0 && (
        <div className="bg-white border border-rose-200 rounded-2xl shadow-sm saas-card-hover overflow-hidden">
          <div className="px-5 py-3.5 border-b border-rose-200 bg-rose-50/70 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              <h2 className="text-sm font-semibold text-rose-900">
                Materials At or Below Reorder Level
              </h2>
            </div>
            {canReceive && (
              <button
                type="button"
                onClick={() => onNavigate('receive')}
                className="px-3.5 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
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
                className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-sm hover:bg-rose-50/30 transition-colors"
              >
                <div>
                  <span className="font-mono text-xs font-semibold text-slate-900 mr-2">
                    {m.code}
                  </span>
                  <span className="font-medium text-slate-900">{m.name}</span>
                </div>
                <div className="flex items-center gap-6 font-mono tabular-nums text-xs">
                  <span className="text-rose-600 font-semibold">
                    Stock: {formatWithUnit(m.currentStock, m.unit)}
                  </span>
                  <span className="text-slate-500">
                    Reorder at: {formatWithUnit(m.reorderLevel, m.unit)}
                  </span>
                  {canReceive && (
                    <button
                      type="button"
                      onClick={() => onNavigate('receive', { materialId: m.id })}
                      className="font-sans font-medium text-indigo-600 underline underline-offset-2 hover:text-indigo-700"
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
            <h2 className="text-base font-bold tracking-tight text-slate-900">Current Stock Ledger Overview</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Computed live from receipts, stage issues, and stock adjustments
            </p>
          </div>
          {canReceive && (
            <button
              type="button"
              onClick={() => onNavigate('receive')}
              className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm whitespace-nowrap shrink-0 transition-colors"
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
          rowClassName={(r) => (r.isBelowReorder ? 'bg-rose-50/40' : '')}
          emptyTitle="No active materials"
          emptyDescription="Add materials in Settings to start tracking stock."
        />
      </div>

      {/* Cut Parts Reorder Attention Table */}
      {belowReorderParts.length > 0 && (
        <div className="bg-white border border-rose-200 rounded-2xl shadow-sm saas-card-hover overflow-hidden">
          <div className="px-5 py-3.5 border-b border-rose-200 bg-rose-50/70 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              <h2 className="text-sm font-semibold text-rose-900">
                Cut Parts At or Below Reorder Level
              </h2>
            </div>
          </div>
          <div className="divide-y divide-slate-200">
            {belowReorderParts.map((p) => (
              <div
                key={p.id}
                className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-sm hover:bg-rose-50/30 transition-colors"
              >
                <div>
                  <span className="font-mono text-xs font-semibold text-slate-900 mr-2">
                    {p.code}
                  </span>
                  <span className="font-medium text-slate-900">{p.name}</span>
                </div>
                <div className="flex items-center gap-6 font-mono tabular-nums text-xs">
                  <span className="text-rose-600 font-semibold">
                    Stock: {formatWithUnit(p.currentStock, p.unit)}
                  </span>
                  <span className="text-slate-500">
                    Reorder at: {formatWithUnit(p.reorderLevel, p.unit)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cut Parts Stock Ledger (Parts Master) */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-base font-bold tracking-tight text-slate-900">
              Cut Parts Stock Ledger (Parts Master)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Live cut-piece inventory from Parts Master Opening Stock and ledger movements
            </p>
          </div>
        </div>

        <DataTable
          data={data.parts ?? []}
          columns={partStockColumns}
          keyField={(r) => r.id}
          searchPlaceholder="Search by part code or part name..."
          searchFilter={(r, q) =>
            r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
          }
          rowClassName={(r) => (r.isBelowReorder ? 'bg-rose-50/40' : '')}
          emptyTitle="No cut parts in Parts Master"
          emptyDescription="Add or bulk import cut parts in Settings > Parts Master to track their Opening Stock."
        />
      </div>

      {/* Recent Batch Activity */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm saas-card-hover overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-base font-bold tracking-tight text-slate-900">Recent Batch Activity</h2>
          <button
            type="button"
            onClick={() => onNavigate('batches')}
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
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
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="px-4 py-3">Batch ID</th>
                  <th className="px-4 py-3">Raw Material</th>
                  <th className="px-4 py-3">Part Name</th>
                  <th className="px-4 py-3 text-right">Quantity</th>
                  <th className="px-4 py-3">Current Stage</th>
                  <th className="px-4 py-3">Created By</th>
                  <th className="px-4 py-3">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {data.recentBatches.map((b) => (
                  <tr
                    key={b.id}
                    onClick={() => onNavigate('batch-detail', { batchId: b.id })}
                    className="border-b border-slate-200 hover:bg-slate-50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-900">
                      {b.id}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-slate-500 mr-1.5">
                        {b.materialCode}
                      </span>
                      <span className="text-slate-900">{b.materialName}</span>
                    </td>
                    <td className="px-4 py-3">
                      {b.partName ? (
                        <span className="font-medium text-slate-900">{b.partName}</span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {formatNumber(b.quantity)} {b.materialUnit}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-600 border border-indigo-200 whitespace-nowrap">
                        <span className="font-mono text-[11px] opacity-80">
                          {String(b.stageSequence).padStart(2, '0')}
                        </span>
                        <span>{b.stageName}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{b.createdByName}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500 tabular-nums">
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
