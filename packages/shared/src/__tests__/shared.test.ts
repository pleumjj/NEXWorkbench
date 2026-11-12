import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceState, type AttentionItem } from '../index';

const item = (severity: AttentionItem['severity']): Pick<AttentionItem, 'severity'> => ({ severity });

test('workspace state: deterministic from attention items', () => {
  assert.equal(workspaceState([]), 'Healthy');
  assert.equal(workspaceState([item('info')]), 'Healthy');
  assert.equal(workspaceState([item('info'), item('warning')]), 'Attention');
  assert.equal(workspaceState([item('warning'), item('critical')]), 'Critical');
});
test('workspace state: an unavailable module is never reported as Healthy', () => {
  assert.equal(workspaceState([], 1), 'Attention');
  assert.equal(workspaceState([item('critical')], 1), 'Critical');
});
