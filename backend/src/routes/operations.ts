import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../config/firebase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { account } from './profile.js';
import { contractLessons, weekBounds } from '../domain/lessonSchedule.js';
import { validateSchedule, minutes } from '../domain/schedule.js';
import { validDate } from '../domain/profiles.js';
import { checkBooking, overlaps } from '../domain/bookingLocks.js';
import { activity } from '../domain/activity.js';
import { completionPatch } from '../domain/completeLesson.js';

export const operationsRouter = Router();
operationsRouter.use(requireAuth);
operationsRouter.get('/admin/activity', ...requireAdmin, async (_req,res)=>{
  const [events,notices]=await Promise.all([db.collection('activity_log').get(),db.collection('notifications').get()]);
  res.json({events:events.docs.map(d=>({id:d.id,...d.data()})).sort((a:any,b:any)=>b.createdAtMs-a.createdAtMs).slice(0,100),notifications:{total:notices.docs.length,waiting:notices.docs.filter(d=>!d.data().pushed).length,retry:notices.docs.filter(d=>d.data().deliveryStatus==='RETRY').length}});
});
const text = (value: unknown, required = false) => {
  if (
    typeof value !== 'string' ||
    value.length > 5000 ||
    (required && !value.trim())
  )
    throw new Error('Nội dung phải từ 1 đến 5000 ký tự.');
  return value.trim();
};
async function owned(uid: string, id: string) {
  const user = await account(uid);
  const ref = db.collection('learning_contracts').doc(id);
  const data = (await ref.get()).data();
  if (!data || data[user.role === 'tutor' ? 'tutorId' : 'userId'] !== uid)
    throw new Error('Không có quyền xem lớp học.');
  return { user, ref, data };
}
operationsRouter.get('/students', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  await account(uid, 'tutor');
  const docs = await db
    .collection('learning_contracts')
    .where('tutorId', '==', uid)
    .get();
  const students = new Map<string, any>();
  for (const doc of docs.docs) {
    const data = doc.data();
    if (data.status === 'VOID') continue;
    const id = data.learnerId || doc.id;
    const item = students.get(id) || {
      id,
      name: data.learnerName,
      subjects: [],
      contracts: [],
      done: 0,
      total: 0,
    };
    const lessons = contractLessons(doc.id, data);
    const done = lessons.filter(l => l.status === 'COMPLETED').length;
    const total = lessons.filter(l => l.status !== 'CANCELLED').length;
    item.done += done;
    item.total += total;
    item.subjects = [...new Set([...item.subjects, data.subject])];
    item.contracts.push({
      id: doc.id,
      packageLabel: data.packageLabel,
      status: data.status,
      done,
      total,
      lessons,
    });
    students.set(id, item);
  }
  res.json([...students.values()]);
});
operationsRouter.get('/class/:id', async (req, res) => {
  const { user, data } = await owned(
    req.firebaseUser!.uid,
    String(req.params.id),
  );
  res.json({
    role: user.role,
    records: data.lessonRecords || {},
    history: data.scheduleHistory || [],
    completed: Object.keys(data.completedLessons || {}),
  });
});
operationsRouter.post('/class/:id/lesson/:index/:action', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  const user = await account(uid);
  const id = String(req.params.id);
  const index = Number(req.params.index);
  const action = String(req.params.action);
  if (!/^\d+$/.test(String(req.params.index)) || !Number.isSafeInteger(index))
    throw new Error('Buổi học không hợp lệ.');
  const ref = db.collection('learning_contracts').doc(id);
  await db.runTransaction(async tx => {
    const data = (await tx.get(ref)).data();
    if (
      !data ||
      data[user.role === 'tutor' ? 'tutorId' : 'userId'] !== uid ||
      !data.lessons?.[index]
    )
      throw new Error('Không có quyền thao tác buổi học.');
    const lesson = contractLessons(id, data)[index];
    const records = { ...data.lessonRecords };
    const record = { ...records[index] };
    let title = '';
    let patch: Record<string, any> = {};
    let lock: (() => void) | undefined;
    if (action === 'journal') {
      if (
        user.role !== 'tutor' ||
        !['AWAIT_CONFIRMATION', 'COMPLETED'].includes(lesson.status)
      )
        throw new Error('Chỉ gia sư ghi nhật ký sau buổi học đã kích hoạt.');
      if ((req.body.homework || '').trim() !== (record.journal?.homework || '')) record.homeworkDone = false;
      record.journal = {
        content: text(req.body.content, true),
        feedback: text(req.body.feedback || ''),
        homework: text(req.body.homework || ''),
        nextGoal: text(req.body.nextGoal || ''),
        updatedAtMs: Date.now(),
      };
      title = 'Gia sư đã cập nhật nhật ký và bài tập';
    } else if (action === 'homework') {
      if (user.role !== 'user' || !record.journal?.homework)
        throw new Error('Không có bài tập để cập nhật.');
      if (typeof req.body.done !== 'boolean')
        throw new Error('Trạng thái không hợp lệ.');
      record.homeworkDone = req.body.done;
      title = 'Người học đã cập nhật tiến độ bài tập';
    } else if (action === 'report') {
      if (
        user.role !== 'tutor' ||
        lesson.status !== 'AWAIT_CONFIRMATION' ||
        record.change?.status === 'PENDING'
      )
        throw new Error(
          'Chỉ báo đã dạy sau giờ kết thúc và không có yêu cầu đổi lịch đang chờ.',
        );
      if (record.attendance?.status === 'REPORTED') return;
      if (record.attendance?.status === 'DISPUTED')
        throw new Error('Buổi học đang chờ trung tâm giải quyết.');
      if (record.attendance?.status === 'REOPENED')
        throw new Error('Cần thống nhất lịch học bù và dạy xong buổi mới trước khi báo hoàn thành.');
      record.attendance = { status: 'REPORTED', reportedAtMs: Date.now() };
      title = 'Gia sư báo đã dạy: vui lòng xác nhận buổi học';
    } else if (action === 'confirm' || action === 'dispute') {
      if (
        user.role !== 'user' ||
        record.attendance?.status !== 'REPORTED' ||
        lesson.status !== 'AWAIT_CONFIRMATION'
      )
        throw new Error('Buổi học chưa chờ xác nhận.');
      if (action === 'confirm') {
        patch = completionPatch(data, index, uid);
        record.attendance = {
          ...record.attendance,
          status: 'CONFIRMED',
          confirmedAtMs: Date.now(),
        };
        title = 'Phụ huynh đã xác nhận hoàn thành buổi học';
      } else {
        record.attendance = {
          ...record.attendance,
          status: 'DISPUTED',
          reason: text(req.body.reason, true),
        };
        title = 'Buổi học có phản hồi cần trung tâm xử lý';
      }
    } else if (action === 'change') {
      if (
        !['UPCOMING', 'AWAIT_CONFIRMATION'].includes(lesson.status) ||
        record.attendance?.status === 'REPORTED' ||
        record.attendance?.status === 'DISPUTED'
      )
        throw new Error(
          'Không thể đổi buổi chưa kích hoạt, đang học hoặc chờ xác nhận hai phía.',
        );
      if (record.change?.status === 'PENDING')
        throw new Error('Đã có đề nghị đang chờ.');
      const proposed = {
        date: text(req.body.date, true),
        startTime: text(req.body.startTime, true),
        endTime: text(req.body.endTime, true),
      };
      if (
        !validDate(proposed.date) ||
        validateSchedule([
          {
            dayOfWeek: 'MONDAY',
            startTime: proposed.startTime,
            endTime: proposed.endTime,
          },
        ]) ||
        minutes(proposed.endTime) - minutes(proposed.startTime) !==
          minutes(lesson.endTime) - minutes(lesson.startTime) ||
        Date.parse(`${proposed.date}T${proposed.startTime}:00+07:00`) <=
          Date.now()
      )
        throw new Error(
          'Ngày giờ học bù phải ở tương lai và giữ nguyên thời lượng.',
        );
      record.change = {
        id: randomUUID(),
        ...proposed,
        reason: text(req.body.reason, true),
        requestedBy: uid,
        status: 'PENDING',
        createdAtMs: Date.now(),
        original: data.lessons[index],
      };
      title = 'Có đề nghị đổi lịch / học bù cần phản hồi';
    } else if (action === 'change-response') {
      const change = record.change;
      if (
        !change ||
        change.status !== 'PENDING' ||
        change.requestedBy === uid ||
        change.id !== req.body.changeId ||
        !['ACCEPT', 'REJECT'].includes(req.body.decision)
      )
        throw new Error(
          'Đề nghị không hợp lệ hoặc không thuộc lượt phản hồi của bạn.',
        );
      if (req.body.decision === 'ACCEPT') {
        if (!['UPCOMING', 'AWAIT_CONFIRMATION'].includes(lesson.status))
          throw new Error('Trạng thái buổi học đã thay đổi.');
        if (
          Date.parse(`${change.date}T${change.startTime}:00+07:00`) <=
          Date.now()
        )
          throw new Error(
            'Lịch đề nghị đã qua. Vui lòng từ chối và tạo đề nghị mới.',
          );
        const proposed = {
          date: change.date,
          startTime: change.startTime,
          endTime: change.endTime,
        };
        const lessons = data.lessons.map((l: any, i: number) =>
          i === index ? proposed : l,
        );
        if (
          lessons.some(
            (l: any, i: number) => i !== index && overlaps(l, proposed),
          )
        )
          throw new Error('Trùng buổi khác trong gói.');
        const week = weekBounds(change.date);
        if (
          lessons.filter((l: any) => l.date >= week.start && l.date <= week.end)
            .length > 2
        )
          throw new Error('Không vượt quá 2 buổi/tuần.');
        if (
          index > 0 &&
          `${proposed.date} ${proposed.startTime}` <=
            `${lessons[0].date} ${lessons[0].startTime}`
        )
          throw new Error('Buổi còn lại phải sau buổi đầu.');
        if (
          index === 0 &&
          lessons.some(
            (l: any, i: number) =>
              i > 0 &&
              `${l.date} ${l.startTime}` <=
                `${proposed.date} ${proposed.startTime}`,
          )
        )
          throw new Error('Buổi đầu phải trước các buổi còn lại.');
        lock = await checkBooking(tx, { ...data, lessons }, id);
        patch.lessons = lessons;
        if (record.attendance?.status === 'REOPENED') {
          record.attendanceHistory = [...(record.attendanceHistory || []), {...record.attendance}];
          record.attendance = {
            status: 'MAKEUP_SCHEDULED',
            resolution: record.attendance.resolution,
            scheduledAtMs: Date.now(),
          };
        }
      }
      record.change = {
        ...change,
        status: req.body.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
        respondedAtMs: Date.now(),
        respondedBy: uid,
      };
      patch.scheduleHistory = [
        ...(data.scheduleHistory || []),
        { ...record.change, lessonIndex: index },
      ];
      title =
        req.body.decision === 'ACCEPT'
          ? 'Lịch học đã được thay đổi'
          : 'Đề nghị đổi lịch đã bị từ chối';
    } else throw new Error('Thao tác không hợp lệ.');
    records[index] = record;
    lock?.();
    tx.update(ref, { ...patch, lessonRecords: records });
    activity(tx, id, data, uid, title, index);
  });
  res.json({ ok: true });
});
operationsRouter.get('/admin/classes', ...requireAdmin, async (_req, res) => {
  const docs = await db.collection('learning_contracts').get();
  res.json(
    docs.docs.map(d => ({
      id: d.id,
      ...d.data(),
      lessons: contractLessons(d.id, d.data()),
    })),
  );
});
operationsRouter.post(
  '/admin/:id/:index/resolve',
  ...requireAdmin,
  async (req, res) => {
    const ref = db.collection('learning_contracts').doc(String(req.params.id));
    const index = Number(req.params.index);
    if (!Number.isSafeInteger(index) || index < 0)
      throw new Error('Buổi không hợp lệ.');
    const note = text(req.body.note, true);
    if (!['COMPLETE', 'REOPEN'].includes(req.body.decision))
      throw new Error('Quyết định không hợp lệ.');
    await db.runTransaction(async tx => {
      const data = (await tx.get(ref)).data();
      const records = { ...data?.lessonRecords };
      const record = { ...records[index] };
      if (!data || record.attendance?.status !== 'DISPUTED')
        throw new Error('Không có tranh chấp đang chờ.');
      const patch =
        req.body.decision === 'COMPLETE'
          ? completionPatch(data, index, req.firebaseUser!.uid)
          : {};
      record.attendance = {
        ...record.attendance,
        status: req.body.decision === 'COMPLETE' ? 'CONFIRMED' : 'REOPENED',
        resolution: note,
        resolvedBy: req.firebaseUser!.uid,
      };
      records[index] = record;
      tx.update(ref, { ...patch, lessonRecords: records });
      activity(
        tx,
        ref.id,
        data,
        req.firebaseUser!.uid,
        `Trung tâm đã xử lý phản hồi: ${note}`,
        index,
      );
    });
    res.json({ ok: true });
  },
);
