import { randomUUID } from 'node:crypto';
import { type Transaction } from 'firebase-admin/firestore';
import { db } from '../config/firebase.js';
export function activity(
  tx: Transaction,
  contractId: string,
  data: Record<string, any>,
  actor: string,
  title: string,
  index?: number,
) {
  const id = randomUUID();
  const createdAtMs = Date.now();
  tx.create(db.collection('activity_log').doc(id), {
    contractId,
    actor,
    title,
    ...(index !== undefined && { lessonIndex: index }),
    createdAtMs,
  });
  for (const uid of new Set([data.userId, data.tutorId])) {
    if (!uid || uid === actor) continue;
    tx.create(db.collection('notifications').doc(`${id}_${uid}`), {
      uid,
      title,
      contractId,
      ...(index !== undefined && { lessonIndex: index }),
      createdAtMs,
      read: false,
      kind: 'EVENT',
      tutor: uid === data.tutorId,
      target: contractId ? (index !== undefined ? 'LessonDetail' : 'LearningContracts') : uid === data.tutorId ? 'Applications' : 'MyTutorRequests',
      pushed: false,
    });
  }
}
