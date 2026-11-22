import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { db } from '../db/index.ts';
import {
  batches,
  batchStageHistory,
  materials,
  stages,
  stockMovements,
  users,
} from '../db/schema.ts';

export type ReportType =
  | 'current-stock'
  | 'reorder-level'
  | 'opening-stock'
  | 'stock-adjusted'
  | 'sent-to-cutting'
  | 'batch-movement';

export interface ReportFilters {
  startDate?: string;
  endDate?: string;
  materialId?: number;
  userId?: number;
}

export interface ReportResult {
  type: ReportType;
  title: string;
  columns: { key: string; label: string; numeric?: boolean }[];
  rows: Record<string, string | number | boolean | null>[];
  summary: { label: string; value: string }[];
}

function parseDateRange(filters: ReportFilters) {
  let start: Date | undefined;
  let end: Date | undefined;
  if (filters.startDate) {
    const d = new Date(filters.startDate);
    if (!Number.isNaN(d.getTime())) {
      d.setUTCHours(0, 0, 0, 0);
      start = d;
    }
  }
  if (filters.endDate) {
    const d = new Date(filters.endDate);
    if (!Number.isNaN(d.getTime())) {
      d.setUTCHours(23, 59, 59, 999);
      end = d;
    }
  }
  return { start, end };
}

export async function runReport(
  type: ReportType,
  filters: ReportFilters
): Promise<ReportResult> {
  const { start, end } = parseDateRange(filters);

  try {
    if (type === 'current-stock' || type === 'reorder-level') {
      const matConditions = [eq(materials.active, true)];
      if (filters.materialId) {
        matConditions.push(eq(materials.id, filters.materialId));
      }

      const materialRows = await db
        .select()
        .from(materials)
        .where(and(...matConditions))
        .orderBy(asc(materials.code));

      const movConditions = [];
      if (start) movConditions.push(gte(stockMovements.movementDate, start));
      if (end) movConditions.push(lte(stockMovements.movementDate, end));
      if (filters.materialId) movConditions.push(eq(stockMovements.materialId, filters.materialId));
      if (filters.userId) movConditions.push(eq(stockMovements.userId, filters.userId));

      const movQuery = db
        .select({
          materialId: stockMovements.materialId,
          receipts: sql<number>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'receipt' THEN ${stockMovements.quantity} ELSE 0 END), 0)::double precision`,
          issues: sql<number>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'issue' THEN ${stockMovements.quantity} ELSE 0 END), 0)::double precision`,
          adjustments: sql<number>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'adjustment' THEN ${stockMovements.quantity} ELSE 0 END), 0)::double precision`,
          currentStock: sql<number>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'receipt' THEN ${stockMovements.quantity} WHEN ${stockMovements.type} = 'issue' THEN -${stockMovements.quantity} WHEN ${stockMovements.type} = 'adjustment' THEN ${stockMovements.quantity} ELSE 0 END), 0)::double precision`,
          lastMovementDate: sql<string | null>`MAX(${stockMovements.movementDate})`,
        })
        .from(stockMovements);

      const ledgerRows = movConditions.length
        ? await movQuery.where(and(...movConditions)).groupBy(stockMovements.materialId)
        : await movQuery.groupBy(stockMovements.materialId);

      const ledgerMap = new Map(ledgerRows.map((l) => [l.materialId, l]));

      if (type === 'current-stock') {
        const rows = materialRows.map((m) => {
          const l = ledgerMap.get(m.id);
          const stock = Number((l?.currentStock ?? 0).toFixed(3));
          return {
            code: m.code,
            name: m.name,
            unit: m.unit,
            receipts: Number((l?.receipts ?? 0).toFixed(3)),
            issues: Number((l?.issues ?? 0).toFixed(3)),
            adjustments: Number((l?.adjustments ?? 0).toFixed(3)),
            currentStock: stock,
            reorderLevel: m.reorderLevel,
            status: stock <= m.reorderLevel ? 'Below Reorder' : 'Healthy',
            lastMovementDate: l?.lastMovementDate
              ? new Date(l.lastMovementDate).toISOString().slice(0, 10)
              : '-',
          };
        });

        const belowCount = rows.filter((r) => r.status === 'Below Reorder').length;
        return {
          type,
          title: 'Current Stock Report',
          columns: [
            { key: 'code', label: 'Code' },
            { key: 'name', label: 'Material' },
            { key: 'unit', label: 'Unit' },
            { key: 'receipts', label: 'Receipts', numeric: true },
            { key: 'issues', label: 'Issues', numeric: true },
            { key: 'adjustments', label: 'Adjustments', numeric: true },
            { key: 'currentStock', label: 'Current Stock', numeric: true },
            { key: 'reorderLevel', label: 'Reorder Level', numeric: true },
            { key: 'status', label: 'Status' },
            { key: 'lastMovementDate', label: 'Last Movement' },
          ],
          rows,
          summary: [
            { label: 'Materials Listed', value: String(rows.length) },
            { label: 'Below Reorder Level', value: String(belowCount) },
          ],
        };
      }

      // reorder-level
      const rows = materialRows
        .map((m) => {
          const l = ledgerMap.get(m.id);
          const stock = Number((l?.currentStock ?? 0).toFixed(3));
          return {
            code: m.code,
            name: m.name,
            unit: m.unit,
            currentStock: stock,
            reorderLevel: m.reorderLevel,
            deficit: Number(Math.max(0, m.reorderLevel - stock).toFixed(3)),
            alertSent: m.reorderAlertSent ? 'Yes' : 'No',
            lastMovementDate: l?.lastMovementDate
              ? new Date(l.lastMovementDate).toISOString().slice(0, 10)
              : '-',
          };
        })
        .filter((r) => r.currentStock <= r.reorderLevel);

      return {
        type,
        title: 'Reorder Level Report',
        columns: [
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Material' },
          { key: 'unit', label: 'Unit' },
          { key: 'currentStock', label: 'Current Stock', numeric: true },
          { key: 'reorderLevel', label: 'Reorder Level', numeric: true },
          { key: 'deficit', label: 'Shortfall', numeric: true },
          { key: 'alertSent', label: 'Alert Dispatched' },
          { key: 'lastMovementDate', label: 'Last Movement' },
        ],
        rows,
        summary: [
          { label: 'Materials at/below Reorder', value: String(rows.length) },
        ],
      };
    }

    if (type === 'opening-stock') {
      const conditions = [eq(stockMovements.isOpening, true)];
      if (start) conditions.push(gte(stockMovements.movementDate, start));
      if (end) conditions.push(lte(stockMovements.movementDate, end));
      if (filters.materialId) conditions.push(eq(stockMovements.materialId, filters.materialId));
      if (filters.userId) conditions.push(eq(stockMovements.userId, filters.userId));

      const data = await db
        .select({
          id: stockMovements.id,
          code: materials.code,
          materialName: materials.name,
          quantity: stockMovements.quantity,
          unit: materials.unit,
          batchId: stockMovements.batchId,
          movementDate: stockMovements.movementDate,
          userName: users.name,
          userEmail: users.email,
          note: stockMovements.note,
        })
        .from(stockMovements)
        .innerJoin(materials, eq(stockMovements.materialId, materials.id))
        .innerJoin(users, eq(stockMovements.userId, users.id))
        .where(and(...conditions))
        .orderBy(desc(stockMovements.movementDate), desc(stockMovements.id));

      const rows = data.map((r) => ({
        movementId: r.id,
        code: r.code,
        material: r.materialName,
        quantity: Number(r.quantity.toFixed(3)),
        unit: r.unit,
        batchId: r.batchId ?? '-',
        movementDate: new Date(r.movementDate).toISOString().slice(0, 10),
        userName: r.userName,
        userEmail: r.userEmail,
        note: r.note ?? '-',
      }));

      return {
        type,
        title: 'Opening Stock Entered Report',
        columns: [
          { key: 'movementId', label: 'Entry ID', numeric: true },
          { key: 'code', label: 'Code' },
          { key: 'material', label: 'Material' },
          { key: 'quantity', label: 'Opening Qty', numeric: true },
          { key: 'unit', label: 'Unit' },
          { key: 'batchId', label: 'Batch ID' },
          { key: 'movementDate', label: 'Date' },
          { key: 'userName', label: 'Entered By' },
          { key: 'userEmail', label: 'User Email' },
          { key: 'note', label: 'Note' },
        ],
        rows,
        summary: [
          { label: 'Opening Entries', value: String(rows.length) },
        ],
      };
    }

    if (type === 'stock-adjusted') {
      // Use SQL window function over full ledger to compute exact old -> new qty for every adjustment
      const signedExpr = sql`CASE WHEN ${stockMovements.type} = 'receipt' THEN ${stockMovements.quantity} WHEN ${stockMovements.type} = 'issue' THEN -${stockMovements.quantity} WHEN ${stockMovements.type} = 'adjustment' THEN ${stockMovements.quantity} ELSE 0 END`;

      const running = db
        .select({
          id: stockMovements.id,
          materialId: stockMovements.materialId,
          type: stockMovements.type,
          quantity: stockMovements.quantity,
          reason: stockMovements.reason,
          note: stockMovements.note,
          movementDate: stockMovements.movementDate,
          userId: stockMovements.userId,
          runningAfter: sql<number>`SUM(${signedExpr}) OVER (PARTITION BY ${stockMovements.materialId} ORDER BY ${stockMovements.movementDate} ASC, ${stockMovements.id} ASC)::double precision`.as('running_after'),
        })
        .from(stockMovements)
        .as('running');

      const conditions = [eq(running.type, 'adjustment')];
      if (start) conditions.push(gte(running.movementDate, start));
      if (end) conditions.push(lte(running.movementDate, end));
      if (filters.materialId) conditions.push(eq(running.materialId, filters.materialId));
      if (filters.userId) conditions.push(eq(running.userId, filters.userId));

      const data = await db
        .select({
          id: running.id,
          code: materials.code,
          materialName: materials.name,
          unit: materials.unit,
          adjustmentQty: running.quantity,
          newQty: running.runningAfter,
          reason: running.reason,
          note: running.note,
          movementDate: running.movementDate,
          userName: users.name,
          userEmail: users.email,
        })
        .from(running)
        .innerJoin(materials, eq(running.materialId, materials.id))
        .innerJoin(users, eq(running.userId, users.id))
        .where(and(...conditions))
        .orderBy(desc(running.movementDate), desc(running.id));

      const rows = data.map((r) => {
        const newQty = Number(r.newQty.toFixed(3));
        const adj = Number(r.adjustmentQty.toFixed(3));
        const oldQty = Number((newQty - adj).toFixed(3));
        return {
          movementId: r.id,
          code: r.code,
          material: r.materialName,
          oldQty,
          adjustment: adj,
          newQty,
          unit: r.unit,
          reason: r.reason ?? '-',
          movementDate: new Date(r.movementDate).toISOString().slice(0, 10),
          userName: r.userName,
          userEmail: r.userEmail,
          note: r.note ?? '-',
        };
      });

      return {
        type,
        title: 'Stock Adjusted Report',
        columns: [
          { key: 'movementId', label: 'Adj ID', numeric: true },
          { key: 'code', label: 'Code' },
          { key: 'material', label: 'Material' },
          { key: 'oldQty', label: 'Old Qty', numeric: true },
          { key: 'adjustment', label: 'Adjustment', numeric: true },
          { key: 'newQty', label: 'New Qty', numeric: true },
          { key: 'unit', label: 'Unit' },
          { key: 'reason', label: 'Reason' },
          { key: 'movementDate', label: 'Date' },
          { key: 'userName', label: 'Adjusted By' },
          { key: 'userEmail', label: 'User Email' },
          { key: 'note', label: 'Note' },
        ],
        rows,
        summary: [
          { label: 'Total Adjustments', value: String(rows.length) },
        ],
      };
    }

    if (type === 'sent-to-cutting') {
      // Every issue movement represents raw material issued into cutting (Stage 2)
      const conditions = [eq(stockMovements.type, 'issue')];
      if (start) conditions.push(gte(stockMovements.movementDate, start));
      if (end) conditions.push(lte(stockMovements.movementDate, end));
      if (filters.materialId) conditions.push(eq(stockMovements.materialId, filters.materialId));
      if (filters.userId) conditions.push(eq(stockMovements.userId, filters.userId));

      const data = await db
        .select({
          id: stockMovements.id,
          batchId: stockMovements.batchId,
          code: materials.code,
          materialName: materials.name,
          quantity: stockMovements.quantity,
          unit: materials.unit,
          movementDate: stockMovements.movementDate,
          userName: users.name,
          userEmail: users.email,
          note: stockMovements.note,
        })
        .from(stockMovements)
        .innerJoin(materials, eq(stockMovements.materialId, materials.id))
        .innerJoin(users, eq(stockMovements.userId, users.id))
        .where(and(...conditions))
        .orderBy(desc(stockMovements.movementDate), desc(stockMovements.id));

      const rows = data.map((r) => ({
        batchId: r.batchId ?? '-',
        code: r.code,
        material: r.materialName,
        quantity: Number(r.quantity.toFixed(3)),
        unit: r.unit,
        sentDate: new Date(r.movementDate).toISOString().slice(0, 10),
        userName: r.userName,
        userEmail: r.userEmail,
        note: r.note ?? '-',
      }));

      const totalQty = rows.reduce((sum, r) => sum + Number(r.quantity), 0);

      return {
        type,
        title: 'Total Sent to Cutting Report',
        columns: [
          { key: 'batchId', label: 'Batch ID' },
          { key: 'code', label: 'Code' },
          { key: 'material', label: 'Material' },
          { key: 'quantity', label: 'Quantity Sent', numeric: true },
          { key: 'unit', label: 'Unit' },
          { key: 'sentDate', label: 'Sent Date' },
          { key: 'userName', label: 'Dispatched By' },
          { key: 'userEmail', label: 'User Email' },
          { key: 'note', label: 'Note' },
        ],
        rows,
        summary: [
          { label: 'Batches Sent to Cutting', value: String(rows.length) },
          { label: 'Cumulative Quantity', value: String(Number(totalQty.toFixed(3))) },
        ],
      };
    }

    // batch-movement
    const conditions = [];
    if (start) conditions.push(gte(batchStageHistory.movedAt, start));
    if (end) conditions.push(lte(batchStageHistory.movedAt, end));
    if (filters.materialId) conditions.push(eq(batches.materialId, filters.materialId));
    if (filters.userId) conditions.push(eq(batchStageHistory.movedBy, filters.userId));

    const baseQuery = db
      .select({
        historyId: batchStageHistory.id,
        batchId: batches.id,
        code: materials.code,
        materialName: materials.name,
        quantity: batches.quantity,
        unit: materials.unit,
        stageSequence: stages.sequence,
        stageName: stages.name,
        movedAt: batchStageHistory.movedAt,
        userName: users.name,
        userEmail: users.email,
        note: batchStageHistory.note,
      })
      .from(batchStageHistory)
      .innerJoin(batches, eq(batchStageHistory.batchId, batches.id))
      .innerJoin(materials, eq(batches.materialId, materials.id))
      .innerJoin(stages, eq(batchStageHistory.stageId, stages.id))
      .innerJoin(users, eq(batchStageHistory.movedBy, users.id));

    const data = conditions.length
      ? await baseQuery
          .where(and(...conditions))
          .orderBy(desc(batchStageHistory.movedAt), desc(batchStageHistory.id))
      : await baseQuery.orderBy(desc(batchStageHistory.movedAt), desc(batchStageHistory.id));

    const rows = data.map((r) => ({
      batchId: r.batchId,
      code: r.code,
      material: r.materialName,
      quantity: Number(r.quantity.toFixed(3)),
      unit: r.unit,
      stageSequence: r.stageSequence,
      stageName: r.stageName,
      movedAt: new Date(r.movedAt).toISOString().replace('T', ' ').slice(0, 19),
      userName: r.userName,
      userEmail: r.userEmail,
      note: r.note ?? '-',
    }));

    const uniqueBatches = new Set(rows.map((r) => r.batchId)).size;

    return {
      type,
      title: 'Batch Movement History Report',
      columns: [
        { key: 'batchId', label: 'Batch ID' },
        { key: 'code', label: 'Code' },
        { key: 'material', label: 'Material' },
        { key: 'quantity', label: 'Batch Qty', numeric: true },
        { key: 'unit', label: 'Unit' },
        { key: 'stageSequence', label: 'Seq', numeric: true },
        { key: 'stageName', label: 'Stage' },
        { key: 'movedAt', label: 'Moved At (UTC)' },
        { key: 'userName', label: 'Moved By' },
        { key: 'userEmail', label: 'User Email' },
        { key: 'note', label: 'Note' },
      ],
      rows,
      summary: [
        { label: 'Stage Transitions', value: String(rows.length) },
        { label: 'Unique Batches', value: String(uniqueBatches) },
      ],
    };
  } catch (error) {
    console.error('Failed to execute report query:', error);
    throw new Error('Failed to generate report.', { cause: error });
  }
}

export function serializeReportToCsv(report: ReportResult): string {
  const escapeCell = (val: string | number | boolean | null | undefined) => {
    const str = val === null || val === undefined ? '' : String(val);
    if (str.includes('"') || str.includes(',') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = report.columns.map((c) => escapeCell(c.label)).join(',');
  const lines = report.rows.map((row) =>
    report.columns.map((c) => escapeCell(row[c.key])).join(',')
  );
  return [header, ...lines].join('\r\n');
}

export function serializeReportToXlsx(report: ReportResult): Buffer {
  const sheetData = [
    report.columns.map((c) => c.label),
    ...report.rows.map((row) => report.columns.map((c) => row[c.key] ?? '')),
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  XLSX.utils.book_append_sheet(wb, ws, report.title.slice(0, 31));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
