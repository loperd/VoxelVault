import assert from 'node:assert/strict';
import test from 'node:test';
import { formatWalletAmount, parseWalletAmount } from '../../src/application/wallet-amount.ts';

test('currency precision preserves minimum units and the int64 boundary exactly', () => {
  assert.equal(parseWalletAmount('12,34', 2), '1234');
  assert.equal(parseWalletAmount('0.000000000000000001', 18), '1');
  assert.equal(parseWalletAmount('9223372036854775807', 0), '9223372036854775807');
  assert.equal(formatWalletAmount('1234', 2), '12,34');
  assert.equal(formatWalletAmount('1', 18), '0,000000000000000001');
  assert.equal(formatWalletAmount('9007199254740993', 0).replace(/\s/g, ''), '9007199254740993');
});

test('invalid precision, fractional overprecision and overflowing amounts are rejected', () => {
  for (const [input, precision] of [
    ['0', 0],
    ['-1', 0],
    ['1e3', 0],
    ['1.1', 0],
    ['1.001', 2],
    ['9223372036854775808', 0],
    ['1', 19],
  ]) {
    assert.throws(() => parseWalletAmount(input, precision));
  }
});
