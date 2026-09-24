const DAY = 86400000;
const OFFSET = 7 * 3600000;
const dateKey = (ms: number) => new Date(ms + OFFSET).toISOString().slice(0, 10);
export function revenueRange(period = 'month', from?: string, to?: string, now = Date.now()) {
  const today = dateKey(now);
  let start = today;
  if (period === 'custom') {
    const valid = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
    if (!valid(from) || !valid(to)) throw new Error('Chọn ngày bắt đầu và kết thúc hợp lệ.');
    start = from!;
  } else {
    const d = new Date(`${today}T00:00:00Z`);
    if (period === 'week') d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    else if (['month', '3months', '6months', 'year'].includes(period)) {
      d.setUTCDate(1);
      if (period === 'year') d.setUTCMonth(0);
      else d.setUTCMonth(d.getUTCMonth() - (period === '3months' ? 2 : period === '6months' ? 5 : 0));
    } else if (period !== 'day') throw new Error('Khoảng thống kê không hợp lệ.');
    start = d.toISOString().slice(0, 10);
  }
  const end = period === 'custom' ? to! : today;
  const fromMs = Date.parse(`${start}T00:00:00+07:00`);
  const toMs = Date.parse(`${end}T00:00:00+07:00`) + DAY;
  if (toMs <= fromMs) throw new Error('Ngày kết thúc phải từ ngày bắt đầu trở đi.');
  if (toMs - fromMs > 366 * 5 * DAY) throw new Error('Vui lòng chọn khoảng tối đa 5 năm.');
  return {from: start, to: end, fromMs, toMs, bucket: (toMs - fromMs === DAY ? 'hour' : toMs - fromMs <= 62 * DAY ? 'day' : 'month') as 'hour' | 'day' | 'month'};
}
export type RevenuePayment = {amount: number; status: string; timestamp: number; tutorId?: string; tutorName?: string};
export function summarizeRevenue(payments: RevenuePayment[], range: ReturnType<typeof revenueRange>) {
  const keyOf = (ms: number) => {
    const s = new Date(ms + OFFSET).toISOString();
    return s.slice(0, range.bucket === 'hour' ? 13 : range.bucket === 'day' ? 10 : 7);
  };
  const buckets = new Map<string, {key: string; total: number; count: number}>();
  for (let ms = range.fromMs; ms < range.toMs; ms += range.bucket === 'hour' ? 3600000 : DAY) {
    const key = keyOf(ms);
    if (!buckets.has(key)) buckets.set(key, {key, total: 0, count: 0});
  }
  const tutors = new Map<string, {id: string; name: string; total: number; count: number}>();
  let total = 0, count = 0;
  for (const p of payments) {
    if (p.status !== 'paid' || !Number.isSafeInteger(p.amount) || p.amount <= 0 || p.timestamp < range.fromMs || p.timestamp >= range.toMs || !Number.isFinite(p.timestamp)) continue;
    const bucket = buckets.get(keyOf(p.timestamp))!;
    bucket.total += p.amount; bucket.count++;
    total += p.amount; count++;
    const id = p.tutorId || 'unassigned';
    const tutor = tutors.get(id) || {id, name: p.tutorName || (p.tutorId ? 'Gia sư chưa có tên' : 'Chưa xác định gia sư'), total: 0, count: 0};
    tutor.total += p.amount; tutor.count++; tutors.set(id, tutor);
  }
  return {from: range.from, to: range.to, timezone: 'Asia/Ho_Chi_Minh', bucket: range.bucket, total, count, average: count ? Math.round(total / count) : 0, series: [...buckets.values()], tutors: [...tutors.values()].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))};
}
