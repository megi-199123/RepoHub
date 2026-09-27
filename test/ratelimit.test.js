'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { clientIp } = require('../server/ratelimit');

const req = (headers, remoteAddress = '10.0.0.1') => ({ headers, socket: { remoteAddress } });
const savedRailwayEnv = process.env.RAILWAY_ENVIRONMENT;

afterEach(() => {
  if (savedRailwayEnv === undefined) delete process.env.RAILWAY_ENVIRONMENT;
  else process.env.RAILWAY_ENVIRONMENT = savedRailwayEnv;
});

test('on Railway, clientIp uses X-Real-IP, not the edge proxy at the end of X-Forwarded-For', () => {
  process.env.RAILWAY_ENVIRONMENT = 'production';
  // Header shape observed on Railway: "<client>, <edge proxy>".
  const ip = clientIp(req({ 'x-forwarded-for': '158.62.56.220, 152.233.33.162', 'x-real-ip': '158.62.56.220' }));
  assert.equal(ip, '158.62.56.220');
});

test('on Railway without X-Real-IP, clientIp falls back to the rightmost X-Forwarded-For entry', () => {
  process.env.RAILWAY_ENVIRONMENT = 'production';
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })), '5.6.7.8');
});

test('off Railway, a client-sent X-Real-IP is ignored and the rightmost X-Forwarded-For entry is used', () => {
  delete process.env.RAILWAY_ENVIRONMENT;
  assert.equal(clientIp(req({ 'x-forwarded-for': '9.9.9.9, 127.0.0.1', 'x-real-ip': '7.7.7.7' })), '127.0.0.1');
});

test('with no proxy headers, clientIp uses the socket address', () => {
  delete process.env.RAILWAY_ENVIRONMENT;
  assert.equal(clientIp(req({})), '10.0.0.1');
});
