import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchSchedule, validateSchedule} from '../dist/domain/schedule.js';
import {emptyTutorDraft, validateTutor} from '../dist/domain/profiles.js';
const slot = (dayOfWeek, startTime, endTime) => ({dayOfWeek, startTime, endTime});
test('schedule rejects reversed, malformed and overlapping slots', () => {
  for (const input of [[slot('MONDAY', '20:00', '18:00')], [slot('MONDAY', '18:00', '18:00')], [slot('MONDAY', '24:00', '25:00')], [slot('INVALID', '08:00', '10:00')], [slot('MONDAY', '18:00', '20:00'), slot('MONDAY', '19:00', '21:00')], [null], []]) assert.ok(validateSchedule(input));
});
test('multiple slots can touch without overlapping; different days are independent', () => {
  assert.equal(validateSchedule([slot('MONDAY', '18:00', '20:00'), slot('MONDAY', '20:00', '21:00'), slot('TUESDAY', '18:00', '20:00')]), null);
  assert.equal(validateSchedule([], false), null);
});
test('matching distinguishes full, partial and different-day schedules', () => {
  const wanted = [slot('MONDAY', '19:00', '21:00')];
  assert.equal(matchSchedule(wanted, [slot('MONDAY', '18:00', '22:00')]).scheduleScore, 100);
  assert.equal(matchSchedule(wanted, [slot('MONDAY', '20:00', '22:00')]).scheduleScore, 50);
  assert.equal(matchSchedule(wanted, [slot('TUESDAY', '19:00', '21:00')]).scheduleScore, 0);
});
test('two out of three equal-duration sessions matches 67 percent', () => {
  const wanted = ['MONDAY', 'WEDNESDAY', 'FRIDAY'].map(day => slot(day, '19:00', '21:00'));
  const result = matchSchedule(wanted, [slot('MONDAY', '18:00', '22:00'), slot('WEDNESDAY', '18:00', '21:00'), slot('FRIDAY', '14:00', '17:00')]);
  assert.equal(result.scheduleScore, 67); assert.equal(result.fullSlots, 2);
});
test('flexibility shifts the whole lesson within its tolerance', () => {
  const wanted = [slot('MONDAY', '19:00', '21:00')], available = [slot('MONDAY', '19:30', '21:30')];
  assert.equal(matchSchedule(wanted, available, 'FIXED').scheduleScore, 75);
  assert.equal(matchSchedule(wanted, available, 'PLUS_MINUS_30').scheduleScore, 100);
  assert.equal(matchSchedule(wanted, available, 'NEGOTIABLE').scheduleScore, 75);
});
test('overlapping availability cannot inflate matching above 100 percent', () => {
  assert.equal(matchSchedule([slot('MONDAY', '19:00', '21:00')], [slot('MONDAY', '18:00', '22:00'), slot('MONDAY', '19:00', '23:00')]).scheduleScore, 0);
});
test('empty and negative pricing is rejected; zero is supported', () => {
  const draft = {...emptyTutorDraft(), teachingModes: ['ONLINE']};
  assert.ok(validateTutor(draft, {}, 5)); draft.onlinePrice = '-1'; assert.ok(validateTutor(draft, {}, 5));
  draft.onlinePrice = '0'; assert.equal(validateTutor(draft, {}, 5), null);
});
test('verification and biography are mandatory for submission', () => {
  const draft = emptyTutorDraft();
  assert.ok(validateTutor(draft, {front: '', back: '', portrait: ''}, 9));
  assert.ok(validateTutor(draft, {}, 7));
});
test('personal step requires a ward instead of the legacy district', () => {
  const draft = {...emptyTutorDraft(), photoURL: 'photo', dateOfBirth: '2000-01-01', gender: 'Nam', province: 'Thành phố Hà Nội', ward: 'Phường Cầu Giấy', district: ''};
  assert.equal(validateTutor(draft, {}, 0), null);
  draft.ward = ''; draft.district = 'Cầu Giấy';
  assert.match(validateTutor(draft, {}, 0), /phường\/xã/);
});
