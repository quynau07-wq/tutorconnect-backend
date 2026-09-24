import {activity} from '../domain/activity.js';
import {Router} from 'express';
import {FieldValue} from 'firebase-admin/firestore';
import {db} from '../config/firebase.js';
import {requireAuth} from '../middleware/auth.js';
import {requireAdmin} from '../middleware/admin.js';
import {account, tutorStatus} from './profile.js';
import {matchSchedule, validateSchedule} from '../domain/schedule.js';
import {validDate} from '../domain/profiles.js';
import {rankMonthlyTutors, vietnamMonth} from '../domain/tutorRanking.js';

export const learningRouter = Router();
learningRouter.use(requireAuth);
const text = (value: unknown, required = false) => {
  if (typeof value !== 'string' || value.length > 10000 || (required && !value.trim())) throw new Error('Vui lòng điền thông tin hợp lệ.');
  return value.trim();
};
const number = (value: unknown, min = 0, max = 100000000) => {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) throw new Error('Giá trị số không hợp lệ.');
  return Number(value);
};
export async function publicTutor(uid: string) {
  const [user, profile] = await Promise.all([db.collection('users').doc(uid).get(), db.collection('tutor_profiles').doc(uid).get()]);
  const data = user.data();
  if (!data || data.role !== 'tutor' || tutorStatus(data) !== 'APPROVED') throw new Error('Gia sư chưa được duyệt hoặc không hoạt động.');
  const p = {...data, ...profile.data()};
  const fields = ['displayName', 'photoURL', 'title', 'bio', 'subjects', 'grades', 'levels', 'university', 'major', 'educationLevel', 'experience', 'experienceYears', 'teachingMethod', 'strengths', 'achievements', 'teachingModes', 'teachingAreas', 'travelRadius', 'onlinePrice', 'offlinePrice', 'priceUnit', 'availability', 'identityVerified', 'educationVerified'];
  return Object.fromEntries([['id', uid], ...fields.filter(key => p[key] !== undefined).map(key => [key, p[key]])]);
}

learningRouter.get('/learners', async (req, res) => {
  const uid = req.firebaseUser!.uid; await account(uid, 'user');
  const snapshot = await db.collection('learners').where('userId', '==', uid).get();
  res.json(snapshot.docs.map(d => ({id: d.id, ...d.data()})));
});
learningRouter.post('/learners', async (req, res) => {
  const uid = req.firebaseUser!.uid; await account(uid, 'user');
  const data: Record<string, any> = {userId: uid};
  for (const key of ['fullName', 'dateOfBirth', 'gender', 'grade', 'school', 'academicLevel', 'subjects', 'goal']) data[key] = text(req.body[key], ['fullName', 'grade'].includes(key));
  if (data.dateOfBirth && (!validDate(data.dateOfBirth) || data.dateOfBirth > new Date().toISOString().slice(0, 10))) throw new Error('Ngày sinh không hợp lệ.');
  const ref = req.body.id ? db.collection('learners').doc(text(req.body.id, true)) : db.collection('learners').doc();
  await db.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (req.body.id && (!existing.exists || existing.data()?.userId !== uid)) throw new Error('Không tìm thấy người học.');
    tx.set(ref, {...data, updatedAt: FieldValue.serverTimestamp()}, {merge: true});
  });
  res.json({id: ref.id, ...data});
});
learningRouter.delete('/learners/:id', async (req, res) => {
  const uid = req.firebaseUser!.uid; await account(uid, 'user');
  const ref = db.collection('learners').doc(String(req.params.id));
  await db.runTransaction(async tx => { const data = (await tx.get(ref)).data(); if (data?.userId !== uid) throw new Error('Không tìm thấy người học.'); tx.delete(ref); });
  res.json({ok: true});
});

learningRouter.post('/jobs', async (req, res) => {
  const uid = req.firebaseUser!.uid; await account(uid, 'user');
  const body = req.body || {};
  const scheduleError = validateSchedule(body.schedule);
  if (scheduleError) throw new Error(scheduleError);
  if (!['FIXED', 'PLUS_MINUS_30', 'PLUS_MINUS_60', 'NEGOTIABLE'].includes(body.scheduleFlexibility)) throw new Error('Mức linh hoạt không hợp lệ.');
  if (!['ONLINE', 'OFFLINE'].includes(body.learningMode)) throw new Error('Hình thức học không hợp lệ.');
  const learnerId = text(body.learnerId, true);
  if ((await db.collection('learners').doc(learnerId).get()).data()?.userId !== uid) throw new Error('Vui lòng chọn người học của bạn.');
  const data = {
    userId: uid, learnerId, subject: text(body.subject, true), grade: text(body.grade, true), goal: text(body.goal),
    learningMode: body.learningMode, location: text(body.location, body.learningMode === 'OFFLINE'),
    sessionsPerWeek: number(body.sessionsPerWeek, 1, 21), durationMinutes: number(body.durationMinutes, 15, 480),
    budget: number(body.budget), requirements: text(body.requirements), description: text(body.description),
    schedule: body.schedule, scheduleFlexibility: body.scheduleFlexibility, status: 'OPEN', createdAt: FieldValue.serverTimestamp(),
  };
  const ref = await db.collection('job_posts').add(data);
  res.status(201).json({id: ref.id, ...data});
});

learningRouter.get('/jobs', async (req, res) => {
  const uid = req.firebaseUser!.uid; const user = await account(uid);
  const query = user.role === 'user' ? db.collection('job_posts').where('userId', '==', uid) : db.collection('job_posts').where('status', '==', 'OPEN');
  const snapshot = await query.get();
  const availability = user.role === 'tutor' ? (await db.collection('tutor_profiles').doc(uid).get()).data()?.availability || [] : [];
  res.json(snapshot.docs.map(d => ({id: d.id, ...d.data(), ...(user.role === 'tutor' && matchSchedule(d.data().schedule || [], availability, d.data().scheduleFlexibility))})));
});
learningRouter.get('/jobs/:id', async (req, res) => {
  const user = await account(req.firebaseUser!.uid);
  const snapshot = await db.collection('job_posts').doc(String(req.params.id)).get();
  const data = snapshot.data();
  if (!data || (user.role === 'user' && data.userId !== req.firebaseUser!.uid)) throw new Error('Không tìm thấy bài đăng.');
  res.json({id: snapshot.id, ...data});
});
learningRouter.patch('/jobs/:id', async (req, res) => {
  const uid = req.firebaseUser!.uid; await account(uid, 'user');
  const ref = db.collection('job_posts').doc(String(req.params.id));
  if (!['OPEN', 'CLOSED'].includes(req.body.status)) throw new Error('Trạng thái không hợp lệ.');
  await db.runTransaction(async tx => { const data = (await tx.get(ref)).data(); if (data?.userId !== uid || data.status === 'MATCHED') throw new Error('Không thể thay đổi bài đăng.'); tx.update(ref, {status: req.body.status}); });
  res.json({ok: true});
});

learningRouter.post('/jobs/:id/applications', async (req, res) => {
  const uid = req.firebaseUser!.uid; await account(uid, 'tutor');
  const jobId = String(req.params.id);
  const ref = db.collection('applications').doc(`${jobId}_${uid}`);
  const introduction = text(req.body.introduction, true);
  await db.runTransaction(async tx => {
    const [user, job, existing] = await Promise.all([tx.get(db.collection('users').doc(uid)), tx.get(db.collection('job_posts').doc(jobId)), tx.get(ref)]);
    if (tutorStatus(user.data() || {}) !== 'APPROVED') throw new Error('Chỉ gia sư đã duyệt mới được ứng tuyển.');
    if (!job.exists || job.data()?.status !== 'OPEN') throw new Error('Bài đăng không còn nhận ứng tuyển.');
    if (existing.exists) throw new Error('Bạn đã ứng tuyển bài đăng này.');
    tx.update(db.collection('job_posts').doc(jobId), {applicationsUpdatedAt: FieldValue.serverTimestamp()});
    tx.create(ref, {jobId, tutorId: uid, userId: job.data()!.userId, introduction, status: 'PENDING', createdAt: FieldValue.serverTimestamp()});
    activity(tx, '', {userId: job.data()!.userId, tutorId: uid}, uid, 'Có ứng viên mới cho bài đăng tìm gia sư');
  });
  res.status(201).json({id: ref.id});
});
learningRouter.get('/applications', async (req, res) => {
  const uid = req.firebaseUser!.uid; await account(uid, 'tutor');
  const snapshot = await db.collection('applications').where('tutorId', '==', uid).get();
  res.json(await Promise.all(snapshot.docs.map(async d => ({id: d.id, ...d.data(), job: (await db.collection('job_posts').doc(d.data().jobId).get()).data()}))));
});
learningRouter.get('/jobs/:id/applications', async (req, res) => {
  const uid = req.firebaseUser!.uid; await account(uid, 'user');
  const jobId = String(req.params.id);
  if ((await db.collection('job_posts').doc(jobId).get()).data()?.userId !== uid) throw new Error('Không có quyền xem ứng viên.');
  const snapshot = await db.collection('applications').where('jobId', '==', jobId).get();
  res.json(await Promise.all(snapshot.docs.map(async d => ({id: d.id, ...d.data(), tutor: await publicTutor(d.data().tutorId).catch(() => ({id: d.data().tutorId, displayName: 'Gia sư không còn hoạt động'}))}))));
});
learningRouter.patch('/applications/:id', async (req, res) => {
  const uid = req.firebaseUser!.uid; await account(uid, 'user');
  if (!['ACCEPTED', 'REJECTED'].includes(req.body.status)) throw new Error('Trạng thái không hợp lệ.');
  const ref = db.collection('applications').doc(String(req.params.id));
  await db.runTransaction(async tx => {
    const application = (await tx.get(ref)).data();
    if (!application || application.userId !== uid || application.status !== 'PENDING') throw new Error('Ứng viên không hợp lệ.');
    const job = db.collection('job_posts').doc(application.jobId);
    const jobData = (await tx.get(job)).data();
    const tutor = (await tx.get(db.collection('users').doc(application.tutorId))).data();
    if (jobData?.status !== 'OPEN') throw new Error('Bài đăng đã đóng hoặc đã chọn gia sư.');
    if (req.body.status === 'ACCEPTED' && tutorStatus(tutor || {}) !== 'APPROVED') throw new Error('Gia sư không còn đủ điều kiện nhận lớp.');
    const others = req.body.status === 'ACCEPTED' ? await tx.get(db.collection('applications').where('jobId', '==', application.jobId)) : null;
    tx.update(ref, {status: req.body.status, updatedAt: FieldValue.serverTimestamp()});
    activity(tx, '', application, uid, req.body.status === 'ACCEPTED' ? 'Đơn ứng tuyển được chấp nhận' : 'Đơn ứng tuyển bị từ chối');
    if (req.body.status === 'ACCEPTED') {
      tx.update(job, {status: 'MATCHED', tutorId: application.tutorId});
      others?.docs.filter(d => d.id !== ref.id && d.data().status === 'PENDING').forEach(d => tx.update(d.ref, {status: 'REJECTED'}));
    }
  });
  res.json({ok: true});
});
learningRouter.get('/tutors/monthly-top', async (req, res) => {
  await account(req.firebaseUser!.uid);
  const now = new Date();
  const applications = await db.collection('applications').where('status', '==', 'ACCEPTED').get();
  const ranked = rankMonthlyTutors(applications.docs.map(d => d.data()) as Parameters<typeof rankMonthlyTutors>[0], now);
  const tutors = [];
  for (const entry of ranked) {
    const user = (await db.collection('users').doc(entry.id).get()).data();
    if (!user || user.role !== 'tutor' || tutorStatus(user) !== 'APPROVED') continue;
    tutors.push({...await publicTutor(entry.id), monthlyClasses: entry.monthlyClasses});
    if (tutors.length === 3) break;
  }
  res.json({month: vietnamMonth(now).label, tutors});
});
learningRouter.get('/tutors/:id', async (req, res) => { await account(req.firebaseUser!.uid); res.json(await publicTutor(String(req.params.id))); });
learningRouter.get('/tutors', async (req, res) => {
  await account(req.firebaseUser!.uid);
  const users = await db.collection('users').where('role', '==', 'tutor').get();
  res.json(await Promise.all(users.docs.filter(d => tutorStatus(d.data()) === 'APPROVED').map(d => publicTutor(d.id))));
});
learningRouter.get('/admin/jobs', ...requireAdmin, async (_req, res) => {
  const [jobs, applications] = await Promise.all([db.collection('job_posts').get(), db.collection('applications').get()]);
  res.json(jobs.docs.map(d => {
    const items = applications.docs.filter(a => a.data().jobId === d.id);
    return {id: d.id, ...d.data(), applicantCount: items.filter(a => a.data().source !== 'ADMIN_RECOMMENDATION').length,
      recommendationCount: items.filter(a => a.data().source === 'ADMIN_RECOMMENDATION').length};
  }));
});
learningRouter.get('/admin/jobs/:id/candidates', ...requireAdmin, async (req, res) => {
  const jobId = String(req.params.id);
  const job = (await db.collection('job_posts').doc(jobId).get()).data();
  if (!job || job.status !== 'OPEN') throw new Error('Bài đăng không còn mở.');
  const existing = await db.collection('applications').where('jobId', '==', jobId).get();
  if (existing.docs.some(d => d.data().source !== 'ADMIN_RECOMMENDATION')) throw new Error('Bài đăng đã có gia sư ứng tuyển.');
  const users = await db.collection('users').where('role', '==', 'tutor').get();
  const candidates = await Promise.all(users.docs.filter(d => tutorStatus(d.data()) === 'APPROVED').map(async d => {
    const tutor = await publicTutor(d.id);
    return {...tutor, alreadyRecommended: existing.docs.some(a => a.data().tutorId === d.id),
      subjectMatch: (tutor.subjects || []).includes(job.subject), gradeMatch: (tutor.grades || []).includes(job.grade),
      ...matchSchedule(job.schedule || [], tutor.availability || [], job.scheduleFlexibility)};
  }));
  res.json(candidates);
});
learningRouter.post('/admin/jobs/:id/recommendations', ...requireAdmin, async (req, res) => {
  const ids = req.body.tutorIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => typeof id !== 'string' || !id.trim() || id.includes('/')) || new Set(ids).size !== ids.length)
    throw new Error('Vui lòng chọn từ 1 đến 20 gia sư khác nhau.');
  const note = text(req.body.note ?? '');
  const jobId = String(req.params.id);
  const jobRef = db.collection('job_posts').doc(jobId);
  await db.runTransaction(async tx => {
    const job = (await tx.get(jobRef)).data();
    const existing = await tx.get(db.collection('applications').where('jobId', '==', jobId));
    const tutors = await Promise.all(ids.map(id => tx.get(db.collection('users').doc(id))));
    if (!job || job.status !== 'OPEN') throw new Error('Bài đăng không còn mở.');
    if (existing.docs.some(d => d.data().source !== 'ADMIN_RECOMMENDATION')) throw new Error('Bài đăng đã có gia sư ứng tuyển, không thể đề xuất thêm.');
    if (tutors.some(d => d.data()?.role !== 'tutor' || tutorStatus(d.data() || {}) !== 'APPROVED')) throw new Error('Chỉ đề xuất gia sư đã duyệt và đang hoạt động.');
    const fresh = ids.filter(id => !existing.docs.some(d => d.data().tutorId === id));
    if (!fresh.length) return;
    tx.update(jobRef, {applicationsUpdatedAt: FieldValue.serverTimestamp()});
    for (const tutorId of fresh) {
      tx.create(db.collection('applications').doc(`${jobId}_${tutorId}`), {
        jobId, tutorId, userId: job.userId, introduction: note, source: 'ADMIN_RECOMMENDATION',
        recommendedBy: req.firebaseUser!.uid, status: 'PENDING', createdAt: FieldValue.serverTimestamp(),
      });
      activity(tx, '', {userId: job.userId, tutorId}, req.firebaseUser!.uid, 'Trung tâm đề xuất gia sư cho bài đăng tìm gia sư');
    }
  });
  res.json({ok: true});
});
learningRouter.patch('/admin/jobs/:id', ...requireAdmin, async (req, res) => {
  if (!['OPEN', 'CLOSED'].includes(req.body.status)) throw new Error('Trạng thái không hợp lệ.');
  const ref = db.collection('job_posts').doc(String(req.params.id));
  await db.runTransaction(async tx => { const job = await tx.get(ref); if (!job.exists || job.data()?.status === 'MATCHED') throw new Error('Không thể đổi trạng thái bài đăng.'); tx.update(ref, {status: req.body.status}); });
  res.json({ok: true});
});
