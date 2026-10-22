import test from 'node:test';
import assert from 'node:assert/strict';
import { selectableWorkBranch } from '../public/shared/workbranches.js';

test('workbranch UI: original branches require explicit in-place mode even if server flags allow them', () => {
  const branch = { name: 'feature/original', original: true, selectable: true, selectableForTask: true, selectableForSession: true };
  assert.equal(selectableWorkBranch(branch, 'task'), false);
  assert.equal(selectableWorkBranch(branch, 'task', { inPlace: false }), false);
  assert.equal(selectableWorkBranch(branch, 'session'), false);
  assert.equal(selectableWorkBranch(branch, 'session', { inPlace: true }), false);
  assert.equal(selectableWorkBranch(branch, 'task', { inPlace: true }), true);
});

test('workbranch UI: in-place mode does not bypass missing, locked, base-branch or task-ownership restrictions', () => {
  const branch = { name: 'feature/original', original: true, selectable: true, selectableForTask: true };
  for (const restriction of [{ locked: true }, { missing: true }, { name: 'main' }, { name: 'develop' }, { selectableForTask: false }]) {
    assert.equal(selectableWorkBranch({ ...branch, ...restriction }, 'task', { inPlace: true }), false, JSON.stringify(restriction));
  }
  assert.equal(selectableWorkBranch({ name: 'feature/owned', selectableForTask: false, selectableForSession: true }, 'task', { inPlace: true }), false);
  assert.equal(selectableWorkBranch({ name: 'feature/owned', selectableForTask: false, selectableForSession: true }, 'session'), true);
});
