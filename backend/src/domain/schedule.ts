export const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;
export type DayOfWeek = typeof DAYS[number];
export type ScheduleSlot = {dayOfWeek: DayOfWeek; startTime: string; endTime: string};
export type ScheduleFlexibility = 'FIXED' | 'PLUS_MINUS_30' | 'PLUS_MINUS_60' | 'NEGOTIABLE';
export const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export const validateSchedule = (slots: unknown, required = true): string | null => {
  if (!Array.isArray(slots) || slots.length > 70 || (required && !slots.length)) return 'Vui lòng thêm lịch học hợp lệ.';
  for (const slot of slots) {
    if (!slot || !DAYS.includes(slot.dayOfWeek) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.endTime)) return 'Giờ phải có định dạng HH:mm.';
    if (minutes(slot.startTime) >= minutes(slot.endTime)) return 'Giờ kết thúc phải sau giờ bắt đầu.';
  }
  for (const day of DAYS) {
    const daySlots = slots.filter(slot => slot.dayOfWeek === day).sort((a, b) => minutes(a.startTime) - minutes(b.startTime));
    for (let i = 1; i < daySlots.length; i++) if (minutes(daySlots[i].startTime) < minutes(daySlots[i - 1].endTime)) return 'Các khung giờ trong cùng ngày không được trùng nhau.';
  }
  return null;
};

// Percentage of requested minutes covered, after shifting each whole lesson within tolerance.
// NEGOTIABLE is scored at the requested times; it is not treated as an automatic match.
export const matchSchedule = (wanted: ScheduleSlot[], available: ScheduleSlot[], flexibility: ScheduleFlexibility = 'FIXED') => {
  if (validateSchedule(wanted) || validateSchedule(available, false)) return {scheduleScore: 0, fullSlots: 0, partialSlots: 0, totalSlots: wanted.length};
  const tolerance = flexibility === 'PLUS_MINUS_30' ? 30 : flexibility === 'PLUS_MINUS_60' ? 60 : 0;
  let covered = 0, total = 0, fullSlots = 0, partialSlots = 0;
  for (const slot of wanted) {
    const start = minutes(slot.startTime), end = minutes(slot.endTime), duration = end - start;
    let best = 0;
    for (let shift = -tolerance; shift <= tolerance; shift++) {
      if (start + shift < 0 || end + shift > 1440) continue;
      const overlap = available.filter(item => item.dayOfWeek === slot.dayOfWeek).reduce((sum, item) => sum + Math.max(0, Math.min(end + shift, minutes(item.endTime)) - Math.max(start + shift, minutes(item.startTime))), 0);
      best = Math.max(best, overlap);
    }
    covered += best; total += duration;
    if (best === duration) fullSlots++; else if (best > 0) partialSlots++;
  }
  return {scheduleScore: Math.round(covered / total * 100), fullSlots, partialSlots, totalSlots: wanted.length};
};
