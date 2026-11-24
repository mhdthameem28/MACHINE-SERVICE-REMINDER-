import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  auditLog,
  batches,
  batchStageHistory,
  emailRecipients,
  materials,
  notifications,
  parts,
  partStockMovements,
  scrapLogs,
  stages,
  stockMovements,
  users,
} from '../db/schema.ts';
import { sendAlertEmail } from './mailer.ts';
import { normalizeReceiveUnit } from '../lib/units.ts';

export class DomainError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'execute'>;

export async function getKnownPartNames(): Promise<string[]> {
  const [batchPartRows, masterPartRows] = await Promise.all([
    db
      .selectDistinct({ partName: batches.partName })
      .from(batches)
      .where(sql`${batches.partName} IS NOT NULL AND trim(${batches.partName}) <> ''`),
    db
      .select({ name: parts.name })
      .from(parts)
      .where(eq(parts.active, true)),
  ]);

  const unique = new Set<string>();
  for (const r of masterPartRows) {
    if (r.name?.trim()) unique.add(r.name.trim());
  }
  for (const r of batchPartRows) {
    if (r.partName?.trim()) unique.add(r.partName.trim());
  }
  return Array.from(unique).sort((a, b) => a.localeCompare(b));
}

export async function getMaterialStockSummary(executor: DbExecutor, materialId: number) {
  const rows = await executor
    .select({
      receipts: sql<number>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'receipt' THEN ${stockMovements.quantity} ELSE 0 END), 0)::double precision`,
      issues: sql<number>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'issue' THEN ${stockMovements.quantity} ELSE 0 END), 0)::double precision`,
      adjustments: sql<number>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'adjustment' THEN ${stockMovements.quantity} ELSE 0 END), 0)::double precision`,
      currentStock: sql<number>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'receipt' THEN ${stockMovements.quantity} WHEN ${stockMovements.type} = 'issue' THEN -${stockMovements.quantity} WHEN ${stockMovements.type} = 'adjustment' THEN ${stockMovements.quantity} ELSE 0 END), 0)::double precision`,
      movementCount: sql<number>`COUNT(*)::int`,
    })
    .from(stockMovements)
    .where(eq(stockMovements.materialId, materialId));

  return (
    rows[0] ?? {
      receipts: 0,
      issues: 0,
      adjustments: 0,
      currentStock: 0,
      movementCount: 0,
    }
  );
}

export async function getAllMaterialsWithStock(includeInactive = false) {
  try {
    const materialRows = includeInactive
      ? await db.select().from(materials).orderBy(asc(materials.code))
      : await db
          .select()
          .from(materials)
          .where(eq(materials.active, true))
          .orderBy(asc(materials.code));

    const ledgerRows = await db
      .select({
        materialId: stockMovements.materialId,
        receipts: sql<number>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'receipt' THEN ${stockMovements.quantity} ELSE 0 END), 0)::double precision`,
        issues: sql<number>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'issue' THEN ${stockMovements.quantity} ELSE 0 END), 0)::double precision`,
        adjustments: sql<number>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'adjustment' THEN ${stockMovements.quantity} ELSE 0 END), 0)::double precision`,
        currentStock: sql<number>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'receipt' THEN ${stockMovements.quantity} WHEN ${stockMovements.type} = 'issue' THEN -${stockMovements.quantity} WHEN ${stockMovements.type} = 'adjustment' THEN ${stockMovements.quantity} ELSE 0 END), 0)::double precision`,
        lastMovementDate: sql<string | null>`MAX(${stockMovements.movementDate})`,
      })
      .from(stockMovements)
      .groupBy(stockMovements.materialId);

    const ledgerMap = new Map(ledgerRows.map((r) => [r.materialId, r]));

    return materialRows.map((m) => {
      const ledger = ledgerMap.get(m.id);
      const currentStock = Number((ledger?.currentStock ?? 0).toFixed(4));
      return {
        ...m,
        receipts: Number((ledger?.receipts ?? 0).toFixed(4)),
        issues: Number((ledger?.issues ?? 0).toFixed(4)),
        adjustments: Number((ledger?.adjustments ?? 0).toFixed(4)),
        currentStock,
        isBelowReorder: currentStock <= m.reorderLevel,
        lastMovementDate: ledger?.lastMovementDate ?? null,
      };
    });
  } catch (error) {
    console.error('Database query failed in getAllMaterialsWithStock:', error);
    throw new Error('Failed to load materials stock summary.', { cause: error });
  }
}

async function evaluateReorderAlert(
  tx: DbExecutor,
  materialId: number,
  triggeredByUserId: number
): Promise<{
  currentStock: number;
  alertTriggered: boolean;
  emailQueuedForDispatch?: { recipients: string[]; subject: string; body: string };
}> {
  const matRows = await tx
    .select()
    .from(materials)
    .where(eq(materials.id, materialId))
    .limit(1);
  const material = matRows[0];
  if (!material) {
    throw new DomainError('Material not found', 404);
  }

  const summary = await getMaterialStockSummary(tx, materialId);
  const currentStock = Number(summary.currentStock.toFixed(4));

  if (currentStock <= material.reorderLevel) {
    if (!material.reorderAlertSent) {
      // Throttle: alert once per breach
      const targetUsers = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.active, true),
            inArray(users.role, ['admin', 'store_keeper'])
          )
        );

      const recipientRows = await tx
        .select({ email: emailRecipients.email })
        .from(emailRecipients)
        .where(eq(emailRecipients.active, true));

      const recipientEmails = recipientRows.map((r) => r.email);
      const title = `Reorder Alert: ${material.code} (${material.name})`;
      const message = `${material.name} (${material.code}) is at ${currentStock} ${material.unit}, at or below its reorder level of ${material.reorderLevel} ${material.unit}.`;

      if (targetUsers.length > 0) {
        await tx.insert(notifications).values(
          targetUsers.map((u) => ({
            userId: u.id,
            type: 'reorder_alert',
            title,
            message,
            entityType: 'material',
            entityId: String(material.id),
            emailSent: false,
            emailRecipientsCount: recipientEmails.length,
            isRead: false,
          }))
        );
      }

      await tx
        .update(materials)
        .set({ reorderAlertSent: true })
        .where(eq(materials.id, material.id));

      await tx.insert(auditLog).values({
        userId: triggeredByUserId,
        action: 'REORDER_ALERT_TRIGGERED',
        entity: 'material',
        entityId: String(material.id),
        details: JSON.stringify({
          code: material.code,
          currentStock,
          reorderLevel: material.reorderLevel,
          recipientCount: recipientEmails.length,
        }),
      });

      return {
        currentStock,
        alertTriggered: true,
        emailQueuedForDispatch: {
          recipients: recipientEmails,
          subject: `[Abone Cut Pieces Tracking] Reorder Level Reached: ${material.code} — ${material.name}`,
          body: `${message}\n\nPlease arrange replenishment for ${material.name} (${material.code}).\nCurrent ledger balance: ${currentStock} ${material.unit}\nConfigured reorder threshold: ${material.reorderLevel} ${material.unit}`,
        },
      };
    }
    return { currentStock, alertTriggered: false };
  }

  // Stock recovered above reorder level -> reset breach flag
  if (material.reorderAlertSent) {
    await tx
      .update(materials)
      .set({ reorderAlertSent: false })
      .where(eq(materials.id, material.id));
  }

  return { currentStock, alertTriggered: false };
}

async function generateNextBatchId(tx: DbExecutor, refDate: Date): Promise<string> {
  const y = refDate.getUTCFullYear();
  const m = String(refDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(refDate.getUTCDate()).padStart(2, '0');
  const prefix = `BATCH-${y}${m}${d}-`;

  const existing = await tx
    .select({ id: batches.id })
    .from(batches)
    .where(sql`${batches.id} LIKE ${prefix + '%'}`)
    .orderBy(desc(batches.id))
    .limit(1);

  let nextSeq = 1;
  if (existing.length > 0) {
    const tail = existing[0].id.slice(prefix.length);
    const parsed = Number.parseInt(tail, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      nextSeq = parsed + 1;
    }
  }
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

export async function receiveStock(params: {
  materialId: number;
  quantity: number;
  unit?: string;
  movementDate: Date;
  sendToLaserCutting: boolean;
  partName?: string;
  piecesQuantity?: number;
  note?: string;
  userId: number;
}) {
  if (!Number.isFinite(params.quantity) || params.quantity <= 0) {
    throw new DomainError('Quantity must be a positive number.');
  }

  let requestedUnit: string | undefined;
  if (params.unit !== undefined && params.unit !== null && String(params.unit).trim() !== '') {
    const normalized = normalizeReceiveUnit(params.unit);
    if (!normalized) {
      throw new DomainError(
        'Invalid unit selected. Allowed units: kg, sheets, pcs, liters, meters, qty.'
      );
    }
    requestedUnit = normalized;
  }

  const trimmedPartName = params.partName?.trim() || '';
  const piecesQty =
    params.piecesQuantity !== undefined && params.piecesQuantity !== null
      ? Number(params.piecesQuantity)
      : NaN;

  if (params.sendToLaserCutting) {
    if (!trimmedPartName) {
      throw new DomainError('Part Name is required when dispatching directly to Laser Cutting.');
    }
    if (!Number.isInteger(piecesQty) || piecesQty <= 0) {
      throw new DomainError(
        'Quantity of pieces must be a positive whole number when dispatching directly to Laser Cutting.'
      );
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      const matRows = await tx
        .select()
        .from(materials)
        .where(eq(materials.id, params.materialId))
        .limit(1);
      const material = matRows[0];
      if (!material || !material.active) {
        throw new DomainError('Selected material is inactive or does not exist.', 404);
      }

      const activeStages = await tx
        .select()
        .from(stages)
        .where(eq(stages.active, true))
        .orderBy(asc(stages.sequence), asc(stages.id));

      if (activeStages.length === 0) {
        throw new DomainError('No active production stages are configured.');
      }

      const stage1 = activeStages[0];
      const stage2 = activeStages[1];
      if (params.sendToLaserCutting && !stage2) {
        throw new DomainError(
          'Cannot send immediately to next stage because fewer than two active stages exist.'
        );
      }

      // Check if this is the first stock movement for this material
      const priorMovements = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(stockMovements)
        .where(eq(stockMovements.materialId, material.id));
      const isOpening = (priorMovements[0]?.count ?? 0) === 0;

      const now = new Date();
      const batchId = await generateNextBatchId(tx, now);
      const targetStage = params.sendToLaserCutting ? stage2 : stage1;
      const effectiveUnit = requestedUnit ?? material.unit;

      const [createdBatch] = await tx
        .insert(batches)
        .values({
          id: batchId,
          materialId: material.id,
          currentStageId: targetStage.id,
          quantity: params.quantity,
          unit: effectiveUnit,
          partName: params.sendToLaserCutting ? trimmedPartName : null,
          piecesQuantity: params.sendToLaserCutting ? piecesQty : null,
          note: params.note?.trim() || null,
          createdAt: now,
          createdBy: params.userId,
        })
        .returning();

      // Stage 01 history row
      await tx.insert(batchStageHistory).values({
        batchId,
        stageId: stage1.id,
        qtyIn: null,
        qtyRejected: 0,
        qtyOut: params.sendToLaserCutting ? piecesQty : null,
        rejectionReason: null,
        movedAt: now,
        movedBy: params.userId,
        note: params.note?.trim() || 'Received into raw material store',
      });

      // If immediate dispatch checked -> second history row with exact same timestamp & user ID
      if (params.sendToLaserCutting && stage2) {
        await tx.insert(batchStageHistory).values({
          batchId,
          stageId: stage2.id,
          qtyIn: piecesQty,
          qtyRejected: 0,
          qtyOut: piecesQty,
          rejectionReason: null,
          movedAt: now,
          movedBy: params.userId,
          note: `Immediate dispatch to ${stage2.name} · Part: ${trimmedPartName} (${piecesQty} pcs)`,
        });
      }

      // Ledger receipt row
      const [receiptMovement] = await tx
        .insert(stockMovements)
        .values({
          materialId: material.id,
          type: 'receipt',
          quantity: params.quantity,
          unit: effectiveUnit,
          batchId,
          isOpening,
          reason: isOpening ? 'Opening Stock' : 'Stock Receipt',
          movementDate: params.movementDate,
          createdAt: now,
          userId: params.userId,
          note: params.note?.trim() || null,
        })
        .returning();

      // If sent immediately to Stage 02 (Laser Cutting), record ledger issue from raw material store
      if (params.sendToLaserCutting && stage2) {
        await tx.insert(stockMovements).values({
          materialId: material.id,
          type: 'issue',
          quantity: params.quantity,
          unit: effectiveUnit,
          batchId,
          isOpening: false,
          reason: `Dispatched to ${stage2.name}`,
          movementDate: params.movementDate,
          createdAt: now,
          userId: params.userId,
          note: `Immediate dispatch from ${stage1.name} to ${stage2.name} (${trimmedPartName}, ${piecesQty} pcs)`,
        });

        // Stage-advance notifications for Operators + Admins
        const opUsers = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(eq(users.active, true), inArray(users.role, ['admin', 'operator']))
          );
        if (opUsers.length > 0) {
          await tx.insert(notifications).values(
            opUsers.map((u) => ({
              userId: u.id,
              type: 'stage_advanced',
              title: `Batch Dispatched: ${batchId}`,
              message: `${batchId} (${params.quantity} ${effectiveUnit} of ${material.name} → ${trimmedPartName}, ${piecesQty} pcs) received and sent directly to ${stage2.name}.`,
              entityType: 'batch',
              entityId: batchId,
              emailSent: false,
              emailRecipientsCount: 0,
              isRead: false,
            }))
          );
        }
      }

      await tx.insert(auditLog).values({
        userId: params.userId,
        action: 'RECEIVE_STOCK',
        entity: 'stock_movement',
        entityId: String(receiptMovement.id),
        details: JSON.stringify({
          batchId,
          materialCode: material.code,
          quantity: params.quantity,
          unit: effectiveUnit,
          isOpening,
          sentToNextStage: params.sendToLaserCutting,
          stage: targetStage.name,
          ...(params.sendToLaserCutting
            ? { partName: trimmedPartName, piecesQuantity: piecesQty }
            : {}),
        }),
        timestamp: now,
      });

      const reorderOutcome = await evaluateReorderAlert(tx, material.id, params.userId);

      return {
        batch: createdBatch,
        material,
        unit: effectiveUnit,
        currentStage: targetStage,
        isOpening,
        currentStock: reorderOutcome.currentStock,
        reorderAlertTriggered: reorderOutcome.alertTriggered,
        emailQueuedForDispatch: reorderOutcome.emailQueuedForDispatch,
      };
    });

    // Send SMTP email outside DB transaction if alert triggered
    if (result.emailQueuedForDispatch) {
      const emailResult = await sendAlertEmail(
        result.emailQueuedForDispatch.recipients,
        result.emailQueuedForDispatch.subject,
        result.emailQueuedForDispatch.body
      );
      if (emailResult.sent) {
        await db
          .update(notifications)
          .set({ emailSent: true })
          .where(
            and(
              eq(notifications.entityType, 'material'),
              eq(notifications.entityId, String(result.material.id)),
              eq(notifications.type, 'reorder_alert')
            )
          );
      }
    }

    return result;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    console.error('Database transaction failed in receiveStock:', error);
    throw new Error('Failed to record stock receipt.', { cause: error });
  }
}

export async function adjustStock(params: {
  materialId: number;
  quantity: number;
  reason: string;
  movementDate: Date;
  note?: string;
  userId: number;
}) {
  if (!Number.isFinite(params.quantity) || params.quantity === 0) {
    throw new DomainError('Adjustment quantity must be a non-zero number.');
  }
  if (!params.reason.trim()) {
    throw new DomainError('Adjustment reason is required.');
  }

  try {
    const result = await db.transaction(async (tx) => {
      const matRows = await tx
        .select()
        .from(materials)
        .where(eq(materials.id, params.materialId))
        .limit(1);
      const material = matRows[0];
      if (!material || !material.active) {
        throw new DomainError('Selected material is inactive or does not exist.', 404);
      }

      const ledger = await getMaterialStockSummary(tx, material.id);
      const projected = Number((ledger.currentStock + params.quantity).toFixed(4));
      if (projected < 0) {
        throw new DomainError(
          `Adjustment would result in negative stock (${projected} ${material.unit}). Current stock is ${ledger.currentStock} ${material.unit}.`
        );
      }

      const now = new Date();
      const [movement] = await tx
        .insert(stockMovements)
        .values({
          materialId: material.id,
          type: 'adjustment',
          quantity: params.quantity,
          unit: material.unit,
          batchId: null,
          isOpening: false,
          reason: params.reason.trim(),
          movementDate: params.movementDate,
          createdAt: now,
          userId: params.userId,
          note: params.note?.trim() || null,
        })
        .returning();

      await tx.insert(auditLog).values({
        userId: params.userId,
        action: 'ADJUST_STOCK',
        entity: 'stock_movement',
        entityId: String(movement.id),
        details: JSON.stringify({
          materialCode: material.code,
          previousStock: ledger.currentStock,
          adjustment: params.quantity,
          newStock: projected,
          reason: params.reason.trim(),
        }),
        timestamp: now,
      });

      const reorderOutcome = await evaluateReorderAlert(tx, material.id, params.userId);

      return {
        movement,
        material,
        previousStock: ledger.currentStock,
        currentStock: reorderOutcome.currentStock,
        reorderAlertTriggered: reorderOutcome.alertTriggered,
        emailQueuedForDispatch: reorderOutcome.emailQueuedForDispatch,
      };
    });

    if (result.emailQueuedForDispatch) {
      const emailResult = await sendAlertEmail(
        result.emailQueuedForDispatch.recipients,
        result.emailQueuedForDispatch.subject,
        result.emailQueuedForDispatch.body
      );
      if (emailResult.sent) {
        await db
          .update(notifications)
          .set({ emailSent: true })
          .where(
            and(
              eq(notifications.entityType, 'material'),
              eq(notifications.entityId, String(result.material.id)),
              eq(notifications.type, 'reorder_alert')
            )
          );
      }
    }

    return result;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    console.error('Database transaction failed in adjustStock:', error);
    throw new Error('Failed to record stock adjustment.', { cause: error });
  }
}

export async function advanceBatch(params: {
  batchId: string;
  partName?: string;
  quantityIssued?: number;
  piecesQuantity?: number;
  quantityProcessed?: number;
  quantityRejected?: number;
  rejectionReason?: string;
  supplierName?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  bendingInchargeName?: string;
  machiningInchargeName?: string;
  note?: string;
  userId: number;
}) {
  try {
    const result = await db.transaction(async (tx) => {
      const batchRows = await tx
        .select()
        .from(batches)
        .where(eq(batches.id, params.batchId))
        .limit(1);
      const batch = batchRows[0];
      if (!batch) {
        throw new DomainError('Batch not found.', 404);
      }

      const matRows = await tx
        .select()
        .from(materials)
        .where(eq(materials.id, batch.materialId))
        .limit(1);
      const material = matRows[0];

      const currentStageRows = await tx
        .select()
        .from(stages)
        .where(eq(stages.id, batch.currentStageId))
        .limit(1);
      const currentStage = currentStageRows[0];
      if (!currentStage) {
        throw new DomainError('Batch current stage not found.', 404);
      }

      const activeStages = await tx
        .select()
        .from(stages)
        .where(eq(stages.active, true))
        .orderBy(asc(stages.sequence), asc(stages.id));

      const nextStageRows = await tx
        .select()
        .from(stages)
        .where(and(eq(stages.active, true), gt(stages.sequence, currentStage.sequence)))
        .orderBy(asc(stages.sequence), asc(stages.id))
        .limit(1);
      const nextStage = nextStageRows[0];
      if (!nextStage) {
        throw new DomainError(
          `Batch is already at the final active stage (${currentStage.name}).`
        );
      }

      const firstActiveStage = activeStages[0];
      const isTransitionFromRawToCutting = Boolean(
        firstActiveStage && currentStage.id === firstActiveStage.id
      );

      const now = new Date();
      const customNote = params.note?.trim();
      const batchUnit = batch.unit || material?.unit || '';

      if (isTransitionFromRawToCutting) {
        const trimmedPartName = params.partName?.trim() || '';
        if (!trimmedPartName) {
          throw new DomainError(
            `Part Name is required when advancing from ${currentStage.name} to ${nextStage.name}.`
          );
        }

        const rawIssued =
          params.quantityIssued !== undefined && params.quantityIssued !== null
            ? Number(params.quantityIssued)
            : batch.quantity;

        if (!Number.isFinite(rawIssued) || rawIssued <= 0) {
          throw new DomainError(
            `Quantity Issued must be a positive number when advancing from ${currentStage.name} to ${nextStage.name}.`
          );
        }
        if (rawIssued > batch.quantity + 1e-6) {
          throw new DomainError(
            `Quantity Issued (${rawIssued}${batchUnit ? ` ${batchUnit}` : ''}) cannot exceed available batch quantity (${batch.quantity}${batchUnit ? ` ${batchUnit}` : ''}).`
          );
        }

        const issuedQty = Math.min(Number(rawIssued.toFixed(4)), batch.quantity);
        const remainingDiff = Number((batch.quantity - issuedQty).toFixed(4));
        const remainingQty = remainingDiff > 1e-6 ? remainingDiff : 0;
        const trimmedSupplierName = params.supplierName?.trim() || null;
        const trimmedInvoiceNumber = params.invoiceNumber?.trim() || null;
        const trimmedInvoiceDate = params.invoiceDate?.trim() || null;

        const [updatedBatch] = await tx
          .update(batches)
          .set({
            currentStageId: nextStage.id,
            quantity: issuedQty,
            partName: trimmedPartName,
            piecesQuantity: null,
            supplierName: trimmedSupplierName,
            invoiceNumber: trimmedInvoiceNumber,
            invoiceDate: trimmedInvoiceDate,
          })
          .where(eq(batches.id, batch.id))
          .returning();

        let remainingBatch: typeof updatedBatch | null = null;
        if (remainingQty > 0) {
          const splitBatchId = await generateNextBatchId(tx, now);
          const splitNote = `Remaining balance split from ${batch.id}${
            batch.note ? ` (${batch.note})` : ''
          }`;

          const [insertedSplit] = await tx
            .insert(batches)
            .values({
              id: splitBatchId,
              materialId: batch.materialId,
              currentStageId: currentStage.id,
              quantity: remainingQty,
              unit: batchUnit || null,
              partName: null,
              piecesQuantity: null,
              note: splitNote,
              createdAt: now,
              createdBy: params.userId,
            })
            .returning();
          remainingBatch = insertedSplit;

          await tx.insert(batchStageHistory).values({
            batchId: splitBatchId,
            stageId: currentStage.id,
            qtyIn: null,
            qtyRejected: 0,
            qtyOut: null,
            rejectionReason: null,
            movedAt: now,
            movedBy: params.userId,
            note: `Remaining ${remainingQty}${
              batchUnit ? ` ${batchUnit}` : ''
            } retained in ${currentStage.name} after issuing ${issuedQty}${
              batchUnit ? ` ${batchUnit}` : ''
            } from ${batch.id}`,
          });
        }

        const unitLabel = batchUnit ? ` ${batchUnit}` : '';
        const splitSummary = remainingBatch
          ? ` · Remaining ${remainingQty}${unitLabel} retained in ${currentStage.name} (${remainingBatch.id})`
          : '';
        const historyNote = customNote
          ? `${customNote} · Part: ${trimmedPartName} · Issued: ${issuedQty}${unitLabel}${splitSummary}`
          : `Part assigned: ${trimmedPartName} · Issued: ${issuedQty}${unitLabel} to ${nextStage.name}${splitSummary}`;

        await tx.insert(batchStageHistory).values({
          batchId: batch.id,
          stageId: nextStage.id,
          qtyIn: issuedQty,
          qtyRejected: 0,
          qtyOut: null,
          rejectionReason: null,
          movedAt: now,
          movedBy: params.userId,
          supplierName: trimmedSupplierName,
          invoiceNumber: trimmedInvoiceNumber,
          invoiceDate: trimmedInvoiceDate,
          note: historyNote,
        });

        // Deduct only the issued quantity from raw material stock ledger
        let reorderOutcome: Awaited<ReturnType<typeof evaluateReorderAlert>> | null = null;
        const existingIssue = await tx
          .select({ id: stockMovements.id })
          .from(stockMovements)
          .where(
            and(
              eq(stockMovements.batchId, batch.id),
              eq(stockMovements.type, 'issue')
            )
          )
          .limit(1);

        if (existingIssue.length === 0) {
          await tx.insert(stockMovements).values({
            materialId: batch.materialId,
            type: 'issue',
            quantity: issuedQty,
            unit: batchUnit || null,
            batchId: batch.id,
            isOpening: false,
            reason: `Issued to ${nextStage.name}`,
            movementDate: now,
            createdAt: now,
            userId: params.userId,
            note: `Issued ${issuedQty}${unitLabel} from ${currentStage.name} to ${nextStage.name} (${trimmedPartName})${
              remainingBatch
                ? `; remaining ${remainingQty}${unitLabel} kept as ${remainingBatch.id}`
                : ''
            }`,
          });

          reorderOutcome = await evaluateReorderAlert(tx, batch.materialId, params.userId);
        }

        await tx.insert(auditLog).values({
          userId: params.userId,
          action: 'ADVANCE_BATCH',
          entity: 'batch',
          entityId: batch.id,
          details: JSON.stringify({
            fromStage: currentStage.name,
            toStage: nextStage.name,
            materialCode: material?.code,
            availableQuantity: batch.quantity,
            quantityIssued: issuedQty,
            unit: batchUnit,
            remainingQuantity: remainingQty,
            remainingBatchId: remainingBatch?.id ?? null,
            partName: trimmedPartName,
            supplierName: trimmedSupplierName,
            invoiceNumber: trimmedInvoiceNumber,
            invoiceDate: trimmedInvoiceDate,
          }),
          timestamp: now,
        });

        const targetUsers = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(eq(users.active, true), inArray(users.role, ['admin', 'operator']))
          );

        if (targetUsers.length > 0) {
          await tx.insert(notifications).values(
            targetUsers.map((u) => ({
              userId: u.id,
              type: 'stage_advanced',
              title: `Issued to ${nextStage.name}: ${batch.id}`,
              message: `${issuedQty}${unitLabel} of ${material?.name ?? ''} issued from ${batch.id} to ${nextStage.name} (Part: ${trimmedPartName})${
                remainingBatch
                  ? `. Remaining ${remainingQty}${unitLabel} stayed in ${currentStage.name} as ${remainingBatch.id}`
                  : ''
              }.`,
              entityType: 'batch',
              entityId: batch.id,
              emailSent: false,
              emailRecipientsCount: 0,
              isRead: false,
            }))
          );
        }

        return {
          batch: updatedBatch,
          remainingBatch,
          fromStage: currentStage,
          toStage: nextStage,
          material,
          issuedQuantity: issuedQty,
          remainingQuantity: remainingQty,
          quantityProcessed: null,
          quantityRejected: 0,
          goodQuantity: null,
          emailQueuedForDispatch: reorderOutcome?.emailQueuedForDispatch,
          reorderAlertTriggered: reorderOutcome?.alertTriggered ?? false,
        };
      }

      // Stage 02+ transitions (piece yield & rejection tracking)
      const assignedPartName = batch.partName ?? null;

      const rawProcessed =
        params.quantityProcessed !== undefined && params.quantityProcessed !== null
          ? Number(params.quantityProcessed)
          : params.piecesQuantity !== undefined && params.piecesQuantity !== null
          ? Number(params.piecesQuantity)
          : batch.piecesQuantity ?? NaN;

      const rawRejected =
        params.quantityRejected !== undefined && params.quantityRejected !== null
          ? Number(params.quantityRejected)
          : 0;

      if (!Number.isInteger(rawProcessed) || rawProcessed <= 0) {
        throw new DomainError(
          `Quantity Processed must be a positive whole number when advancing from ${currentStage.name} to ${nextStage.name}.`
        );
      }
      if (!Number.isInteger(rawRejected) || rawRejected < 0) {
        throw new DomainError(
          'Quantity Rejected must be a non-negative whole number.'
        );
      }
      if (rawRejected > rawProcessed) {
        throw new DomainError(
          `Quantity Rejected (${rawRejected}) cannot exceed Quantity Processed (${rawProcessed}).`
        );
      }

      const goodQty = rawProcessed - rawRejected;
      const trimmedReason = params.rejectionReason?.trim() || null;
      const isBendingTransition = currentStage.sequence === 2;
      const isMachiningTransition = currentStage.sequence === 3;
      const trimmedBendingIncharge = params.bendingInchargeName?.trim() || null;
      const trimmedMachiningIncharge = params.machiningInchargeName?.trim() || null;

      if (isBendingTransition && !trimmedBendingIncharge) {
        throw new DomainError(
          `Bending Incharge Name is required when advancing from ${currentStage.name} to ${nextStage.name}.`
        );
      }

      const stageInchargeName = isBendingTransition
        ? trimmedBendingIncharge
        : isMachiningTransition
        ? trimmedMachiningIncharge
        : null;

      const [updatedBatch] = await tx
        .update(batches)
        .set({
          currentStageId: nextStage.id,
          piecesQuantity: goodQty,
          ...(isBendingTransition
            ? { bendingInchargeName: trimmedBendingIncharge }
            : {}),
          ...(isMachiningTransition && trimmedMachiningIncharge
            ? { machiningInchargeName: trimmedMachiningIncharge }
            : {}),
        })
        .where(eq(batches.id, batch.id))
        .returning();

      const qtySummary =
        rawRejected > 0
          ? `Processed: ${rawProcessed}, Rejected: ${rawRejected}${
              trimmedReason ? ` (${trimmedReason})` : ''
            }, Good Out: ${goodQty} pcs`
          : `Processed: ${rawProcessed}, Good Out: ${goodQty} pcs`;

      const historyNote = customNote
        ? `${customNote} · ${qtySummary}`
        : `Advanced from ${currentStage.name} to ${nextStage.name} · ${qtySummary}`;

      await tx.insert(batchStageHistory).values({
        batchId: batch.id,
        stageId: nextStage.id,
        qtyIn: rawProcessed,
        qtyRejected: rawRejected,
        qtyOut: goodQty,
        rejectionReason: trimmedReason,
        movedAt: now,
        movedBy: params.userId,
        inchargeName: stageInchargeName,
        note: historyNote,
      });

      if (rawRejected > 0) {
        await tx.insert(scrapLogs).values({
          batchId: batch.id,
          materialId: batch.materialId,
          stageId: currentStage.id,
          partName: assignedPartName,
          quantityProcessed: rawProcessed,
          quantityRejected: rawRejected,
          quantityGood: goodQty,
          reason: trimmedReason,
          loggedBy: params.userId,
          loggedAt: now,
        });
      }

      await tx.insert(auditLog).values({
        userId: params.userId,
        action: 'ADVANCE_BATCH',
        entity: 'batch',
        entityId: batch.id,
        details: JSON.stringify({
          fromStage: currentStage.name,
          toStage: nextStage.name,
          materialCode: material?.code,
          quantity: batch.quantity,
          partName: assignedPartName,
          quantityProcessed: rawProcessed,
          quantityRejected: rawRejected,
          goodQuantity: goodQty,
          rejectionReason: trimmedReason,
          ...(isBendingTransition
            ? { bendingInchargeName: trimmedBendingIncharge }
            : {}),
          ...(isMachiningTransition
            ? { machiningInchargeName: trimmedMachiningIncharge }
            : {}),
        }),
        timestamp: now,
      });

      // Notify Operators + Admins about stage advancement
      const targetUsers = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(eq(users.active, true), inArray(users.role, ['admin', 'operator']))
        );

      const partSummary = assignedPartName
        ? ` · Part: ${assignedPartName} (${goodQty} good pcs${
            rawRejected > 0 ? `, ${rawRejected} rejected` : ''
          })`
        : ` (${goodQty} good pcs${rawRejected > 0 ? `, ${rawRejected} rejected` : ''})`;

      if (targetUsers.length > 0) {
        await tx.insert(notifications).values(
          targetUsers.map((u) => ({
            userId: u.id,
            type: 'stage_advanced',
            title: `Stage Completed: ${batch.id} → ${nextStage.name}`,
            message: `Batch ${batch.id} (${batch.quantity} ${material?.unit ?? ''} ${material?.name ?? ''}${partSummary}) moved from ${currentStage.name} to ${nextStage.name}.`,
            entityType: 'batch',
            entityId: batch.id,
            emailSent: false,
            emailRecipientsCount: 0,
            isRead: false,
          }))
        );
      }

      return {
        batch: updatedBatch,
        remainingBatch: null,
        fromStage: currentStage,
        toStage: nextStage,
        material,
        issuedQuantity: null,
        remainingQuantity: 0,
        quantityProcessed: rawProcessed,
        quantityRejected: rawRejected,
        goodQuantity: goodQty,
        emailQueuedForDispatch: undefined,
        reorderAlertTriggered: false,
      };
    });

    if (result.emailQueuedForDispatch && result.material) {
      const emailResult = await sendAlertEmail(
        result.emailQueuedForDispatch.recipients,
        result.emailQueuedForDispatch.subject,
        result.emailQueuedForDispatch.body
      );
      if (emailResult.sent) {
        await db
          .update(notifications)
          .set({ emailSent: true })
          .where(
            and(
              eq(notifications.entityType, 'material'),
              eq(notifications.entityId, String(result.material.id)),
              eq(notifications.type, 'reorder_alert')
            )
          );
      }
    }

    return result;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    console.error('Database transaction failed in advanceBatch:', error);
    throw new Error('Failed to advance batch stage.', { cause: error });
  }
}

export async function getPartStockSummary(executor: DbExecutor, partId: number) {
  const rows = await executor
    .select({
      receipts: sql<number>`COALESCE(SUM(CASE WHEN ${partStockMovements.type} = 'receipt' THEN ${partStockMovements.quantity} ELSE 0 END), 0)::double precision`,
      issues: sql<number>`COALESCE(SUM(CASE WHEN ${partStockMovements.type} = 'issue' THEN ${partStockMovements.quantity} ELSE 0 END), 0)::double precision`,
      adjustments: sql<number>`COALESCE(SUM(CASE WHEN ${partStockMovements.type} = 'adjustment' THEN ${partStockMovements.quantity} ELSE 0 END), 0)::double precision`,
      currentStock: sql<number>`COALESCE(SUM(CASE WHEN ${partStockMovements.type} = 'receipt' THEN ${partStockMovements.quantity} WHEN ${partStockMovements.type} = 'issue' THEN -${partStockMovements.quantity} WHEN ${partStockMovements.type} = 'adjustment' THEN ${partStockMovements.quantity} ELSE 0 END), 0)::double precision`,
      movementCount: sql<number>`COUNT(*)::int`,
    })
    .from(partStockMovements)
    .where(eq(partStockMovements.partId, partId));

  return (
    rows[0] ?? {
      receipts: 0,
      issues: 0,
      adjustments: 0,
      currentStock: 0,
      movementCount: 0,
    }
  );
}

export async function evaluatePartReorderAlert(
  tx: DbExecutor,
  partId: number,
  triggeredByUserId: number
): Promise<{
  partId: number;
  currentStock: number;
  alertTriggered: boolean;
  emailQueuedForDispatch?: { recipients: string[]; subject: string; body: string };
}> {
  const partRows = await tx
    .select()
    .from(parts)
    .where(eq(parts.id, partId))
    .limit(1);
  const part = partRows[0];
  if (!part) {
    throw new DomainError('Part not found', 404);
  }

  const summary = await getPartStockSummary(tx, partId);
  const currentStock = Number(summary.currentStock.toFixed(4));

  if (currentStock <= part.reorderLevel) {
    if (!part.reorderAlertSent) {
      const targetUsers = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.active, true),
            inArray(users.role, ['admin', 'store_keeper'])
          )
        );

      const recipientRows = await tx
        .select({ email: emailRecipients.email })
        .from(emailRecipients)
        .where(eq(emailRecipients.active, true));

      const recipientEmails = recipientRows.map((r) => r.email);
      const title = `Cut Part Reorder Alert: ${part.code} (${part.name})`;
      const message = `${part.name} (${part.code}) is at ${currentStock} ${part.unit}, at or below its reorder level of ${part.reorderLevel} ${part.unit}.`;

      if (targetUsers.length > 0) {
        await tx.insert(notifications).values(
          targetUsers.map((u) => ({
            userId: u.id,
            type: 'reorder_alert',
            title,
            message,
            entityType: 'part',
            entityId: String(part.id),
            emailSent: false,
            emailRecipientsCount: recipientEmails.length,
            isRead: false,
          }))
        );
      }

      await tx
        .update(parts)
        .set({ reorderAlertSent: true })
        .where(eq(parts.id, part.id));

      await tx.insert(auditLog).values({
        userId: triggeredByUserId,
        action: 'REORDER_ALERT_TRIGGERED',
        entity: 'part',
        entityId: String(part.id),
        details: JSON.stringify({
          code: part.code,
          currentStock,
          reorderLevel: part.reorderLevel,
          recipientCount: recipientEmails.length,
        }),
      });

      return {
        partId: part.id,
        currentStock,
        alertTriggered: true,
        emailQueuedForDispatch: {
          recipients: recipientEmails,
          subject: `[Abone Cut Pieces Tracking] Cut Part Reorder Level Reached: ${part.code} — ${part.name}`,
          body: `${message}\n\nPlease arrange production or replenishment for cut part ${part.name} (${part.code}).\nCurrent ledger balance: ${currentStock} ${part.unit}\nConfigured reorder threshold: ${part.reorderLevel} ${part.unit}`,
        },
      };
    }
    return { partId: part.id, currentStock, alertTriggered: false };
  }

  if (part.reorderAlertSent) {
    await tx
      .update(parts)
      .set({ reorderAlertSent: false })
      .where(eq(parts.id, part.id));
  }

  return { partId: part.id, currentStock, alertTriggered: false };
}

export async function getAllPartsWithStock(includeInactive = false) {
  try {
    const partRows = includeInactive
      ? await db.select().from(parts).orderBy(asc(parts.code))
      : await db
          .select()
          .from(parts)
          .where(eq(parts.active, true))
          .orderBy(asc(parts.code));

    const ledgerRows = await db
      .select({
        partId: partStockMovements.partId,
        receipts: sql<number>`COALESCE(SUM(CASE WHEN ${partStockMovements.type} = 'receipt' THEN ${partStockMovements.quantity} ELSE 0 END), 0)::double precision`,
        issues: sql<number>`COALESCE(SUM(CASE WHEN ${partStockMovements.type} = 'issue' THEN ${partStockMovements.quantity} ELSE 0 END), 0)::double precision`,
        adjustments: sql<number>`COALESCE(SUM(CASE WHEN ${partStockMovements.type} = 'adjustment' THEN ${partStockMovements.quantity} ELSE 0 END), 0)::double precision`,
        currentStock: sql<number>`COALESCE(SUM(CASE WHEN ${partStockMovements.type} = 'receipt' THEN ${partStockMovements.quantity} WHEN ${partStockMovements.type} = 'issue' THEN -${partStockMovements.quantity} WHEN ${partStockMovements.type} = 'adjustment' THEN ${partStockMovements.quantity} ELSE 0 END), 0)::double precision`,
        lastMovementDate: sql<string | null>`MAX(${partStockMovements.movementDate})`,
      })
      .from(partStockMovements)
      .groupBy(partStockMovements.partId);

    const ledgerMap = new Map(ledgerRows.map((r) => [r.partId, r]));

    return partRows.map((p) => {
      const ledger = ledgerMap.get(p.id);
      const currentStock = Number((ledger?.currentStock ?? 0).toFixed(4));
      return {
        ...p,
        receipts: Number((ledger?.receipts ?? 0).toFixed(4)),
        issues: Number((ledger?.issues ?? 0).toFixed(4)),
        adjustments: Number((ledger?.adjustments ?? 0).toFixed(4)),
        currentStock,
        isBelowReorder: currentStock <= p.reorderLevel,
        lastMovementDate: ledger?.lastMovementDate ?? null,
      };
    });
  } catch (error) {
    console.error('Database query failed in getAllPartsWithStock:', error);
    throw new Error('Failed to load parts stock summary.', { cause: error });
  }
}

export async function bulkImportMaterialsWithOpeningStock(params: {
  items: {
    code: string;
    name: string;
    unit: string;
    reorderLevel: number;
    qty: number;
  }[];
  skippedCodes: string[];
  userId: number;
}) {
  return await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(materials)
      .values(
        params.items.map((item) => ({
          code: item.code,
          name: item.name,
          unit: item.unit,
          reorderLevel: item.reorderLevel,
          active: true,
        }))
      )
      .returning();

    const itemByCode = new Map(params.items.map((it) => [it.code, it]));
    const itemsWithOpening = inserted.filter(
      (mat) => (itemByCode.get(mat.code)?.qty ?? 0) > 0
    );

    let openingCount = 0;
    if (itemsWithOpening.length > 0) {
      const now = new Date();
      const activeStages = await tx
        .select()
        .from(stages)
        .where(eq(stages.active, true))
        .orderBy(asc(stages.sequence), asc(stages.id));
      const stage1 = activeStages[0] ?? null;

      // Reserve contiguous batch IDs if Stage 01 exists
      let nextSeq = 1;
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, '0');
      const d = String(now.getUTCDate()).padStart(2, '0');
      const prefix = `BATCH-${y}${m}${d}-`;
      if (stage1) {
        const existingBatch = await tx
          .select({ id: batches.id })
          .from(batches)
          .where(sql`${batches.id} LIKE ${prefix + '%'}`)
          .orderBy(desc(batches.id))
          .limit(1);
        if (existingBatch.length > 0) {
          const parsed = Number.parseInt(existingBatch[0].id.slice(prefix.length), 10);
          if (Number.isFinite(parsed) && parsed >= 1) {
            nextSeq = parsed + 1;
          }
        }
      }

      for (const mat of itemsWithOpening) {
        const qty = itemByCode.get(mat.code)?.qty ?? 0;
        if (qty <= 0) continue;

        let batchId: string | null = null;
        if (stage1) {
          batchId = `${prefix}${String(nextSeq).padStart(4, '0')}`;
          nextSeq += 1;

          await tx.insert(batches).values({
            id: batchId,
            materialId: mat.id,
            currentStageId: stage1.id,
            quantity: qty,
            unit: mat.unit,
            note: 'Opening Stock (Bulk Import)',
            createdAt: now,
            createdBy: params.userId,
          });

          await tx.insert(batchStageHistory).values({
            batchId,
            stageId: stage1.id,
            movedAt: now,
            movedBy: params.userId,
            note: 'Opening Stock imported via bulk CSV/Excel upload',
          });
        }

        await tx.insert(stockMovements).values({
          materialId: mat.id,
          type: 'receipt',
          quantity: qty,
          unit: mat.unit,
          batchId,
          isOpening: true,
          reason: 'Opening Stock',
          movementDate: now,
          createdAt: now,
          userId: params.userId,
          note: 'Bulk import opening stock',
        });

        openingCount += 1;
      }
    }

    await tx.insert(auditLog).values({
      userId: params.userId,
      action: 'BULK_IMPORT_MATERIALS',
      entity: 'material',
      entityId: `${inserted.length} items`,
      details: JSON.stringify({
        insertedCount: inserted.length,
        openingStockCount: openingCount,
        skippedCount: params.skippedCodes.length,
        codes: inserted.map((m) => m.code),
      }),
    });

    return { inserted, openingCount };
  });
}

export async function bulkImportPartsWithOpeningStock(params: {
  items: {
    code: string;
    name: string;
    unit: string;
    reorderLevel: number;
    qty: number;
  }[];
  skippedCodes: string[];
  userId: number;
}) {
  const result = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(parts)
      .values(
        params.items.map((item) => ({
          code: item.code,
          name: item.name,
          unit: item.unit,
          reorderLevel: item.reorderLevel,
          active: true,
        }))
      )
      .returning();

    const itemByCode = new Map(params.items.map((it) => [it.code, it]));
    const now = new Date();
    let openingCount = 0;

    const movementValues = inserted
      .map((part) => {
        const qty = itemByCode.get(part.code)?.qty ?? 0;
        if (qty <= 0) return null;
        openingCount += 1;
        return {
          partId: part.id,
          type: 'receipt',
          quantity: qty,
          batchId: null,
          isOpening: true,
          reason: 'Opening Stock',
          movementDate: now,
          createdAt: now,
          userId: params.userId,
          note: 'Bulk import opening stock',
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    if (movementValues.length > 0) {
      await tx.insert(partStockMovements).values(movementValues);
    }

    const queuedEmails: {
      partId: number;
      recipients: string[];
      subject: string;
      body: string;
    }[] = [];
    let reorderAlertCount = 0;

    for (const part of inserted) {
      const qty = itemByCode.get(part.code)?.qty ?? 0;
      if (part.reorderLevel > 0 && qty <= part.reorderLevel) {
        const alertOutcome = await evaluatePartReorderAlert(
          tx,
          part.id,
          params.userId
        );
        if (alertOutcome.alertTriggered) {
          reorderAlertCount += 1;
          if (alertOutcome.emailQueuedForDispatch) {
            queuedEmails.push({
              partId: part.id,
              ...alertOutcome.emailQueuedForDispatch,
            });
          }
        }
      }
    }

    await tx.insert(auditLog).values({
      userId: params.userId,
      action: 'BULK_IMPORT_PARTS',
      entity: 'part',
      entityId: `${inserted.length} items`,
      details: JSON.stringify({
        insertedCount: inserted.length,
        openingStockCount: openingCount,
        reorderAlertCount,
        skippedCount: params.skippedCodes.length,
        codes: inserted.map((p) => p.code),
      }),
    });

    return { inserted, openingCount, reorderAlertCount, queuedEmails };
  });

  for (const email of result.queuedEmails) {
    const emailResult = await sendAlertEmail(
      email.recipients,
      email.subject,
      email.body
    );
    if (emailResult.sent) {
      await db
        .update(notifications)
        .set({ emailSent: true })
        .where(
          and(
            eq(notifications.entityType, 'part'),
            eq(notifications.entityId, String(email.partId)),
            eq(notifications.type, 'reorder_alert')
          )
        );
    }
  }

  return {
    inserted: result.inserted,
    openingCount: result.openingCount,
    reorderAlertCount: result.reorderAlertCount,
  };
}

export interface BulkStockUpdateInputRow {
  rowNumber?: number;
  itemCode: string;
  productName?: string;
  quantity: number;
  unit?: string;
}

export interface BulkStockUpdateResult {
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

export async function bulkUpdateStockFromUpload(params: {
  rows: BulkStockUpdateInputRow[];
  movementType: 'receipt' | 'adjustment';
  movementDate: Date;
  userId: number;
}): Promise<BulkStockUpdateResult> {
  if (!Array.isArray(params.rows) || params.rows.length === 0) {
    throw new DomainError('No rows provided for bulk stock update.');
  }

  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const batchPrefix = `BATCH-${y}${m}${d}-`;

  const txOutcome = await db.transaction(async (tx) => {
    const [activeMaterials, activeParts, activeStages] = await Promise.all([
      tx.select().from(materials).where(eq(materials.active, true)),
      tx.select().from(parts).where(eq(parts.active, true)),
      tx
        .select()
        .from(stages)
        .where(eq(stages.active, true))
        .orderBy(asc(stages.sequence), asc(stages.id)),
    ]);

    const materialByCode = new Map(
      activeMaterials.map((mat) => [mat.code.trim().toUpperCase(), mat])
    );
    const partByCode = new Map(
      activeParts.map((part) => [part.code.trim().toUpperCase(), part])
    );
    const stage1 = activeStages[0] ?? null;

    let nextBatchSeq = 1;
    if (params.movementType === 'receipt' && stage1) {
      const existingBatch = await tx
        .select({ id: batches.id })
        .from(batches)
        .where(sql`${batches.id} LIKE ${batchPrefix + '%'}`)
        .orderBy(desc(batches.id))
        .limit(1);
      if (existingBatch.length > 0) {
        const parsedSeq = Number.parseInt(
          existingBatch[0].id.slice(batchPrefix.length),
          10
        );
        if (Number.isFinite(parsedSeq) && parsedSeq >= 1) {
          nextBatchSeq = parsedSeq + 1;
        }
      }
    }

    const updatedItems: BulkStockUpdateResult['updatedItems'] = [];
    const skippedRows: BulkStockUpdateResult['skippedRows'] = [];
    const queuedEmails: {
      entityType: 'material' | 'part';
      entityId: number;
      recipients: string[];
      subject: string;
      body: string;
    }[] = [];
    let materialUpdatedCount = 0;
    let partUpdatedCount = 0;
    let reorderAlertCount = 0;

    for (let i = 0; i < params.rows.length; i += 1) {
      const rawRow = params.rows[i];
      const rowNumber = rawRow.rowNumber ?? i + 1;
      const normalizedCode = String(rawRow.itemCode ?? '').trim().toUpperCase();
      const qty = Number(rawRow.quantity);

      if (!normalizedCode) {
        skippedRows.push({
          rowNumber,
          itemCode: '(blank)',
          reason: 'Missing Item Code.',
        });
        continue;
      }

      if (!Number.isFinite(qty)) {
        skippedRows.push({
          rowNumber,
          itemCode: normalizedCode,
          reason: 'Invalid quantity value.',
        });
        continue;
      }

      if (params.movementType === 'receipt' && qty <= 0) {
        skippedRows.push({
          rowNumber,
          itemCode: normalizedCode,
          reason: 'Receipt quantity must be greater than zero.',
        });
        continue;
      }

      if (params.movementType === 'adjustment' && qty === 0) {
        skippedRows.push({
          rowNumber,
          itemCode: normalizedCode,
          reason: 'Adjustment quantity cannot be zero.',
        });
        continue;
      }

      const rawUnit = rawRow.unit !== undefined && rawRow.unit !== null ? String(rawRow.unit).trim() : '';
      const normalizedUnit = rawUnit ? normalizeReceiveUnit(rawUnit) : undefined;
      if (rawUnit && !normalizedUnit) {
        skippedRows.push({
          rowNumber,
          itemCode: normalizedCode,
          reason: `Unsupported unit "${rawUnit}".`,
        });
        continue;
      }

      const matchedMaterial = materialByCode.get(normalizedCode);
      const matchedPart = !matchedMaterial ? partByCode.get(normalizedCode) : undefined;

      if (!matchedMaterial && !matchedPart) {
        skippedRows.push({
          rowNumber,
          itemCode: normalizedCode,
          reason: 'Item Code does not exist in active Materials or Parts Master.',
        });
        continue;
      }

      if (matchedMaterial) {
        const summary = await getMaterialStockSummary(tx, matchedMaterial.id);
        const effectiveUnit = normalizedUnit ?? matchedMaterial.unit;

        if (params.movementType === 'adjustment') {
          const projected = Number((summary.currentStock + qty).toFixed(4));
          if (projected < 0) {
            skippedRows.push({
              rowNumber,
              itemCode: matchedMaterial.code,
              reason: `Skipped: adjustment (${qty}) would make stock negative (${projected} ${matchedMaterial.unit}).`,
            });
            continue;
          }
        }

        const isOpening =
          params.movementType === 'receipt' && summary.movementCount === 0;
        let createdBatchId: string | null = null;

        if (params.movementType === 'receipt' && stage1) {
          createdBatchId = `${batchPrefix}${String(nextBatchSeq).padStart(4, '0')}`;
          nextBatchSeq += 1;

          await tx.insert(batches).values({
            id: createdBatchId,
            materialId: matchedMaterial.id,
            currentStageId: stage1.id,
            quantity: qty,
            unit: effectiveUnit,
            note: 'Bulk Stock Update Upload',
            createdAt: now,
            createdBy: params.userId,
          });

          await tx.insert(batchStageHistory).values({
            batchId: createdBatchId,
            stageId: stage1.id,
            qtyIn: null,
            qtyRejected: 0,
            qtyOut: null,
            rejectionReason: null,
            movedAt: now,
            movedBy: params.userId,
            note: 'Bulk Stock Update Upload',
          });
        }

        await tx.insert(stockMovements).values({
          materialId: matchedMaterial.id,
          type: params.movementType,
          quantity: qty,
          unit: effectiveUnit,
          batchId: createdBatchId,
          isOpening,
          reason:
            params.movementType === 'receipt'
              ? isOpening
                ? 'Opening Stock'
                : 'Stock Receipt'
              : 'Bulk Stock Update',
          movementDate: params.movementDate,
          createdAt: now,
          userId: params.userId,
          note: 'Bulk Stock Update Upload',
        });

        const alertOutcome = await evaluateReorderAlert(
          tx,
          matchedMaterial.id,
          params.userId
        );
        if (alertOutcome.alertTriggered) {
          reorderAlertCount += 1;
          if (alertOutcome.emailQueuedForDispatch) {
            queuedEmails.push({
              entityType: 'material',
              entityId: matchedMaterial.id,
              ...alertOutcome.emailQueuedForDispatch,
            });
          }
        }

        materialUpdatedCount += 1;
        updatedItems.push({
          itemCode: matchedMaterial.code,
          productName: matchedMaterial.name,
          entityType: 'material',
          quantity: qty,
          unit: effectiveUnit,
          newStock: alertOutcome.currentStock,
          batchId: createdBatchId,
        });
      } else if (matchedPart) {
        const summary = await getPartStockSummary(tx, matchedPart.id);
        const effectiveUnit = normalizedUnit ?? matchedPart.unit;

        if (params.movementType === 'adjustment') {
          const projected = Number((summary.currentStock + qty).toFixed(4));
          if (projected < 0) {
            skippedRows.push({
              rowNumber,
              itemCode: matchedPart.code,
              reason: `Skipped: adjustment (${qty}) would make stock negative (${projected} ${matchedPart.unit}).`,
            });
            continue;
          }
        }

        const isOpening =
          params.movementType === 'receipt' && summary.movementCount === 0;

        await tx.insert(partStockMovements).values({
          partId: matchedPart.id,
          type: params.movementType,
          quantity: qty,
          batchId: null,
          isOpening,
          reason:
            params.movementType === 'receipt'
              ? isOpening
                ? 'Opening Stock'
                : 'Stock Receipt'
              : 'Bulk Stock Update',
          movementDate: params.movementDate,
          createdAt: now,
          userId: params.userId,
          note: 'Bulk Stock Update Upload',
        });

        const alertOutcome = await evaluatePartReorderAlert(
          tx,
          matchedPart.id,
          params.userId
        );
        if (alertOutcome.alertTriggered) {
          reorderAlertCount += 1;
          if (alertOutcome.emailQueuedForDispatch) {
            queuedEmails.push({
              entityType: 'part',
              entityId: matchedPart.id,
              ...alertOutcome.emailQueuedForDispatch,
            });
          }
        }

        partUpdatedCount += 1;
        updatedItems.push({
          itemCode: matchedPart.code,
          productName: matchedPart.name,
          entityType: 'part',
          quantity: qty,
          unit: effectiveUnit,
          newStock: alertOutcome.currentStock,
          batchId: null,
        });
      }
    }

    await tx.insert(auditLog).values({
      userId: params.userId,
      action: 'BULK_STOCK_UPDATE',
      entity: 'stock_movement',
      entityId: `${updatedItems.length} updated`,
      details: JSON.stringify({
        movementType: params.movementType,
        updatedCount: updatedItems.length,
        materialUpdatedCount,
        partUpdatedCount,
        skippedCount: skippedRows.length,
        skippedCodes: skippedRows.map((s) => s.itemCode),
        note: 'Bulk Stock Update Upload',
      }),
      timestamp: now,
    });

    return {
      movementType: params.movementType,
      updatedCount: updatedItems.length,
      materialUpdatedCount,
      partUpdatedCount,
      updatedItems,
      skippedRows,
      reorderAlertCount,
      queuedEmails,
    };
  });

  for (const email of txOutcome.queuedEmails) {
    const emailResult = await sendAlertEmail(
      email.recipients,
      email.subject,
      email.body
    );
    if (emailResult.sent) {
      await db
        .update(notifications)
        .set({ emailSent: true })
        .where(
          and(
            eq(notifications.entityType, email.entityType),
            eq(notifications.entityId, String(email.entityId)),
            eq(notifications.type, 'reorder_alert')
          )
        );
    }
  }

  return {
    movementType: txOutcome.movementType,
    updatedCount: txOutcome.updatedCount,
    materialUpdatedCount: txOutcome.materialUpdatedCount,
    partUpdatedCount: txOutcome.partUpdatedCount,
    updatedItems: txOutcome.updatedItems,
    skippedRows: txOutcome.skippedRows,
    reorderAlertCount: txOutcome.reorderAlertCount,
  };
}


