import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextVersionId } from '../src/version.ts';

// Version ids order the snapshots, so they must keep increasing when two are minted
// in the same millisecond or the clock steps back. The clock is faked here: with the
// real one, whether two calls share a millisecond depends on timing.
test('nextVersionId stays strictly increasing when the clock stands still or steps back', (t) => {
  const now = t.mock.method(Date, 'now', () => Date.UTC(2100, 0, 1));
  const first = nextVersionId();
  const sameMs = nextVersionId();
  now.mock.mockImplementation(() => Date.UTC(2099, 11, 31, 23, 59, 59));
  const steppedBack = nextVersionId();
  assert.deepEqual([first, sameMs, steppedBack], [
    '2100-01-01T00:00:00.000Z',
    '2100-01-01T00:00:00.001Z',
    '2100-01-01T00:00:00.002Z',
  ]);
});
