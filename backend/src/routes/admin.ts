import {accountStatus} from '../accountStatus.js';
import {Router} from 'express';
import {FieldValue} from 'firebase-admin/firestore';
import type {QueryDocumentSnapshot} from 'firebase-admin/firestore';
import {getAuth} from 'firebase-admin/auth';
import {db} from '../config/firebase.js';
import {requireAdmin, requireSuperAdmin} from '../middleware/admin.js';
import {tutorStatus} from './profile.js';
import {revenueRange, summarizeRevenue} from '../domain/revenue.js';

const router = Router();
const tutors = db.collection('users');
const withTutorProfile = async (item: Record<string, any>) => {
  if (item.role !== 'tutor') return {...item, ...(await db.collection('user_profiles').doc(item.id).get()).data()};
  const [profile, verification] = await Promise.all([db.collection('tutor_profiles').doc(item.id).get(), db.collection('tutor_verifications').doc(item.id).get()]);
  return {...item, ...profile.data(), tutorStatus: tutorStatus(item), verification: verification.data() || null};
};

const serializeUser = (document: QueryDocumentSnapshot) => ({
  id: document.id,
  ...document.data(),
  role: document.data().role === 'parent' ? 'user' : document.data().role,
  accountStatus: accountStatus(document.data()),
  approvalStatus: document.data().role === 'tutor'
    ? document.data().approvalStatus || 'pending'
    : undefined,
});

const profileUpdates = (body: Record<string, unknown>, isTutor: boolean) => {
  const updates: Record<string, any> = {};
  const fields = ['displayName', 'phoneNumber', 'dateOfBirth', 'address', 'photoURL', 'documentBase64', ...(isTutor ? ['degreeImageBase64', 'certificateImageBase64', 'experience', 'bio'] : [])];
  for (const field of fields) {
    const value = body[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') throw new Error(`Invalid ${field}`);
    updates[field] = typeof value === 'string' ? value.trim() : null;
  }
  if ('displayName' in updates && !updates.displayName) throw new Error('Họ tên không được để trống.');
  if (updates.dateOfBirth) {
    const date = new Date(updates.dateOfBirth);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(updates.dateOfBirth) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== updates.dateOfBirth || date > new Date()) throw new Error('Ngày sinh không hợp lệ.');
  }
  if (body.age !== undefined) {
    const age = body.age === null || body.age === '' ? null : Number(body.age);
    if (age !== null && (!Number.isInteger(age) || age < 1 || age > 150)) throw new Error('Tuổi không hợp lệ.');
    updates.age = age;
  }
  if (isTutor) for (const field of ['subjects', 'grades']) {
    if (body[field] === undefined) continue;
    const value = body[field];
    if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || item.length > 100)) throw new Error(`Invalid ${field}`);
    updates[field] = [...new Set(value.map(item => item.trim()).filter(Boolean))];
  }
  return updates;
};

router.post('/users/:role', ...requireAdmin, async (request, response) => {
  const role = String(request.params.role);
  if (role !== 'user' && role !== 'tutor') { response.status(400).json({message: 'Vai trò không hợp lệ.'}); return; }
  const body = request.body || {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof body.password !== 'string' || body.password.length < 8) {
    response.status(400).json({message: 'Email không hợp lệ hoặc mật khẩu ít hơn 8 ký tự.'}); return;
  }
  let profile: Record<string, any>;
  try {
    profile = profileUpdates(body, role === 'tutor');
    if (!profile.displayName) throw new Error('Vui lòng nhập họ tên.');
    const phone = (profile.phoneNumber || '').replace(/[\s().-]/g, '');
    if (!/^(0\d{9}|\+84\d{9})$/.test(phone)) throw new Error('Vui lòng nhập số điện thoại Việt Nam hợp lệ.');
    profile.phoneNumber = phone;
    if (role === 'tutor' && (!profile.subjects?.length || !profile.grades?.length)) throw new Error('Vui lòng chọn môn dạy và lớp dạy.');
    if (Buffer.byteLength(JSON.stringify(profile)) > 890000) throw new Error('Tổng dung lượng hồ sơ quá lớn. Vui lòng chọn ảnh nhỏ hơn.');
  } catch (error) { response.status(400).json({message: (error as Error).message}); return; }

  let uid: string | undefined;
  try {
    const user = await getAuth().createUser({email, password: body.password, displayName: profile.displayName});
    uid = user.uid;
    const data = {
      dateOfBirth: null, age: null, address: null, photoURL: null, documentBase64: null,
      ...profile, uid, email, role,
      accountStatus: 'active',
      ...(role === 'tutor' && {
        experience: profile.experience || null, bio: profile.bio || null,
        degreeImageBase64: profile.degreeImageBase64 || null,
        certificateImageBase64: profile.certificateImageBase64 || null,
        degreeStatus: profile.degreeImageBase64 ? 'uploaded' : 'none',
        certificateStatus: profile.certificateImageBase64 ? 'uploaded' : 'none',
        approvalStatus: 'approved',
        tutorStatus: 'APPROVED',
        reviewedAt: FieldValue.serverTimestamp(),
        reviewedBy: request.firebaseUser!.uid,
      }),
      createdAt: FieldValue.serverTimestamp(), createdBy: request.firebaseUser!.uid,
    };
    try { await tutors.doc(uid).set(data); }
    catch (error) {
      // Auth and Firestore do not share a transaction; undo Auth if the profile fails.
      await getAuth().deleteUser(uid);
      throw error;
    }
    response.status(201).json({id: uid, ...data, createdAt: undefined});
  } catch (error) {
    const code = (error as {code?: string}).code;
    const messages: Record<string, string> = {
      'auth/email-already-exists': 'Email này đã được sử dụng.',
      'auth/invalid-email': 'Email không hợp lệ.',
      'auth/invalid-password': 'Mật khẩu không hợp lệ.',
    };
    response.status(messages[code || ''] ? 400 : 500).json({message: messages[code || ''] || 'Không thể tạo tài khoản. Vui lòng thử lại.'});
  }
});

router.patch('/users/:role/:uid', ...requireAdmin, async (request, response, next) => {
  if (request.params.uid === 'status') { next(); return; }
  const role = String(request.params.role);
  if (!['user', 'tutor'].includes(role)) { response.status(400).json({message: 'Invalid user role'}); return; }
  const uid = String(request.params.uid);
  const profile = tutors.doc(uid);
  const snapshot = await profile.get();
  if (!snapshot.exists || (snapshot.data()?.role === 'parent' ? 'user' : snapshot.data()?.role) !== role) { response.status(404).json({message: 'User profile not found'}); return; }
  let updates: Record<string, any>;
  try { updates = profileUpdates(request.body || {}, role === 'tutor'); } catch (error) { response.status(400).json({message: (error as Error).message}); return; }
  if (Buffer.byteLength(JSON.stringify({...snapshot.data(), ...updates})) > 900000) { response.status(400).json({message: 'Ảnh quá lớn, vui lòng chọn ảnh nhỏ hơn.'}); return; }
  if (updates.displayName !== undefined) await getAuth().updateUser(uid, {displayName: updates.displayName});
  const batch = db.batch();
  batch.update(profile, {...updates, updatedAt: FieldValue.serverTimestamp(), updatedBy: request.firebaseUser!.uid});
  if (role === 'tutor' && (await db.collection('tutor_profiles').doc(uid).get()).exists) {
    const teaching = Object.fromEntries(Object.entries(updates).filter(([key]) => ['photoURL', 'dateOfBirth', 'address', 'subjects', 'grades', 'experience', 'bio'].includes(key)));
    batch.set(db.collection('tutor_profiles').doc(uid), teaching, {merge: true});
  }
  if (role === 'user' && (await db.collection('user_profiles').doc(uid).get()).exists) {
    const personal = Object.fromEntries(Object.entries(updates).filter(([key]) => ['displayName', 'phoneNumber', 'photoURL', 'dateOfBirth', 'address', 'age'].includes(key)));
    batch.set(db.collection('user_profiles').doc(uid), personal, {merge: true});
  }
  await batch.commit();
  const data = (await profile.get()).data()!;
  response.json({id: uid, ...data, role: data.role === 'parent' ? 'user' : data.role, accountStatus: accountStatus(data)});
});

router.get('/users/:role', ...requireAdmin, async (request, response) => {
  const role = String(request.params.role);
  if (role !== 'user' && role !== 'tutor') {
    response.status(400).json({message: 'Invalid user role'});
    return;
  }

  const snapshot = await tutors.where('role', 'in', role === 'user' ? ['user', 'parent'] : ['tutor']).get();
  response.json(await Promise.all(snapshot.docs.map(document => withTutorProfile(serializeUser(document)))));
});

router.patch('/users/:uid/status', ...requireAdmin, async (request, response) => {
  const status = request.body?.status;
  if (status !== 'active' && status !== 'locked') {
    response.status(400).json({message: 'Invalid account status'});
    return;
  }

  const uid = String(request.params.uid);
  const user = tutors.doc(uid);
  const snapshot = await user.get();
  if (!snapshot.exists || !['user', 'parent', 'tutor'].includes(snapshot.data()?.role)) {
    response.status(404).json({message: 'User profile not found'});
    return;
  }

  const nextStatus = status === 'locked' ? 'locked' : accountStatus({...snapshot.data(), accountStatus: 'active', disabled: false});
  await getAuth().updateUser(uid, {disabled: status === 'locked'});
  await user.update({
    accountStatus: nextStatus,
    accountStatusUpdatedAt: FieldValue.serverTimestamp(),
    accountStatusUpdatedBy: request.firebaseUser!.uid,
  });
  response.json({id: uid, accountStatus: nextStatus});
});

router.get('/session', ...requireAdmin, (request, response) => {
  response.json({email: request.admin!.email, role: request.admin!.role});
});

router.get('/tutors', ...requireAdmin, async (request, response) => {
  const status = typeof request.query.status === 'string'
    ? request.query.status
    : 'pending';
  const snapshot = await tutors.where('role', '==', 'tutor').get();

  response.json(await Promise.all(snapshot.docs
    .map(document => {
      const data = document.data();
      return {
        id: document.id,
        ...data,
        accountStatus: accountStatus(data),
        degreeUrl: data.degreeImageBase64 || data.degreeUrl || null,
        certificateUrl: data.certificateImageBase64 || data.certificateUrl || null,
        approvalStatus: data.approvalStatus || 'pending',
      };
    })
    .filter(tutor => tutor.approvalStatus === status).map(withTutorProfile)));
});

router.patch('/tutors/:uid/status', ...requireAdmin, async (request, response) => {
  const status = request.body?.status;

  if (!['approved', 'rejected', 'pending'].includes(status)) {
    response.status(400).json({message: 'Invalid approval status'});
    return;
  }

  const uid = String(request.params.uid);
  const tutor = tutors.doc(uid);
  const rejectionReason = typeof request.body.rejectionReason === 'string' ? request.body.rejectionReason.trim() : '';
  if (status === 'rejected' && !rejectionReason) { response.status(400).json({message: 'Vui lòng nhập lý do từ chối.'}); return; }
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(tutor);
    const data = snapshot.data();
    if (!data || data.role !== 'tutor') throw new Error('Không tìm thấy gia sư.');
    if (data.accountStatus === 'locked' || !['PENDING', 'APPROVED', 'REJECTED'].includes(tutorStatus(data))) throw new Error('Hồ sơ chưa được gửi xét duyệt hoặc đã bị khóa.');
    const verification = await tx.get(db.collection('tutor_verifications').doc(uid));
    const profile = await tx.get(db.collection('tutor_profiles').doc(uid));
    const verified = verification.data();
    tx.update(tutor, {
      approvalStatus: status, tutorStatus: status.toUpperCase(), rejectionReason: status === 'rejected' ? rejectionReason : '',
      accountStatus: accountStatus({...data, approvalStatus: status}),
      identityVerified: status === 'approved' && !!(verified?.front && verified?.back && verified?.portrait),
      educationVerified: status === 'approved' && !!profile.data()?.certificates?.length,
      reviewedAt: FieldValue.serverTimestamp(), reviewedBy: request.firebaseUser!.uid,
    });
  });

  response.json({id: uid, approvalStatus: status});
});

router.get('/staff', ...requireSuperAdmin, async (_request, response) => {
  const snapshot = await db.collection('adminProfiles').where('role', '==', 'admin').get();
  response.json(snapshot.docs.map(document => ({id: document.id, ...document.data(), role: 'admin', accountStatus: accountStatus(document.data())})));
});

router.post('/staff', ...requireSuperAdmin, async (request, response) => {
  const {email, password, displayName, phoneNumber, dateOfBirth, age, address, documentBase64} = request.body || {};
  if (!email || !password || !displayName) {
    response.status(400).json({message: 'Email, password and displayName are required'});
    return;
  }
  if (typeof password !== 'string' || password.length < 8) {
    response.status(400).json({message: 'Password must contain at least 8 characters'});
    return;
  }

  try { profileUpdates(request.body || {}, false); } catch (error) { response.status(400).json({message: (error as Error).message}); return; }
  const parsedAge = age === undefined || age === null || age === '' ? null : Number(age);
  if (age !== undefined && age !== null && age !== '' && Number.isNaN(parsedAge)) {
    response.status(400).json({message: 'Age must be a valid number'});
    return;
  }

  const contactPhone = typeof phoneNumber === 'string' ? phoneNumber.trim().replace(/[\s().-]/g, '') : '';
  const authPhone = contactPhone.startsWith('0') ? `+84${contactPhone.slice(1)}` : contactPhone;
  if (authPhone && !/^\+[1-9]\d{7,14}$/.test(authPhone)) {
    response.status(400).json({message: 'Số điện thoại không hợp lệ. Nhập số bắt đầu bằng 0 hoặc mã quốc gia +84.'});
    return;
  }
  const user = await getAuth().createUser({email, password, displayName, ...(authPhone && {phoneNumber: authPhone})});
  await db.collection('adminProfiles').doc(user.uid).set({
    uid: user.uid,
    email: email.toLowerCase(),
    displayName,
    phoneNumber: contactPhone || null,
    dateOfBirth: dateOfBirth || null,
    age: parsedAge ?? null,
    address: typeof address === 'string' && address.trim() ? address.trim() : null,
    documentBase64: documentBase64 || null,
    role: 'admin',
    accountStatus: 'active',
    createdAt: FieldValue.serverTimestamp(),
  });
  response.status(201).json({id: user.uid, ...(await db.collection('adminProfiles').doc(user.uid).get()).data()});
});

router.patch('/staff/:uid', ...requireSuperAdmin, async (request, response) => {
  const {disabled} = request.body || {};
  let updates: Record<string, any>;
  try { updates = profileUpdates(request.body || {}, false); } catch (error) { response.status(400).json({message: (error as Error).message}); return; }
  const {displayName} = updates;
  if (disabled !== undefined && typeof disabled !== 'boolean') { response.status(400).json({message: 'Invalid disabled value'}); return; }
  const uid = String(request.params.uid);
  const profile = db.collection('adminProfiles').doc(uid);
  if (!(await profile.get()).exists) {
    response.status(404).json({message: 'Staff admin not found'});
    return;
  }
  if (displayName !== undefined) await getAuth().updateUser(uid, {displayName});
  if (disabled !== undefined) await getAuth().updateUser(uid, {disabled});
  await profile.update({...updates, ...(disabled !== undefined && {disabled, accountStatus: disabled ? 'locked' : 'active'}), updatedAt: FieldValue.serverTimestamp()});
  response.json({id: uid, ...(await profile.get()).data()});
});

router.delete('/staff/:uid', ...requireSuperAdmin, async (request, response) => {
  const uid = String(request.params.uid);
  await getAuth().deleteUser(uid);
  await db.collection('adminProfiles').doc(uid).delete();
  response.status(204).send();
});

router.get('/revenue', ...requireSuperAdmin, async (request, response) => {
  let range;
  try {
    range = revenueRange(typeof request.query.period === 'string' ? request.query.period : 'month', typeof request.query.from === 'string' ? request.query.from : undefined, typeof request.query.to === 'string' ? request.query.to : undefined);
  } catch (error) { response.status(400).json({message: (error as Error).message}); return; }
  // A single-field range query avoids requiring a new composite index.
  const query = db.collection('payments').where('createdAt', '>=', new Date(range.fromMs)).where('createdAt', '<', new Date(range.toMs)).orderBy('createdAt').limit(500);
  const payments: Record<string, any>[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  while (true) {
    const page = await (cursor ? query.startAfter(cursor) : query).get();
    payments.push(...page.docs.map(doc => doc.data()).filter(p => p.status === 'paid'));
    if (page.size < 500) break;
    cursor = page.docs[page.docs.length - 1];
  }
  const ids = [...new Set(payments.filter(p => !p.tutorId && typeof p.contractId === 'string' && p.contractId).map(p => p.contractId as string))];
  const contracts = new Map<string, Record<string, any>>();
  for (let i = 0; i < ids.length; i += 200) {
    const docs = await db.getAll(...ids.slice(i, i + 200).map(id => db.collection('learning_contracts').doc(id)));
    for (const doc of docs) contracts.set(doc.id, doc.data() || {});
  }
  response.json(summarizeRevenue(payments.map(p => {
    const contract = contracts.get(p.contractId);
    return {amount: p.amount, status: p.status, timestamp: p.createdAt?.toMillis?.() ?? NaN, tutorId: p.tutorId || contract?.tutorId, tutorName: p.tutorName || contract?.tutorName};
  }), range));
});

export default router;
