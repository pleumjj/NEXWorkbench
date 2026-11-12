import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestorsOf, descendantsOf } from '../tree';
import { describeProcess } from '../index';
import { toolName } from '../classify';

const p = (pid: number, ppid: number) => ({ pid, ppid, name: 'x', command: 'x', cpu: 0, memory: 0, user: 'me' });

test('process tree: ancestors and descendants', () => {
  const list = [p(1, 0), p(10, 1), p(20, 10), p(30, 20), p(31, 20)];
  assert.deepEqual([...ancestorsOf(list, 30)].sort((a, b) => a - b), [10, 20, 30]);
  assert.deepEqual([...descendantsOf(list, 10)].sort((a, b) => a - b), [20, 30, 31]);
});
test('tool names normalise rewritten process titles', () => {
  assert.equal(toolName('npm run dev'), 'npm');
  assert.equal(toolName('postgres: db idle'), 'postgres');
  assert.equal(toolName('-zsh'), 'zsh');
  assert.equal(toolName('next-server (v15.5)'), 'next-server');
});
test('dictionary explains common processes', () => {
  assert.match(describeProcess('mds_stores')!, /^Spotlight/);
  assert.equal(describeProcess('Google Chrome Helper (Renderer)'), 'Renders a web page, tab or extension.');
  assert.match(describeProcess('svchost.exe')!, /Windows services/);
});
