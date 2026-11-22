import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  auditLog,
  batches,
  batchStageHistory,
  emailRecipients,
  materials,
  notifications,
  stages,
  stockMovements,
  users,
} from '../db/schema.ts';
import { sendAlertEmail } from './mailer.ts';

export class DomainError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'execute'>;

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
          subject: `[ForgeFlow] Reorder Level Reached: ${material.code} — ${material.name}`,
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
  movementDate: Date;
  sendToLaserCutting: boolean;
  note?: string;
  userId: number;
}) {
  if (!Number.isFinite(params.quantity) || params.quantity <= 0) {
    throw new DomainError('Quantity must be a positive number.');
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

      const [createdBatch] = await tx
        .insert(batches)
        .values({
          id: batchId,
          materialId: material.id,
          currentStageId: targetStage.id,
          quantity: params.quantity,
          note: params.note?.trim() || null,
          createdAt: now,
          createdBy: params.userId,
        })
        .returning();

      // Stage 01 history row
      await tx.insert(batchStageHistory).values({
        batchId,
        stageId: stage1.id,
        movedAt: now,
        movedBy: params.userId,
        note: params.note?.trim() || 'Received into raw material store',
      });

      // If immediate dispatch checked -> second history row with exact same timestamp & user ID
      if (params.sendToLaserCutting && stage2) {
        await tx.insert(batchStageHistory).values({
          batchId,
          stageId: stage2.id,
          movedAt: now,
          movedBy: params.userId,
          note: `Immediate dispatch to ${stage2.name} on receipt`,
        });
      }

      // Ledger receipt row
      const [receiptMovement] = await tx
        .insert(stockMovements)
        .values({
          materialId: material.id,
          type: 'receipt',
          quantity: params.quantity,
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
          batchId,
          isOpening: false,
          reason: `Dispatched to ${stage2.name}`,
          movementDate: params.movementDate,
          createdAt: now,
          userId: params.userId,
          note: `Immediate dispatch from ${stage1.name} to ${stage2.name}`,
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
              message: `${batchId} (${params.quantity} ${material.unit} of ${material.name}) received and sent directly to ${stage2.name}.`,
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
          isOpening,
          sentToNextStage: params.sendToLaserCutting,
          stage: targetStage.name,
        }),
        timestamp: now,
      });

      const reorderOutcome = await evaluateReorderAlert(tx, material.id, params.userId);

      return {
        batch: createdBatch,
        material,
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

      const now = new Date();

      const [updatedBatch] = await tx
        .update(batches)
        .set({ currentStageId: nextStage.id })
        .where(eq(batches.id, batch.id))
        .returning();

      await tx.insert(batchStageHistory).values({
        batchId: batch.id,
        stageId: nextStage.id,
        movedAt: now,
        movedBy: params.userId,
        note: params.note?.trim() || `Advanced from ${currentStage.name} to ${nextStage.name}`,
      });

      // If transitioning out of the first active stage (Raw Material), issue quantity from raw stock
      let reorderOutcome: Awaited<ReturnType<typeof evaluateReorderAlert>> | null = null;
      const firstActiveStage = activeStages[0];
      if (firstActiveStage && currentStage.id === firstActiveStage.id) {
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
            quantity: batch.quantity,
            batchId: batch.id,
            isOpening: false,
            reason: `Issued to ${nextStage.name}`,
            movementDate: now,
            createdAt: now,
            userId: params.userId,
            note: `Batch advanced from ${currentStage.name} to ${nextStage.name}`,
          });

          reorderOutcome = await evaluateReorderAlert(tx, batch.materialId, params.userId);
        }
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

      if (targetUsers.length > 0) {
        await tx.insert(notifications).values(
          targetUsers.map((u) => ({
            userId: u.id,
            type: 'stage_advanced',
            title: `Stage Completed: ${batch.id} → ${nextStage.name}`,
            message: `Batch ${batch.id} (${batch.quantity} ${material?.unit ?? ''} ${material?.name ?? ''}) moved from ${currentStage.name} to ${nextStage.name}.`,
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
        fromStage: currentStage,
        toStage: nextStage,
        material,
        emailQueuedForDispatch: reorderOutcome?.emailQueuedForDispatch,
        reorderAlertTriggered: reorderOutcome?.alertTriggered ?? false,
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
