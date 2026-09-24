import {completeLesson} from '../domain/completeLesson.js';
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { account, tutorStatus } from './profile.js';
import { packageQuote } from '../domain/packages.js';
import { matchSchedule } from '../domain/schedule.js';
import {checkBooking} from '../domain/bookingLocks.js';
import {activity} from '../domain/activity.js';
import {momoConfig} from '../services/momo.js';
import {momoCheckout} from '../domain/momoCheckout.js';
import {zaloConfig} from '../services/zalopay.js';
import {zaloCheckout} from '../domain/zalopayPayments.js';

export const contractsRouter = Router();
contractsRouter.use(requireAuth);
const present = (id: string, data: Record<string, any>, tutor = false) => {
  if (!tutor) return { id, ...data };
  const keys = [
    'tutorId',
    'tutorName',
    'learnerName',
    'subject',
    'packageLabel',
    'sessions',
    'schedule',
    'lessons',
    'mode',
    'location',
    'status',
    'rejectionReason',
    'decisionAt',
  ];
  return {
    id,
    ...Object.fromEntries(
      keys.filter(key => data[key] !== undefined).map(key => [key, data[key]]),
    ),
  };
};
contractsRouter.get('/', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  const user = await account(uid);
  const docs = await db
    .collection('learning_contracts')
    .where(user.role === 'tutor' ? 'tutorId' : 'userId', '==', uid)
    .get();
  const contracts = docs.docs.map(d =>
    present(d.id, d.data(), user.role === 'tutor'),
  );
  res.json({
    contracts,
    rejectionCount: contracts.filter((c: any) => c.status === 'CANCELLED')
      .length,
  });
});
contractsRouter.post('/', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  await account(uid, 'user');
  const body = req.body || {};
  for (const key of [
    'tutorId',
    'learnerId',
    'subject',
    'mode',
    'packageId',
    'startDate',
    'requestId',
  ])
    if (
      typeof body[key] !== 'string' ||
      !body[key].trim() ||
      body[key].length > 150 ||
      body[key].includes('/')
    )
      throw new Error('Thiếu thông tin đăng ký gói học.');
  const ref = db
    .collection('learning_contracts')
    .doc(createHash('sha256').update(`${uid}:${body.requestId}`).digest('hex'));
  await db.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (existing.exists) return;
    const [userDoc, profileDoc, learnerDoc] = await Promise.all([
      tx.get(db.collection('users').doc(body.tutorId)),
      tx.get(db.collection('tutor_profiles').doc(body.tutorId)),
      tx.get(db.collection('learners').doc(body.learnerId)),
    ]);
    const user = userDoc.data();
    const profile = profileDoc.data();
    const learner = learnerDoc.data();
    if (
      !user ||
      user.role !== 'tutor' ||
      tutorStatus(user) !== 'APPROVED' ||
      !profile
    )
      throw new Error('Gia sư chưa được duyệt hoặc không hoạt động.');
    if (!learner || learner.userId !== uid)
      throw new Error('Người học không hợp lệ.');
    if (
      !profile.subjects?.includes(body.subject) ||
      !profile.grades?.includes(learner.grade)
    )
      throw new Error('Gia sư không dạy môn hoặc trình độ của người học.');
    if (
      !['ONLINE', 'LEARNER_HOME', 'TUTOR_HOME'].includes(body.mode) ||
      !profile.teachingModes?.includes(body.mode)
    )
      throw new Error('Hình thức học không hợp lệ.');
    const location =
      typeof body.location === 'string' ? body.location.trim() : '';
    if (location.length > 1000 || (body.mode !== 'ONLINE' && !location))
      throw new Error('Vui lòng nhập địa điểm học.');
    const quote = packageQuote(
      body.packageId,
      body.schedule,
      body.mode === 'ONLINE' ? profile.onlinePrice : profile.offlinePrice,
      profile.priceUnit,
      body.startDate,
    );
    if (
      matchSchedule(body.schedule, profile.availability || []).scheduleScore !==
      100
    )
      throw new Error('Lịch học phải nằm trong lịch rảnh của gia sư.');
    const lessons = quote.lessons;
    if (
      Date.parse(`${lessons[0].date}T${lessons[0].startTime}:00+07:00`) <=
      Date.now()
    )
      throw new Error('Buổi đầu phải ở thời điểm tương lai.');
    const releaseLock = await checkBooking(tx, {tutorId: body.tutorId, learnerId: body.learnerId, userId: uid, lessons}, ref.id);
    releaseLock();
    tx.create(ref, {
      ...quote,
      userId: uid,
      tutorId: body.tutorId,
      tutorName: user.displayName || '',
      learnerId: body.learnerId,
      learnerName: learner.fullName,
      subject: body.subject,
      mode: body.mode,
      location,
      schedule: body.schedule,
      lessons,
      status: 'WAIT_FIRST_PAYMENT',
      reservationExpiresAtMs: Date.now() + 30 * 60 * 1000,
      recipient: 'CENTER',
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  res.status(201).json({ id: ref.id });
});
contractsRouter.post('/:id/decision', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  await account(uid, 'user');
  if (!['ACCEPT', 'REJECT'].includes(req.body.decision))
    throw new Error('Quyết định không hợp lệ.');
  const reason =
    typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (req.body.decision === 'REJECT' && (!reason || reason.length > 2000))
    throw new Error('Vui lòng ghi lý do từ chối (tối đa 2000 ký tự).');
  const ref = db.collection('learning_contracts').doc(String(req.params.id));
  await db.runTransaction(async tx => {
    const data = (await tx.get(ref)).data();
    if (!data || data.userId !== uid)
      throw new Error('Không tìm thấy hợp đồng.');
    const target =
      req.body.decision === 'ACCEPT' ? 'WAIT_BALANCE' : 'CANCELLED';
    if (data.status === target) return;
    if (data.status !== 'AWAIT_DECISION')
      throw new Error(
        'Chỉ quyết định sau khi trung tâm xác nhận buổi đầu hoàn thành.',
      );
    tx.update(ref, {
      status: target,
      rejectionReason: target === 'CANCELLED' ? reason : '',
      rejectionCategory: target === 'CANCELLED' && ['METHOD', 'PUNCTUALITY', 'COMMUNICATION', 'CHANGED_NEEDS', 'OTHER'].includes(req.body.category) ? req.body.category : 'OTHER',
      decisionAt: FieldValue.serverTimestamp(),
    });
    activity(tx, ref.id, data, uid, target === 'CANCELLED' ? 'Người học đã từ chối sau buổi đầu' : 'Người học đã đồng ý tiếp tục gói học');
  });
  res.json({ ok: true });
});
contractsRouter.post('/:id/cancel-unpaid', async (req, res) => {
  const uid = req.firebaseUser!.uid; await account(uid, 'user');
  const ref = db.collection('learning_contracts').doc(String(req.params.id));
  await db.runTransaction(async tx => {
    const data = (await tx.get(ref)).data();
    if (!data || data.userId !== uid || data.status !== 'WAIT_FIRST_PAYMENT') throw new Error('Chỉ hủy đăng ký chưa thanh toán buổi đầu.');
    tx.update(ref, {status: 'VOID'}); activity(tx, ref.id, data, uid, 'Đăng ký chưa thanh toán đã hủy, lịch được giải phóng');
  }); res.json({ok: true});
});
contractsRouter.get('/admin/all', ...requireAdmin, async (_req, res) => {
  const docs = await db.collection('learning_contracts').get();
  res.json(docs.docs.map(d => present(d.id, d.data())));
});
contractsRouter.get('/admin/reconciliation', ...requireAdmin, async (_req, res) => {
  const docs = await db.collection('payment_reconciliation').get();
  res.json(docs.docs.map(d => ({id: d.id, ...d.data()})));
});
contractsRouter.post('/:id/checkout', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  await account(uid, 'user');
  const data = (await db.collection('learning_contracts').doc(String(req.params.id)).get()).data();
  if (!data || data.userId !== uid) throw new Error('Không tìm thấy hợp đồng.');
  if (!['WAIT_FIRST_PAYMENT', 'WAIT_BALANCE'].includes(data.status)) throw new Error('Hợp đồng không có khoản thanh toán đang chờ.');
  if ((process.env.PAYMENT_PROVIDER || 'zalopay') === 'zalopay') {
    const config = zaloConfig();
    if (!config) {
      res.status(503).json({message: 'Chưa cấu hình ZaloPay sandbox. Chế độ query cần App ID và Key 1; chế độ callback cần thêm Key 2 và URL HTTPS.'});
      return;
    }
    res.json(await zaloCheckout(String(req.params.id), uid, config));
    return;
  }
  if (process.env.PAYMENT_PROVIDER !== 'momo') throw new Error('Cổng thanh toán chưa được hỗ trợ.');
  const config = momoConfig();
  if (!config) {
    res.status(503).json({message: 'Trung tâm chưa cấu hình MoMo sandbox. Gói học đã được lưu; vui lòng thử lại sau.'});
    return;
  }
  res.json(await momoCheckout(String(req.params.id), uid, config));
});
contractsRouter.post('/admin/:id/complete-first', ...requireAdmin, async (req, res) => {
  await completeLesson(String(req.params.id), 0, req.firebaseUser!.uid);
  res.json({ok: true});
});
contractsRouter.post('/admin/:id/lessons/:index/complete', ...requireAdmin, async (req, res) => {
  await completeLesson(String(req.params.id), /^\d+$/.test(String(req.params.index)) ? Number(req.params.index) : -1, req.firebaseUser!.uid);
  res.json({ok: true});
});
