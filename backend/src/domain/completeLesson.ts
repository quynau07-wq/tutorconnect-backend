import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase.js';
import { contractLessons } from './lessonSchedule.js';
import { activity } from './activity.js';
export async function completeLesson(
  contractId: string,
  index: number,
  adminId: string,
) {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new Error('Buổi học không hợp lệ.');
  const ref = db.collection('learning_contracts').doc(contractId);
  await db.runTransaction(async tx => {
    const data = (await tx.get(ref)).data();
    if (!data || !data.lessons?.[index])
      throw new Error('Không tìm thấy buổi học.');
    if (data.lessonRecords?.[index]?.attendance?.status === 'DISPUTED')
      throw new Error('Dùng mục xử lý phản hồi để ghi lý do giải quyết.');
    const patch = completionPatch(data, index, adminId);
    if (!Object.keys(patch).length) return;
    tx.update(ref, patch);
    activity(
      tx,
      contractId,
      data,
      adminId,
      'Trung tâm đã xác nhận hoàn thành buổi học',
      index,
    );
  });
}

export function completionPatch(
  data: Record<string, any>,
  index: number,
  adminId: string,
): Record<string, any> {
  if (data.lessonRecords?.[index]?.attendance?.status === 'REOPENED')
    throw new Error('Buổi được mở lại cần thống nhất lịch học bù trước khi xác nhận hoàn thành.');
  if (data.lessonRecords?.[index]?.change?.status === 'PENDING')
    throw new Error('Cần xử lý đề nghị đổi lịch trước.');
  const lessons = contractLessons('', data);
  if (lessons[index].status === 'COMPLETED') return {};
  if (
    lessons[index].status !== 'AWAIT_CONFIRMATION' ||
    (index === 0 ? data.status !== 'FIRST_SCHEDULED' : data.status !== 'ACTIVE')
  )
    throw new Error(
      'Chỉ xác nhận buổi đã được thanh toán và đã qua giờ kết thúc.',
    );
  const completedLessons = {
    ...data.completedLessons,
    [String(index)]: {
      confirmedBy: adminId,
      confirmedAt: FieldValue.serverTimestamp(),
    },
  };
  const allDone = lessons.every(
    (lesson, i) => i === index || lesson.status === 'COMPLETED',
  );
  return {
    completedLessons,
    ...(index === 0
      ? {
          firstCompletedAt: FieldValue.serverTimestamp(),
          firstCompletedBy: adminId,
          status: data.lessons.length === 1 ? 'COMPLETED' : 'AWAIT_DECISION',
        }
      : allDone
      ? { status: 'COMPLETED' }
      : {}),
  };
}
