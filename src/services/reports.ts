import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { db } from '../db/index.ts';
import {
  batches,
  batchStageHistory,
  materials,
  parts,
  partStockMovements,
  scrapLogs,
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
  | 'batch-movement'
  | 'scrap-log'
  | 'raw-material-movement'
  | 'cut-pieces-movement';

export interface ReportFilters {
  startDate?: string;
  endDate?: string;
  materialId?: number;
  partId?: number;
  partName?: string;
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
          unit: sql<string>`COALESCE(${stockMovements.unit}, ${materials.unit})`,
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
          unit: stockMovements.unit,
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
          unit: sql<string>`COALESCE(${running.unit}, ${materials.unit})`,
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
          partName: batches.partName,
          piecesQuantity: batches.piecesQuantity,
          quantity: stockMovements.quantity,
          unit: sql<string>`COALESCE(${stockMovements.unit}, ${materials.unit})`,
          movementDate: stockMovements.movementDate,
          userName: users.name,
          userEmail: users.email,
          note: stockMovements.note,
        })
        .from(stockMovements)
        .innerJoin(materials, eq(stockMovements.materialId, materials.id))
        .leftJoin(batches, eq(stockMovements.batchId, batches.id))
        .innerJoin(users, eq(stockMovements.userId, users.id))
        .where(and(...conditions))
        .orderBy(desc(stockMovements.movementDate), desc(stockMovements.id));

      const rows = data.map((r) => ({
        batchId: r.batchId ?? '-',
        code: r.code,
        material: r.materialName,
        partName: r.partName ?? '-',
        piecesQuantity: r.piecesQuantity ?? '-',
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
          { key: 'material', label: 'Raw Material' },
          { key: 'partName', label: 'Part Name' },
          { key: 'piecesQuantity', label: 'Pieces', numeric: true },
          { key: 'quantity', label: 'Raw Qty Sent', numeric: true },
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

    if (type === 'scrap-log') {
      const conditions = [];
      if (start) conditions.push(gte(scrapLogs.loggedAt, start));
      if (end) conditions.push(lte(scrapLogs.loggedAt, end));
      if (filters.materialId) conditions.push(eq(scrapLogs.materialId, filters.materialId));
      if (filters.userId) conditions.push(eq(scrapLogs.loggedBy, filters.userId));

      const baseQuery = db
        .select({
          scrapId: scrapLogs.id,
          batchId: scrapLogs.batchId,
          code: materials.code,
          materialName: materials.name,
          partName: scrapLogs.partName,
          stageSequence: stages.sequence,
          stageName: stages.name,
          quantityProcessed: scrapLogs.quantityProcessed,
          quantityRejected: scrapLogs.quantityRejected,
          quantityGood: scrapLogs.quantityGood,
          reason: scrapLogs.reason,
          loggedAt: scrapLogs.loggedAt,
          userName: users.name,
          userEmail: users.email,
        })
        .from(scrapLogs)
        .innerJoin(materials, eq(scrapLogs.materialId, materials.id))
        .innerJoin(stages, eq(scrapLogs.stageId, stages.id))
        .innerJoin(users, eq(scrapLogs.loggedBy, users.id));

      const data = conditions.length
        ? await baseQuery
            .where(and(...conditions))
            .orderBy(desc(scrapLogs.loggedAt), desc(scrapLogs.id))
        : await baseQuery.orderBy(desc(scrapLogs.loggedAt), desc(scrapLogs.id));

      const rows = data.map((r) => ({
        scrapId: r.scrapId,
        batchId: r.batchId,
        code: r.code,
        material: r.materialName,
        partName: r.partName ?? '-',
        stage: `${String(r.stageSequence).padStart(2, '0')}. ${r.stageName}`,
        quantityProcessed: r.quantityProcessed,
        quantityRejected: r.quantityRejected,
        quantityGood: r.quantityGood,
        reason: r.reason ?? '-',
        loggedAt: new Date(r.loggedAt).toISOString().replace('T', ' ').slice(0, 19),
        userName: r.userName,
        userEmail: r.userEmail,
      }));

      const totalRejected = rows.reduce((sum, r) => sum + Number(r.quantityRejected), 0);
      const totalProcessed = rows.reduce((sum, r) => sum + Number(r.quantityProcessed), 0);

      return {
        type,
        title: 'Scrap & Rejection Log Report',
        columns: [
          { key: 'scrapId', label: 'Log ID', numeric: true },
          { key: 'batchId', label: 'Batch ID' },
          { key: 'code', label: 'Code' },
          { key: 'material', label: 'Raw Material' },
          { key: 'partName', label: 'Part Name' },
          { key: 'stage', label: 'Rejected At Stage' },
          { key: 'quantityProcessed', label: 'Qty Processed', numeric: true },
          { key: 'quantityRejected', label: 'Qty Rejected', numeric: true },
          { key: 'quantityGood', label: 'Good Qty', numeric: true },
          { key: 'reason', label: 'Rejection Reason' },
          { key: 'loggedAt', label: 'Logged At (UTC)' },
          { key: 'userName', label: 'Logged By' },
          { key: 'userEmail', label: 'User Email' },
        ],
        rows,
        summary: [
          { label: 'Rejection Events', value: String(rows.length) },
          { label: 'Total Pieces Rejected', value: String(totalRejected) },
          { label: 'Pieces Processed in Affected Runs', value: String(totalProcessed) },
        ],
      };
    }

    if (type === 'raw-material-movement') {
      const signedExpr = sql`CASE WHEN ${stockMovements.type} = 'receipt' THEN ${stockMovements.quantity} WHEN ${stockMovements.type} = 'issue' THEN -${stockMovements.quantity} WHEN ${stockMovements.type} = 'adjustment' THEN ${stockMovements.quantity} ELSE 0 END`;

      const running = db
        .select({
          id: stockMovements.id,
          materialId: stockMovements.materialId,
          type: stockMovements.type,
          quantity: stockMovements.quantity,
          unit: stockMovements.unit,
          batchId: stockMovements.batchId,
          reason: stockMovements.reason,
          note: stockMovements.note,
          movementDate: stockMovements.movementDate,
          userId: stockMovements.userId,
          runningAfter: sql<number>`SUM(${signedExpr}) OVER (PARTITION BY ${stockMovements.materialId} ORDER BY ${stockMovements.movementDate} ASC, ${stockMovements.id} ASC)::double precision`.as('running_after'),
        })
        .from(stockMovements)
        .as('running_raw');

      const conditions = [];
      if (start) conditions.push(gte(running.movementDate, start));
      if (end) conditions.push(lte(running.movementDate, end));
      if (filters.materialId) conditions.push(eq(running.materialId, filters.materialId));
      if (filters.userId) conditions.push(eq(running.userId, filters.userId));

      const baseQuery = db
        .select({
          movementId: running.id,
          date: running.movementDate,
          code: materials.code,
          materialName: materials.name,
          unit: sql<string>`COALESCE(${running.unit}, ${materials.unit})`,
          type: running.type,
          quantity: running.quantity,
          balance: running.runningAfter,
          batchId: running.batchId,
          reason: running.reason,
          note: running.note,
          userName: users.name,
        })
        .from(running)
        .innerJoin(materials, eq(running.materialId, materials.id))
        .innerJoin(users, eq(running.userId, users.id));

      const data = conditions.length
        ? await baseQuery
            .where(and(...conditions))
            .orderBy(desc(running.movementDate), desc(running.id))
        : await baseQuery.orderBy(desc(running.movementDate), desc(running.id));

      const rows = data.map((r) => {
        const typeLabel =
          r.type === 'receipt'
            ? 'Receipt'
            : r.type === 'issue'
            ? 'Issue'
            : 'Adjustment';
        const qtyIn =
          r.type === 'receipt' || (r.type === 'adjustment' && r.quantity > 0)
            ? Number(r.quantity.toFixed(3))
            : 0;
        const qtyOut =
          r.type === 'issue' || (r.type === 'adjustment' && r.quantity < 0)
            ? Number(Math.abs(r.quantity).toFixed(3))
            : 0;
        const refParts = [r.batchId, r.reason, r.note].filter(
          (v) => v && String(v).trim() !== ''
        );
        return {
          movementId: r.movementId,
          date: new Date(r.date).toISOString().slice(0, 10),
          code: r.code,
          materialName: r.materialName,
          unit: r.unit,
          movementType: typeLabel,
          qtyIn,
          qtyOut,
          balance: Number(r.balance.toFixed(3)),
          reference: refParts.length > 0 ? refParts.join(' · ') : '-',
          userName: r.userName,
        };
      });

      const totalIn = rows.reduce((s, r) => s + Number(r.qtyIn), 0);
      const totalOut = rows.reduce((s, r) => s + Number(r.qtyOut), 0);

      return {
        type,
        title: 'Raw Material Movement Report',
        columns: [
          { key: 'date', label: 'Date' },
          { key: 'code', label: 'Material Code' },
          { key: 'materialName', label: 'Material Name' },
          { key: 'unit', label: 'Unit' },
          { key: 'movementType', label: 'Movement Type' },
          { key: 'qtyIn', label: 'Qty In', numeric: true },
          { key: 'qtyOut', label: 'Qty Out', numeric: true },
          { key: 'balance', label: 'Balance', numeric: true },
          { key: 'reference', label: 'Reference' },
          { key: 'userName', label: 'User' },
        ],
        rows,
        summary: [
          { label: 'Transactions', value: String(rows.length) },
          { label: 'Total Qty In', value: String(Number(totalIn.toFixed(3))) },
          { label: 'Total Qty Out', value: String(Number(totalOut.toFixed(3))) },
        ],
      };
    }

    if (type === 'cut-pieces-movement') {
      const [allParts, partMovements, batchHistoryRows, scrapRows] = await Promise.all([
        db.select().from(parts),
        db
          .select({
            id: partStockMovements.id,
            partId: partStockMovements.partId,
            partCode: parts.code,
            partName: parts.name,
            type: partStockMovements.type,
            quantity: partStockMovements.quantity,
            batchId: partStockMovements.batchId,
            reason: partStockMovements.reason,
            note: partStockMovements.note,
            movementDate: partStockMovements.movementDate,
            userId: partStockMovements.userId,
            userName: users.name,
          })
          .from(partStockMovements)
          .innerJoin(parts, eq(partStockMovements.partId, parts.id))
          .innerJoin(users, eq(partStockMovements.userId, users.id))
          .orderBy(asc(partStockMovements.movementDate), asc(partStockMovements.id)),
        db
          .select({
            historyId: batchStageHistory.id,
            batchId: batches.id,
            materialId: batches.materialId,
            partName: batches.partName,
            piecesQuantity: batches.piecesQuantity,
            qtyIn: batchStageHistory.qtyIn,
            qtyOut: batchStageHistory.qtyOut,
            stageSequence: stages.sequence,
            stageName: stages.name,
            movedAt: batchStageHistory.movedAt,
            userId: batchStageHistory.movedBy,
            userName: users.name,
            note: batchStageHistory.note,
          })
          .from(batchStageHistory)
          .innerJoin(batches, eq(batchStageHistory.batchId, batches.id))
          .innerJoin(stages, eq(batchStageHistory.stageId, stages.id))
          .innerJoin(users, eq(batchStageHistory.movedBy, users.id))
          .where(sql`${batches.partName} IS NOT NULL AND trim(${batches.partName}) <> ''`)
          .orderBy(asc(batchStageHistory.movedAt), asc(batchStageHistory.id)),
        db
          .select({
            scrapId: scrapLogs.id,
            batchId: scrapLogs.batchId,
            materialId: scrapLogs.materialId,
            partName: scrapLogs.partName,
            stageSequence: stages.sequence,
            stageName: stages.name,
            quantityRejected: scrapLogs.quantityRejected,
            reason: scrapLogs.reason,
            loggedAt: scrapLogs.loggedAt,
            userId: scrapLogs.loggedBy,
            userName: users.name,
          })
          .from(scrapLogs)
          .innerJoin(stages, eq(scrapLogs.stageId, stages.id))
          .innerJoin(users, eq(scrapLogs.loggedBy, users.id))
          .orderBy(asc(scrapLogs.loggedAt), asc(scrapLogs.id)),
      ]);

      const partByLowerName = new Map(
        allParts.map((p) => [p.name.trim().toLowerCase(), p])
      );

      interface CutPieceEvent {
        eventKey: string;
        sortTime: number;
        sortTie: number;
        dateObj: Date;
        date: string;
        partId: number | null;
        partCode: string;
        partName: string;
        materialId: number | null;
        movementType: 'Produced' | 'Rejected' | 'Adjusted';
        qtyIn: number;
        qtyOut: number;
        balance: number;
        reference: string;
        userId: number;
        userName: string;
      }

      const events: CutPieceEvent[] = [];

      // 1. Parts Master stock movements
      for (const m of partMovements) {
        const dt = new Date(m.movementDate);
        const movementType: 'Produced' | 'Rejected' | 'Adjusted' =
          m.type === 'receipt'
            ? 'Produced'
            : m.type === 'issue'
            ? 'Rejected'
            : 'Adjusted';
        const qtyIn =
          m.type === 'receipt' || (m.type === 'adjustment' && m.quantity > 0)
            ? Number(m.quantity.toFixed(3))
            : 0;
        const qtyOut =
          m.type === 'issue' || (m.type === 'adjustment' && m.quantity < 0)
            ? Number(Math.abs(m.quantity).toFixed(3))
            : 0;
        const refParts = [m.batchId, m.reason, m.note].filter(
          (v) => v && String(v).trim() !== ''
        );
        events.push({
          eventKey: `pm-${m.id}`,
          sortTime: dt.getTime(),
          sortTie: 1_000_000 + m.id,
          dateObj: dt,
          date: dt.toISOString().slice(0, 10),
          partId: m.partId,
          partCode: m.partCode,
          partName: m.partName,
          materialId: null,
          movementType,
          qtyIn,
          qtyOut,
          balance: 0,
          reference: refParts.length > 0 ? refParts.join(' · ') : 'Parts Master',
          userId: m.userId,
          userName: m.userName,
        });
      }

      // 2. First Produced cut-piece entry per production batch (Stage 03+ output from Laser Cutting, or immediate dispatch with qtyOut > 0)
      const seenBatchProduction = new Set<string>();
      for (const h of batchHistoryRows) {
        if (seenBatchProduction.has(h.batchId)) continue;
        const isCutPieceStageRow =
          h.stageSequence >= 3 ||
          (h.stageSequence === 2 && h.qtyOut !== null && h.qtyOut > 0);
        const qtyProduced = isCutPieceStageRow
          ? h.qtyIn !== null && h.qtyIn > 0
            ? Number(h.qtyIn.toFixed(3))
            : h.piecesQuantity && h.piecesQuantity > 0
            ? h.piecesQuantity
            : 0
          : 0;
        if (qtyProduced <= 0) continue;

        seenBatchProduction.add(h.batchId);
        const pName = h.partName!.trim();
        const matchedPart = partByLowerName.get(pName.toLowerCase());
        const dt = new Date(h.movedAt);
        const refParts = [h.batchId, h.stageName, h.note].filter(
          (v) => v && String(v).trim() !== ''
        );
        events.push({
          eventKey: `bp-${h.historyId}`,
          sortTime: dt.getTime(),
          sortTie: 2_000_000 + h.historyId,
          dateObj: dt,
          date: dt.toISOString().slice(0, 10),
          partId: matchedPart?.id ?? null,
          partCode: matchedPart?.code ?? '-',
          partName: matchedPart?.name ?? pName,
          materialId: h.materialId,
          movementType: 'Produced',
          qtyIn: qtyProduced,
          qtyOut: 0,
          balance: 0,
          reference: refParts.join(' · '),
          userId: h.userId,
          userName: h.userName,
        });
      }

      // 3. Stage rejections logged to scrap_logs
      for (const s of scrapRows) {
        const pName = (s.partName ?? '').trim() || 'Unspecified Part';
        const matchedPart = partByLowerName.get(pName.toLowerCase());
        const dt = new Date(s.loggedAt);
        const refParts = [
          s.batchId,
          `Rejected at ${String(s.stageSequence).padStart(2, '0')}. ${s.stageName}`,
          s.reason,
        ].filter((v) => v && String(v).trim() !== '');
        events.push({
          eventKey: `sc-${s.scrapId}`,
          sortTime: dt.getTime(),
          sortTie: 3_000_000 + s.scrapId,
          dateObj: dt,
          date: dt.toISOString().slice(0, 10),
          partId: matchedPart?.id ?? null,
          partCode: matchedPart?.code ?? '-',
          partName: matchedPart?.name ?? pName,
          materialId: s.materialId,
          movementType: 'Rejected',
          qtyIn: 0,
          qtyOut: s.quantityRejected,
          balance: 0,
          reference: refParts.join(' · '),
          userId: s.userId,
          userName: s.userName,
        });
      }

      // Sort chronologically to compute running balance per Part
      events.sort((a, b) => a.sortTime - b.sortTime || a.sortTie - b.sortTie);
      const balanceByPart = new Map<string, number>();
      for (const ev of events) {
        const key = (ev.partCode !== '-' ? ev.partCode : ev.partName).toLowerCase();
        const nextBal = (balanceByPart.get(key) ?? 0) + ev.qtyIn - ev.qtyOut;
        balanceByPart.set(key, nextBal);
        ev.balance = Number(nextBal.toFixed(3));
      }

      // Apply filters after balance calculation
      const filtered = events.filter((ev) => {
        if (start && ev.dateObj < start) return false;
        if (end && ev.dateObj > end) return false;
        if (filters.userId && ev.userId !== filters.userId) return false;
        if (filters.materialId && ev.materialId !== filters.materialId) return false;
        if (filters.partId && ev.partId !== filters.partId) {
          const targetPart = allParts.find((p) => p.id === filters.partId);
          if (
            !targetPart ||
            ev.partName.trim().toLowerCase() !== targetPart.name.trim().toLowerCase()
          ) {
            return false;
          }
        }
        if (
          filters.partName &&
          ev.partName.trim().toLowerCase() !== filters.partName.trim().toLowerCase()
        ) {
          return false;
        }
        return true;
      });

      // Most recent first for display
      filtered.sort((a, b) => b.sortTime - a.sortTime || b.sortTie - a.sortTie);

      const rows = filtered.map((ev) => ({
        movementId: ev.eventKey,
        date: ev.date,
        partCode: ev.partCode,
        partName: ev.partName,
        movementType: ev.movementType,
        qtyIn: ev.qtyIn,
        qtyOut: ev.qtyOut,
        balance: ev.balance,
        reference: ev.reference,
        userName: ev.userName,
      }));

      const totalIn = rows.reduce((s, r) => s + Number(r.qtyIn), 0);
      const totalOut = rows.reduce((s, r) => s + Number(r.qtyOut), 0);

      return {
        type,
        title: 'Cut Pieces Movement Report',
        columns: [
          { key: 'date', label: 'Date' },
          { key: 'partCode', label: 'Part Code' },
          { key: 'partName', label: 'Part Name' },
          { key: 'movementType', label: 'Movement Type' },
          { key: 'qtyIn', label: 'Qty In', numeric: true },
          { key: 'qtyOut', label: 'Qty Out', numeric: true },
          { key: 'balance', label: 'Balance', numeric: true },
          { key: 'reference', label: 'Reference' },
          { key: 'userName', label: 'User' },
        ],
        rows,
        summary: [
          { label: 'Transactions', value: String(rows.length) },
          { label: 'Total Produced / In', value: String(Number(totalIn.toFixed(3))) },
          { label: 'Total Rejected / Out', value: String(Number(totalOut.toFixed(3))) },
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
        partName: batches.partName,
        piecesQuantity: batches.piecesQuantity,
        qtyIn: batchStageHistory.qtyIn,
        qtyRejected: batchStageHistory.qtyRejected,
        qtyOut: batchStageHistory.qtyOut,
        rejectionReason: batchStageHistory.rejectionReason,
        quantity: batches.quantity,
        unit: sql<string>`COALESCE(${batches.unit}, ${materials.unit})`,
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
      partName: r.partName ?? '-',
      qtyIn: r.qtyIn !== null ? Number(r.qtyIn.toFixed(4)) : '-',
      qtyRejected: r.qtyRejected ?? 0,
      qtyOut: r.qtyOut ?? '-',
      piecesQuantity: r.piecesQuantity ?? '-',
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
        { key: 'material', label: 'Raw Material' },
        { key: 'partName', label: 'Part Name' },
        { key: 'qtyIn', label: 'Qty In', numeric: true },
        { key: 'qtyRejected', label: 'Qty Rejected', numeric: true },
        { key: 'qtyOut', label: 'Qty Out', numeric: true },
        { key: 'quantity', label: 'Raw Qty', numeric: true },
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
