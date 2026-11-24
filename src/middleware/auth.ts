import type { Request, Response, NextFunction } from 'express';
import { eq, sql } from 'drizzle-orm';
import { adminAuth } from '../lib/firebase-admin.ts';
import { verifySessionToken } from '../lib/security.ts';
import { db } from '../db/index.ts';
import { users } from '../db/schema.ts';
import type { UserRole } from '../lib/roles.ts';

export interface AuthenticatedUser {
  id: number;
  uid: string | null;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
}

export interface AuthRequest extends Request {
  authUser?: AuthenticatedUser;
}

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing authentication token' });
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Empty authentication token' });
  }

  try {
    // 1. Try server-signed email/password session token first if prefixed with ff.
    if (token.startsWith('ff.')) {
      const payload = verifySessionToken(token);
      if (!payload) {
        return res.status(401).json({ error: 'Unauthorized: Session expired or invalid' });
      }
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, payload.sub))
        .limit(1);
      const dbUser = rows[0];
      if (!dbUser || !dbUser.active) {
        return res.status(403).json({ error: 'Account is inactive or no longer registered' });
      }
      req.authUser = {
        id: dbUser.id,
        uid: dbUser.uid,
        name: dbUser.name,
        email: dbUser.email,
        role: dbUser.role as UserRole,
        active: dbUser.active,
      };
      return next();
    }

    // 2. Otherwise verify Firebase ID Token (Google OAuth)
    const decoded = await adminAuth.verifyIdToken(token);
    const email = (decoded.email ?? '').trim().toLowerCase();
    if (!email) {
      return res.status(401).json({ error: 'Unauthorized: Verified account has no email' });
    }

    // Password-only fallback admin account cannot authenticate via Google OAuth
    if (email === 'admin@protrack.com') {
      return res.status(403).json({ error: 'Access Denied: Unauthorized Email' });
    }

    // Look up user strictly by lowercase email in the whitelist table
    const dbUserRows = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);

    let dbUser = dbUserRows[0];

    // If database has zero users at all, only allow bootstrapping the primary owner email
    if (!dbUser) {
      const existingCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(users);
      if ((existingCount[0]?.count ?? 0) === 0 && email === 'mhdthameem28work@gmail.com') {
        const inserted = await db
          .insert(users)
          .values({
            uid: decoded.uid,
            name: decoded.name || 'System Administrator',
            email,
            role: 'admin',
            active: true,
          })
          .onConflictDoUpdate({
            target: users.email,
            set: { uid: decoded.uid },
          })
          .returning();
        dbUser = inserted[0];
      } else {
        return res.status(403).json({
          error: 'Access Denied: Unauthorized Email',
        });
      }
    } else if (!dbUser.active) {
      return res.status(403).json({
        error: 'Access Denied: Unauthorized Email',
      });
    } else if (!dbUser.uid) {
      // Bind Firebase UID to the whitelisted user record
      const updated = await db
        .update(users)
        .set({
          uid: decoded.uid,
          name: dbUser.name || decoded.name || email.split('@')[0],
        })
        .where(eq(users.id, dbUser.id))
        .returning();
      dbUser = updated[0];
    }

    req.authUser = {
      id: dbUser.id,
      uid: dbUser.uid,
      name: dbUser.name,
      email: dbUser.email,
      role: dbUser.role as UserRole,
      active: dbUser.active,
    };
    return next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
};

export const requireRole = (allowedRoles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.authUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!allowedRoles.includes(req.authUser.role)) {
      return res.status(403).json({
        error: `Forbidden: ${req.authUser.role} role does not have permission for this action`,
      });
    }
    return next();
  };
};
