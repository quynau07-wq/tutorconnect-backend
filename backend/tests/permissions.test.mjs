import {test, beforeEach, mock, after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createHmac} from 'node:crypto';
import {emptyTutorDraft} from '../dist/domain/profiles.js';

const records = new Map();
const snapshot = ref => ({id: ref.id, ref, exists: records.has(ref.path), data: () => records.get(ref.path)});
function collection(name) {
  const base = {doc: (id = `generated-${records.size}`) => {
    const ref = {id, path: `${name}/${id}`, get: async () => snapshot(ref), set: async data => records.set(`${name}/${id}`, data), update: async data => records.set(`${name}/${id}`, {...records.get(`${name}/${id}`), ...data}), delete: async () => records.delete(`${name}/${id}`)};
    return ref;
  }, where: (field, op, value) => ({get: async () => ({docs: [...records.entries()].filter(([key, data]) => key.startsWith(`${name}/`) && (op === '==' ? data[field] === value : value.includes(data[field]))).map(([key]) => snapshot(base.doc(key.split('/')[1])))})}),
  get: async () => ({docs: [...records.keys()].filter(key => key.startsWith(`${name}/`)).map(key => snapshot(base.doc(key.split('/')[1])))})};
  base.add = async data => {const ref = base.doc(); await ref.set(data); return ref;};
  return base;
}
const db = {collection, runTransaction: async action => {
  const writes = [];
  const tx = {get: async ref => {if(writes.length)throw new Error('Firestore reads must precede writes');return ref.get();}, create: (ref, data) => writes.push(() => records.set(ref.path, data)), set: (ref, data) => writes.push(() => records.set(ref.path, data)), update: (ref, data) => writes.push(() => records.set(ref.path, {...records.get(ref.path), ...data})), delete: ref => writes.push(() => records.delete(ref.path))};
  const result=await action(tx); writes.forEach(write => write());return result;
}};
const requireAuth = (req, res, next) => { if (!req.headers['x-test-user']) return res.sendStatus(401); req.firebaseUser = {uid: req.headers['x-test-user'], email: 'test@example.com'}; next(); };
mock.module('../dist/config/firebase.js', {namedExports: {db}});
const sendPush = mock.fn(async () => 'sent');
mock.module('firebase-admin/messaging', {namedExports: {getMessaging: () => ({send: sendPush})}});
mock.module('../dist/middleware/auth.js', {namedExports: {requireAuth}});
const requireAdmin = [requireAuth, (req, res, next) => req.firebaseUser.uid === 'admin' ? next() : res.sendStatus(403)];
mock.module('../dist/middleware/admin.js', {namedExports: {requireAdmin, requireSuperAdmin: requireAdmin}});
const {learningRouter} = await import('../dist/routes/learning.js');
const {profileRouter} = await import('../dist/routes/profile.js');
const {contractsRouter} = await import('../dist/routes/contracts.js');
const {paymentsRouter} = await import('../dist/routes/payments.js');
const {lessonScheduleRouter} = await import('../dist/routes/lessonSchedule.js');
const {operationsRouter} = await import('../dist/routes/operations.js');
const {notificationsRouter} = await import('../dist/routes/notifications.js');
const {notificationTick} = await import('../dist/notificationWorker.js');
const {settleContractPayment} = await import('../dist/domain/contractPayments.js');
const {default: adminRouter} = await import('../dist/routes/admin.js');
const app = express(); app.use(express.json({limit: '2mb'})); app.use('/learning', learningRouter); app.use('/profile', profileRouter);
app.use('/admin', adminRouter);
app.use('/contracts', contractsRouter);
app.use('/payments', paymentsRouter);
app.use('/schedule', lessonScheduleRouter);
app.use('/operations', operationsRouter);
app.use('/notifications', notificationsRouter);
app.use((error, _req, res, _next) => res.status(400).json({message: error.message}));
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
after(() => new Promise(resolve => server.close(resolve)));
const call = async (uid, path, method = 'GET', body) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {method, headers: {'x-test-user': uid, 'content-type': 'application/json'}, ...(body && {body: JSON.stringify(body)})});
  return {status: response.status, body: await response.json().catch(() => null)};
};
beforeEach(() => {
  records.clear();
  sendPush.mock.resetCalls();
  sendPush.mock.mockImplementation(async () => 'sent');
  records.set('users/owner', {role: 'user', accountStatus: 'active'});
  records.set('users/other', {role: 'user', accountStatus: 'active'});
  records.set('users/tutor', {role: 'tutor', accountStatus: 'active', tutorStatus: 'APPROVED', displayName: 'Tutor', email: 'private@example.com', documentBase64: 'private identity'});
  records.set('users/pending', {role: 'tutor', tutorStatus: 'PENDING'});
  records.set('tutor_profiles/tutor', {subjects: ['Toán'], certificates: [{image: 'private certificate'}], availability: []});
  records.set('tutor_verifications/tutor', {front: 'private front', back: 'private back', portrait: 'private portrait'});
  records.set('job_posts/job', {userId: 'owner', status: 'OPEN', subject: 'Toán'});
});
test('personal editor restores tutor details without exposing verification or overwriting account identity', async () => {
  records.set('tutor_profiles/tutor', {...emptyTutorDraft(), dateOfBirth: '1995-03-12', gender: 'Nam', province: 'Hà Nội', ward: 'Phường A', photoURL: 'data:image/jpeg;base64,avatar', bio: 'Teaching bio'});
  const result = await call('tutor', '/profile/personal');
  assert.equal(result.status, 200);
  assert.equal(result.body.dateOfBirth, '1995-03-12');
  assert.equal(result.body.province, 'Hà Nội');
  assert.equal(result.body.displayName, 'Tutor');
  assert.equal(result.body.bio, undefined);
  assert.equal(result.body.front, undefined);
});

test('personal edits stay in sync with tutor onboarding and preserve teaching fields', async () => {
  records.set('tutor_profiles/tutor', {...emptyTutorDraft(), bio: 'Keep biography', subjects: ['Toán']});
  const data = {displayName: 'Updated tutor', phoneNumber: '0912345678', photoURL: 'data:image/jpeg;base64,new', dateOfBirth: '1995-03-12', gender: 'Nữ', province: 'Hà Nội', ward: 'Phường A', district: '', address: '10 phố A', coordinates: null};
  assert.equal((await call('tutor', '/profile/personal', 'PUT', data)).status, 200);
  const personal = await call('tutor', '/profile/personal');
  const teaching = await call('tutor', '/profile/tutor');
  assert.equal(personal.body.displayName, data.displayName);
  assert.equal(teaching.body.account.displayName, data.displayName);
  assert.equal(teaching.body.draft.dateOfBirth, data.dateOfBirth);
  assert.equal(teaching.body.draft.photoURL, data.photoURL);
  assert.equal(teaching.body.draft.bio, 'Keep biography');
  assert.deepEqual(teaching.body.draft.subjects, ['Toán']);
});

test('saving a tutor draft restores the same personal fields when reopening either editor', async () => {
  const draft = {...emptyTutorDraft(), dateOfBirth: '1997-04-15', gender: 'Nam', province: 'Hà Nội', photoURL: 'data:image/jpeg;base64,new'};
  assert.equal((await call('tutor', '/profile/tutor', 'PUT', {draft})).status, 200);
  assert.equal((await call('tutor', '/profile/personal')).body.dateOfBirth, draft.dateOfBirth);
  assert.equal((await call('tutor', '/profile/tutor')).body.draft.photoURL, draft.photoURL);
  assert.equal(records.get('users/tutor').photoURL, draft.photoURL);
});

test('legacy shared fields prefer the latest profile and preserve intentionally cleared values', async () => {
  records.set('tutor_profiles/tutor', {...emptyTutorDraft(), address: 'Old address', coordinates: {latitude: 21, longitude: 105}, updatedAt: {seconds: 10}});
  records.set('user_profiles/tutor', {address: '', coordinates: null, gender: 'Nữ', updatedAt: {seconds: 20}});
  assert.equal((await call('tutor', '/profile/personal')).body.address, '');
  const result = await call('tutor', '/profile/tutor');
  assert.equal(result.body.draft.address, '');
  assert.equal(result.body.draft.coordinates, null);
  assert.equal(result.body.draft.gender, 'Nữ');
});

test('job package is validated and its label is derived on the server', async () => {
  records.set('learners/learner', {userId: 'owner', grade: 'Lớp 8'});
  const data = {learnerId: 'learner', subject: 'Toán', grade: 'Lớp 8', goal: '', learningMode: 'ONLINE', location: '', sessionsPerWeek: '2', durationMinutes: '120', budget: '200000', requirements: '', description: '', scheduleFlexibility: 'FIXED', schedule: [{dayOfWeek: 'MONDAY', startTime: '18:00', endTime: '20:00'}], packageId: 'MONTH_3', packageLabel: 'Forged label'};
  assert.equal((await call('owner', '/learning/jobs', 'POST', {...data, packageId: 'INVALID'})).status, 400);
  const result = await call('owner', '/learning/jobs', 'POST', data);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.packageId, 'MONTH_3');
  assert.equal(result.body.packageLabel, '3 tháng');
  assert.equal(records.get(`job_posts/${result.body.id}`).packageId, 'MONTH_3');
  assert.equal((await call('tutor', `/learning/jobs/${result.body.id}`)).body.packageLabel, '3 tháng');
});

test('monthly leaderboard returns at most three approved tutors with public fields only', async () => {
  const updatedAt = {toMillis: () => Date.now() - 1};
  for (let i = 0; i < 5; i++) {
    const id = `ranked-${i}`;
    records.set(`users/${id}`, {role: 'tutor', tutorStatus: i === 0 ? 'SUSPENDED' : 'APPROVED', displayName: id, email: 'private'});
    for (let j = 0; j < 5 - i; j++) records.set(`applications/${id}-${j}`, {tutorId: id, jobId: `${id}-${j}`, status: 'ACCEPTED', updatedAt});
  }
  const result = await call('owner', '/learning/tutors/monthly-top');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.tutors.map(t => [t.id, t.monthlyClasses]), [['ranked-1', 4], ['ranked-2', 3], ['ranked-3', 2]]);
  assert.equal(result.body.tutors[0].email, undefined);
  assert.equal((await call('', '/learning/tutors/monthly-top')).status, 401);
});

test('only approved tutors may apply, and duplicate application is prevented', async () => {
  assert.equal((await call('owner', '/learning/jobs/job/applications', 'POST', {introduction: 'Hello'})).status, 400);
  assert.equal((await call('pending', '/learning/jobs/job/applications', 'POST', {introduction: 'Hello'})).status, 400);
  assert.equal((await call('tutor', '/learning/jobs/job/applications', 'POST', {introduction: 'Hello'})).status, 201);
  assert.equal((await call('tutor', '/learning/jobs/job/applications', 'POST', {introduction: 'Hello'})).status, 400);
});

test('only admins recommend active approved tutors, with no partial writes for invalid selection', async () => {
  const path='/learning/admin/jobs/job/recommendations';
  for (const uid of ['owner','other','tutor']) assert.equal((await call(uid,path,'POST',{tutorIds:['tutor']})).status,403);
  for (const tutorIds of [[],['tutor','tutor'],['pending'],['owner'],['tutor','missing']]) {
    assert.equal((await call('admin',path,'POST',{tutorIds})).status,400);
    assert.equal(records.has('applications/job_tutor'),false);
  }
  records.set('users/tutor',{...records.get('users/tutor'),accountStatus:'locked'});
  assert.equal((await call('admin',path,'POST',{tutorIds:['tutor']})).status,400);
});

test('admin recommendations await the parent, are idempotent and acceptance selects exactly one tutor', async () => {
  records.set('users/tutor2',{role:'tutor',tutorStatus:'APPROVED',accountStatus:'active'});
  const path='/learning/admin/jobs/job/recommendations';
  const body={tutorIds:['tutor','tutor2'],note:'Suggested by center'};
  assert.equal((await call('admin',path,'POST',body)).status,200);
  const noticeCount=[...records.keys()].filter(k=>k.startsWith('notifications/')).length;
  assert.equal((await call('admin',path,'POST',body)).status,200);
  assert.equal([...records.keys()].filter(k=>k.startsWith('notifications/')).length,noticeCount);
  assert.equal(records.get('job_posts/job').status,'OPEN');
  const applications=(await call('owner','/learning/jobs/job/applications')).body;
  assert.equal(applications.length,2);assert.ok(applications.every(a=>a.status==='PENDING' && a.source==='ADMIN_RECOMMENDATION'));
  assert.equal((await call('other','/learning/applications/job_tutor','PATCH',{status:'ACCEPTED'})).status,400);
  assert.equal((await call('owner','/learning/applications/job_tutor','PATCH',{status:'ACCEPTED'})).status,200);
  assert.equal(records.get('job_posts/job').tutorId,'tutor');
  assert.equal(records.get('applications/job_tutor2').status,'REJECTED');
  assert.equal((await call('admin',path,'POST',body)).status,400);
});

test('recommendations are blocked once an organic application arrives or job closes', async () => {
  const path='/learning/admin/jobs/job/recommendations';
  await call('tutor','/learning/jobs/job/applications','POST',{introduction:'Hello'});
  assert.equal((await call('admin',path,'POST',{tutorIds:['tutor']})).status,400);
  assert.equal((await call('admin','/learning/admin/jobs/job/candidates')).status,400);
  assert.equal((await call('admin','/learning/admin/jobs')).body[0].applicantCount,1);
  records.delete('applications/job_tutor');records.set('job_posts/job',{...records.get('job_posts/job'),status:'CLOSED'});
  assert.equal((await call('admin',path,'POST',{tutorIds:['tutor']})).status,400);
});

test('candidate list excludes inactive tutors and private fields; rejection preserves open job', async () => {
  const path='/learning/admin/jobs/job';
  assert.equal((await call('owner',path+'/candidates')).status,403);
  let candidates=(await call('admin',path+'/candidates')).body;
  assert.deepEqual(candidates.map(c=>c.id),['tutor']);
  assert.equal(candidates[0].email,undefined);assert.equal(candidates[0].certificates,undefined);
  await call('admin',path+'/recommendations','POST',{tutorIds:['tutor']});
  candidates=(await call('admin',path+'/candidates')).body;assert.equal(candidates[0].alreadyRecommended,true);
  assert.equal((await call('admin','/learning/admin/jobs')).body[0].recommendationCount,1);
  assert.equal((await call('owner','/learning/applications/job_tutor','PATCH',{status:'REJECTED'})).status,200);
  assert.equal(records.get('job_posts/job').status,'OPEN');
});
test('applicants are private to the job owner', async () => {
  assert.equal((await call('other', '/learning/jobs/job/applications')).status, 400);
  assert.equal((await call('owner', '/learning/jobs/job/applications')).status, 200);
});
test('public tutor projection never includes identity documents, email or certificate files', async () => {
  const result = await call('owner', '/learning/tutors/tutor');
  assert.equal(result.status, 200);
  for (const key of ['email', 'documentBase64', 'verification', 'certificates', 'front', 'back']) assert.equal(result.body[key], undefined);
  assert.equal(result.body.displayName, 'Tutor');
});
test('only owner accepts applicants, and acceptance closes matching atomically', async () => {
  await call('tutor', '/learning/jobs/job/applications', 'POST', {introduction: 'Hello'});
  assert.equal((await call('other', '/learning/applications/job_tutor', 'PATCH', {status: 'ACCEPTED'})).status, 400);
  assert.equal((await call('owner', '/learning/applications/job_tutor', 'PATCH', {status: 'ACCEPTED'})).status, 200);
  assert.equal(records.get('job_posts/job').status, 'MATCHED');
  assert.equal(records.get('applications/job_tutor').status, 'ACCEPTED');
});
test('suspension before acceptance prevents a tutor from receiving a class', async () => {
  await call('tutor', '/learning/jobs/job/applications', 'POST', {introduction: 'Hello'});
  records.set('users/tutor', {role: 'tutor', tutorStatus: 'APPROVED', accountStatus: 'locked'});
  assert.equal((await call('owner', '/learning/applications/job_tutor', 'PATCH', {status: 'ACCEPTED'})).status, 400);
  assert.equal(records.get('job_posts/job').status, 'OPEN');
});
test('a user cannot read tutor verification data through the owner endpoint', async () => {
  assert.equal((await call('owner', '/profile/tutor')).status, 400);
  assert.equal((await call('tutor', '/profile/tutor')).body.verification.front, 'private front');
});
test('submitting an incomplete tutor profile cannot change approval state', async () => {
  assert.equal((await call('tutor', '/profile/tutor', 'PUT', {draft: {}, verification: {}, submit: true})).status, 400);
  assert.equal(records.get('users/tutor').tutorStatus, 'APPROVED');
});

test('draft submission, rejection with reason, resubmission and approval form a complete cycle', async () => {
  records.set('users/tutor', {role: 'tutor', tutorStatus: 'DRAFT', accountStatus: 'active'});
  const draft = {...emptyTutorDraft(), photoURL: 'data:image/jpeg;base64,AA==', dateOfBirth: '2000-01-01', gender: 'Nam', province: 'Hà Nội', ward: 'Phường Cầu Giấy', district: 'Cầu Giấy', university: 'Đại học', major: 'Toán', educationLevel: 'Đại học', educationStatus: 'Đã tốt nghiệp', startYear: '2018', graduationYear: '2022', subjects: ['Toán'], grades: ['Lớp 10'], levels: ['THPT'], experienceYears: '0', experienceLevel: 'Chưa có kinh nghiệm', teachingModes: ['ONLINE'], onlinePrice: '100000', availability: [{dayOfWeek: 'MONDAY', startTime: '18:00', endTime: '20:00'}], title: 'Gia sư Toán', bio: 'Giới thiệu', teachingMethod: 'Theo mục tiêu', strengths: 'Kiên nhẫn'};
  const verification = {front: 'data:image/jpeg;base64,AA==', back: 'data:image/jpeg;base64,AA==', portrait: 'data:image/jpeg;base64,AA=='};
  assert.equal((await call('tutor', '/profile/tutor', 'PUT', {draft, verification, submit: true})).status, 200);
  assert.equal(records.get('users/tutor').tutorStatus, 'PENDING');
  assert.equal((await call('tutor', '/profile/tutor', 'PUT', {draft, verification})).status, 400);
  assert.equal((await call('owner', '/admin/tutors/tutor/status', 'PATCH', {status: 'approved'})).status, 403);
  assert.equal((await call('admin', '/admin/tutors/tutor/status', 'PATCH', {status: 'rejected'})).status, 400);
  assert.equal((await call('admin', '/admin/tutors/tutor/status', 'PATCH', {status: 'rejected', rejectionReason: 'Ảnh mờ'})).status, 200);
  assert.equal((await call('tutor', '/profile/tutor')).body.rejectionReason, 'Ảnh mờ');
  assert.equal((await call('tutor', '/profile/tutor', 'PUT', {draft, verification, submit: true})).status, 200);
  assert.equal((await call('admin', '/admin/tutors/tutor/status', 'PATCH', {status: 'approved'})).status, 200);
  assert.equal(records.get('users/tutor').tutorStatus, 'APPROVED');
  assert.equal(records.get('users/tutor').identityVerified, true);
  assert.equal(records.get('users/tutor').rejectionReason, '');
});
test('registration cannot choose admin or overwrite an existing role', async () => {
  assert.equal((await call('new-user', '/profile/register', 'POST', {role: 'admin', displayName: 'Name', phoneNumber: '0912345678', acceptedTerms: true})).status, 400);
  assert.equal((await call('owner', '/profile/register', 'POST', {role: 'tutor', displayName: 'Name', phoneNumber: '0912345678', acceptedTerms: true})).status, 400);
  assert.equal(records.get('users/owner').role, 'user');
});

const seedContract = (status = 'WAIT_FIRST_PAYMENT', sessions = 8) => {
  const data = {userId: 'owner', tutorId: 'tutor', tutorName: 'Tutor', learnerName: 'Child', subject: 'Math', packageLabel: '1 month', sessions, firstAmount: 100000, remainingAmount: sessions === 1 ? 0 : 700000, total: sessions === 1 ? 100000 : 800000, status, lessons: Array.from({length: sessions}, (_, i) => ({date: '2020-01-' + String(i + 1).padStart(2, '0'), startTime: '18:00', endTime: '20:00'}))};
  records.set('learning_contracts/c1', data); return data;
};
test('contract creation validates ownership, tutor schedule and server pricing; retry creates once', async () => {
  records.set('learners/l1', {userId: 'owner', fullName: 'Child', grade: 'Grade 9'});
  const schedule = [{dayOfWeek: 'MONDAY', startTime: '18:00', endTime: '20:00'}];
  records.set('tutor_profiles/tutor', {subjects: ['Math'], grades: ['Grade 9'], teachingModes: ['ONLINE'], onlinePrice: '100000', priceUnit: 'HOUR', availability: schedule});
  const body = {requestId: 'unique-1', tutorId: 'tutor', learnerId: 'l1', subject: 'Math', mode: 'ONLINE', packageId: 'MONTH_1', startDate: '2090-09-01', schedule, total: 1};
  assert.equal((await call('other', '/contracts', 'POST', body)).status, 400);
  assert.equal((await call('owner', '/contracts', 'POST', {...body, schedule: [{...schedule[0], startTime: '17:00'}]})).status, 400);
  const first = await call('owner', '/contracts', 'POST', body);
  assert.equal(first.status, 201);
  assert.equal(records.get(`learning_contracts/${first.body.id}`).firstAmount, 200000);
  assert.equal((await call('owner', '/contracts', 'POST', body)).body.id, first.body.id);
  assert.equal([...records.keys()].filter(k => k.startsWith('learning_contracts/')).length, 1);
});
test('payment settlement is exact, idempotent and only activates after both stages', async () => {
  seedContract();
  records.set('payment_orders/o1', {contractId: 'c1', stage: 'FIRST', amount: 100000, provider: 'test'});
  await assert.rejects(settleContractPayment('o1', 1, 'tx1'));
  assert.equal(records.get('learning_contracts/c1').status, 'WAIT_FIRST_PAYMENT');
  assert.equal((await call('owner', '/contracts/c1/decision', 'POST', {decision: 'ACCEPT'})).status, 400);
  await settleContractPayment('o1', 100000, 'tx1'); await settleContractPayment('o1', 100000, 'tx1');
  assert.equal(records.get('learning_contracts/c1').status, 'FIRST_SCHEDULED');
  assert.equal((await call('tutor', '/contracts/admin/c1/complete-first', 'POST')).status, 403);
  assert.equal((await call('admin', '/contracts/admin/c1/complete-first', 'POST')).status, 200);
  assert.equal((await call('other', '/contracts/c1/decision', 'POST', {decision: 'ACCEPT'})).status, 400);
  assert.equal((await call('owner', '/contracts/c1/decision', 'POST', {decision: 'ACCEPT'})).status, 200);
  assert.equal(records.get('learning_contracts/c1').status, 'WAIT_BALANCE');
  records.set('payment_orders/o2', {contractId: 'c1', stage: 'BALANCE', amount: 700000, provider: 'test'});
  await settleContractPayment('o2', 700000, 'tx2');
  assert.equal(records.get('learning_contracts/c1').status, 'ACTIVE');
  const paid = [...records.entries()].filter(([key]) => key.startsWith('payments/')).map(([,value]) => value);
  assert.equal(paid.length, 2); assert.equal(paid.reduce((sum,p) => sum + p.amount, 0), 800000);
  assert.ok(paid.every(p => p.recipient === 'CENTER'));
});
test('rejection counts once, cancels remaining lessons and hides payments from tutor', async () => {
  seedContract('AWAIT_DECISION');
  assert.equal((await call('owner', '/contracts/c1/decision', 'POST', {decision: 'REJECT', reason: ''})).status, 400);
  for (let i = 0; i < 2; i++) assert.equal((await call('owner', '/contracts/c1/decision', 'POST', {decision: 'REJECT', reason: 'Not suitable'})).status, 200);
  const tutor = await call('tutor', '/contracts');
  assert.equal(tutor.body.rejectionCount, 1);
  assert.equal(tutor.body.contracts[0].rejectionReason, 'Not suitable');
  for (const key of ['total', 'firstAmount', 'remainingAmount', 'userId']) assert.equal(tutor.body.contracts[0][key], undefined);
  assert.equal((await call('other', '/contracts')).body.contracts.length, 0);
  assert.equal((await call('owner', '/contracts/admin/all')).status, 403);
  assert.equal((await call('owner', '/contracts/c1/decision', 'POST', {decision: 'ACCEPT'})).status, 400);
});
test('single lesson completes without remaining payment; future lesson cannot complete early', async () => {
  const data = seedContract('FIRST_SCHEDULED', 1);
  records.set('learning_contracts/c1', {...data, lessons: [{date: '2090-01-01', startTime: '18:00', endTime: '20:00'}]});
  assert.equal((await call('admin', '/contracts/admin/c1/complete-first', 'POST')).status, 400);
  records.set('learning_contracts/c1', data);
  assert.equal((await call('admin', '/contracts/admin/c1/complete-first', 'POST')).status, 200);
  assert.equal(records.get('learning_contracts/c1').status, 'COMPLETED');
});
test('duplicate successful transfer is reconciled, never credits twice', async () => {
  seedContract();
  records.set('payment_orders/o1', {contractId: 'c1', stage: 'FIRST', amount: 100000, provider: 'test'});
  records.set('payment_orders/o2', {contractId: 'c1', stage: 'FIRST', amount: 100000, provider: 'test'});
  await settleContractPayment('o1', 100000, 'tx1'); await settleContractPayment('o2', 100000, 'tx2');
  assert.equal(records.get('payment_orders/o2').needsReview, true);
  assert.equal([...records.keys()].filter(k => k.startsWith('payments/')).length, 1);
  assert.ok(records.has('payment_reconciliation/o2'));
});

test('checkout enforces ownership and refuses payment while provider is unconfigured', async () => {
  seedContract();
  assert.equal((await call('other', '/contracts/c1/checkout', 'POST')).status, 400);
  assert.equal((await call('tutor', '/contracts/c1/checkout', 'POST')).status, 400);
  assert.equal((await call('owner', '/contracts/c1/checkout', 'POST')).status, 503);
  assert.equal(records.get('learning_contracts/c1').status, 'WAIT_FIRST_PAYMENT');
  assert.equal((await call('owner', '/contracts/admin/reconciliation')).status, 403);
});
test('a provider transaction cannot pay two different orders', async () => {
  seedContract();
  records.set('payment_orders/o1', {contractId: 'c1', stage: 'FIRST', amount: 100000, provider: 'test'});
  records.set('payment_orders/o2', {contractId: 'c1', stage: 'FIRST', amount: 100000, provider: 'test'});
  await settleContractPayment('o1', 100000, 'same-tx');
  await assert.rejects(settleContractPayment('o2', 100000, 'same-tx'));
  assert.equal(records.get('payment_orders/o2').status, undefined);
});

test('schedule list and detail are scoped to owner or assigned tutor and do not expose money', async () => {
  seedContract('ACTIVE', 1);
  assert.equal((await call('other', '/schedule')).body.lessons.length, 0);
  for (const uid of ['owner', 'tutor']) {
    const list = await call(uid, '/schedule');
    assert.equal(list.status, 200); assert.equal(list.body.lessons.length, 1);
    const detail = await call(uid, '/schedule/c1/0');
    assert.deepEqual(detail.body.lesson, list.body.lessons[0]);
    assert.equal(detail.body.lesson.total, undefined); assert.equal(detail.body.lesson.userId, undefined);
  }
  assert.equal((await call('other', '/schedule/c1/0')).status, 404);
  assert.equal((await call('owner', '/schedule/c1/999')).status, 404);
  assert.equal((await call('owner', '/schedule/c1/-1')).status, 404);
  assert.equal((await call('', '/schedule')).status, 401);
});
test('admin completion persists, is idempotent and completes the entire package only at the end', async () => {
  const data = seedContract('ACTIVE', 3);
  records.set('learning_contracts/c1', {...data, lessons: [data.lessons[0], {date: '2020-01-02', startTime: '18:00', endTime: '20:00'}, {date: '2020-01-03', startTime: '18:00', endTime: '20:00'}]});
  assert.equal((await call('tutor', '/contracts/admin/c1/lessons/1/complete', 'POST')).status, 403);
  for (let i = 0; i < 2; i++) assert.equal((await call('admin', '/contracts/admin/c1/lessons/1/complete', 'POST')).status, 200);
  assert.equal(records.get('learning_contracts/c1').status, 'ACTIVE');
  assert.equal((await call('owner', '/schedule/c1/1')).body.lesson.status, 'COMPLETED');
  assert.equal((await call('admin', '/contracts/admin/c1/lessons/2/complete', 'POST')).status, 200);
  assert.equal(records.get('learning_contracts/c1').status, 'COMPLETED');
});
test('unpaid, cancelled and future lessons cannot be marked complete', async () => {
  for (const status of ['WAIT_FIRST_PAYMENT', 'WAIT_BALANCE', 'CANCELLED']) {
    const data = seedContract(status);
    records.set('learning_contracts/c1', {...data, lessons: [...data.lessons, data.lessons[0]]});
    assert.equal((await call('admin', '/contracts/admin/c1/lessons/1/complete', 'POST')).status, 400);
  }
  const data = seedContract('ACTIVE');
  records.set('learning_contracts/c1', {...data, lessons: [data.lessons[0], {date: '2090-01-01', startTime: '18:00', endTime: '20:00'}]});
  assert.equal((await call('admin', '/contracts/admin/c1/lessons/1/complete', 'POST')).status, 400);
});

test('booking conflicts include both tutor and learner; adjacent slots are valid', async () => {
  const {checkBooking} = await import('../dist/domain/bookingLocks.js');
  records.set('learning_contracts/existing', {tutorId:'tutor',learnerId:'l1',status:'ACTIVE',lessons:[{date:'2090-01-01',startTime:'18:00',endTime:'20:00'}]});
  const input={tutorId:'tutor',learnerId:'l2',lessons:[{date:'2090-01-01',startTime:'19:00',endTime:'21:00'}]};
  await assert.rejects(db.runTransaction(tx=>checkBooking(tx,input,'new')));
  await assert.rejects(db.runTransaction(tx=>checkBooking(tx,{...input,tutorId:'other-tutor',learnerId:'l1'},'new')));
  await db.runTransaction(async tx=>{const lock=await checkBooking(tx,{...input,lessons:[{date:'2090-01-01',startTime:'20:00',endTime:'22:00'}]},'new');lock();});
  assert.equal([...records.keys()].filter(k=>k.startsWith('schedule_locks/')).length,2);
});
test('two-party attendance cannot be forged and completion is durable', async () => {
  seedContract('FIRST_SCHEDULED');
  assert.equal((await call('owner','/operations/class/c1/lesson/0/report','POST')).status,400);
  assert.equal((await call('owner','/operations/class/c1/lesson/0/confirm','POST')).status,400);
  assert.equal((await call('tutor','/operations/class/c1/lesson/0/report','POST')).status,200);
  assert.equal((await call('tutor','/operations/class/c1/lesson/0/confirm','POST')).status,400);
  assert.equal((await call('owner','/operations/class/c1/lesson/0/confirm','POST')).status,200);
  assert.equal(records.get('learning_contracts/c1').status,'AWAIT_DECISION');
  assert.equal((await call('owner','/schedule/c1/0')).body.lesson.status,'COMPLETED');
});
test('dispute needs admin resolution with a reason, and can reopen for makeup', async () => {
  seedContract('FIRST_SCHEDULED');
  await call('tutor','/operations/class/c1/lesson/0/report','POST');
  assert.equal((await call('owner','/operations/class/c1/lesson/0/dispute','POST',{reason:'Tutor did not attend'})).status,200);
  assert.equal((await call('admin','/contracts/admin/c1/complete-first','POST')).status,400);
  assert.equal((await call('owner','/operations/admin/c1/0/resolve','POST',{decision:'COMPLETE',note:'fake'})).status,403);
  assert.equal((await call('admin','/operations/admin/c1/0/resolve','POST',{decision:'REOPEN',note:'Agreed to reschedule'})).status,200);
  assert.equal(records.get('learning_contracts/c1').lessonRecords[0].attendance.status,'REOPENED');
  assert.equal(records.get('learning_contracts/c1').status,'FIRST_SCHEDULED');
});
test('reopened makeup cannot be reported or completed until a new schedule is accepted', async () => {
  seedContract('FIRST_SCHEDULED', 1);
  const path = '/operations/class/c1/lesson/0/';
  await call('tutor', path + 'report', 'POST');
  await call('owner', path + 'dispute', 'POST', {reason: 'Did not attend'});
  await call('admin', '/operations/admin/c1/0/resolve', 'POST', {decision: 'REOPEN', note: 'Arrange makeup'});
  assert.equal((await call('tutor', path + 'report', 'POST')).status, 400);
  assert.equal((await call('admin', '/contracts/admin/c1/complete-first', 'POST')).status, 400);
  assert.equal((await call('owner', path + 'change', 'POST', {date: '2090-02-01', startTime: '18:00', endTime: '20:00', reason: 'Makeup'})).status, 200);
  const changeId = records.get('learning_contracts/c1').lessonRecords[0].change.id;
  assert.equal((await call('tutor', path + 'change-response', 'POST', {changeId, decision: 'ACCEPT'})).status, 200);
  const c = records.get('learning_contracts/c1');
  assert.equal(c.lessonRecords[0].attendance.status, 'MAKEUP_SCHEDULED');
  assert.equal(c.lessonRecords[0].attendanceHistory[0].resolution, 'Arrange makeup');
  assert.equal((await call('tutor', path + 'report', 'POST')).status, 400);
  // Simulate the accepted makeup's end time having passed.
  c.lessons[0].date = '2020-01-01';
  assert.equal((await call('tutor', path + 'report', 'POST')).status, 200);
  assert.equal((await call('owner', path + 'confirm', 'POST')).status, 200);
  assert.equal(records.get('learning_contracts/c1').status, 'COMPLETED');
});

test('a pending change can be rejected while the original lesson is in progress', async t => {
  const c = seedContract('ACTIVE', 2);
  records.set('learning_contracts/c1', {...c, lessons: [c.lessons[0], {date: '2090-01-01', startTime: '18:00', endTime: '20:00'}]});
  const path = '/operations/class/c1/lesson/1/';
  await call('owner', path + 'change', 'POST', {date: '2090-01-02', startTime: '18:00', endTime: '20:00', reason: 'Busy'});
  const changeId = records.get('learning_contracts/c1').lessonRecords[1].change.id;
  t.mock.timers.enable({apis: ['Date'], now: new Date('2090-01-01T12:00:00Z')});
  assert.equal((await call('tutor', path + 'change-response', 'POST', {changeId, decision: 'REJECT'})).status, 200);
  assert.equal(records.get('learning_contracts/c1').lessonRecords[1].change.status, 'REJECTED');
  assert.equal(records.get('learning_contracts/c1').lessons[1].date, '2090-01-01');
});

test('journals and homework have distinct permissions and appear only to participants', async () => {
  seedContract('ACTIVE');
  const body={content:'Fractions',feedback:'Improving',homework:'Exercises 1-5',nextGoal:'Decimals'};
  assert.equal((await call('owner','/operations/class/c1/lesson/0/journal','POST',body)).status,400);
  assert.equal((await call('tutor','/operations/class/c1/lesson/0/journal','POST',body)).status,200);
  assert.equal((await call('other','/operations/class/c1')).status,400);
  assert.equal((await call('owner','/operations/class/c1')).body.records[0].journal.content,'Fractions');
  assert.equal((await call('tutor','/operations/class/c1/lesson/0/homework','POST',{done:true})).status,400);
  assert.equal((await call('owner','/operations/class/c1/lesson/0/homework','POST',{done:true})).status,200);
  assert.equal((await call('owner','/notifications/tasks/current')).body.filter(t=>t.title.includes('Exercises')).length,0);
});
test('rescheduling requires other party, protects duration and records history', async () => {
  const c=seedContract('ACTIVE',2);
  records.set('learning_contracts/c1',{...c,learnerId:'l1',lessons:[c.lessons[0],{date:'2090-01-01',startTime:'18:00',endTime:'20:00'}]});
  const path='/operations/class/c1/lesson/1/';
  assert.equal((await call('owner',path+'change','POST',{date:'2090-01-02',startTime:'18:00',endTime:'19:00',reason:'Busy'})).status,400);
  assert.equal((await call('owner',path+'change','POST',{date:'2090-01-02',startTime:'18:00',endTime:'20:00',reason:'Busy'})).status,200);
  const changeId=records.get('learning_contracts/c1').lessonRecords[1].change.id;
  assert.equal((await call('owner',path+'change-response','POST',{changeId,decision:'ACCEPT'})).status,400);
  assert.equal((await call('tutor',path+'change-response','POST',{changeId:'stale',decision:'ACCEPT'})).status,400);
  assert.equal((await call('tutor',path+'change-response','POST',{changeId,decision:'ACCEPT'})).status,200);
  const updated=records.get('learning_contracts/c1');assert.equal(updated.lessons[1].date,'2090-01-02');assert.equal(updated.scheduleHistory.length,1);
  assert.equal((await call('tutor',path+'change-response','POST',{changeId,decision:'ACCEPT'})).status,400);
});
test('reschedule acceptance rechecks another contract conflict', async () => {
  const c=seedContract('ACTIVE',2);records.set('learning_contracts/c1',{...c,learnerId:'l1',lessons:[c.lessons[0],{date:'2090-01-01',startTime:'18:00',endTime:'20:00'}]});
  const path='/operations/class/c1/lesson/1/';
  await call('owner',path+'change','POST',{date:'2090-01-02',startTime:'18:00',endTime:'20:00',reason:'Busy'});
  records.set('learning_contracts/c2',{tutorId:'tutor',learnerId:'l2',status:'ACTIVE',lessons:[{date:'2090-01-02',startTime:'19:00',endTime:'21:00'}]});
  const changeId=records.get('learning_contracts/c1').lessonRecords[1].change.id;
  assert.equal((await call('tutor',path+'change-response','POST',{changeId,decision:'ACCEPT'})).status,400);
  assert.equal(records.get('learning_contracts/c1').lessons[1].date,'2090-01-01');
});
test('students and admin operations use real contracts and enforce access', async () => {
  seedContract('ACTIVE',2);
  const students=await call('tutor','/operations/students');assert.equal(students.body.length,1);assert.equal(students.body[0].done,1);assert.equal(students.body[0].total,2);
  assert.equal((await call('owner','/operations/students')).status,400);
  assert.equal((await call('owner','/operations/admin/classes')).status,403);
  assert.equal((await call('admin','/operations/admin/classes')).body.length,1);
});
test('inbox and notification preferences are durable and private', async () => {
  seedContract('FIRST_SCHEDULED');await call('tutor','/operations/class/c1/lesson/0/report','POST');
  const notices=(await call('owner','/notifications')).body;assert.equal(notices.length,1);
  assert.equal((await call('other',`/notifications/${notices[0].id}/read`,'POST')).status,400);
  assert.equal((await call('owner',`/notifications/${notices[0].id}/read`,'POST')).status,200);
  assert.equal((await call('owner','/notifications')).body[0].read,true);
  assert.equal((await call('owner','/notifications/settings/current','PUT',{notifications:false,reminders:false})).status,200);
  assert.deepEqual((await call('owner','/notifications/settings/current')).body,{notifications:false,reminders:false});
});
test('reservation expires without counting as tutor rejection', async () => {
  const c=seedContract();records.set('learning_contracts/c1',{...c,reservationExpiresAtMs:Date.now()-1});
  await notificationTick();assert.equal(records.get('learning_contracts/c1').status,'VOID');
  assert.equal((await call('tutor','/contracts')).body.rejectionCount,0);
  assert.ok((await call('owner','/notifications')).body.length);
});
test('reminder generation deduplicates and honors notification preference', async () => {
  const date=new Date(Date.now()+30*60000+7*3600000);const c=seedContract('FIRST_SCHEDULED',1);
  const startTime=date.toISOString().slice(11,16);const end=new Date(date.getTime()+60000);
  records.set('learning_contracts/c1',{...c,lessons:[{date:date.toISOString().slice(0,10),startTime,endTime:end.toISOString().slice(11,16)}]});
  records.set('notification_settings/owner',{notifications:false,reminders:true});records.set('notification_settings/tutor',{notifications:false,reminders:true});
  await notificationTick();await notificationTick();assert.equal([...records.keys()].filter(k=>k.startsWith('notifications/reminder_')).length,2);
});

test('push sends once with private payload and respects saved preferences', async () => {
  records.set('push_devices/device', {uid:'owner',token:'test-token'});
  records.set('notifications/n1', {uid:'owner',title:'Private lesson content',kind:'EVENT',createdAtMs:Date.now(),pushed:false});
  await notificationTick();await notificationTick();
  assert.equal(sendPush.mock.callCount(),1);
  const payload=sendPush.mock.calls[0].arguments[0];
  assert.deepEqual(payload.data,{notificationId:'n1',uid:'owner'});
  assert.equal(payload.notification.body.includes('Private lesson content'),false);
  assert.equal(records.get('notifications/n1').deliveryStatus,'SENT');
  records.set('notification_settings/owner',{notifications:false});
  records.set('notifications/n2',{uid:'owner',kind:'EVENT',createdAtMs:Date.now(),pushed:false});
  await notificationTick();assert.equal(sendPush.mock.callCount(),1);
  assert.equal(records.get('notifications/n2').deliveryStatus,'SKIPPED');
});

test('push retries transient failures and removes expired tokens without claiming delivery', async () => {
  records.set('push_devices/device',{uid:'owner',token:'test-token'});
  records.set('notifications/n1',{uid:'owner',kind:'EVENT',createdAtMs:Date.now(),pushed:false});
  sendPush.mock.mockImplementation(async()=>{throw Object.assign(new Error('Unavailable'),{code:'messaging/server-unavailable'});});
  await notificationTick();assert.equal(records.get('notifications/n1').pushed,false);
  assert.equal(records.get('notifications/n1').deliveryStatus,'RETRY');
  sendPush.mock.mockImplementation(async()=>{throw Object.assign(new Error('Expired'),{code:'messaging/registration-token-not-registered'});});
  await notificationTick();assert.equal(records.has('push_devices/device'),false);
  assert.equal(records.get('notifications/n1').pushed,true);
  assert.equal(records.get('notifications/n1').deliveryStatus,'INBOX_ONLY');
});

function setupMomo(t) {
  const vars = {PAYMENT_PROVIDER: 'momo', MOMO_PARTNER_CODE: 'TEST', MOMO_ACCESS_KEY: 'access', MOMO_SECRET_KEY: 'secret', MOMO_PUBLIC_URL: 'https://backend.example.com'};
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => { for (const key of Object.keys(vars)) { if(previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const nativeFetch = globalThis.fetch;
  const requests = [];
  const mocked = mock.method(globalThis, 'fetch', async (url, options) => {
    if (url !== 'https://test-payment.momo.vn/v2/gateway/api/create') return nativeFetch(url, options);
    const body = JSON.parse(options.body); requests.push(body);
    return Response.json({...body, resultCode: 0, payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?t=test'});
  });
  t.after(() => mocked.mock.restore());
  return requests;
}
function ipn(orderId, changes = {}) {
  const order = records.get(`payment_orders/${orderId}`);
  const body = {partnerCode: 'TEST', orderId, requestId: orderId, amount: order.amount, orderInfo: order.orderInfo, extraData: '', orderType: 'momo_wallet', payType: 'qr', transId: 123456, resultCode: 0, responseTime: 1234, message: 'Success', ...changes};
  const raw = `accessKey=access&amount=${body.amount}&extraData=${body.extraData}&message=${body.message}&orderId=${body.orderId}&orderInfo=${body.orderInfo}&orderType=${body.orderType}&partnerCode=${body.partnerCode}&payType=${body.payType}&requestId=${body.requestId}&responseTime=${body.responseTime}&resultCode=${body.resultCode}&transId=${body.transId}`;
  return {...body, signature: createHmac('sha256', 'secret').update(raw).digest('hex')};
}

test('MoMo checkout signs server amount, reuses pending order and restricts reads', async t => {
  const requests = setupMomo(t); seedContract();
  assert.equal((await call('', '/contracts/c1/checkout', 'POST')).status, 401);
  assert.equal((await call('other', '/contracts/c1/checkout', 'POST')).status, 400);
  const first = await call('owner', '/contracts/c1/checkout', 'POST', {amount: 1});
  assert.equal(first.status, 200);
  assert.equal(first.body.sandbox, true);
  const second = await call('owner', '/contracts/c1/checkout', 'POST');
  assert.equal(first.body.orderId, second.body.orderId);
  assert.equal(requests.length, 1);
  const b = requests[0];
  assert.equal(b.amount, 100000); assert.equal(b.autoCapture, true);
  assert.equal(b.accessKey, undefined); assert.equal(b.secretKey, undefined);
  const raw = `accessKey=access&amount=100000&extraData=&ipnUrl=https://backend.example.com/api/payments/momo/ipn&orderId=${b.orderId}&orderInfo=${b.orderInfo}&partnerCode=TEST&redirectUrl=https://backend.example.com/api/payments/momo/return&requestId=${b.requestId}&requestType=captureWallet`;
  assert.equal(b.signature, createHmac('sha256', 'secret').update(raw).digest('hex'));
  assert.equal((await call('other', `/payments/${b.orderId}`)).status, 404);
  assert.equal((await call('owner', `/payments/${b.orderId}`)).body.status, 'pending');
  assert.equal(records.get('learning_contracts/c1').status, 'WAIT_FIRST_PAYMENT');
});

test('MoMo IPN rejects forged signatures and mismatched fields, settles both stages idempotently', async t => {
  setupMomo(t); seedContract();
  const {body: order} = await call('owner', '/contracts/c1/checkout', 'POST');
  const post = body => call('', '/payments/momo/ipn', 'POST', body);
  assert.equal((await post({...ipn(order.orderId), signature: '0'.repeat(64)})).status, 401);
  for(const changes of [{amount: 1000}, {requestId: 'other'}, {orderInfo: 'wrong'}, {transId: 0}]) assert.equal((await post(ipn(order.orderId, changes))).status, 400);
  assert.equal((await post(ipn(order.orderId, {partnerCode: 'OTHER'}))).status, 401);
  assert.equal((await post(ipn(order.orderId, {resultCode: 7000}))).status, 204);
  assert.equal(records.get('learning_contracts/c1').status, 'WAIT_FIRST_PAYMENT');
  for(let i = 0; i < 2; i++) assert.equal((await post(ipn(order.orderId))).status, 204);
  assert.equal(records.get('learning_contracts/c1').status, 'FIRST_SCHEDULED');
  assert.equal((await post(ipn(order.orderId, {resultCode: 1006}))).status, 204);
  assert.equal(records.get(`payment_orders/${order.orderId}`).status, 'paid');
  await call('admin', '/contracts/admin/c1/complete-first', 'POST');
  await call('owner', '/contracts/c1/decision', 'POST', {decision: 'ACCEPT'});
  const {body: balance} = await call('owner', '/contracts/c1/checkout', 'POST');
  assert.notEqual(balance.orderId, order.orderId);
  assert.equal(records.get(`payment_orders/${balance.orderId}`).amount, 700000);
  assert.equal((await post(ipn(balance.orderId, {transId: 123457}))).status, 204);
  assert.equal(records.get('learning_contracts/c1').status, 'ACTIVE');
});

test('MoMo failure permits a new order and late success is reconciled', async t => {
  setupMomo(t); seedContract();
  const first = (await call('owner', '/contracts/c1/checkout', 'POST')).body;
  await call('', '/payments/momo/ipn', 'POST', ipn(first.orderId, {resultCode: 1006}));
  assert.equal(records.get('learning_contracts/c1').status, 'WAIT_FIRST_PAYMENT');
  const second = (await call('owner', '/contracts/c1/checkout', 'POST')).body;
  assert.notEqual(first.orderId, second.orderId);
  await call('owner', '/contracts/c1/cancel-unpaid', 'POST');
  assert.equal((await call('', '/payments/momo/ipn', 'POST', ipn(second.orderId))).status, 204);
  assert.equal(records.get('learning_contracts/c1').status, 'VOID');
  assert.equal(records.get(`payment_orders/${second.orderId}`).needsReview, true);
});

function setupZalo(t) {
  const vars = {PAYMENT_PROVIDER: 'zalopay', ZALOPAY_APP_ID: '1234', ZALOPAY_KEY1: 'key-one', ZALOPAY_KEY2: 'key-two', ZALOPAY_PUBLIC_URL: 'https://backend.example.com'};
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => { for (const key of Object.keys(vars)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const original = globalThis.fetch;
  const state = {creates: [], queries: [], query: {return_code: 3}, create: {return_code: 1, order_url: 'https://sbgateway.zalopay.vn/openinapp?order=test'}, timeout: false};
  const mocked = mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).startsWith('https://sb-openapi.zalopay.vn/v2/')) return original(url, options);
    const b = JSON.parse(options.body);
    if (url.endsWith('/create')) {
      state.creates.push(b);
      const raw = `${b.app_id}|${b.app_trans_id}|${b.app_user}|${b.amount}|${b.app_time}|${b.embed_data}|${b.item}`;
      assert.equal(b.mac, createHmac('sha256', 'key-one').update(raw).digest('hex'));
      if (state.timeout) throw new Error('timeout');
      return Response.json(state.create);
    }
    state.queries.push(b);
    assert.equal(b.mac, createHmac('sha256', 'key-one').update(`1234|${b.app_trans_id}|key-one`).digest('hex'));
    return Response.json(state.query);
  });
  t.after(() => mocked.mock.restore());
  return state;
}
function zaloCallback(orderId, changes = {}) {
  const order = records.get(`payment_orders/${orderId}`);
  const data = JSON.stringify({app_id: 1234, app_trans_id: orderId, app_user: order.appUser, amount: order.amount, zp_trans_id: 260924000000001, ...changes});
  return {type: 1, data, mac: createHmac('sha256', 'key-two').update(data).digest('hex')};
}

test('ZaloPay creates a signed sandbox order with server pricing and reuses it', async t => {
  const state = setupZalo(t); seedContract();
  assert.equal((await call('other', '/contracts/c1/checkout', 'POST')).status, 400);
  const result = await call('owner', '/contracts/c1/checkout', 'POST', {amount: 1, provider: 'momo'});
  assert.equal(result.status, 200); assert.equal(result.body.provider, 'zalopay');
  const id = result.body.orderId;
  assert.match(id, /^\d{6}_[a-f0-9]{24}$/); assert.ok(id.length <= 40);
  assert.equal(state.creates[0].amount, 100000);
  assert.equal(state.creates[0].callback_url, 'https://backend.example.com/api/payments/zalopay/callback');
  assert.deepEqual(JSON.parse(state.creates[0].embed_data).preferred_payment_method, ['zalopay_wallet']);
  assert.equal((await call('owner', '/contracts/c1/checkout', 'POST')).body.orderId, id);
  assert.equal(state.creates.length, 1);
  const queryCount = state.queries.length;
  assert.equal((await call('other', `/payments/${id}`)).status, 404);
  assert.equal(state.queries.length, queryCount);
  assert.equal(records.get('learning_contracts/c1').status, 'WAIT_FIRST_PAYMENT');
});

test('ZaloPay rejects forged callbacks, mismatched app/user/amount and wrong callback type', async t => {
  setupZalo(t); seedContract();
  const {body: {orderId}} = await call('owner', '/contracts/c1/checkout', 'POST');
  const post = body => call('', '/payments/zalopay/callback', 'POST', body);
  assert.equal((await post({...zaloCallback(orderId), mac: '0'.repeat(64)})).body.return_code, 2);
  assert.equal((await post({...zaloCallback(orderId), type: 2})).body.return_code, 2);
  for (const change of [{app_id: 9999}, {app_user: 'other'}, {amount: 1}, {zp_trans_id: 0}, {zp_trans_id: Number.MAX_SAFE_INTEGER + 1}]) {
    assert.equal((await post(zaloCallback(orderId, change))).body.return_code, 2);
  }
  assert.equal(records.get('learning_contracts/c1').status, 'WAIT_FIRST_PAYMENT');
  const redirect = await call('', '/payments/zalopay/return?status=1&amount=100000');
  assert.equal(redirect.status, 200);
  assert.equal(records.get('learning_contracts/c1').status, 'WAIT_FIRST_PAYMENT');
  for(let i = 0; i < 2; i++) assert.equal((await post(zaloCallback(orderId))).body.return_code, 1);
  assert.equal(records.get('learning_contracts/c1').status, 'FIRST_SCHEDULED');
  assert.equal([...records.keys()].filter(k => k.startsWith('payments/')).length, 1);
});

test('ZaloPay query recovers a missed callback and completes the balance payment', async t => {
  const state = setupZalo(t); seedContract();
  const first = (await call('owner', '/contracts/c1/checkout', 'POST')).body;
  state.query = {return_code: 1, amount: 1, zp_trans_id: 260924000000001};
  assert.equal((await call('owner', `/payments/${first.orderId}`)).status, 400);
  assert.equal(records.get('learning_contracts/c1').status, 'WAIT_FIRST_PAYMENT');
  state.query.amount = 100000;
  assert.equal((await call('owner', `/payments/${first.orderId}`)).body.status, 'paid');
  assert.equal((await call('', '/payments/zalopay/callback', 'POST', zaloCallback(first.orderId))).body.return_code, 1);
  await call('admin', '/contracts/admin/c1/complete-first', 'POST');
  await call('owner', '/contracts/c1/decision', 'POST', {decision: 'ACCEPT'});
  const balance = (await call('owner', '/contracts/c1/checkout', 'POST')).body;
  assert.notEqual(balance.orderId, first.orderId);
  assert.equal(records.get(`payment_orders/${balance.orderId}`).amount, 700000);
  state.query = {return_code: 1, amount: 700000, zp_trans_id: 260924000000002};
  assert.equal((await call('owner', `/payments/${balance.orderId}`)).body.status, 'paid');
  assert.equal(records.get('learning_contracts/c1').status, 'ACTIVE');
});

test('ZaloPay only replaces confirmed expired orders, and reconciles late transfers', async t => {
  const state = setupZalo(t); seedContract();
  const first = (await call('owner', '/contracts/c1/checkout', 'POST')).body;
  state.query = {return_code: 2, sub_return_code: -402};
  assert.equal((await call('owner', '/contracts/c1/checkout', 'POST')).status, 400);
  assert.equal(state.creates.length, 1);
  assert.equal(records.get(`payment_orders/${first.orderId}`).status, 'pending');
  state.query = {return_code: 2, sub_return_code: -63};
  assert.equal((await call('owner', `/payments/${first.orderId}`)).body.status, 'pending');
  state.query = {return_code: 2, sub_return_code: -54};
  const second = (await call('owner', '/contracts/c1/checkout', 'POST')).body;
  assert.notEqual(second.orderId, first.orderId);
  await call('owner', '/contracts/c1/cancel-unpaid', 'POST');
  assert.equal((await call('', '/payments/zalopay/callback', 'POST', zaloCallback(second.orderId))).body.return_code, 1);
  assert.equal(records.get('learning_contracts/c1').status, 'VOID');
  assert.equal(records.get(`payment_orders/${second.orderId}`).needsReview, true);
});

test('ZaloPay timeout keeps the order ID and can retry after confirmed missing order', async t => {
  const state = setupZalo(t); seedContract(); state.timeout = true;
  assert.equal((await call('owner', '/contracts/c1/checkout', 'POST')).status, 400);
  const id = state.creates[0].app_trans_id;
  state.timeout = false; state.query = {return_code: 2, sub_return_code: -101};
  assert.equal((await call('owner', '/contracts/c1/checkout', 'POST')).body.orderId, id);
  assert.equal(state.creates[1].app_trans_id, id);
});

test('ZaloPay worker settles without an active mobile app; date IDs use Vietnam time', async t => {
  const {zaloOrderId} = await import('../dist/services/zalopay.js');
  assert.ok(zaloOrderId(Date.parse('2026-12-31T17:01:00Z')).startsWith('270101_'));
  const state = setupZalo(t); seedContract();
  const order = (await call('owner', '/contracts/c1/checkout', 'POST')).body;
  const record = records.get(`payment_orders/${order.orderId}`); record.appTime -= 60000;
  state.query = {return_code: 1, amount: 100000, zp_trans_id: 260924000000001};
  const {paymentTick} = await import('../dist/paymentWorker.js');
  await paymentTick(); await paymentTick();
  assert.equal(records.get('learning_contracts/c1').status, 'FIRST_SCHEDULED');
  assert.equal(state.queries.length, 1);
});

test('ZaloPay query-only demo needs no Key 2 or public URL and rejects all callbacks', async t => {
  const state = setupZalo(t); seedContract();
  const oldMode = process.env.ZALOPAY_VERIFY_MODE;
  process.env.ZALOPAY_VERIFY_MODE = 'query';
  process.env.ZALOPAY_KEY2 = ''; process.env.ZALOPAY_PUBLIC_URL = '';
  t.after(() => {if(oldMode === undefined) delete process.env.ZALOPAY_VERIFY_MODE; else process.env.ZALOPAY_VERIFY_MODE = oldMode;});
  state.create.order_url = 'https://qcgateway.zalopay.vn/openinapp?order=test';
  const result = await call('owner', '/contracts/c1/checkout', 'POST');
  assert.equal(result.status, 200);
  assert.equal(state.creates[0].callback_url, undefined);
  assert.equal(JSON.parse(state.creates[0].embed_data).redirecturl, 'http://127.0.0.1:3000/api/payments/zalopay/return');
  const callback = await call('', '/payments/zalopay/callback', 'POST', zaloCallback(result.body.orderId));
  assert.equal(callback.status, 503);
  assert.equal(records.get('learning_contracts/c1').status, 'WAIT_FIRST_PAYMENT');
  state.query = {return_code: 1, amount: 100000, zp_trans_id: 260925000000001};
  assert.equal((await call('owner', `/payments/${result.body.orderId}`)).body.status, 'paid');
  assert.equal(records.get('learning_contracts/c1').status, 'FIRST_SCHEDULED');
});

test('ZaloPay never accepts a production or lookalike checkout URL', async t => {
  const state = setupZalo(t); seedContract();
  for (const url of ['https://gateway.zalopay.vn/pay', 'https://qcgateway.zalopay.vn.evil.example/pay', 'http://qcgateway.zalopay.vn/pay']) {
    state.create.order_url = url;
    assert.equal((await call('owner', '/contracts/c1/checkout', 'POST')).status, 400);
    assert.equal(records.get('learning_contracts/c1').status, 'WAIT_FIRST_PAYMENT');
  }
});
