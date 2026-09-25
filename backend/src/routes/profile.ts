import {Router} from 'express';
import {FieldValue} from 'firebase-admin/firestore';
import {db} from '../config/firebase.js';
import {requireAuth} from '../middleware/auth.js';
import {emptyTutorDraft, validateTutor, validDate, type TutorDraft, type Verification} from '../domain/profiles.js';
import {validateSchedule} from '../domain/schedule.js';
import {personalFields, resolvePersonalProfile} from '../domain/personalProfile.js';

export const profileRouter = Router();
profileRouter.use(requireAuth);
profileRouter.post('/register', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  const {role, displayName, phoneNumber, acceptedTerms} = req.body || {};
  if (!['user', 'tutor'].includes(role) || typeof displayName !== 'string' || !displayName.trim() || typeof phoneNumber !== 'string' || !/^0\d{9}$/.test(phoneNumber) || acceptedTerms !== true) throw new Error('Thông tin đăng ký hoặc đồng ý điều khoản chưa hợp lệ.');
  const ref = db.collection('users').doc(uid);
  await db.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (existing.exists) {
      if (existing.data()?.role === role && existing.data()?.termsVersion === '2026-09') return;
      throw new Error('Tài khoản đã có hồ sơ.');
    }
    tx.create(ref, {uid, email: req.firebaseUser!.email || '', displayName: displayName.trim(), phoneNumber, role, accountStatus: 'active',
      ...(role === 'tutor' && {tutorStatus: 'DRAFT', approvalStatus: 'draft'}), termsAcceptedAt: FieldValue.serverTimestamp(), termsVersion: '2026-09', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()});
  });
  res.status(201).json({ok: true});
});
export const tutorStatus = (data: Record<string, any>) => data.accountStatus === 'locked' || data.disabled ? 'SUSPENDED' : data.tutorStatus || (data.approvalStatus || 'draft').toUpperCase();
export async function account(uid: string, role?: string): Promise<Record<string, any>> {
  const snapshot = await db.collection('users').doc(uid).get();
  const data = snapshot.data();
  if (!data || data.accountStatus === 'locked' || data.disabled) throw new Error('Tài khoản không hoạt động.');
  const normalized = data.role === 'parent' ? 'user' : data.role;
  if (!['user', 'tutor'].includes(normalized)) throw new Error('Vai trò tài khoản không hợp lệ.');
  if (role && normalized !== role) throw new Error('Bạn không có quyền thực hiện thao tác này.');
  return {...data, role: normalized};
}
const safeDraft = (input: Record<string, any>): TutorDraft => {
  const defaults = emptyTutorDraft();
  const output: Record<string, any> = {};
  for (const [key, value] of Object.entries(defaults)) {
    const next = input[key] ?? value;
    if (Array.isArray(value)) {
      if (!Array.isArray(next) || next.length > 70) throw new Error('Danh sách không hợp lệ.');
      if (key !== 'certificates' && key !== 'availability' && next.some(item => typeof item !== 'string' || item.length > 100)) throw new Error('Lựa chọn không hợp lệ.');
    } else if (key === 'coordinates') {
      if (next !== null && (!Number.isFinite(next.latitude) || !Number.isFinite(next.longitude) || Math.abs(next.latitude) > 90 || Math.abs(next.longitude) > 180)) throw new Error('Tọa độ không hợp lệ.');
    } else if (typeof next !== 'string') throw new Error('Thông tin hồ sơ không hợp lệ.');
    output[key] = next;
  }
  if (output.certificates.length > 10 || output.certificates.some((c: any) => !c || ['name', 'issuer', 'issuedAt', 'expiresAt', 'image'].some(k => typeof c[k] !== 'string'))) throw new Error('Chứng chỉ không hợp lệ.');
  if (Buffer.byteLength(JSON.stringify(output)) > 850000) throw new Error('Hồ sơ quá lớn. Vui lòng giảm dung lượng ảnh.');
  if (validateSchedule(output.availability, false)) throw new Error(validateSchedule(output.availability, false)!);
  return output as TutorDraft;
};

profileRouter.get('/tutor', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  const user = await account(uid, 'tutor');
  const [profile, verification, personal] = await Promise.all([db.collection('tutor_profiles').doc(uid).get(), db.collection('tutor_verifications').doc(uid).get(), db.collection('user_profiles').doc(uid).get()]);
  const defaults = emptyTutorDraft();
  const legacy = Object.fromEntries(Object.keys(defaults).filter(key => user[key] !== undefined && user[key] !== null).map(key => [key, user[key]]));
  const draft = {...defaults, ...legacy, ...profile.data(), ...personalFields(resolvePersonalProfile(user, personal.data(), profile.data()))};
  const aliases: Record<string, string> = {Văn: 'Ngữ văn', 'Anh văn': 'Tiếng Anh', Anh: 'Tiếng Anh', Lý: 'Vật lý', Hóa: 'Hóa học', Sinh: 'Sinh học', Sử: 'Lịch sử', Địa: 'Địa lý'};
  draft.subjects = [...new Set(draft.subjects.map((subject: string) => aliases[subject] || subject))];
  res.json({account: user, status: tutorStatus(user), rejectionReason: user.rejectionReason || '', draft, verification: verification.data() || {front: '', back: '', portrait: ''}});
});

profileRouter.put('/tutor', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  const draft = safeDraft(req.body?.draft || {});
  const input = req.body?.verification || {};
  const verification: Verification = {front: input.front || '', back: input.back || '', portrait: input.portrait || ''};
  if (Object.values(verification).some(value => typeof value !== 'string' || (value && !/^data:image\/(jpeg|png|webp);base64,/.test(value))) || Buffer.byteLength(JSON.stringify(verification)) > 850000) throw new Error('Ảnh xác minh không hợp lệ hoặc quá lớn.');
  const submit = req.body?.submit === true;
  if (submit) { const error = validateTutor(draft, verification); if (error) throw new Error(error); }
  await db.runTransaction(async tx => {
    const ref = db.collection('users').doc(uid);
    const user = (await tx.get(ref)).data();
    if (!user || user.role !== 'tutor' || user.accountStatus === 'locked' || !['DRAFT', 'REJECTED', 'APPROVED'].includes(tutorStatus(user))) throw new Error('Hồ sơ đang xét duyệt hoặc tài khoản không được phép sửa.');
    const personalRef = db.collection('user_profiles').doc(uid);
    const personal = (await tx.get(personalRef)).data();
    tx.set(db.collection('tutor_profiles').doc(uid), {...draft, updatedAt: FieldValue.serverTimestamp()});
    tx.set(personalRef, {...personal, ...personalFields(draft), coordinates: draft.coordinates, updatedAt: FieldValue.serverTimestamp()});
    tx.set(db.collection('tutor_verifications').doc(uid), {...verification, updatedAt: FieldValue.serverTimestamp()});
    // Editing an approved profile requires a fresh review; never publish unreviewed changes.
    tx.update(ref, {photoURL: draft.photoURL, tutorStatus: submit ? 'PENDING' : 'DRAFT', approvalStatus: submit ? 'pending' : 'draft', accountStatus: submit ? 'pending' : 'active', identityVerified: false, educationVerified: false, updatedAt: FieldValue.serverTimestamp()});
  });
  res.json({status: submit ? 'PENDING' : 'DRAFT'});
});

profileRouter.get('/personal', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  const user = await account(uid);
  const personal = (await db.collection('user_profiles').doc(uid).get()).data();
  const tutor = user.role === 'tutor' ? (await db.collection('tutor_profiles').doc(uid).get()).data() : undefined;
  res.json(resolvePersonalProfile(user, personal, tutor));
});
profileRouter.put('/personal', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  await account(uid);
  const data: Record<string, any> = {};
  for (const key of ['displayName', 'phoneNumber', 'photoURL', 'dateOfBirth', 'gender', 'province', 'ward', 'district', 'address']) {
    if (typeof req.body?.[key] !== 'string') throw new Error('Thông tin cá nhân không hợp lệ.');
    data[key] = req.body[key].trim();
  }
  if (!data.displayName || !/^0\d{9}$/.test(data.phoneNumber) || (data.dateOfBirth && (!validDate(data.dateOfBirth) || data.dateOfBirth > new Date().toISOString().slice(0, 10)))) throw new Error('Vui lòng kiểm tra họ tên, số điện thoại và ngày sinh.');
  const coordinates = req.body.coordinates ?? null;
  if (coordinates && (!Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude) || Math.abs(coordinates.latitude) > 90 || Math.abs(coordinates.longitude) > 180)) throw new Error('Tọa độ không hợp lệ.');
  if (Buffer.byteLength(JSON.stringify(data)) > 850000) throw new Error('Ảnh quá lớn.');
  await db.runTransaction(async tx => {
    const userRef = db.collection('users').doc(uid);
    const user = (await tx.get(userRef)).data();
    if (!user || user.accountStatus === 'locked' || user.disabled) throw new Error('Tài khoản không hoạt động.');
    const tutorRef = db.collection('tutor_profiles').doc(uid);
    const tutor = user.role === 'tutor' ? await tx.get(tutorRef) : null;
    tx.set(db.collection('user_profiles').doc(uid), {...data, coordinates, updatedAt: FieldValue.serverTimestamp()});
    tx.update(userRef, {displayName: data.displayName, phoneNumber: data.phoneNumber, photoURL: data.photoURL, updatedAt: FieldValue.serverTimestamp()});
    if (tutor?.exists) tx.update(tutorRef, {...personalFields(data), coordinates, updatedAt: FieldValue.serverTimestamp()});
  });
  res.json({ok: true});
});
