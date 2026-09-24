import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import {cert, getApps, initializeApp} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore} from 'firebase-admin/firestore';

const envCandidates = [
  path.resolve(process.cwd(), 'backend/.env'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../backend/.env'),
];

const envPath = envCandidates.find(candidate => fs.existsSync(candidate));

dotenv.config(envPath ? {path: envPath} : undefined);

const backendRoot = envPath
  ? path.dirname(envPath)
  : path.resolve(process.cwd(), 'backend');

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  ? path.resolve(process.cwd(), process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
  : path.join(backendRoot, 'service-account.json');

const serviceAccount = fs.existsSync(serviceAccountPath)
  ? JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))
  : undefined;

const hasServiceAccount = Boolean(
  serviceAccount || (
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY &&
  process.env.FIREBASE_PRIVATE_KEY.includes('BEGIN PRIVATE KEY')
  ),
);

if (!hasServiceAccount) {
  throw new Error(
    'Firebase Admin credentials are missing. Set FIREBASE_SERVICE_ACCOUNT_PATH to a service-account JSON file or provide a complete FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in backend/.env.',
  );
}

const app = getApps()[0] || (hasServiceAccount
  ? initializeApp({
      credential: cert(serviceAccount || {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
      }),
    })
  : initializeApp());

export const adminAuth = getAuth(app);
export const db = getFirestore(app);
