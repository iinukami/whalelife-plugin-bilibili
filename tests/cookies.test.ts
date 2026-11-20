/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeResponseCookies, normalizeCookie, removedCookieNames, sameCookieAuthentication } from '../src/cookies.ts';
import { BiliError } from '../src/errors.ts';

// Entirely synthetic values. No real cookie files or platform requests are used.
const OLD = 'SESSDATA=SYNTHETIC_OLD; bili_jct=11111111111111111111111111111111; DedeUserID=17';
const NEW = 'SESSDATA=SYNTHETIC_NEW; bili_jct=22222222222222222222222222222222; DedeUserID=17';
const headers = (cookie = NEW) => cookie.split('; ').map(pair => pair + '; Path=/; HttpOnly');
const code = (expected: string) => (error: unknown) => error instanceof BiliError && error.code === expected;
const values = (cookie: string) => Object.fromEntries(cookie.split('; ').map(pair => { const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)]; }));

test('response cookies use the existing allowlist and preserve omitted session device context', () => {
  const old = OLD + '; buvid3=SYNTHETIC_OLD_DEVICE; buvid4=SYNTHETIC_FOUR; buvid_fp=SYNTHETIC_FP; b_nut=123';
  const merged = mergeResponseCookies([...headers(), 'buvid3=SYNTHETIC_SERVER_DEVICE; Path=/', 'bili_ticket=SYNTHETIC_TICKET; Path=/',
    'unrelated_tracking=discard; Path=/', 'other_tracking="quoted value, x=y"; Path=/'], old);
  assert.deepEqual(values(merged.cookie), { ...values(NEW), buvid3: 'SYNTHETIC_SERVER_DEVICE', buvid4: 'SYNTHETIC_FOUR', buvid_fp: 'SYNTHETIC_FP', b_nut: '123', bili_ticket: 'SYNTHETIC_TICKET' });
  assert.deepEqual(merged.removedCookieNames, []);
  assert.equal(normalizeCookie(old), old);
});

test('new QR login never inherits a previous account and requires fresh authentication fields', () => {
  const other = NEW.replace('DedeUserID=17', 'DedeUserID=29');
  assert.deepEqual(values(mergeResponseCookies([...headers(other), 'buvid3=SYNTHETIC_NEW_DEVICE; Path=/']).cookie), { ...values(other), buvid3: 'SYNTHETIC_NEW_DEVICE' });
  assert.throws(() => mergeResponseCookies(headers(other), OLD + '; buvid3=SYNTHETIC_OLD_DEVICE'), code('account_changed'));
  for (const incomplete of [[...headers().slice(1)], ['buvid3=SYNTHETIC_DEVICE'], [...headers(), 'SESSDATA=; Max-Age=0']])
    assert.throws(() => mergeResponseCookies(incomplete, OLD), code('malformed_response'));
});

test('explicit deletion and Max-Age precedence override retained device cookies', () => {
  const now = Date.UTC(2026, 0, 1), old = OLD + '; buvid3=SYNTHETIC_DEVICE; buvid4=SYNTHETIC_FOUR';
  for (const deletion of ['buvid3=', 'buvid3=discard; Max-Age=0', 'buvid3=discard; Max-Age=-2',
    'buvid3=discard; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'buvid3=discard; Max-Age=0; Expires=Thu, 01 Jan 2099 00:00:00 GMT']) {
    const result = mergeResponseCookies([...headers(), deletion], old, now);
    assert.equal(values(result.cookie).buvid3, undefined); assert.equal(values(result.cookie).buvid4, 'SYNTHETIC_FOUR');
    assert.deepEqual(result.removedCookieNames, ['buvid3']);
  }
  const kept = mergeResponseCookies([...headers(), 'buvid3=SYNTHETIC_REPLACED; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=600'], old, now);
  assert.equal(values(kept.cookie).buvid3, 'SYNTHETIC_REPLACED'); assert.deepEqual(kept.removedCookieNames, []);
  const last = mergeResponseCookies([...headers(), 'buvid3=; Max-Age=0', 'buvid3=SYNTHETIC_LATEST'], old, now);
  assert.equal(values(last.cookie).buvid3, 'SYNTHETIC_LATEST'); assert.deepEqual(last.removedCookieNames, []);
});

test('cookie response rejects ambiguous or oversized headers without exposing raw values', () => {
  for (const malformed of ['SESSDATA=SYNTHETIC, bili_jct=bad', 'buvid3=bad\r\nX-Fake: bad', 'buvid3=' + 'x'.repeat(8193)])
    assert.throws(() => mergeResponseCookies([...headers(), malformed], OLD), code('malformed_response'));
  assert.throws(() => mergeResponseCookies(Array(65).fill('unused=value'), OLD), code('malformed_response'));
  assert.throws(() => normalizeCookie(OLD + '; bili_jct=' + '3'.repeat(32)), code('invalid_input'));
  assert.equal(sameCookieAuthentication(OLD, OLD + '; buvid3=SYNTHETIC_DEVICE'), true);
  assert.equal(sameCookieAuthentication(OLD, NEW), false);
  assert.deepEqual(removedCookieNames(['buvid3', 'bili_ticket']), ['buvid3', 'bili_ticket']);
  for (const invalid of [['unrelated_tracking'], ['buvid3', 'buvid3'], ['buvid3', 3], 'buvid3']) assert.throws(() => removedCookieNames(invalid), code('malformed_response'));
});
