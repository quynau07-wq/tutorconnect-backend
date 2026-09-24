import { getMessaging } from 'firebase-admin/messaging';
import { db } from './config/firebase.js';
import { contractLessons } from './domain/lessonSchedule.js';
import { activity } from './domain/activity.js';
export async function notificationTick() {
  const now = Date.now();
  const contracts = await db.collection('learning_contracts').get();
  for (const doc of contracts.docs) {
    const c = doc.data();
    if (
      c.status === 'WAIT_FIRST_PAYMENT' &&
      c.reservationExpiresAtMs &&
      c.reservationExpiresAtMs <= now
    ) {
      await db.runTransaction(async tx => {
        const latest = (await tx.get(doc.ref)).data();
        if (
          latest?.status === 'WAIT_FIRST_PAYMENT' &&
          latest.reservationExpiresAtMs <= now
        ) {
          tx.update(doc.ref, {
            status: 'VOID',
            voidReason: 'Hết thời gian giữ lịch',
          });
          activity(
            tx,
            doc.id,
            latest,
            'SYSTEM',
            'Đăng ký hết thời gian giữ lịch 30 phút',
          );
        }
      });
      continue;
    }
    for (const lesson of contractLessons(doc.id, c)) {
      const time = Date.parse(`${lesson.date}T${lesson.startTime}:00+07:00`);
      if (lesson.status !== 'UPCOMING' || time - now > 3600000 || time <= now)
        continue;
      for (const uid of [c.userId, c.tutorId]) {
        const id = `reminder_${doc.id}_${lesson.lessonIndex}_${time}_${uid}`;
        const ref = db.collection('notifications').doc(id);
        await db.runTransaction(async tx => {
          if ((await tx.get(ref)).exists) return;
          tx.create(ref, {
            uid,
            contractId: doc.id,
            lessonIndex: lesson.lessonIndex,
            title: `Sắp đến buổi ${lesson.lessonIndex + 1}: ${
              lesson.subject
            } lúc ${lesson.startTime}`,
            kind: 'REMINDER',
            createdAtMs: now,
            read: false,
            pushed: false,
          });
        });
      }
    }
  }
  const pending = await db
    .collection('notifications')
    .where('pushed', '==', false)
    .get();
  for (const doc of pending.docs) {
    const n = doc.data();
    const claimed = await db.runTransaction(async tx => {
      const latest = (await tx.get(doc.ref)).data();
      if (!latest || latest.pushed || (latest.leaseUntilMs || 0) > now) return false;
      tx.update(doc.ref, {leaseUntilMs: now + 120000, attempts: (latest.attempts || 0) + 1});
      return true;
    });
    if (!claimed) continue;
    const settings = (
      await db.collection('notification_settings').doc(n.uid).get()
    ).data();
    const user = (await db.collection('users').doc(n.uid).get()).data();
    if (
      !user ||
      user.disabled ||
      user.accountStatus === 'locked' ||
      settings?.notifications === false ||
      (n.kind === 'REMINDER' && settings?.reminders === false) ||
      now - n.createdAtMs > 86400000
    ) {
      await doc.ref.update({ pushed: true, leaseUntilMs: 0, deliveryStatus: 'SKIPPED' });
      continue;
    }
    const devices = await db
      .collection('push_devices')
      .where('uid', '==', n.uid)
      .get();
    let failed = false;
    let sent = 0;
    for (const device of devices.docs) {
      try {
        await getMessaging().send({
          token: device.data().token,
          notification: {
            title: 'TutorConnect',
            body: 'Bạn có cập nhật mới. Mở ứng dụng để xem chi tiết.',
          },
          data: { notificationId: doc.id, uid: n.uid },
          android: { priority: 'high', notification: {tag: doc.id} },
        });
        sent++;
      } catch (e: any) {
        if (
          [
            'messaging/registration-token-not-registered',
            'messaging/invalid-registration-token',
          ].includes(e.code)
        )
          await device.ref.delete();
        else failed = true;
      }
    }
    await doc.ref.update({pushed: !failed, leaseUntilMs: 0, deliveryStatus: failed ? 'RETRY' : sent ? 'SENT' : 'INBOX_ONLY'});
  }
}
export function startNotificationWorker() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await notificationTick();
    } catch {
      console.error('Không thể cập nhật thông báo; sẽ thử lại.');
    } finally {
      running = false;
    }
  };
  void tick();
  return setInterval(() => void tick(), 60000);
}
