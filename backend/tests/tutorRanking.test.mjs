import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rankMonthlyTutors,
  vietnamMonth,
} from '../dist/domain/tutorRanking.js';

test('Vietnam month handles UTC boundary and year rollover', () => {
  const period = vietnamMonth(new Date('2026-12-31T17:00:00Z'));
  assert.equal(period.label, '1/2027');
  assert.equal(
    new Date(period.start).toISOString(),
    '2026-12-31T17:00:00.000Z',
  );
  assert.equal(new Date(period.end).toISOString(), '2027-01-31T17:00:00.000Z');
});
test('ranking counts distinct accepted classes this month, excludes future and missing dates', () => {
  const entry = (tutorId, jobId, date, status = 'ACCEPTED') => ({
    tutorId,
    jobId,
    status,
    updatedAt: { toMillis: () => Date.parse(date) },
  });
  const result = rankMonthlyTutors(
    [
      entry('a', '1', '2026-08-31T17:00:00Z'),
      entry('a', '1', '2026-09-02T00:00:00Z'),
      entry('b', '2', '2026-09-01T00:00:00Z'),
      entry('b', '3', '2026-09-02T00:00:00Z'),
      entry('c', '4', '2026-08-31T16:59:59Z'),
      entry('c', '5', '2026-09-20T00:00:00Z'),
      entry('c', '6', '2026-09-02T00:00:00Z', 'REJECTED'),
      { tutorId: 'c', jobId: '7', status: 'ACCEPTED' },
    ],
    new Date('2026-09-18T00:00:00Z'),
  );
  assert.deepEqual(result, [
    { id: 'b', monthlyClasses: 2 },
    { id: 'a', monthlyClasses: 1 },
  ]);
});
