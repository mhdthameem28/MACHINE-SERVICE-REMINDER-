import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from './src/db/index.ts';
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
} from './src/db/schema.ts';
import { ALL_ROLES, type UserRole } from './src/lib/roles.ts';
import { hashPassword, signSessionToken, verifyPassword } from './src/lib/security.ts';
import { type AuthRequest, requireAuth, requireRole } from './src/middleware/auth.ts';
import {
  adjustStock,
  advanceBatch,
  DomainError,
  getAllMaterialsWithStock,
  receiveStock,
} from './src/services/production.ts';
import {
  type ReportFilters,
  type ReportType,
  runReport,
  serializeReportToCsv,
  serializeReportToXlsx,
} from './src/services/reports.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

// Block unknown/non-standard HTTP error leakage
function handleRouteError(res: Response, err: unknown, fallbackMessage: string) {
  if (err instanceof DomainError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(fallbackMessage, err);
  return res.status(500).json({ error: fallbackMessage });
}

// ============================================================================
// AUTH ROUTES
// ============================================================================

app.get('/api/auth/setup-status', async (_req: Request, res: Response) => {
  try {
    const adminsWithPassword = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.active, true), sql`${users.passwordHash} IS NOT NULL`))
      .limit(1);

    const existingAdmins = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.active, true)))
      .orderBy(asc(users.id))
      .limit(1);

    res.json({
      needsInitialPassword: adminsWithPassword.length === 0,
      defaultAdminEmail: existingAdmins[0]?.email ?? null,
    });
  } catch (err) {
    handleRouteError(res, err, 'Failed to check setup status');
  }
});

app.post('/api/auth/setup-admin', async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const name = String(req.body?.name ?? '').trim() || 'System Administrator';
    const password = String(req.body?.password ?? '');

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid admin email is required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const existingWithPassword = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), sql`${users.passwordHash} IS NOT NULL`))
      .limit(1);

    if (existingWithPassword.length > 0) {
      return res.status(403).json({
        error: 'Initial admin password has already been configured. Please sign in normally.',
      });
    }

    const passwordHash = hashPassword(password);
    const existingByEmail = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);

    let adminUser;
    if (existingByEmail.length > 0) {
      const target = existingByEmail[0];
      if (target.role !== 'admin') {
        return res.status(403).json({ error: 'Specified email is not an admin account.' });
      }
      const [updated] = await db
        .update(users)
        .set({ passwordHash, name: target.name || name, active: true })
        .where(eq(users.id, target.id))
        .returning();
      adminUser = updated;
    } else {
      const [created] = await db
        .insert(users)
        .values({
          name,
          email,
          passwordHash,
          role: 'admin',
          active: true,
        })
        .returning();
      adminUser = created;
    }

    await db.insert(auditLog).values({
      userId: adminUser.id,
      action: 'SETUP_ADMIN_PASSWORD',
      entity: 'user',
      entityId: String(adminUser.id),
      details: JSON.stringify({ email: adminUser.email }),
    });

    const token = signSessionToken(adminUser.id, adminUser.email);
    res.json({
      token,
      user: {
        id: adminUser.id,
        uid: adminUser.uid,
        name: adminUser.name,
        email: adminUser.email,
        role: adminUser.role,
        active: adminUser.active,
      },
    });
  } catch (err) {
    handleRouteError(res, err, 'Failed to complete initial admin setup');
  }
});

app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const rows = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    const user = rows[0];

    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (!user.active) {
      return res.status(403).json({
        error: 'Your account has been deactivated. Contact an Administrator.',
      });
    }

    const token = signSessionToken(user.id, user.email);
    res.json({
      token,
      user: {
        id: user.id,
        uid: user.uid,
        name: user.name,
        email: user.email,
        role: user.role,
        active: user.active,
      },
    });
  } catch (err) {
    handleRouteError(res, err, 'Authentication failed');
  }
});

app.get('/api/auth/me', requireAuth, (req: AuthRequest, res: Response) => {
  res.json({ user: req.authUser });
});

// ============================================================================
// DASHBOARD & REFERENCE ROUTES
// ============================================================================

app.get('/api/dashboard', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const materialList = await getAllMaterialsWithStock(false);
    const activeStages = await db
      .select()
      .from(stages)
      .where(eq(stages.active, true))
      .orderBy(asc(stages.sequence), asc(stages.id));

    const recentBatches = await db
      .select({
        id: batches.id,
        quantity: batches.quantity,
        createdAt: batches.createdAt,
        materialCode: materials.code,
        materialName: materials.name,
        materialUnit: materials.unit,
        stageName: stages.name,
        stageSequence: stages.sequence,
        createdByName: users.name,
      })
      .from(batches)
      .innerJoin(materials, eq(batches.materialId, materials.id))
      .innerJoin(stages, eq(batches.currentStageId, stages.id))
      .innerJoin(users, eq(batches.createdBy, users.id))
      .orderBy(desc(batches.createdAt))
      .limit(10);

    const stageDistribution = await db
      .select({
        stageId: stages.id,
        stageName: stages.name,
        sequence: stages.sequence,
        batchCount: sql<number>`COUNT(${batches.id})::int`,
      })
      .from(stages)
      .leftJoin(batches, eq(batches.currentStageId, stages.id))
      .where(eq(stages.active, true))
      .groupBy(stages.id, stages.name, stages.sequence)
      .orderBy(asc(stages.sequence));

    const unreadRows = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, req.authUser!.id), eq(notifications.isRead, false)));

    res.json({
      materials: materialList,
      belowReorderMaterials: materialList.filter((m) => m.isBelowReorder),
      activeStages,
      stageDistribution,
      recentBatches,
      unreadNotifications: unreadRows[0]?.count ?? 0,
    });
  } catch (err) {
    handleRouteError(res, err, 'Failed to load dashboard data');
  }
});

app.get('/api/materials', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const includeInactive =
      req.query.includeInactive === 'true' && req.authUser?.role === 'admin';
    const list = await getAllMaterialsWithStock(includeInactive);

    const movementCounts = await db
      .select({
        materialId: stockMovements.materialId,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(stockMovements)
      .groupBy(stockMovements.materialId);
    const countMap = new Map(movementCounts.map((r) => [r.materialId, r.count]));

    res.json({
      materials: list.map((m) => ({
        ...m,
        hasMovements: (countMap.get(m.id) ?? 0) > 0,
      })),
    });
  } catch (err) {
    handleRouteError(res, err, 'Failed to load materials');
  }
});

app.get('/api/stages', requireAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const stageList = await db
      .select()
      .from(stages)
      .orderBy(asc(stages.sequence), asc(stages.id));
    res.json({ stages: stageList });
  } catch (err) {
    handleRouteError(res, err, 'Failed to load stages');
  }
});

app.get(
  '/api/users/directory',
  requireAuth,
  requireRole(['admin', 'store_keeper', 'viewer']),
  async (_req: AuthRequest, res: Response) => {
    try {
      const list = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          active: users.active,
        })
        .from(users)
        .orderBy(asc(users.name));
      res.json({ users: list });
    } catch (err) {
      handleRouteError(res, err, 'Failed to load user directory');
    }
  }
);

// ============================================================================
// CORE PRODUCTION WORKFLOW ROUTES
// ============================================================================

app.post(
  '/api/stock/receive',
  requireAuth,
  requireRole(['admin', 'store_keeper']),
  async (req: AuthRequest, res: Response) => {
    try {
      const materialId = Number(req.body?.materialId);
      const quantity = Number(req.body?.quantity);
      const dateStr = String(req.body?.movementDate ?? '');
      const sendToLaserCutting = Boolean(req.body?.sendToLaserCutting);
      const note = req.body?.note ? String(req.body.note) : undefined;

      if (!Number.isInteger(materialId) || materialId <= 0) {
        return res.status(400).json({ error: 'Please select a valid material.' });
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return res.status(400).json({ error: 'Quantity must be greater than zero.' });
      }
      const movementDate = dateStr ? new Date(dateStr) : new Date();
      if (Number.isNaN(movementDate.getTime())) {
        return res.status(400).json({ error: 'Invalid receipt date.' });
      }

      const outcome = await receiveStock({
        materialId,
        quantity,
        movementDate,
        sendToLaserCutting,
        note,
        userId: req.authUser!.id,
      });

      res.status(201).json(outcome);
    } catch (err) {
      handleRouteError(res, err, 'Failed to receive stock');
    }
  }
);

app.post(
  '/api/stock/adjust',
  requireAuth,
  requireRole(['admin', 'store_keeper']),
  async (req: AuthRequest, res: Response) => {
    try {
      const materialId = Number(req.body?.materialId);
      const quantity = Number(req.body?.quantity);
      const reason = String(req.body?.reason ?? '').trim();
      const dateStr = String(req.body?.movementDate ?? '');
      const note = req.body?.note ? String(req.body.note) : undefined;

      if (!Number.isInteger(materialId) || materialId <= 0) {
        return res.status(400).json({ error: 'Please select a valid material.' });
      }
      if (!Number.isFinite(quantity) || quantity === 0) {
        return res.status(400).json({ error: 'Adjustment quantity must be non-zero.' });
      }
      if (!reason) {
        return res.status(400).json({ error: 'Adjustment reason is required.' });
      }
      const movementDate = dateStr ? new Date(dateStr) : new Date();
      if (Number.isNaN(movementDate.getTime())) {
        return res.status(400).json({ error: 'Invalid adjustment date.' });
      }

      const outcome = await adjustStock({
        materialId,
        quantity,
        reason,
        movementDate,
        note,
        userId: req.authUser!.id,
      });

      res.status(201).json(outcome);
    } catch (err) {
      handleRouteError(res, err, 'Failed to adjust stock');
    }
  }
);

app.get('/api/batches', requireAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const batchRows = await db
      .select({
        id: batches.id,
        materialId: batches.materialId,
        materialCode: materials.code,
        materialName: materials.name,
        materialUnit: materials.unit,
        currentStageId: batches.currentStageId,
        stageName: stages.name,
        stageSequence: stages.sequence,
        quantity: batches.quantity,
        note: batches.note,
        createdAt: batches.createdAt,
        createdBy: batches.createdBy,
        createdByName: users.name,
        createdByEmail: users.email,
      })
      .from(batches)
      .innerJoin(materials, eq(batches.materialId, materials.id))
      .innerJoin(stages, eq(batches.currentStageId, stages.id))
      .innerJoin(users, eq(batches.createdBy, users.id))
      .orderBy(desc(batches.createdAt));

    const activeStages = await db
      .select()
      .from(stages)
      .where(eq(stages.active, true))
      .orderBy(asc(stages.sequence), asc(stages.id));

    res.json({ batches: batchRows, activeStages });
  } catch (err) {
    handleRouteError(res, err, 'Failed to load batches');
  }
});

app.get('/api/batches/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const batchId = String(req.params.id);
    const batchRows = await db
      .select({
        id: batches.id,
        materialId: batches.materialId,
        materialCode: materials.code,
        materialName: materials.name,
        materialUnit: materials.unit,
        currentStageId: batches.currentStageId,
        stageName: stages.name,
        stageSequence: stages.sequence,
        quantity: batches.quantity,
        note: batches.note,
        createdAt: batches.createdAt,
        createdBy: batches.createdBy,
        createdByName: users.name,
        createdByEmail: users.email,
      })
      .from(batches)
      .innerJoin(materials, eq(batches.materialId, materials.id))
      .innerJoin(stages, eq(batches.currentStageId, stages.id))
      .innerJoin(users, eq(batches.createdBy, users.id))
      .where(eq(batches.id, batchId))
      .limit(1);

    const batch = batchRows[0];
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found.' });
    }

    const history = await db
      .select({
        id: batchStageHistory.id,
        batchId: batchStageHistory.batchId,
        stageId: batchStageHistory.stageId,
        stageName: stages.name,
        stageSequence: stages.sequence,
        movedAt: batchStageHistory.movedAt,
        movedBy: batchStageHistory.movedBy,
        movedByName: users.name,
        movedByEmail: users.email,
        note: batchStageHistory.note,
      })
      .from(batchStageHistory)
      .innerJoin(stages, eq(batchStageHistory.stageId, stages.id))
      .innerJoin(users, eq(batchStageHistory.movedBy, users.id))
      .where(eq(batchStageHistory.batchId, batchId))
      .orderBy(asc(batchStageHistory.movedAt), asc(batchStageHistory.id));

    const activeStages = await db
      .select()
      .from(stages)
      .where(eq(stages.active, true))
      .orderBy(asc(stages.sequence), asc(stages.id));

    const nextStage =
      activeStages.find((s) => s.sequence > batch.stageSequence) ?? null;

    res.json({
      batch,
      history,
      activeStages,
      nextStage,
    });
  } catch (err) {
    handleRouteError(res, err, 'Failed to load batch details');
  }
});

app.post(
  '/api/batches/:id/advance',
  requireAuth,
  requireRole(['admin', 'operator']),
  async (req: AuthRequest, res: Response) => {
    try {
      const batchId = String(req.params.id);
      const note = req.body?.note ? String(req.body.note) : undefined;
      const outcome = await advanceBatch({
        batchId,
        note,
        userId: req.authUser!.id,
      });
      res.json(outcome);
    } catch (err) {
      handleRouteError(res, err, 'Failed to advance batch stage');
    }
  }
);

// ============================================================================
// REPORTS & EXPORT ROUTES (shared query for UI + CSV + XLSX)
// ============================================================================

const VALID_REPORTS: ReportType[] = [
  'current-stock',
  'reorder-level',
  'opening-stock',
  'stock-adjusted',
  'sent-to-cutting',
  'batch-movement',
];

function parseReportFilters(req: Request): ReportFilters {
  const materialIdRaw = req.query.materialId ? Number(req.query.materialId) : undefined;
  const userIdRaw = req.query.userId ? Number(req.query.userId) : undefined;
  return {
    startDate: req.query.startDate ? String(req.query.startDate) : undefined,
    endDate: req.query.endDate ? String(req.query.endDate) : undefined,
    materialId: materialIdRaw && Number.isInteger(materialIdRaw) ? materialIdRaw : undefined,
    userId: userIdRaw && Number.isInteger(userIdRaw) ? userIdRaw : undefined,
  };
}

app.get(
  '/api/reports/:type',
  requireAuth,
  requireRole(['admin', 'store_keeper', 'viewer']),
  async (req: AuthRequest, res: Response) => {
    try {
      const type = String(req.params.type) as ReportType;
      if (!VALID_REPORTS.includes(type)) {
        return res.status(400).json({ error: 'Unknown report type.' });
      }
      const report = await runReport(type, parseReportFilters(req));
      res.json(report);
    } catch (err) {
      handleRouteError(res, err, 'Failed to run report');
    }
  }
);

app.get(
  '/api/reports/:type/export',
  requireAuth,
  requireRole(['admin', 'store_keeper', 'viewer']),
  async (req: AuthRequest, res: Response) => {
    try {
      const type = String(req.params.type) as ReportType;
      const format = String(req.query.format ?? 'csv').toLowerCase();
      if (!VALID_REPORTS.includes(type)) {
        return res.status(400).json({ error: 'Unknown report type.' });
      }
      if (format !== 'csv' && format !== 'xlsx') {
        return res.status(400).json({ error: 'Format must be csv or xlsx.' });
      }

      const report = await runReport(type, parseReportFilters(req));
      const dateStamp = new Date().toISOString().slice(0, 10);

      if (format === 'csv') {
        const csv = serializeReportToCsv(report);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${type}-${dateStamp}.csv"`
        );
        return res.send(csv);
      }

      const buffer = serializeReportToXlsx(report);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${type}-${dateStamp}.xlsx"`
      );
      return res.send(buffer);
    } catch (err) {
      handleRouteError(res, err, 'Failed to export report');
    }
  }
);

// ============================================================================
// NOTIFICATIONS ROUTES
// ============================================================================

app.get('/api/notifications', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const items = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, req.authUser!.id))
      .orderBy(desc(notifications.createdAt))
      .limit(100);

    const unreadCount = items.filter((n) => !n.isRead).length;
    res.json({ notifications: items, unreadCount });
  } catch (err) {
    handleRouteError(res, err, 'Failed to load notifications');
  }
});

app.post(
  '/api/notifications/:id/read',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid notification ID.' });
      }
      await db
        .update(notifications)
        .set({ isRead: true })
        .where(
          and(eq(notifications.id, id), eq(notifications.userId, req.authUser!.id))
        );
      res.json({ ok: true });
    } catch (err) {
      handleRouteError(res, err, 'Failed to mark notification as read');
    }
  }
);

app.post(
  '/api/notifications/read-all',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      await db
        .update(notifications)
        .set({ isRead: true })
        .where(eq(notifications.userId, req.authUser!.id));
      res.json({ ok: true });
    } catch (err) {
      handleRouteError(res, err, 'Failed to mark notifications as read');
    }
  }
);

// ============================================================================
// SETTINGS ROUTES (ADMIN ONLY)
// ============================================================================

app.post(
  '/api/settings/stages',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const name = String(req.body?.name ?? '').trim();
      const requestedSeq = req.body?.sequence ? Number(req.body.sequence) : null;
      if (!name) {
        return res.status(400).json({ error: 'Stage name is required.' });
      }

      const maxSeqRows = await db
        .select({ maxSeq: sql<number>`COALESCE(MAX(${stages.sequence}), 0)::int` })
        .from(stages);
      const sequence =
        requestedSeq && Number.isInteger(requestedSeq) && requestedSeq > 0
          ? requestedSeq
          : (maxSeqRows[0]?.maxSeq ?? 0) + 1;

      const [created] = await db
        .insert(stages)
        .values({ name, sequence, active: true })
        .returning();

      await db.insert(auditLog).values({
        userId: req.authUser!.id,
        action: 'CREATE_STAGE',
        entity: 'stage',
        entityId: String(created.id),
        details: JSON.stringify({ name: created.name, sequence: created.sequence }),
      });

      res.status(201).json({ stage: created });
    } catch (err) {
      handleRouteError(res, err, 'Failed to create stage');
    }
  }
);

app.patch(
  '/api/settings/stages/:id',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid stage ID.' });
      }
      const updates: Partial<{ name: string; sequence: number; active: boolean }> = {};
      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) return res.status(400).json({ error: 'Stage name cannot be empty.' });
        updates.name = name;
      }
      if (req.body?.sequence !== undefined) {
        const seq = Number(req.body.sequence);
        if (!Number.isInteger(seq) || seq <= 0) {
          return res.status(400).json({ error: 'Sequence must be a positive integer.' });
        }
        updates.sequence = seq;
      }
      if (req.body?.active !== undefined) {
        updates.active = Boolean(req.body.active);
      }

      const [updated] = await db
        .update(stages)
        .set(updates)
        .where(eq(stages.id, id))
        .returning();
      if (!updated) {
        return res.status(404).json({ error: 'Stage not found.' });
      }

      await db.insert(auditLog).values({
        userId: req.authUser!.id,
        action: 'UPDATE_STAGE',
        entity: 'stage',
        entityId: String(updated.id),
        details: JSON.stringify(updates),
      });

      res.json({ stage: updated });
    } catch (err) {
      handleRouteError(res, err, 'Failed to update stage');
    }
  }
);

app.post(
  '/api/settings/stages/reorder',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const orderedIds = Array.isArray(req.body?.orderedIds)
        ? req.body.orderedIds.map((id: unknown) => Number(id))
        : [];
      if (orderedIds.length === 0 || orderedIds.some((n: number) => !Number.isInteger(n))) {
        return res.status(400).json({ error: 'Valid orderedIds array is required.' });
      }

      await db.transaction(async (tx) => {
        for (let i = 0; i < orderedIds.length; i++) {
          await tx
            .update(stages)
            .set({ sequence: i + 1 })
            .where(eq(stages.id, orderedIds[i]));
        }
        await tx.insert(auditLog).values({
          userId: req.authUser!.id,
          action: 'REORDER_STAGES',
          entity: 'stage',
          entityId: orderedIds.join(','),
          details: JSON.stringify({ orderedIds }),
        });
      });

      const updatedStages = await db
        .select()
        .from(stages)
        .orderBy(asc(stages.sequence), asc(stages.id));
      res.json({ stages: updatedStages });
    } catch (err) {
      handleRouteError(res, err, 'Failed to reorder stages');
    }
  }
);

app.post(
  '/api/settings/materials',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const code = String(req.body?.code ?? '').trim().toUpperCase();
      const name = String(req.body?.name ?? '').trim();
      const unit = String(req.body?.unit ?? '').trim();
      const reorderLevel = Number(req.body?.reorderLevel ?? 0);

      if (!code || !name || !unit) {
        return res.status(400).json({ error: 'Code, name, and unit are required.' });
      }
      if (!Number.isFinite(reorderLevel) || reorderLevel < 0) {
        return res.status(400).json({ error: 'Reorder level must be zero or greater.' });
      }

      const [created] = await db
        .insert(materials)
        .values({ code, name, unit, reorderLevel, active: true })
        .returning();

      await db.insert(auditLog).values({
        userId: req.authUser!.id,
        action: 'CREATE_MATERIAL',
        entity: 'material',
        entityId: String(created.id),
        details: JSON.stringify({ code, name, unit, reorderLevel }),
      });

      res.status(201).json({ material: created });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        return res.status(409).json({ error: 'Material code already exists.' });
      }
      handleRouteError(res, err, 'Failed to create material');
    }
  }
);

app.patch(
  '/api/settings/materials/:id',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid material ID.' });
      }

      const updates: Partial<{
        code: string;
        name: string;
        unit: string;
        reorderLevel: number;
        active: boolean;
      }> = {};

      if (req.body?.code !== undefined) {
        const code = String(req.body.code).trim().toUpperCase();
        if (!code) return res.status(400).json({ error: 'Code cannot be empty.' });
        updates.code = code;
      }
      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
        updates.name = name;
      }
      if (req.body?.unit !== undefined) {
        const unit = String(req.body.unit).trim();
        if (!unit) return res.status(400).json({ error: 'Unit cannot be empty.' });
        updates.unit = unit;
      }
      if (req.body?.reorderLevel !== undefined) {
        const lvl = Number(req.body.reorderLevel);
        if (!Number.isFinite(lvl) || lvl < 0) {
          return res.status(400).json({ error: 'Reorder level must be >= 0.' });
        }
        updates.reorderLevel = lvl;
      }
      if (req.body?.active !== undefined) {
        updates.active = Boolean(req.body.active);
      }

      const [updated] = await db
        .update(materials)
        .set(updates)
        .where(eq(materials.id, id))
        .returning();
      if (!updated) {
        return res.status(404).json({ error: 'Material not found.' });
      }

      await db.insert(auditLog).values({
        userId: req.authUser!.id,
        action: 'UPDATE_MATERIAL',
        entity: 'material',
        entityId: String(updated.id),
        details: JSON.stringify(updates),
      });

      res.json({ material: updated });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        return res.status(409).json({ error: 'Material code already exists.' });
      }
      handleRouteError(res, err, 'Failed to update material');
    }
  }
);

app.get(
  '/api/settings/users',
  requireAuth,
  requireRole(['admin']),
  async (_req: AuthRequest, res: Response) => {
    try {
      const list = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          active: users.active,
          hasPassword: sql<boolean>`(${users.passwordHash} IS NOT NULL)`,
          createdAt: users.createdAt,
        })
        .from(users)
        .orderBy(asc(users.id));
      res.json({ users: list });
    } catch (err) {
      handleRouteError(res, err, 'Failed to load users');
    }
  }
);

app.post(
  '/api/settings/users',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const name = String(req.body?.name ?? '').trim();
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const role = String(req.body?.role ?? 'viewer') as UserRole;
      const password = req.body?.password ? String(req.body.password) : '';

      if (!name || !email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid name and email are required.' });
      }
      if (!ALL_ROLES.includes(role)) {
        return res.status(400).json({ error: 'Invalid user role.' });
      }
      if (password && password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      }

      const [created] = await db
        .insert(users)
        .values({
          name,
          email,
          role,
          passwordHash: password ? hashPassword(password) : null,
          active: true,
        })
        .returning({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          active: users.active,
          createdAt: users.createdAt,
        });

      await db.insert(auditLog).values({
        userId: req.authUser!.id,
        action: 'CREATE_USER',
        entity: 'user',
        entityId: String(created.id),
        details: JSON.stringify({ email: created.email, role: created.role }),
      });

      res.status(201).json({ user: created });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        return res.status(409).json({ error: 'A user with this email already exists.' });
      }
      handleRouteError(res, err, 'Failed to create user');
    }
  }
);

app.patch(
  '/api/settings/users/:id',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid user ID.' });
      }

      if (id === req.authUser!.id && req.body?.active === false) {
        return res.status(400).json({ error: 'You cannot deactivate your own account.' });
      }
      if (id === req.authUser!.id && req.body?.role && req.body.role !== 'admin') {
        return res.status(400).json({ error: 'You cannot downgrade your own admin role.' });
      }

      const updates: Partial<{
        name: string;
        role: string;
        active: boolean;
        passwordHash: string;
      }> = {};

      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
        updates.name = name;
      }
      if (req.body?.role !== undefined) {
        const role = String(req.body.role) as UserRole;
        if (!ALL_ROLES.includes(role)) {
          return res.status(400).json({ error: 'Invalid role.' });
        }
        updates.role = role;
      }
      if (req.body?.active !== undefined) {
        updates.active = Boolean(req.body.active);
      }
      if (req.body?.password && String(req.body.password).length > 0) {
        const pw = String(req.body.password);
        if (pw.length < 8) {
          return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }
        updates.passwordHash = hashPassword(pw);
      }

      const [updated] = await db
        .update(users)
        .set(updates)
        .where(eq(users.id, id))
        .returning({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          active: users.active,
          createdAt: users.createdAt,
        });

      if (!updated) {
        return res.status(404).json({ error: 'User not found.' });
      }

      await db.insert(auditLog).values({
        userId: req.authUser!.id,
        action: 'UPDATE_USER',
        entity: 'user',
        entityId: String(updated.id),
        details: JSON.stringify({
          name: updates.name,
          role: updates.role,
          active: updates.active,
          passwordReset: Boolean(updates.passwordHash),
        }),
      });

      res.json({ user: updated });
    } catch (err) {
      handleRouteError(res, err, 'Failed to update user');
    }
  }
);

app.get(
  '/api/settings/email-recipients',
  requireAuth,
  requireRole(['admin']),
  async (_req: AuthRequest, res: Response) => {
    try {
      const list = await db
        .select()
        .from(emailRecipients)
        .orderBy(asc(emailRecipients.id));
      res.json({ recipients: list });
    } catch (err) {
      handleRouteError(res, err, 'Failed to load email recipients');
    }
  }
);

app.post(
  '/api/settings/email-recipients',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const name = req.body?.name ? String(req.body.name).trim() : null;
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email address is required.' });
      }

      const [created] = await db
        .insert(emailRecipients)
        .values({ email, name, active: true })
        .returning();

      await db.insert(auditLog).values({
        userId: req.authUser!.id,
        action: 'CREATE_EMAIL_RECIPIENT',
        entity: 'email_recipient',
        entityId: String(created.id),
        details: JSON.stringify({ email: created.email, name: created.name }),
      });

      res.status(201).json({ recipient: created });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        return res.status(409).json({ error: 'Recipient email already exists.' });
      }
      handleRouteError(res, err, 'Failed to add email recipient');
    }
  }
);

app.patch(
  '/api/settings/email-recipients/:id',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid recipient ID.' });
      }

      const updates: Partial<{ email: string; name: string | null; active: boolean }> = {};
      if (req.body?.email !== undefined) {
        const email = String(req.body.email).trim().toLowerCase();
        if (!email || !email.includes('@')) {
          return res.status(400).json({ error: 'Valid email address is required.' });
        }
        updates.email = email;
      }
      if (req.body?.name !== undefined) {
        updates.name = req.body.name ? String(req.body.name).trim() : null;
      }
      if (req.body?.active !== undefined) {
        updates.active = Boolean(req.body.active);
      }

      const [updated] = await db
        .update(emailRecipients)
        .set(updates)
        .where(eq(emailRecipients.id, id))
        .returning();
      if (!updated) {
        return res.status(404).json({ error: 'Recipient not found.' });
      }

      await db.insert(auditLog).values({
        userId: req.authUser!.id,
        action: 'UPDATE_EMAIL_RECIPIENT',
        entity: 'email_recipient',
        entityId: String(updated.id),
        details: JSON.stringify(updates),
      });

      res.json({ recipient: updated });
    } catch (err) {
      handleRouteError(res, err, 'Failed to update email recipient');
    }
  }
);

app.delete(
  '/api/settings/email-recipients/:id',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid recipient ID.' });
      }
      const [deleted] = await db
        .delete(emailRecipients)
        .where(eq(emailRecipients.id, id))
        .returning();
      if (!deleted) {
        return res.status(404).json({ error: 'Recipient not found.' });
      }

      await db.insert(auditLog).values({
        userId: req.authUser!.id,
        action: 'DELETE_EMAIL_RECIPIENT',
        entity: 'email_recipient',
        entityId: String(id),
        details: JSON.stringify({ email: deleted.email }),
      });

      res.json({ ok: true });
    } catch (err) {
      handleRouteError(res, err, 'Failed to remove email recipient');
    }
  }
);

app.get(
  '/api/settings/audit-log',
  requireAuth,
  requireRole(['admin']),
  async (_req: AuthRequest, res: Response) => {
    try {
      const entries = await db
        .select({
          id: auditLog.id,
          userId: auditLog.userId,
          userName: users.name,
          userEmail: users.email,
          action: auditLog.action,
          entity: auditLog.entity,
          entityId: auditLog.entityId,
          details: auditLog.details,
          timestamp: auditLog.timestamp,
        })
        .from(auditLog)
        .innerJoin(users, eq(auditLog.userId, users.id))
        .orderBy(desc(auditLog.timestamp), desc(auditLog.id))
        .limit(200);
      res.json({ entries });
    } catch (err) {
      handleRouteError(res, err, 'Failed to load audit log');
    }
  }
);

// Global JSON error fallback for API routes
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'API route not found' });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function startServer() {
  const port = Number(process.env.PORT || 3000);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`ForgeFlow server listening on http://0.0.0.0:${port}`);
  });
}

startServer();
