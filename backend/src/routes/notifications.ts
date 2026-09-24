import { Router } from 'express';
import { createHash } from 'node:crypto';
import { db } from '../config/firebase.js';
import { requireAuth } from '../middleware/auth.js';
import { account } from './profile.js';
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);
notificationsRouter.get('/', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  await account(uid);
  const docs = await db
    .collection('notifications')
    .where('uid', '==', uid)
    .get();
  res.json(
    docs.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a: any, b: any) => b.createdAtMs - a.createdAtMs)
      .slice(0, 100),
  );
});
notificationsRouter.post('/:id/read', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  await account(uid);
  const ref = db.collection('notifications').doc(String(req.params.id));
  await db.runTransaction(async tx => {
    const data = (await tx.get(ref)).data();
    if (data?.uid !== uid) throw new Error('Không có quyền.');
    tx.update(ref, { read: true });
  });
  res.json({ ok: true });
});
notificationsRouter.get('/settings/current', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  await account(uid);
  const data = (
    await db.collection('notification_settings').doc(uid).get()
  ).data();
  res.json({
    notifications: data?.notifications ?? true,
    reminders: data?.reminders ?? true,
  });
});
notificationsRouter.put('/settings/current', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  await account(uid);
  if (
    typeof req.body.notifications !== 'boolean' ||
    typeof req.body.reminders !== 'boolean'
  )
    throw new Error('Cài đặt không hợp lệ.');
  await db
    .collection('notification_settings')
    .doc(uid)
    .set({
      notifications: req.body.notifications,
      reminders: req.body.reminders,
    });
  res.json({ ok: true });
});
notificationsRouter.post('/devices/register', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  await account(uid);
  const token = req.body.token;
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096)
    throw new Error('Token không hợp lệ.');
  await db
    .collection('push_devices')
    .doc(createHash('sha256').update(token).digest('hex'))
    .set({ uid, token, updatedAtMs: Date.now() });
  res.json({ ok: true });
});
notificationsRouter.post('/devices/remove', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  await account(uid);
  if (typeof req.body.token !== 'string')
    throw new Error('Token không hợp lệ.');
  const ref = db
    .collection('push_devices')
    .doc(createHash('sha256').update(req.body.token).digest('hex'));
  await db.runTransaction(async tx => {
    if ((await tx.get(ref)).data()?.uid === uid) tx.delete(ref);
  });
  res.json({ ok: true });
});
notificationsRouter.get('/tasks/current', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  const user = await account(uid);
  const docs = await db
    .collection('learning_contracts')
    .where(user.role === 'tutor' ? 'tutorId' : 'userId', '==', uid)
    .get();
  const tasks: any[] = [];
  for (const doc of docs.docs) {
    const c = doc.data();
    if (['VOID', 'CANCELLED'].includes(c.status)) continue;
    if (
      user.role === 'user' &&
      ['WAIT_FIRST_PAYMENT', 'WAIT_BALANCE', 'AWAIT_DECISION'].includes(
        c.status,
      )
    )
      tasks.push({
        id: doc.id,
        title:
          c.status === 'AWAIT_DECISION'
            ? 'Quyết định sau buổi đầu'
            : 'Gói học đang chờ thanh toán',
        contractId: doc.id,
      });
    for (const [i, r] of Object.entries(c.lessonRecords || {}) as [
      string,
      any,
    ][]) {
      const title =
        r.change?.status === 'PENDING' && r.change.requestedBy !== uid
          ? 'Phản hồi đề nghị đổi lịch'
          : user.role === 'user' && r.attendance?.status === 'REPORTED'
          ? 'Xác nhận buổi học'
          : user.role === 'user' && r.journal?.homework && !r.homeworkDone
          ? 'Bài tập chưa hoàn thành'
          : '';
      if (title)
        tasks.push({
          id: `${doc.id}:${i}`,
          title,
          contractId: doc.id,
          lessonIndex: Number(i),
        });
    }
  }
  res.json(tasks);
});
