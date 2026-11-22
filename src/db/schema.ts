import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').unique(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  role: text('role').notNull().default('viewer'), // 'admin' | 'store_keeper' | 'operator' | 'viewer'
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const materials = pgTable('materials', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  unit: text('unit').notNull(),
  reorderLevel: doublePrecision('reorder_level').notNull().default(0),
  reorderAlertSent: boolean('reorder_alert_sent').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const stages = pgTable('stages', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  sequence: integer('sequence').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const batches = pgTable('batches', {
  id: text('id').primaryKey(),
  materialId: integer('material_id')
    .references(() => materials.id)
    .notNull(),
  currentStageId: integer('current_stage_id')
    .references(() => stages.id)
    .notNull(),
  quantity: doublePrecision('quantity').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  createdBy: integer('created_by')
    .references(() => users.id)
    .notNull(),
});

export const batchStageHistory = pgTable('batch_stage_history', {
  id: serial('id').primaryKey(),
  batchId: text('batch_id')
    .references(() => batches.id)
    .notNull(),
  stageId: integer('stage_id')
    .references(() => stages.id)
    .notNull(),
  movedAt: timestamp('moved_at', { withTimezone: true }).defaultNow().notNull(),
  movedBy: integer('moved_by')
    .references(() => users.id)
    .notNull(),
  note: text('note'),
});

export const stockMovements = pgTable('stock_movements', {
  id: serial('id').primaryKey(),
  materialId: integer('material_id')
    .references(() => materials.id)
    .notNull(),
  type: text('type').notNull(), // 'receipt' | 'issue' | 'adjustment'
  quantity: doublePrecision('quantity').notNull(),
  batchId: text('batch_id').references(() => batches.id),
  isOpening: boolean('is_opening').notNull().default(false),
  reason: text('reason'),
  movementDate: timestamp('movement_date', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  userId: integer('user_id')
    .references(() => users.id)
    .notNull(),
  note: text('note'),
});

export const notifications = pgTable('notifications', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id)
    .notNull(),
  type: text('type').notNull(), // 'reorder_alert' | 'stage_advanced'
  title: text('title').notNull(),
  message: text('message').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  emailSent: boolean('email_sent').notNull().default(false),
  emailRecipientsCount: integer('email_recipients_count').notNull().default(0),
  isRead: boolean('is_read').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const emailRecipients = pgTable('email_recipients', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id)
    .notNull(),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  details: text('details'),
  timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  batches: many(batches),
  stockMovements: many(stockMovements),
  notifications: many(notifications),
  auditLogs: many(auditLog),
}));

export const materialsRelations = relations(materials, ({ many }) => ({
  batches: many(batches),
  stockMovements: many(stockMovements),
}));

export const stagesRelations = relations(stages, ({ many }) => ({
  batches: many(batches),
  history: many(batchStageHistory),
}));

export const batchesRelations = relations(batches, ({ one, many }) => ({
  material: one(materials, {
    fields: [batches.materialId],
    references: [materials.id],
  }),
  currentStage: one(stages, {
    fields: [batches.currentStageId],
    references: [stages.id],
  }),
  creator: one(users, {
    fields: [batches.createdBy],
    references: [users.id],
  }),
  history: many(batchStageHistory),
  stockMovements: many(stockMovements),
}));

export const batchStageHistoryRelations = relations(batchStageHistory, ({ one }) => ({
  batch: one(batches, {
    fields: [batchStageHistory.batchId],
    references: [batches.id],
  }),
  stage: one(stages, {
    fields: [batchStageHistory.stageId],
    references: [stages.id],
  }),
  mover: one(users, {
    fields: [batchStageHistory.movedBy],
    references: [users.id],
  }),
}));

export const stockMovementsRelations = relations(stockMovements, ({ one }) => ({
  material: one(materials, {
    fields: [stockMovements.materialId],
    references: [materials.id],
  }),
  batch: one(batches, {
    fields: [stockMovements.batchId],
    references: [batches.id],
  }),
  user: one(users, {
    fields: [stockMovements.userId],
    references: [users.id],
  }),
}));
