import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import { db } from '../config/firebase.js';
type Slot = { date: string; startTime: string; endTime: string };
export const overlaps = (a: Slot, b: Slot) =>
  a.date === b.date && a.startTime < b.endTime && b.startTime < a.endTime;
// All schedule writers lock both participants, including when the query is empty.
export async function checkBooking(
  tx: Transaction,
  data: Record<string, any>,
  skipId: string,
) {
  const lockIds = [
    `tutor:${data.tutorId}`,
    `learner:${data.learnerId || data.userId}`,
  ].sort();
  const refs = lockIds.map(id =>
    db
      .collection('schedule_locks')
      .doc(createHash('sha256').update(id).digest('hex')),
  );
  for (const ref of refs) await tx.get(ref);
  const tutor = await tx.get(
    db.collection('learning_contracts').where('tutorId', '==', data.tutorId),
  );
  const learner = data.learnerId
    ? await tx.get(
        db
          .collection('learning_contracts')
          .where('learnerId', '==', data.learnerId),
      )
    : { docs: [] };
  const others = new Map(
    [...tutor.docs, ...learner.docs].map(d => [d.id, d.data()]),
  );
  for (const [id, other] of others) {
    if (
      id === skipId ||
      ['CANCELLED', 'COMPLETED', 'VOID'].includes(other.status)
    )
      continue;
    if (
      (data.lessons as Slot[]).some(slot =>
        (other.lessons || []).some((existing: Slot) =>
          overlaps(slot, existing),
        ),
      )
    )
      throw new Error(
        'Trùng lịch gia sư hoặc người học. Vui lòng chọn khung giờ khác.',
      );
  }
  return () =>
    refs.forEach(ref =>
      tx.set(ref, { updatedAt: FieldValue.serverTimestamp() }),
    );
}
