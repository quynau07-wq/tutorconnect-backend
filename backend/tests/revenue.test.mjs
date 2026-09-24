import {test} from 'node:test';
import assert from 'node:assert/strict';
import {revenueRange, summarizeRevenue} from '../dist/domain/revenue.js';

test('revenue presets use Vietnam day, Monday week and calendar months across years', () => {
  const now = Date.parse('2025-12-31T18:00:00Z'); // Jan 1 in Vietnam
  const expected = {day:'2026-01-01', week:'2025-12-29', month:'2026-01-01', '3months':'2025-11-01', '6months':'2025-08-01', year:'2026-01-01'};
  for (const [period, from] of Object.entries(expected)) {
    const r = revenueRange(period, undefined, undefined, now);
    assert.equal(r.from, from); assert.equal(r.to, '2026-01-01');
  }
});
test('revenue range validates dates, order and maximum duration', () => {
  for (const [from,to] of [['2026-02-30','2026-03-01'],['2026-05-02','2026-05-01'],['','2026-01-01'],['2020-01-01','2026-01-01']]) {
    assert.throws(() => revenueRange('custom',from,to));
  }
  assert.throws(() => revenueRange('invalid'));
  assert.equal(revenueRange('custom','2024-02-29','2024-02-29').bucket,'hour');
});
test('only confirmed valid payments inside local date range contribute; breakdown totals match', () => {
  const r = revenueRange('custom','2026-09-25','2026-09-25');
  const p = {status:'paid',amount:100000,timestamp:r.fromMs,tutorId:'a',tutorName:'Gia sư A'};
  const report = summarizeRevenue([p, {...p,amount:300000,tutorId:'b',tutorName:'Gia sư B',timestamp:r.toMs-1}, {...p,timestamp:r.toMs}, {...p,timestamp:r.fromMs-1}, {...p,status:'pending'}, {...p,status:'failed'}, {...p,amount:-1}, {...p,amount:1.5}, {...p,timestamp:NaN}],r);
  assert.equal(report.total,400000); assert.equal(report.count,2); assert.equal(report.average,200000);
  assert.equal(report.series.length,24); assert.equal(report.series[0].total,100000); assert.equal(report.series[23].total,300000);
  assert.equal(report.tutors[0].id,'b');
  assert.equal(report.tutors.reduce((sum,t)=>sum+t.total,0),report.total);
  assert.equal(report.series.reduce((sum,t)=>sum+t.total,0),report.total);
});
test('tutors with the same name remain separate and missing tutor remains counted', () => {
  const r = revenueRange('custom','2026-01-01','2026-01-31');
  const payments = ['a','b',undefined].map(tutorId=>({amount:100,status:'paid',timestamp:r.fromMs,tutorId,tutorName:tutorId?'Nguyễn Văn A':undefined}));
  const report = summarizeRevenue(payments,r);
  assert.equal(report.tutors.length,3); assert.equal(report.total,300);
  assert.equal(report.tutors.find(t=>t.id==='unassigned').name,'Chưa xác định gia sư');
  assert.equal(report.series.length,31);
});
test('empty data keeps all month buckets including leap-year February', () => {
  const report = summarizeRevenue([],revenueRange('custom','2024-01-01','2024-06-30'));
  assert.deepEqual(report.series.map(p=>p.key),['2024-01','2024-02','2024-03','2024-04','2024-05','2024-06']);
  assert.equal(report.total,0); assert.equal(report.average,0); assert.deepEqual(report.tutors,[]);
});
