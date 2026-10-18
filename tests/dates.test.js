import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { daysBetween, todayLocal } from '../src/dates.js';

describe('dates', () => {
  it('formats today in local time', () => {
    assert.equal(todayLocal(new Date(2026, 9, 18, 23, 30)), '2026-10-18');
    assert.equal(todayLocal(new Date(2026, 0, 1, 0, 10)), '2026-01-01');
  });

  it('counts whole days either way across month ends and DST', () => {
    assert.equal(daysBetween('2026-10-18', '2026-10-21'), 3);
    assert.equal(daysBetween('2026-10-18', '2026-10-01'), -17);
    assert.equal(daysBetween('2026-03-30', '2026-04-10'), 11);
    assert.equal(daysBetween('2026-10-18', '2026-10-18'), 0);
  });
});
