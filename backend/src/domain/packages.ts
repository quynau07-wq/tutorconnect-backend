import {
  DAYS,
  minutes,
  validateSchedule,
  type ScheduleSlot,
} from './schedule.js';
export const PACKAGES = [
  { id: 'SINGLE', label: '1 buổi', months: 0 },
  { id: 'MONTH_1', label: '1 tháng', months: 1 },
  { id: 'MONTH_3', label: '3 tháng', months: 3 },
  { id: 'MONTH_6', label: '6 tháng', months: 6 },
  { id: 'YEAR_1', label: '1 năm', months: 12 },
] as const;
export const CONTRACT_STATUS: Record<string, string> = {
  VOID: 'Đã hủy đăng ký chưa thanh toán',
  WAIT_FIRST_PAYMENT: 'Chờ thanh toán buổi đầu',
  FIRST_SCHEDULED: 'Đã thanh toán · chờ học buổi đầu',
  AWAIT_DECISION: 'Chờ quyết định sau buổi đầu',
  WAIT_BALANCE: 'Chờ thanh toán phần còn lại',
  ACTIVE: 'Đã thanh toán đủ · đang học',
  CANCELLED: 'Đã hủy sau buổi đầu',
  COMPLETED: 'Đã hoàn thành',
};
export function packageQuote(
  packageId: string,
  schedule: ScheduleSlot[],
  price: string,
  unit: string,
  startDate: string,
) {
  const selected = PACKAGES.find(item => item.id === packageId);
  if (!selected) throw new Error('Gói học không hợp lệ.');
  const error = validateSchedule(schedule);
  if (error) throw new Error(error);
  if (schedule.length > (selected.months ? 2 : 1))
    throw new Error(
      'Gói nhiều buổi tối đa 2 buổi/tuần; gói lẻ chỉ chọn 1 buổi.',
    );
  const durations = schedule.map(
    slot => minutes(slot.endTime) - minutes(slot.startTime),
  );
  if (
    durations.some(
      duration => duration < 30 || duration > 240 || duration !== durations[0],
    )
  )
    throw new Error('Các buổi phải cùng thời lượng, từ 30 đến 240 phút.');
  if (!/^\d+$/.test(price) || !['HOUR', 'SESSION'].includes(unit))
    throw new Error('Gia sư chưa có học phí hợp lệ.');
  const pricePerLesson = Math.round(
    Number(price) * (unit === 'HOUR' ? durations[0] / 60 : 1),
  );
  const lessons = lessonDates(startDate, schedule, selected.months);
  const sessions = lessons.length;
  const total = sessions * pricePerLesson;
  if (!Number.isSafeInteger(total) || pricePerLesson <= 0)
    throw new Error('Học phí phải lớn hơn 0 và trong giới hạn hợp lệ.');
  return {
    packageId,
    packageLabel: selected.label,
    startDate,
    lessons,
    sessions,
    pricePerLesson,
    total,
    firstAmount: pricePerLesson,
    remainingAmount: total - pricePerLesson,
  };
}
export function lessonDates(
  startDate: string,
  schedule: ScheduleSlot[],
  months: number,
) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
    !Number.isFinite(Date.parse(startDate)) ||
    new Date(startDate).toISOString().slice(0, 10) !== startDate
  )
    throw new Error('Ngày bắt đầu không hợp lệ.');
  const lessons: { date: string; startTime: string; endTime: string }[] = [];
  const date = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1),
  );
  const lastDay = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0),
  ).getUTCDate();
  end.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  for (
    let day = 0;
    day < 370 && (months ? date < end : !lessons.length);
    day++
  ) {
    const weekday = DAYS[(date.getUTCDay() + 6) % 7];
    for (const slot of schedule
      .filter(s => s.dayOfWeek === weekday)
      .sort((a, b) => a.startTime.localeCompare(b.startTime))) {
      lessons.push({
        date: date.toISOString().slice(0, 10),
        startTime: slot.startTime,
        endTime: slot.endTime,
      });
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  if (!lessons.length) throw new Error('Không thể tạo lịch học.');
  return lessons;
}
