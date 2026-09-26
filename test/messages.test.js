import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorToast, spotsLabel, matchLabel } from '../src/ui/messages.js';

test('errorToast maps statuses to copy and a settings action', () => {
  assert.deepEqual(errorToast({ status: 'nokey' }), { title: 'Add your TypeSafe key', settings: true });
  assert.deepEqual(errorToast({ status: 401 }), { title: 'TypeSafe key rejected', settings: true });
  assert.deepEqual(errorToast({ status: 403 }), { title: 'TypeSafe denied access. Check your key or plan', settings: true });
  assert.deepEqual(errorToast({ status: 429 }), { title: 'TypeSafe is busy, try again', settings: false });
  assert.deepEqual(errorToast({ status: 529 }), { title: 'TypeSafe is busy, try again', settings: false });
  assert.deepEqual(errorToast({ status: 'network' }), { title: "Can't reach TypeSafe", settings: false });
  assert.deepEqual(errorToast(new Error('x')), { title: 'Something went wrong', settings: false });
});

test('labels', () => {
  assert.equal(spotsLabel(1), '1 spot');
  assert.equal(spotsLabel(3), '3 spots');
  assert.equal(matchLabel(1, 9, 4045), 'Match 2 of 9 · 1:07:25');
});
