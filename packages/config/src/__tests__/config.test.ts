import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLocalRequest } from '../index';

const allowed = { origins: ['http://localhost:3900', 'http://127.0.0.1:3900'], ports: [3900, 3901] };

test('local guard: accepts our web app and loopback tools', () => {
  assert.equal(checkLocalRequest({ host: '127.0.0.1:3901' }, allowed), null);
  assert.equal(checkLocalRequest({ host: 'localhost:3900', origin: 'http://localhost:3900' }, allowed), null);
});
test('local guard: rejects other sites (CSRF) and foreign hosts (DNS rebinding)', () => {
  assert.match(checkLocalRequest({ host: '127.0.0.1:3901', origin: 'https://evil.example' }, allowed)!, /Origin/);
  assert.match(checkLocalRequest({ host: 'attacker.test:3901' }, allowed)!, /Host/);
  assert.match(checkLocalRequest({ host: '127.0.0.1:9999' }, allowed)!, /Host/);
});
