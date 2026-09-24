export const LESSON_STATUS = {
  WAIT_PAYMENT: 'Chờ thanh toán buổi đầu',
  WAIT_DECISION: 'Chờ quyết định sau buổi đầu',
  WAIT_BALANCE: 'Chờ thanh toán phần còn lại',
  UPCOMING: 'Sắp học',
  IN_PROGRESS: 'Đang diễn ra',
  AWAIT_CONFIRMATION: 'Chờ xác nhận đã học',
  COMPLETED: 'Đã hoàn thành',
  CANCELLED: 'Đã hủy',
} as const;
export type ScheduledLesson = {
  id: string;
  contractId: string;
  lessonIndex: number;
  date: string;
  startTime: string;
  endTime: string;
  tutorId: string;
  tutorName: string;
  learnerId: string;
  learnerName: string;
  subject: string;
  mode: string;
  location: string;
  packageLabel: string;
  contractStatus: string;
  status: keyof typeof LESSON_STATUS;
  rejectionReason: string;
};
export function vietnamToday(now = new Date()) {
  return new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}
export function weekBounds(today: string) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const start = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + 6);
  return { start, end: date.toISOString().slice(0, 10) };
}
export function contractLessons(
  contractId: string,
  data: Record<string, any>,
  now = new Date(),
): ScheduledLesson[] {
  return (data.lessons || []).map(
    (
      lesson: { date: string; startTime: string; endTime: string },
      index: number,
    ) => {
      const firstDone =
        index === 0 &&
        (data.firstCompletedAt ||
          [
            'AWAIT_DECISION',
            'WAIT_BALANCE',
            'ACTIVE',
            'COMPLETED',
            'CANCELLED',
          ].includes(data.status));
      let status: ScheduledLesson['status'];
      if (
        firstDone ||
        data.completedLessons?.[String(index)] ||
        data.status === 'COMPLETED'
      )
        status = 'COMPLETED';
      else if (['CANCELLED', 'VOID'].includes(data.status)) status = 'CANCELLED';
      else if (data.status === 'WAIT_FIRST_PAYMENT') status = 'WAIT_PAYMENT';
      else if (
        index > 0 &&
        ['FIRST_SCHEDULED', 'AWAIT_DECISION'].includes(data.status)
      )
        status = 'WAIT_DECISION';
      else if (index > 0 && data.status === 'WAIT_BALANCE')
        status = 'WAIT_BALANCE';
      else {
        const start = Date.parse(`${lesson.date}T${lesson.startTime}:00+07:00`);
        const end = Date.parse(`${lesson.date}T${lesson.endTime}:00+07:00`);
        status =
          now.getTime() < start
            ? 'UPCOMING'
            : now.getTime() < end
            ? 'IN_PROGRESS'
            : 'AWAIT_CONFIRMATION';
      }
      return {
        id: `${contractId}:${index}`,
        contractId,
        lessonIndex: index,
        ...lesson,
        tutorId: data.tutorId,
        tutorName: data.tutorName || '',
        learnerId: data.learnerId || contractId,
        learnerName: data.learnerName || '',
        subject: data.subject || '',
        mode: data.mode || '',
        location: data.location || '',
        packageLabel: data.packageLabel || '',
        contractStatus: data.status,
        status,
        rejectionReason: data.rejectionReason || '',
      };
    },
  );
}
