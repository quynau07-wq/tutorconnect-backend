import test from 'node:test';
import assert from 'node:assert/strict';
import {contractLessons, vietnamToday, weekBounds} from '../dist/domain/lessonSchedule.js';
const lessons = [{date: '2026-09-19', startTime: '18:00', endTime: '20:00'}, {date: '2026-09-21', startTime: '18:00', endTime: '20:00'}];
const now = new Date('2026-09-19T12:00:00Z');
const states = (status, extra = {}) => contractLessons('c', {status, lessons, ...extra}, now).map(l => l.status);
test('schedule gates unpaid lessons and preserves first lesson history on cancellation', () => {
  assert.deepEqual(states('WAIT_FIRST_PAYMENT'), ['WAIT_PAYMENT', 'WAIT_PAYMENT']);
  assert.deepEqual(states('FIRST_SCHEDULED'), ['IN_PROGRESS', 'WAIT_DECISION']);
  assert.deepEqual(states('AWAIT_DECISION'), ['COMPLETED', 'WAIT_DECISION']);
  assert.deepEqual(states('WAIT_BALANCE'), ['COMPLETED', 'WAIT_BALANCE']);
  assert.deepEqual(states('ACTIVE'), ['COMPLETED', 'UPCOMING']);
  assert.deepEqual(states('CANCELLED'), ['COMPLETED', 'CANCELLED']);
});
test('passing end time does not automatically complete a lesson', () => {
  const past = new Date('2026-09-22T00:00:00Z');
  assert.equal(contractLessons('c', {status: 'ACTIVE', lessons}, past)[1].status, 'AWAIT_CONFIRMATION');
  assert.equal(contractLessons('c', {status: 'ACTIVE', lessons, completedLessons: {'1': {confirmedBy: 'admin'}}}, past)[1].status, 'COMPLETED');
  assert.equal(contractLessons('c', {status: 'FIRST_SCHEDULED', lessons}, new Date('2026-09-19T13:00:00Z'))[0].status, 'AWAIT_CONFIRMATION');
});
test('Vietnam today and Monday-Sunday week cross months and years', () => {
  assert.equal(vietnamToday(new Date('2026-12-31T17:00:00Z')), '2027-01-01');
  assert.deepEqual(weekBounds('2027-01-01'), {start: '2026-12-28', end: '2027-01-03'});
  assert.deepEqual(weekBounds('2027-01-03'), {start: '2026-12-28', end: '2027-01-03'});
});
