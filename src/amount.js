'use strict';

// Moonetix sends amounts with at most five decimals and no trailing zeros:
// 150, 0.75, 1.23456. Rounding is half away from zero on the shortest decimal
// form of the number, which is what PHP 8.4 number_format() does. 1.000005
// therefore becomes 1.00001, although the nearest double is slightly below it.

function plainDecimal(n) {
  const s = String(n);
  const e = s.search(/e/i);
  if (e === -1) return s;
  const neg = s[0] === '-';
  const mant = s.slice(neg ? 1 : 0, e);
  const exp = Number(s.slice(e + 1));
  const [int, frac = ''] = mant.split('.');
  const digits = int + frac;
  const point = int.length + exp;
  let out;
  if (point <= 0) out = '0.' + '0'.repeat(-point) + digits;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = digits.slice(0, point) + '.' + digits.slice(point);
  return (neg ? '-' : '') + out;
}

function roundHalfUp(decimal, places) {
  const neg = decimal[0] === '-';
  const [int, frac = ''] = (neg ? decimal.slice(1) : decimal).split('.');
  const padded = (frac + '0'.repeat(places + 1)).slice(0, places + 1);
  let digits = (int + padded.slice(0, places)).split('').map(Number);
  if (padded[places] >= '5') {
    let i = digits.length - 1;
    while (i >= 0 && digits[i] === 9) digits[i--] = 0;
    if (i < 0) digits.unshift(1);
    else digits[i]++;
  }
  const all = digits.join('');
  const intPart = all.slice(0, all.length - places).replace(/^0+(?=\d)/, '');
  const fracPart = all.slice(all.length - places);
  return (neg ? '-' : '') + intPart + (places ? '.' + fracPart : '');
}

function moonetixAmount(value) {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || String(value).trim() === '') throw new Error(`Not a number: ${value}`);
  let s = roundHalfUp(plainDecimal(n), 5);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '' || s === '-0' ? '0' : s;
}

module.exports = { moonetixAmount, plainDecimal, roundHalfUp };
