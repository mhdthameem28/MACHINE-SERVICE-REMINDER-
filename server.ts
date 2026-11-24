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
  parts,
  partStockMovements,
  scrapLogs,
  stages,
  stockMovements,
  users,
} from './src/db/schema.ts';
import { ALL_ROLES, type UserRole } from './src/lib/roles.ts';
import {
  isValidMaterialUnit,
  MATERIAL_UNITS,
  normalizeMaterialUnit,
  normalizeReceiveUnit,
} from './src/lib/units.ts';
import { hashPassword, signSessionToken, verifyPassword } from './src/lib/security.ts';
import { type AuthRequest, requireAuth, requireRole } from './src/middleware/auth.ts';
import {
  checkLoginRateLimit,
  extractClientIp,
  recordFailedLoginAttempt,
  recordSuccessfulLogin,
} from './src/middleware/rateLimit.ts';
import {
  adjustStock,
  advanceBatch,
  bulkImportMaterialsWithOpeningStock,
  bulkImportPartsWithOpeningStock,
  bulkUpdateStockFromUpload,
  DomainError,
  evaluatePartReorderAlert,
  getAllMaterialsWithStock,
  getAllPartsWithStock,
  getKnownPartNames,
  receiveStock,
} from './src/services/production.ts';
import { sendAlertEmail } from './src/services/mailer.ts';
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
app.disable('x-powered-by');
app.set('trust proxy', 1);

const BASE_CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' https://apis.google.com https://www.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com https://www.gstatic.com",
  "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://apis.google.com",
  "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];

const APP_CSP = [
  ...BASE_CSP_DIRECTIVES,
  "frame-ancestors 'self' https://aistudio.google.com https://*.google.com https://*.googleusercontent.com https://*.usercontent.goog",
].join('; ');

const API_CSP = [...BASE_CSP_DIRECTIVES, "frame-ancestors 'none'"].join('; ');

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.startsWith('/api')) {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', API_CSP);
  } else {
    res.setHeader('Content-Security-Policy', APP_CSP);
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

app.get('/.well-known/security.txt', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(
    'Contact: mailto:mhdthameem28work@gmail.com\nExpires: 2027-11-24T00:00:00.000Z\nPreferred-Languages: en\n'
  );
});

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
    const clientIp = extractClientIp(req);
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');

    const rateCheck = checkLoginRateLimit(clientIp, email);
    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', String(rateCheck.retryAfterSeconds));
      return res.status(429).json({
        error: 'Too many failed login attempts. Please try again in 15 minutes.',
        retryAfterSeconds: rateCheck.retryAfterSeconds,
      });
    }

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
      const outcome = recordFailedLoginAttempt(clientIp, email);
      if (outcome.blocked) {
        res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
      }
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (!user.active) {
      return res.status(403).json({
        error: 'Your account has been deactivated. Contact an Administrator.',
      });
    }

    recordSuccessfulLogin(clientIp, email);

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
    const [materialList, partList, activeStages] = await Promise.all([
      getAllMaterialsWithStock(false),
      getAllPartsWithStock(false),
      db
        .select()
        .from(stages)
        .where(eq(stages.active, true))
        .orderBy(asc(stages.sequence), asc(stages.id)),
    ]);

    const recentBatches = await db
      .select({
        id: batches.id,
        quantity: batches.quantity,
        partName: batches.partName,
        piecesQuantity: batches.piecesQuantity,
        createdAt: batches.createdAt,
        materialCode: materials.code,
        materialName: materials.name,
        materialUnit: sql<string>`COALESCE(${batches.unit}, ${materials.unit})`,
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
        totalPieces: sql<number>`COALESCE(SUM(${batches.piecesQuantity}), 0)::int`,
        totalRawQuantity: sql<number>`COALESCE(SUM(${batches.quantity}), 0)::double precision`,
      })
      .from(stages)
      .leftJoin(batches, eq(batches.currentStageId, stages.id))
      .where(eq(stages.active, true))
      .groupBy(stages.id, stages.name, stages.sequence)
      .orderBy(asc(stages.sequence));

    const stageUnitRows = await db
      .select({
        stageId: batches.currentStageId,
        unit: sql<string>`COALESCE(${batches.unit}, ${materials.unit})`,
        total: sql<number>`COALESCE(SUM(${batches.quantity}), 0)::double precision`,
      })
      .from(batches)
      .innerJoin(materials, eq(batches.materialId, materials.id))
      .groupBy(batches.currentStageId, sql`COALESCE(${batches.unit}, ${materials.unit})`);

    const stageUnitsMap = new Map<number, { unit: string; total: number }[]>();
    for (const row of stageUnitRows) {
      const list = stageUnitsMap.get(row.stageId) ?? [];
      list.push({ unit: row.unit, total: Number(row.total.toFixed(4)) });
      stageUnitsMap.set(row.stageId, list);
    }

    const enrichedStageDistribution = stageDistribution.map((st) => ({
      ...st,
      totalRawQuantity: Number((st.totalRawQuantity ?? 0).toFixed(4)),
      unitTotals: stageUnitsMap.get(st.stageId) ?? [],
    }));

    // Executive KPI aggregates
    const [batchAggregateRows, scrapTotalRows, rejectionsByStageRows, topCutPartsRows] =
      await Promise.all([
        db
          .select({
            batchesCreated: sql<number>`COUNT(${batches.id})::int`,
            completedBatches: sql<number>`COALESCE(SUM(CASE WHEN ${stages.sequence} >= 4 THEN 1 ELSE 0 END), 0)::int`,
            inProcessBatches: sql<number>`COALESCE(SUM(CASE WHEN ${stages.sequence} < 4 THEN 1 ELSE 0 END), 0)::int`,
          })
          .from(batches)
          .innerJoin(stages, eq(batches.currentStageId, stages.id)),
        db
          .select({
            totalRejectedPieces: sql<number>`COALESCE(SUM(${scrapLogs.quantityRejected}), 0)::int`,
          })
          .from(scrapLogs),
        db
          .select({
            stageId: stages.id,
            stageName: stages.name,
            sequence: stages.sequence,
            rejectedPieces: sql<number>`COALESCE(SUM(${scrapLogs.quantityRejected}), 0)::int`,
            incidentCount: sql<number>`COUNT(${scrapLogs.id})::int`,
          })
          .from(scrapLogs)
          .innerJoin(stages, eq(scrapLogs.stageId, stages.id))
          .groupBy(stages.id, stages.name, stages.sequence)
          .orderBy(asc(stages.sequence)),
        db
          .select({
            partName: sql<string>`trim(${batches.partName})`,
            totalPieces: sql<number>`COALESCE(SUM(${batches.piecesQuantity}), 0)::int`,
            batchCount: sql<number>`COUNT(${batches.id})::int`,
            rawQuantity: sql<number>`COALESCE(SUM(${batches.quantity}), 0)::double precision`,
          })
          .from(batches)
          .where(sql`${batches.partName} IS NOT NULL AND trim(${batches.partName}) <> ''`)
          .groupBy(sql`trim(${batches.partName})`)
          .orderBy(
            desc(sql`COALESCE(SUM(${batches.piecesQuantity}), 0)`),
            desc(sql`COUNT(${batches.id})`)
          )
          .limit(5),
      ]);

    // Last 30 days daily good pieces produced (from stage transitions beyond Raw Material)
    const today = new Date();
    const startWindow = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 29)
    );

    const dailyProdRows = await db
      .select({
        dayKey: sql<string>`to_char(${batchStageHistory.movedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
        goodPieces: sql<number>`COALESCE(SUM(${batchStageHistory.qtyOut}), 0)::int`,
        rejectedPieces: sql<number>`COALESCE(SUM(${batchStageHistory.qtyRejected}), 0)::int`,
        transitions: sql<number>`COUNT(${batchStageHistory.id})::int`,
      })
      .from(batchStageHistory)
      .innerJoin(stages, eq(batchStageHistory.stageId, stages.id))
      .where(
        and(
          sql`${batchStageHistory.movedAt} >= ${startWindow}`,
          sql`${stages.sequence} >= 2`,
          sql`${batchStageHistory.qtyOut} IS NOT NULL AND ${batchStageHistory.qtyOut} > 0`
        )
      )
      .groupBy(sql`to_char(${batchStageHistory.movedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);

    const dailyProdMap = new Map(dailyProdRows.map((r) => [r.dayKey, r]));
    const monthNames = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const productionOverTime: {
      date: string;
      label: string;
      goodPieces: number;
      rejectedPieces: number;
      transitions: number;
    }[] = [];

    for (let i = 0; i < 30; i += 1) {
      const d = new Date(startWindow.getTime() + i * 86_400_000);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      const dateKey = `${y}-${m}-${day}`;
      const label = `${monthNames[d.getUTCMonth()]} ${d.getUTCDate()}`;
      const row = dailyProdMap.get(dateKey);
      productionOverTime.push({
        date: dateKey,
        label,
        goodPieces: row?.goodPieces ?? 0,
        rejectedPieces: row?.rejectedPieces ?? 0,
        transitions: row?.transitions ?? 0,
      });
    }

    const unreadRows = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, req.authUser!.id), eq(notifications.isRead, false)));

    res.json({
      materials: materialList,
      parts: partList,
      belowReorderMaterials: materialList.filter((m) => m.isBelowReorder),
      belowReorderParts: partList.filter((p) => p.isBelowReorder),
      activeStages,
      stageDistribution: enrichedStageDistribution,
      recentBatches,
      unreadNotifications: unreadRows[0]?.count ?? 0,
      executiveSummary: {
        batchesCreated: batchAggregateRows[0]?.batchesCreated ?? 0,
        completedBatches: batchAggregateRows[0]?.completedBatches ?? 0,
        inProcessBatches: batchAggregateRows[0]?.inProcessBatches ?? 0,
        totalRejectedPieces: scrapTotalRows[0]?.totalRejectedPieces ?? 0,
        productionOverTime,
        rejectionsByStage: rejectionsByStageRows.filter((r) => r.rejectedPieces > 0),
        topCutPartsProduced: topCutPartsRows.map((p) => ({
          ...p,
          rawQuantity: Number((p.rawQuantity ?? 0).toFixed(4)),
        })),
      },
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

app.get('/api/parts', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const includeInactive =
      req.query.includeInactive === 'true' && req.authUser?.role === 'admin';
    const list = await getAllPartsWithStock(includeInactive);
    res.json({ parts: list });
  } catch (err) {
    handleRouteError(res, err, 'Failed to load parts master');
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

app.get('/api/part-names', requireAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const partNames = await getKnownPartNames();
    res.json({ partNames });
  } catch (err) {
    handleRouteError(res, err, 'Failed to load part names');
  }
});

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
      const rawUnit = req.body?.unit;
      const unit =
        rawUnit !== undefined && rawUnit !== null && String(rawUnit).trim() !== ''
          ? normalizeReceiveUnit(rawUnit)
          : undefined;
      const dateStr = String(req.body?.movementDate ?? '');
      const sendToLaserCutting = Boolean(req.body?.sendToLaserCutting);
      const partName = req.body?.partName ? String(req.body.partName) : undefined;
      const piecesQuantity =
        req.body?.piecesQuantity !== undefined && req.body?.piecesQuantity !== ''
          ? Number(req.body.piecesQuantity)
          : undefined;
      const note = req.body?.note ? String(req.body.note) : undefined;

      if (!Number.isInteger(materialId) || materialId <= 0) {
        return res.status(400).json({ error: 'Please select a valid material.' });
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return res.status(400).json({ error: 'Quantity must be greater than zero.' });
      }
      if (rawUnit !== undefined && rawUnit !== null && String(rawUnit).trim() !== '' && !unit) {
        return res.status(400).json({
          error: 'Invalid unit. Allowed units: kg, sheets, pcs, liters, meters, qty.',
        });
      }
      const movementDate = dateStr ? new Date(dateStr) : new Date();
      if (Number.isNaN(movementDate.getTime())) {
        return res.status(400).json({ error: 'Invalid receipt date.' });
      }

      const outcome = await receiveStock({
        materialId,
        quantity,
        unit: unit ?? undefined,
        movementDate,
        sendToLaserCutting,
        partName,
        piecesQuantity,
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

app.post(
  '/api/stock/bulk-update',
  requireAuth,
  requireRole(['admin', 'store_keeper']),
  async (req: AuthRequest, res: Response) => {
    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const rawType = String(req.body?.movementType ?? 'receipt').trim().toLowerCase();
      const movementType: 'receipt' | 'adjustment' =
        rawType === 'adjustment' ? 'adjustment' : 'receipt';
      const dateStr = String(req.body?.movementDate ?? '');
      const movementDate = dateStr ? new Date(dateStr) : new Date();

      if (rows.length === 0) {
        return res.status(400).json({ error: 'Please upload at least one row.' });
      }
      if (rows.length > 500) {
        return res.status(400).json({ error: 'Maximum 500 rows per bulk stock upload.' });
      }
      if (Number.isNaN(movementDate.getTime())) {
        return res.status(400).json({ error: 'Invalid movement date.' });
      }

      const normalizedRows = rows.map((r: Record<string, unknown>, idx: number) => ({
        rowNumber: Number(r?.rowNumber) || idx + 1,
        itemCode: String(r?.itemCode ?? '').trim(),
        productName: r?.productName ? String(r.productName).trim() : undefined,
        quantity: Number(r?.quantity),
        unit: r?.unit ? String(r.unit).trim() : undefined,
      }));

      const outcome = await bulkUpdateStockFromUpload({
        rows: normalizedRows,
        movementType,
        movementDate,
        userId: req.authUser!.id,
      });

      res.status(201).json(outcome);
    } catch (err) {
      handleRouteError(res, err, 'Failed to process bulk stock update');
    }
  }
);

app.get('/api/batches', requireAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const [batchRows, activeStages, knownPartNames] = await Promise.all([
      db
        .select({
          id: batches.id,
          materialId: batches.materialId,
          materialCode: materials.code,
          materialName: materials.name,
          materialUnit: sql<string>`COALESCE(${batches.unit}, ${materials.unit})`,
          currentStageId: batches.currentStageId,
          stageName: stages.name,
          stageSequence: stages.sequence,
          quantity: batches.quantity,
          partName: batches.partName,
          piecesQuantity: batches.piecesQuantity,
          supplierName: batches.supplierName,
          invoiceNumber: batches.invoiceNumber,
          invoiceDate: batches.invoiceDate,
          bendingInchargeName: batches.bendingInchargeName,
          machiningInchargeName: batches.machiningInchargeName,
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
        .orderBy(desc(batches.createdAt)),
      db
        .select()
        .from(stages)
        .where(eq(stages.active, true))
        .orderBy(asc(stages.sequence), asc(stages.id)),
      getKnownPartNames(),
    ]);

    res.json({ batches: batchRows, activeStages, knownPartNames });
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
        materialUnit: sql<string>`COALESCE(${batches.unit}, ${materials.unit})`,
        currentStageId: batches.currentStageId,
        stageName: stages.name,
        stageSequence: stages.sequence,
        quantity: batches.quantity,
        partName: batches.partName,
        piecesQuantity: batches.piecesQuantity,
        supplierName: batches.supplierName,
        invoiceNumber: batches.invoiceNumber,
        invoiceDate: batches.invoiceDate,
        bendingInchargeName: batches.bendingInchargeName,
        machiningInchargeName: batches.machiningInchargeName,
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

    const [history, scrapEntries, activeStages, knownPartNames] = await Promise.all([
      db
        .select({
          id: batchStageHistory.id,
          batchId: batchStageHistory.batchId,
          stageId: batchStageHistory.stageId,
          stageName: stages.name,
          stageSequence: stages.sequence,
          qtyIn: batchStageHistory.qtyIn,
          qtyRejected: batchStageHistory.qtyRejected,
          qtyOut: batchStageHistory.qtyOut,
          rejectionReason: batchStageHistory.rejectionReason,
          movedAt: batchStageHistory.movedAt,
          movedBy: batchStageHistory.movedBy,
          movedByName: users.name,
          movedByEmail: users.email,
          supplierName: batchStageHistory.supplierName,
          invoiceNumber: batchStageHistory.invoiceNumber,
          invoiceDate: batchStageHistory.invoiceDate,
          inchargeName: batchStageHistory.inchargeName,
          note: batchStageHistory.note,
        })
        .from(batchStageHistory)
        .innerJoin(stages, eq(batchStageHistory.stageId, stages.id))
        .innerJoin(users, eq(batchStageHistory.movedBy, users.id))
        .where(eq(batchStageHistory.batchId, batchId))
        .orderBy(asc(batchStageHistory.movedAt), asc(batchStageHistory.id)),
      db
        .select({
          id: scrapLogs.id,
          stageId: scrapLogs.stageId,
          stageName: stages.name,
          stageSequence: stages.sequence,
          partName: scrapLogs.partName,
          quantityProcessed: scrapLogs.quantityProcessed,
          quantityRejected: scrapLogs.quantityRejected,
          quantityGood: scrapLogs.quantityGood,
          reason: scrapLogs.reason,
          loggedAt: scrapLogs.loggedAt,
          loggedByName: users.name,
        })
        .from(scrapLogs)
        .innerJoin(stages, eq(scrapLogs.stageId, stages.id))
        .innerJoin(users, eq(scrapLogs.loggedBy, users.id))
        .where(eq(scrapLogs.batchId, batchId))
        .orderBy(desc(scrapLogs.loggedAt), desc(scrapLogs.id)),
      db
        .select()
        .from(stages)
        .where(eq(stages.active, true))
        .orderBy(asc(stages.sequence), asc(stages.id)),
      getKnownPartNames(),
    ]);

    const nextStage =
      activeStages.find((s) => s.sequence > batch.stageSequence) ?? null;

    const requiresPartAssignment = Boolean(
      nextStage && activeStages[0] && batch.currentStageId === activeStages[0].id
    );

    res.json({
      batch,
      history,
      scrapEntries,
      activeStages,
      nextStage,
      requiresPartAssignment,
      knownPartNames,
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
      const partName = req.body?.partName ? String(req.body.partName) : undefined;
      const quantityIssued =
        req.body?.quantityIssued !== undefined && req.body?.quantityIssued !== ''
          ? Number(req.body.quantityIssued)
          : undefined;
      const piecesQuantity =
        req.body?.piecesQuantity !== undefined && req.body?.piecesQuantity !== ''
          ? Number(req.body.piecesQuantity)
          : undefined;
      const quantityProcessed =
        req.body?.quantityProcessed !== undefined && req.body?.quantityProcessed !== ''
          ? Number(req.body.quantityProcessed)
          : undefined;
      const quantityRejected =
        req.body?.quantityRejected !== undefined && req.body?.quantityRejected !== ''
          ? Number(req.body.quantityRejected)
          : undefined;
      const rejectionReason = req.body?.rejectionReason
        ? String(req.body.rejectionReason)
        : undefined;
      const supplierName = req.body?.supplierName
        ? String(req.body.supplierName)
        : undefined;
      const invoiceNumber = req.body?.invoiceNumber
        ? String(req.body.invoiceNumber)
        : undefined;
      const invoiceDate = req.body?.invoiceDate
        ? String(req.body.invoiceDate)
        : undefined;
      const bendingInchargeName = req.body?.bendingInchargeName
        ? String(req.body.bendingInchargeName)
        : undefined;
      const machiningInchargeName = req.body?.machiningInchargeName
        ? String(req.body.machiningInchargeName)
        : undefined;
      const note = req.body?.note ? String(req.body.note) : undefined;
      const outcome = await advanceBatch({
        batchId,
        partName,
        quantityIssued,
        piecesQuantity,
        quantityProcessed,
        quantityRejected,
        rejectionReason,
        supplierName,
        invoiceNumber,
        invoiceDate,
        bendingInchargeName,
        machiningInchargeName,
        note,
        userId: req.authUser!.id,
      });
      res.json(outcome);
    } catch (err) {
      handleRouteError(res, err, 'Failed to advance batch stage');
    }
  }
);

app.get('/api/scrap-logs', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const stageIdParam = req.query.stageId ? Number(req.query.stageId) : undefined;
    const conditions = [];
    if (stageIdParam && Number.isInteger(stageIdParam)) {
      conditions.push(eq(scrapLogs.stageId, stageIdParam));
    }

    const baseLogsQuery = db
      .select({
        id: scrapLogs.id,
        batchId: scrapLogs.batchId,
        materialId: scrapLogs.materialId,
        materialCode: materials.code,
        materialName: materials.name,
        stageId: scrapLogs.stageId,
        stageName: stages.name,
        stageSequence: stages.sequence,
        partName: scrapLogs.partName,
        quantityProcessed: scrapLogs.quantityProcessed,
        quantityRejected: scrapLogs.quantityRejected,
        quantityGood: scrapLogs.quantityGood,
        reason: scrapLogs.reason,
        loggedAt: scrapLogs.loggedAt,
        loggedByName: users.name,
        loggedByEmail: users.email,
      })
      .from(scrapLogs)
      .innerJoin(materials, eq(scrapLogs.materialId, materials.id))
      .innerJoin(stages, eq(scrapLogs.stageId, stages.id))
      .innerJoin(users, eq(scrapLogs.loggedBy, users.id));

    const [logs, stageSummary, activeStages] = await Promise.all([
      conditions.length
        ? baseLogsQuery
            .where(and(...conditions))
            .orderBy(desc(scrapLogs.loggedAt), desc(scrapLogs.id))
        : baseLogsQuery.orderBy(desc(scrapLogs.loggedAt), desc(scrapLogs.id)),
      db
        .select({
          stageId: stages.id,
          stageName: stages.name,
          stageSequence: stages.sequence,
          incidentCount: sql<number>`COUNT(${scrapLogs.id})::int`,
          totalRejected: sql<number>`COALESCE(SUM(${scrapLogs.quantityRejected}), 0)::int`,
          totalProcessed: sql<number>`COALESCE(SUM(${scrapLogs.quantityProcessed}), 0)::int`,
        })
        .from(stages)
        .leftJoin(scrapLogs, eq(scrapLogs.stageId, stages.id))
        .where(eq(stages.active, true))
        .groupBy(stages.id, stages.name, stages.sequence)
        .orderBy(asc(stages.sequence)),
      db
        .select()
        .from(stages)
        .where(eq(stages.active, true))
        .orderBy(asc(stages.sequence), asc(stages.id)),
    ]);

    res.json({ logs, stageSummary, activeStages });
  } catch (err) {
    handleRouteError(res, err, 'Failed to load scrap and rejection log');
  }
});

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
  'scrap-log',
  'raw-material-movement',
  'cut-pieces-movement',
];

function parseReportFilters(req: Request): ReportFilters {
  const materialIdRaw = req.query.materialId ? Number(req.query.materialId) : undefined;
  const partIdRaw = req.query.partId ? Number(req.query.partId) : undefined;
  const partNameRaw = req.query.partName ? String(req.query.partName).trim() : undefined;
  const userIdRaw = req.query.userId ? Number(req.query.userId) : undefined;
  return {
    startDate: req.query.startDate ? String(req.query.startDate) : undefined,
    endDate: req.query.endDate ? String(req.query.endDate) : undefined,
    materialId: materialIdRaw && Number.isInteger(materialIdRaw) ? materialIdRaw : undefined,
    partId: partIdRaw && Number.isInteger(partIdRaw) ? partIdRaw : undefined,
    partName: partNameRaw || undefined,
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
      const rawUnit = String(req.body?.unit ?? '').trim();
      const reorderLevel = Number(req.body?.reorderLevel ?? 0);

      if (!code || !name || !rawUnit) {
        return res.status(400).json({ error: 'Code, name, and unit are required.' });
      }
      if (!isValidMaterialUnit(rawUnit)) {
        return res.status(400).json({
          error: `Unit must be one of: ${MATERIAL_UNITS.join(', ')}.`,
        });
      }
      if (!Number.isFinite(reorderLevel) || reorderLevel < 0) {
        return res.status(400).json({ error: 'Reorder level must be zero or greater.' });
      }

      const [created] = await db
        .insert(materials)
        .values({ code, name, unit: rawUnit, reorderLevel, active: true })
        .returning();

      await db.insert(auditLog).values({
        userId: req.authUser!.id,
        action: 'CREATE_MATERIAL',
        entity: 'material',
        entityId: String(created.id),
        details: JSON.stringify({ code, name, unit: rawUnit, reorderLevel }),
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

app.post(
  '/api/settings/materials/bulk-import',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const inputRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const skipExisting = req.body?.skipExisting !== false;

      if (inputRows.length === 0) {
        return res.status(400).json({ error: 'No material rows provided for import.' });
      }
      if (inputRows.length > 1000) {
        return res.status(400).json({ error: 'Maximum 1,000 rows per bulk import.' });
      }

      const validationErrors: string[] = [];
      const seenCodes = new Set<string>();
      const prepared: {
        code: string;
        name: string;
        unit: string;
        reorderLevel: number;
        qty: number;
      }[] = [];

      for (let i = 0; i < inputRows.length; i++) {
        const row = inputRows[i] as Record<string, unknown>;
        const rowNum = i + 1;
        const code = String(row?.code ?? '').trim().toUpperCase();
        const name = String(row?.name ?? '').trim();
        const normalizedUnit = normalizeMaterialUnit(String(row?.unit ?? ''));
        const reorderLevel = Number(row?.reorderLevel ?? 0);
        const qty =
          row?.qty === undefined || row?.qty === null || row?.qty === ''
            ? 0
            : Number(row.qty);

        if (!code) {
          validationErrors.push(`Row ${rowNum}: Material Code is required.`);
          continue;
        }
        if (!name) {
          validationErrors.push(`Row ${rowNum} (${code}): Material Name is required.`);
          continue;
        }
        if (!normalizedUnit) {
          validationErrors.push(
            `Row ${rowNum} (${code}): Invalid unit "${String(row?.unit ?? '')}". Allowed: ${MATERIAL_UNITS.join(', ')}.`
          );
          continue;
        }
        if (!Number.isFinite(reorderLevel) || reorderLevel < 0) {
          validationErrors.push(
            `Row ${rowNum} (${code}): Reorder Level must be a non-negative number.`
          );
          continue;
        }
        if (!Number.isFinite(qty) || qty < 0) {
          validationErrors.push(
            `Row ${rowNum} (${code}): Qty (Opening Stock) must be a non-negative number.`
          );
          continue;
        }
        if (seenCodes.has(code)) {
          validationErrors.push(`Row ${rowNum}: Duplicate Material Code "${code}" in upload.`);
          continue;
        }

        seenCodes.add(code);
        prepared.push({
          code,
          name,
          unit: normalizedUnit,
          reorderLevel,
          qty,
        });
      }

      if (validationErrors.length > 0) {
        return res.status(400).json({
          error: validationErrors.slice(0, 5).join(' '),
          details: validationErrors,
        });
      }

      const existingRows = await db.select({ code: materials.code }).from(materials);
      const existingCodeSet = new Set(existingRows.map((r) => r.code.toUpperCase()));

      const toInsert = prepared.filter((p) => !existingCodeSet.has(p.code));
      const skippedCodes = prepared
        .filter((p) => existingCodeSet.has(p.code))
        .map((p) => p.code);

      if (!skipExisting && skippedCodes.length > 0) {
        return res.status(409).json({
          error: `Material code(s) already exist: ${skippedCodes.slice(0, 5).join(', ')}.`,
        });
      }

      if (toInsert.length === 0) {
        return res.status(200).json({
          insertedCount: 0,
          openingStockCount: 0,
          skippedCodes,
          materials: [],
        });
      }

      const { inserted, openingCount } = await bulkImportMaterialsWithOpeningStock({
        items: toInsert,
        skippedCodes,
        userId: req.authUser!.id,
      });

      res.status(201).json({
        insertedCount: inserted.length,
        openingStockCount: openingCount,
        skippedCodes,
        materials: inserted,
      });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        return res.status(409).json({ error: 'One or more material codes already exist.' });
      }
      handleRouteError(res, err, 'Failed to bulk import materials');
    }
  }
);

app.post(
  '/api/settings/parts',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const code = String(req.body?.code ?? '').trim().toUpperCase();
      const name = String(req.body?.name ?? '').trim();
      const rawUnit = String(req.body?.unit ?? 'qty').trim();
      const normalizedUnit = normalizeMaterialUnit(rawUnit);
      const reorderLevel =
        req.body?.reorderLevel === undefined ||
        req.body?.reorderLevel === null ||
        req.body?.reorderLevel === ''
          ? 0
          : Number(req.body.reorderLevel);
      const qty =
        req.body?.qty === undefined || req.body?.qty === null || req.body?.qty === ''
          ? 0
          : Number(req.body.qty);

      if (!code || !name || !rawUnit) {
        return res.status(400).json({ error: 'Part Code, Part Name, and Unit are required.' });
      }
      if (!normalizedUnit) {
        return res.status(400).json({
          error: `Unit must be one of: ${MATERIAL_UNITS.join(', ')}.`,
        });
      }
      if (!Number.isFinite(reorderLevel) || reorderLevel < 0) {
        return res.status(400).json({ error: 'Reorder level must be zero or greater.' });
      }
      if (!Number.isFinite(qty) || qty < 0) {
        return res.status(400).json({ error: 'Opening Qty must be zero or greater.' });
      }

      const outcome = await db.transaction(async (tx) => {
        const [part] = await tx
          .insert(parts)
          .values({ code, name, unit: normalizedUnit, reorderLevel, active: true })
          .returning();

        const now = new Date();
        if (qty > 0) {
          await tx.insert(partStockMovements).values({
            partId: part.id,
            type: 'receipt',
            quantity: qty,
            batchId: null,
            isOpening: true,
            reason: 'Opening Stock',
            movementDate: now,
            createdAt: now,
            userId: req.authUser!.id,
            note: 'Initial opening stock on part creation',
          });
        }

        let alertResult: Awaited<ReturnType<typeof evaluatePartReorderAlert>> | null = null;
        if (reorderLevel > 0 && qty <= reorderLevel) {
          alertResult = await evaluatePartReorderAlert(tx, part.id, req.authUser!.id);
        }

        await tx.insert(auditLog).values({
          userId: req.authUser!.id,
          action: 'CREATE_PART',
          entity: 'part',
          entityId: String(part.id),
          details: JSON.stringify({
            code,
            name,
            unit: normalizedUnit,
            reorderLevel,
            openingQty: qty,
          }),
        });

        return {
          part,
          reorderAlertTriggered: alertResult?.alertTriggered ?? false,
          emailQueuedForDispatch: alertResult?.emailQueuedForDispatch,
        };
      });

      if (outcome.emailQueuedForDispatch) {
        const emailResult = await sendAlertEmail(
          outcome.emailQueuedForDispatch.recipients,
          outcome.emailQueuedForDispatch.subject,
          outcome.emailQueuedForDispatch.body
        );
        if (emailResult.sent) {
          await db
            .update(notifications)
            .set({ emailSent: true })
            .where(
              and(
                eq(notifications.entityType, 'part'),
                eq(notifications.entityId, String(outcome.part.id)),
                eq(notifications.type, 'reorder_alert')
              )
            );
        }
      }

      res.status(201).json({
        part: outcome.part,
        reorderAlertTriggered: outcome.reorderAlertTriggered,
      });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        return res.status(409).json({ error: 'Part code already exists.' });
      }
      handleRouteError(res, err, 'Failed to create part');
    }
  }
);

app.post(
  '/api/settings/parts/bulk-import',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const inputRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const skipExisting = req.body?.skipExisting !== false;

      if (inputRows.length === 0) {
        return res.status(400).json({ error: 'No part rows provided for import.' });
      }
      if (inputRows.length > 1000) {
        return res.status(400).json({ error: 'Maximum 1,000 rows per bulk import.' });
      }

      const validationErrors: string[] = [];
      const seenCodes = new Set<string>();
      const prepared: {
        code: string;
        name: string;
        unit: string;
        reorderLevel: number;
        qty: number;
      }[] = [];

      for (let i = 0; i < inputRows.length; i++) {
        const row = inputRows[i] as Record<string, unknown>;
        const rowNum = i + 1;
        const code = String(row?.code ?? '').trim().toUpperCase();
        const name = String(row?.name ?? '').trim();
        const normalizedUnit = normalizeMaterialUnit(String(row?.unit ?? 'qty'));
        const reorderLevel =
          row?.reorderLevel === undefined ||
          row?.reorderLevel === null ||
          row?.reorderLevel === ''
            ? 0
            : Number(row.reorderLevel);
        const qty =
          row?.qty === undefined || row?.qty === null || row?.qty === ''
            ? 0
            : Number(row.qty);

        if (!code) {
          validationErrors.push(`Row ${rowNum}: Part Code is required.`);
          continue;
        }
        if (!name) {
          validationErrors.push(`Row ${rowNum} (${code}): Part Name is required.`);
          continue;
        }
        if (!normalizedUnit) {
          validationErrors.push(
            `Row ${rowNum} (${code}): Invalid unit "${String(row?.unit ?? '')}". Allowed: ${MATERIAL_UNITS.join(', ')}.`
          );
          continue;
        }
        if (!Number.isFinite(reorderLevel) || reorderLevel < 0) {
          validationErrors.push(
            `Row ${rowNum} (${code}): Reorder Level must be a non-negative number.`
          );
          continue;
        }
        if (!Number.isFinite(qty) || qty < 0) {
          validationErrors.push(
            `Row ${rowNum} (${code}): Qty (Opening Stock) must be a non-negative number.`
          );
          continue;
        }
        if (seenCodes.has(code)) {
          validationErrors.push(`Row ${rowNum}: Duplicate Part Code "${code}" in upload.`);
          continue;
        }

        seenCodes.add(code);
        prepared.push({
          code,
          name,
          unit: normalizedUnit,
          reorderLevel,
          qty,
        });
      }

      if (validationErrors.length > 0) {
        return res.status(400).json({
          error: validationErrors.slice(0, 5).join(' '),
          details: validationErrors,
        });
      }

      const existingRows = await db.select({ code: parts.code }).from(parts);
      const existingCodeSet = new Set(existingRows.map((r) => r.code.toUpperCase()));

      const toInsert = prepared.filter((p) => !existingCodeSet.has(p.code));
      const skippedCodes = prepared
        .filter((p) => existingCodeSet.has(p.code))
        .map((p) => p.code);

      if (!skipExisting && skippedCodes.length > 0) {
        return res.status(409).json({
          error: `Part code(s) already exist: ${skippedCodes.slice(0, 5).join(', ')}.`,
        });
      }

      if (toInsert.length === 0) {
        return res.status(200).json({
          insertedCount: 0,
          openingStockCount: 0,
          reorderAlertCount: 0,
          skippedCodes,
          parts: [],
        });
      }

      const { inserted, openingCount, reorderAlertCount } =
        await bulkImportPartsWithOpeningStock({
          items: toInsert,
          skippedCodes,
          userId: req.authUser!.id,
        });

      res.status(201).json({
        insertedCount: inserted.length,
        openingStockCount: openingCount,
        reorderAlertCount,
        skippedCodes,
        parts: inserted,
      });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        return res.status(409).json({ error: 'One or more part codes already exist.' });
      }
      handleRouteError(res, err, 'Failed to bulk import parts');
    }
  }
);

app.patch(
  '/api/settings/parts/:id',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid part ID.' });
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
        const rawUnit = String(req.body.unit).trim();
        const normalizedUnit = normalizeMaterialUnit(rawUnit);
        if (!normalizedUnit) {
          return res.status(400).json({
            error: `Unit must be one of: ${MATERIAL_UNITS.join(', ')}.`,
          });
        }
        updates.unit = normalizedUnit;
      }
      if (req.body?.reorderLevel !== undefined) {
        const rl = Number(req.body.reorderLevel);
        if (!Number.isFinite(rl) || rl < 0) {
          return res.status(400).json({ error: 'Reorder level must be zero or greater.' });
        }
        updates.reorderLevel = rl;
      }
      if (req.body?.active !== undefined) {
        updates.active = Boolean(req.body.active);
      }

      const outcome = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(parts)
          .set(updates)
          .where(eq(parts.id, id))
          .returning();

        if (!updated) {
          return null;
        }

        let alertResult: Awaited<ReturnType<typeof evaluatePartReorderAlert>> | null = null;
        if (updates.reorderLevel !== undefined && updated.active) {
          alertResult = await evaluatePartReorderAlert(tx, updated.id, req.authUser!.id);
        }

        await tx.insert(auditLog).values({
          userId: req.authUser!.id,
          action: 'UPDATE_PART',
          entity: 'part',
          entityId: String(updated.id),
          details: JSON.stringify(updates),
        });

        return {
          updated,
          emailQueuedForDispatch: alertResult?.emailQueuedForDispatch,
        };
      });

      if (!outcome) {
        return res.status(404).json({ error: 'Part not found.' });
      }

      if (outcome.emailQueuedForDispatch) {
        const emailResult = await sendAlertEmail(
          outcome.emailQueuedForDispatch.recipients,
          outcome.emailQueuedForDispatch.subject,
          outcome.emailQueuedForDispatch.body
        );
        if (emailResult.sent) {
          await db
            .update(notifications)
            .set({ emailSent: true })
            .where(
              and(
                eq(notifications.entityType, 'part'),
                eq(notifications.entityId, String(outcome.updated.id)),
                eq(notifications.type, 'reorder_alert')
              )
            );
        }
      }

      res.json({ part: outcome.updated });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        return res.status(409).json({ error: 'Part code already exists.' });
      }
      handleRouteError(res, err, 'Failed to update part');
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
        if (!isValidMaterialUnit(unit)) {
          return res.status(400).json({
            error: `Unit must be one of: ${MATERIAL_UNITS.join(', ')}.`,
          });
        }
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

app.delete(
  '/api/settings/materials/:id',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid material ID.' });
      }

      const existingRows = await db
        .select()
        .from(materials)
        .where(eq(materials.id, id))
        .limit(1);
      const target = existingRows[0];
      if (!target) {
        return res.status(404).json({ error: 'Material not found.' });
      }

      const [refs] = await db
        .select({
          batchCount: sql<number>`(SELECT count(*)::int FROM batches WHERE material_id = ${id})`,
          scrapCount: sql<number>`(SELECT count(*)::int FROM scrap_logs WHERE material_id = ${id})`,
          nonOpeningMovements: sql<number>`(SELECT count(*)::int FROM stock_movements WHERE material_id = ${id} AND (is_opening = false OR batch_id IS NOT NULL))`,
        })
        .from(materials)
        .where(eq(materials.id, id));

      if ((refs?.batchCount ?? 0) > 0) {
        return res.status(409).json({
          error: `Cannot delete material "${target.code}" because it is already tied to ${refs.batchCount} batch(es). Deactivate it instead, or clear transactional data first.`,
        });
      }
      if ((refs?.scrapCount ?? 0) > 0) {
        return res.status(409).json({
          error: `Cannot delete material "${target.code}" because it has recorded rejection history. Deactivate it instead, or clear transactional data first.`,
        });
      }
      if ((refs?.nonOpeningMovements ?? 0) > 0) {
        return res.status(409).json({
          error: `Cannot delete material "${target.code}" because it has recorded stock movements. Deactivate it instead, or clear transactional data first.`,
        });
      }

      await db.transaction(async (tx) => {
        await tx
          .delete(stockMovements)
          .where(and(eq(stockMovements.materialId, id), eq(stockMovements.isOpening, true)));
        await tx
          .delete(notifications)
          .where(
            and(
              eq(notifications.entityType, 'material'),
              eq(notifications.entityId, String(id))
            )
          );
        await tx.delete(materials).where(eq(materials.id, id));
        await tx.insert(auditLog).values({
          userId: req.authUser!.id,
          action: 'DELETE_MATERIAL',
          entity: 'material',
          entityId: String(id),
          details: JSON.stringify({ code: target.code, name: target.name }),
        });
      });

      res.json({ deletedId: id, code: target.code });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === '23503') {
        return res.status(409).json({
          error:
            'Cannot delete this material because it is referenced by existing production records.',
        });
      }
      handleRouteError(res, err, 'Failed to delete material');
    }
  }
);

app.delete(
  '/api/settings/parts/:id',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid part ID.' });
      }

      const existingRows = await db
        .select()
        .from(parts)
        .where(eq(parts.id, id))
        .limit(1);
      const target = existingRows[0];
      if (!target) {
        return res.status(404).json({ error: 'Part not found.' });
      }

      const normalizedName = target.name.trim().toLowerCase();
      const [refs] = await db
        .select({
          batchCount: sql<number>`(SELECT count(*)::int FROM batches WHERE part_name IS NOT NULL AND lower(trim(part_name)) = ${normalizedName})`,
          scrapCount: sql<number>`(SELECT count(*)::int FROM scrap_logs WHERE part_name IS NOT NULL AND lower(trim(part_name)) = ${normalizedName})`,
          nonOpeningMovements: sql<number>`(SELECT count(*)::int FROM part_stock_movements WHERE part_id = ${id} AND (is_opening = false OR batch_id IS NOT NULL))`,
        })
        .from(parts)
        .where(eq(parts.id, id));

      if ((refs?.batchCount ?? 0) > 0) {
        return res.status(409).json({
          error: `Cannot delete cut part "${target.code}" because it is already tied to ${refs.batchCount} batch(es). Deactivate it instead, or clear transactional data first.`,
        });
      }
      if ((refs?.scrapCount ?? 0) > 0) {
        return res.status(409).json({
          error: `Cannot delete cut part "${target.code}" because it has recorded rejection history. Deactivate it instead, or clear transactional data first.`,
        });
      }
      if ((refs?.nonOpeningMovements ?? 0) > 0) {
        return res.status(409).json({
          error: `Cannot delete cut part "${target.code}" because it has recorded stock movements. Deactivate it instead, or clear transactional data first.`,
        });
      }

      await db.transaction(async (tx) => {
        await tx
          .delete(partStockMovements)
          .where(and(eq(partStockMovements.partId, id), eq(partStockMovements.isOpening, true)));
        await tx
          .delete(notifications)
          .where(
            and(eq(notifications.entityType, 'part'), eq(notifications.entityId, String(id)))
          );
        await tx.delete(parts).where(eq(parts.id, id));
        await tx.insert(auditLog).values({
          userId: req.authUser!.id,
          action: 'DELETE_PART',
          entity: 'part',
          entityId: String(id),
          details: JSON.stringify({ code: target.code, name: target.name }),
        });
      });

      res.json({ deletedId: id, code: target.code });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === '23503') {
        return res.status(409).json({
          error:
            'Cannot delete this cut part because it is referenced by existing production records.',
        });
      }
      handleRouteError(res, err, 'Failed to delete part');
    }
  }
);

app.get(
  '/api/settings/danger-zone/summary',
  requireAuth,
  requireRole(['admin']),
  async (_req: AuthRequest, res: Response) => {
    try {
      const [
        batchRows,
        historyRows,
        rawMovementRows,
        partMovementRows,
        scrapRows,
        materialRows,
        partRows,
        userRows,
      ] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(batches),
        db.select({ count: sql<number>`count(*)::int` }).from(batchStageHistory),
        db.select({ count: sql<number>`count(*)::int` }).from(stockMovements),
        db.select({ count: sql<number>`count(*)::int` }).from(partStockMovements),
        db.select({ count: sql<number>`count(*)::int` }).from(scrapLogs),
        db.select({ count: sql<number>`count(*)::int` }).from(materials),
        db.select({ count: sql<number>`count(*)::int` }).from(parts),
        db.select({ count: sql<number>`count(*)::int` }).from(users),
      ]);

      res.json({
        transactional: {
          batches: batchRows[0]?.count ?? 0,
          batchStageHistory: historyRows[0]?.count ?? 0,
          stockMovements: rawMovementRows[0]?.count ?? 0,
          partStockMovements: partMovementRows[0]?.count ?? 0,
          scrapLogs: scrapRows[0]?.count ?? 0,
        },
        preserved: {
          materials: materialRows[0]?.count ?? 0,
          parts: partRows[0]?.count ?? 0,
          users: userRows[0]?.count ?? 0,
        },
      });
    } catch (err) {
      handleRouteError(res, err, 'Failed to load danger zone summary');
    }
  }
);

app.post(
  '/api/settings/danger-zone/clear-transactional-data',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      if (req.body?.confirm !== true) {
        return res.status(400).json({
          error: 'Explicit confirmation is required before clearing transactional data.',
        });
      }

      const cleared = await db.transaction(async (tx) => {
        // Delete child transactional tables before parent batches table to respect FKs
        const scrapRes = await tx.delete(scrapLogs);
        const historyRes = await tx.delete(batchStageHistory);
        const rawMovRes = await tx.delete(stockMovements);
        const partMovRes = await tx.delete(partStockMovements);
        const batchRes = await tx.delete(batches);
        const notifRes = await tx.delete(notifications);

        // Reset reorder alert throttle flags so future real transactions trigger alerts cleanly
        await tx.update(materials).set({ reorderAlertSent: false });
        await tx.update(parts).set({ reorderAlertSent: false });

        const counts = {
          scrapLogs: scrapRes.rowCount ?? 0,
          batchStageHistory: historyRes.rowCount ?? 0,
          stockMovements: rawMovRes.rowCount ?? 0,
          partStockMovements: partMovRes.rowCount ?? 0,
          batches: batchRes.rowCount ?? 0,
          notifications: notifRes.rowCount ?? 0,
        };

        await tx.insert(auditLog).values({
          userId: req.authUser!.id,
          action: 'CLEAR_TRANSACTIONAL_DATA',
          entity: 'system',
          entityId: 'transactional_data',
          details: JSON.stringify(counts),
        });

        return counts;
      });

      res.json({ cleared });
    } catch (err) {
      handleRouteError(res, err, 'Failed to clear transactional data');
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

      res.status(201).json({ user: { ...created, hasPassword: Boolean(password) } });
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
          hasPassword: sql<boolean>`(${users.passwordHash} IS NOT NULL)`,
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

app.delete(
  '/api/settings/users/:id',
  requireAuth,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid user ID.' });
      }
      if (id === req.authUser!.id) {
        return res.status(400).json({ error: 'You cannot remove your own active account.' });
      }

      const existingRows = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const target = existingRows[0];
      if (!target) {
        return res.status(404).json({ error: 'User not found.' });
      }

      const [refs] = await db
        .select({
          movements: sql<number>`(SELECT count(*)::int FROM stock_movements WHERE user_id = ${id})`,
          batches: sql<number>`(SELECT count(*)::int FROM batches WHERE created_by = ${id})`,
          history: sql<number>`(SELECT count(*)::int FROM batch_stage_history WHERE moved_by = ${id})`,
          audits: sql<number>`(SELECT count(*)::int FROM audit_log WHERE user_id = ${id})`,
        })
        .from(users)
        .where(eq(users.id, id));

      if (
        (refs?.movements ?? 0) > 0 ||
        (refs?.batches ?? 0) > 0 ||
        (refs?.history ?? 0) > 0 ||
        (refs?.audits ?? 0) > 0
      ) {
        return res.status(409).json({
          error:
            'This user has recorded production or audit history and cannot be deleted. Click Deactivate to revoke their login access immediately.',
        });
      }

      await db.delete(notifications).where(eq(notifications.userId, id));
      await db.delete(users).where(eq(users.id, id));

      await db.insert(auditLog).values({
        userId: req.authUser!.id,
        action: 'REMOVE_USER',
        entity: 'user',
        entityId: String(id),
        details: JSON.stringify({ email: target.email }),
      });

      res.json({ removedId: id });
    } catch (err) {
      handleRouteError(res, err, 'Failed to remove user');
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
    console.log(`Abone Cut Pieces Tracking server listening on http://0.0.0.0:${port}`);
  });
}

startServer();
