import test from 'node:test';
import assert from 'node:assert/strict';
import { packageQuote, lessonDates } from '../dist/domain/packages.js';
const schedule = [
  { dayOfWeek: 'MONDAY', startTime: '18:00', endTime: '20:00' },
  { dayOfWeek: 'THURSDAY', startTime: '18:00', endTime: '20:00' },
];
test('monthly packages count calendar lessons, not fixed four-week months', () => {
  const q = packageQuote('MONTH_1', schedule, '100000', 'HOUR', '2026-09-01');
  assert.equal(q.sessions, 8);
  assert.equal(q.firstAmount, 200000);
  assert.equal(q.remainingAmount, 1400000);
  const october = packageQuote(
    'MONTH_1',
    schedule,
    '150000',
    'SESSION',
    '2026-10-01',
  );
  assert.equal(october.sessions, 9);
  assert.equal(october.total, 1350000);
});
test('calendar clamps month-end, handles leap years and end-exclusive boundaries', () => {
  const dailySunday = [
    { dayOfWeek: 'SUNDAY', startTime: '08:00', endTime: '09:00' },
  ];
  const lessons = lessonDates('2027-01-31', dailySunday, 1);
  assert.equal(lessons[0].date, '2027-01-31');
  assert.equal(lessons.at(-1).date, '2027-02-21');
  assert.equal(
    lessonDates(
      '2028-02-01',
      [{ dayOfWeek: 'TUESDAY', startTime: '08:00', endTime: '09:00' }],
      1,
    ).length,
    5,
  );
  assert.throws(() => lessonDates('2026-02-30', schedule, 1));
});
test('single lesson, maximum two weekly slots and safe pricing', () => {
  const q = packageQuote(
    'SINGLE',
    schedule.slice(0, 1),
    '120000',
    'SESSION',
    '2026-09-01',
  );
  assert.equal(q.sessions, 1);
  assert.equal(q.remainingAmount, 0);
  assert.equal(q.lessons[0].date, '2026-09-07');
  assert.throws(() =>
    packageQuote('SINGLE', schedule, '120000', 'SESSION', '2026-09-01'),
  );
  assert.throws(() =>
    packageQuote(
      'YEAR_1',
      [...schedule, { ...schedule[0], dayOfWeek: 'FRIDAY' }],
      '120000',
      'SESSION',
      '2026-09-01',
    ),
  );
  for (const price of ['', '-1', 'NaN', '0', '999999999999999999'])
    assert.throws(() =>
      packageQuote('MONTH_1', schedule, price, 'HOUR', '2026-09-01'),
    );
  assert.equal(
    packageQuote('YEAR_1', schedule, '120000', 'SESSION', '2026-09-01')
      .sessions,
    104,
  );
});
