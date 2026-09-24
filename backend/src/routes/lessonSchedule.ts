import { Router } from 'express';
import { db } from '../config/firebase.js';
import { requireAuth } from '../middleware/auth.js';
import { account } from './profile.js';
import { contractLessons, vietnamToday } from '../domain/lessonSchedule.js';
export const lessonScheduleRouter = Router();
lessonScheduleRouter.use(requireAuth);
lessonScheduleRouter.get('/', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  const user = await account(uid);
  const now = new Date();
  const snapshot = await db
    .collection('learning_contracts')
    .where(user.role === 'tutor' ? 'tutorId' : 'userId', '==', uid)
    .get();
  const lessons = snapshot.docs
    .flatMap(d => contractLessons(d.id, d.data(), now))
    .sort(
      (a, b) =>
        `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`) ||
        a.id.localeCompare(b.id),
    );
  res.json({ role: user.role, today: vietnamToday(now), lessons });
});
lessonScheduleRouter.get('/:contractId/:index', async (req, res) => {
  const uid = req.firebaseUser!.uid;
  const user = await account(uid);
  const data = (
    await db
      .collection('learning_contracts')
      .doc(String(req.params.contractId))
      .get()
  ).data();
  const index = String(req.params.index);
  if (
    !data ||
    data[user.role === 'tutor' ? 'tutorId' : 'userId'] !== uid ||
    !/^(0|[1-9]\d*)$/.test(index)
  )
    return res.status(404).json({ message: 'Không tìm thấy buổi học.' });
  const lesson = contractLessons(String(req.params.contractId), data)[
    Number(index)
  ];
  if (!lesson)
    return res.status(404).json({ message: 'Không tìm thấy buổi học.' });
  res.json({ lesson, role: user.role });
});
