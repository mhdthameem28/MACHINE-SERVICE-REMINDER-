import type { Request } from 'express';

const MAX_CONSECUTIVE_FAILURES = 5;
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const FAILURE_RESET_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_KEYS = 10_000;

interface AttemptRecord {
  consecutiveFailures: number;
  lastFailureAt: number;
  blockedUntil: number;
}

const attemptStore = new Map<string, AttemptRecord>();

function pruneExpired(now: number) {
  if (attemptStore.size === 0) return;
  for (const [key, record] of attemptStore.entries()) {
    const isBlockExpired = record.blockedUntil > 0 && record.blockedUntil <= now;
    const isStale =
      record.blockedUntil === 0 && record.lastFailureAt + FAILURE_RESET_WINDOW_MS <= now;
    if (isBlockExpired || isStale) {
      attemptStore.delete(key);
    }
  }
  // Hard cap to avoid unbounded memory growth under spray attacks
  while (attemptStore.size > MAX_TRACKED_KEYS) {
    const oldestKey = attemptStore.keys().next().value;
    if (!oldestKey) break;
    attemptStore.delete(oldestKey);
  }
}

export function extractClientIp(req: Request): string {
  const raw = req.ip || req.socket?.remoteAddress || 'unknown';
  return String(raw).trim().toLowerCase() || 'unknown';
}

function buildKeys(ip: string, email?: string): string[] {
  const keys = [`ip:${ip}`];
  const normalizedEmail = (email ?? '').trim().toLowerCase();
  if (normalizedEmail) {
    keys.push(`email:${normalizedEmail}`);
  }
  return keys;
}

export function checkLoginRateLimit(
  ip: string,
  email?: string,
  now = Date.now()
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  pruneExpired(now);

  let maxBlockedUntil = 0;
  for (const key of buildKeys(ip, email)) {
    const record = attemptStore.get(key);
    if (!record) continue;
    if (record.blockedUntil > now) {
      if (record.blockedUntil > maxBlockedUntil) {
        maxBlockedUntil = record.blockedUntil;
      }
    }
  }

  if (maxBlockedUntil > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((maxBlockedUntil - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  return { allowed: true };
}

export function recordFailedLoginAttempt(
  ip: string,
  email?: string,
  now = Date.now()
): { blocked: boolean; retryAfterSeconds: number; consecutiveFailures: number } {
  pruneExpired(now);

  let maxFailures = 0;
  let blockedUntil = 0;

  for (const key of buildKeys(ip, email)) {
    const existing = attemptStore.get(key);
    const isExpired =
      !existing ||
      (existing.blockedUntil > 0 && existing.blockedUntil <= now) ||
      (existing.blockedUntil === 0 && existing.lastFailureAt + FAILURE_RESET_WINDOW_MS <= now);

    const nextFailures = isExpired ? 1 : existing.consecutiveFailures + 1;
    const nextBlockedUntil =
      nextFailures >= MAX_CONSECUTIVE_FAILURES ? now + BLOCK_DURATION_MS : 0;

    attemptStore.set(key, {
      consecutiveFailures: nextFailures,
      lastFailureAt: now,
      blockedUntil: nextBlockedUntil,
    });

    if (nextFailures > maxFailures) {
      maxFailures = nextFailures;
    }
    if (nextBlockedUntil > blockedUntil) {
      blockedUntil = nextBlockedUntil;
    }
  }

  return {
    blocked: blockedUntil > now,
    retryAfterSeconds: blockedUntil > now ? Math.ceil((blockedUntil - now) / 1000) : 0,
    consecutiveFailures: maxFailures,
  };
}

export function recordSuccessfulLogin(ip: string, email?: string) {
  for (const key of buildKeys(ip, email)) {
    attemptStore.delete(key);
  }
}
