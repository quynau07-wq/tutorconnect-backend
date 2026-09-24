import type {NextFunction, Request, Response} from 'express';
import {adminAuth} from '../config/firebase.js';

declare global {
  namespace Express {
    interface Request {
      firebaseUser?: Awaited<ReturnType<typeof adminAuth.verifyIdToken>>;
    }
  }
}

export const requireAuth = async (
  request: Request,
  response: Response,
  next: NextFunction,
) => {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : undefined;

  if (!token) {
    response.status(401).json({message: 'Missing Firebase ID token'});
    return;
  }

  try {
    request.firebaseUser = await adminAuth.verifyIdToken(token, true);
    next();
  } catch {
    response.status(401).json({message: 'Invalid or expired Firebase ID token'});
  }
};
