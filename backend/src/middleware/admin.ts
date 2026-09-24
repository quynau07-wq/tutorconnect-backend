import type {NextFunction, Request, Response} from 'express';
import {requireAuth} from './auth.js';
import {db} from '../config/firebase.js';

const adminEmails = new Set(
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean),
);

const superAdminEmails = new Set(
  (process.env.SUPER_ADMIN_EMAILS || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean),
);

const resolveAdmin = async (request: Request) => {
  const email = request.firebaseUser?.email?.toLowerCase();
  if (!email) return null;

  if (superAdminEmails.has(email) || adminEmails.has(email)) {
    const role: 'admin' | 'super_admin' = superAdminEmails.has(email)
      ? 'super_admin'
      : 'admin';
    return {role, email};
  }

  const snapshot = await db.collection('adminProfiles').doc(request.firebaseUser!.uid).get();
  if (!snapshot.exists || snapshot.data()?.disabled || snapshot.data()?.accountStatus === 'locked') return null;
  return {role: 'admin' as const, email, ...snapshot.data()};
};

export const requireAdmin = [
  requireAuth,
  async (request: Request, response: Response, next: NextFunction) => {
    const admin = await resolveAdmin(request);
    if (!admin) {
      response.status(403).json({message: 'Admin access required'});
      return;
    }

    request.admin = admin;
    next();
  },
];

export const requireSuperAdmin = [
  ...requireAdmin,
  (request: Request, response: Response, next: NextFunction) => {
    if (request.admin?.role !== 'super_admin') {
      response.status(403).json({message: 'Super admin access required'});
      return;
    }
    next();
  },
];

declare global {
  namespace Express {
    interface Request {
      admin?: {role: 'admin' | 'super_admin'; email: string; [key: string]: unknown};
    }
  }
}
