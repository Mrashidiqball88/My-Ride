'use strict';

const fs = require('fs');

function fail() {
  throw new TypeError('Unsupported or invalid image format');
}

function png(input) {
  if (input.length < 24 || !input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  return { width: input.readUInt32BE(16), height: input.readUInt32BE(20), type: 'png' };
}

function gif(input) {
  if (input.length < 10 || !/GIF8[79]a/.test(input.toString('ascii', 0, 6))) return null;
  return { width: input.readUInt16LE(6), height: input.readUInt16LE(8), type: 'gif' };
}

function bmp(input) {
  if (input.length < 26 || input.toString('ascii', 0, 2) !== 'BM') return null;
  return { width: input.readUInt32LE(18), height: Math.abs(input.readInt32LE(22)), type: 'bmp' };
}

function webp(input) {
  if (input.length < 30 || input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = input.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return {
      width: 1 + input[24] + (input[25] << 8) + (input[26] << 16),
      height: 1 + input[27] + (input[28] << 8) + (input[29] << 16),
      type: 'webp'
    };
  }
  if (chunk === 'VP8 ' && input.length >= 30) {
    const start = 20;
    if (input[start + 3] === 0x9d && input[start + 4] === 0x01 && input[start + 5] === 0x2a) {
      return { width: input.readUInt16LE(start + 6) & 0x3fff, height: input.readUInt16LE(start + 8) & 0x3fff, type: 'webp' };
    }
  }
  return null;
}

function jpeg(input) {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= input.length) {
    if (input[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < input.length && input[offset] === 0xff) offset += 1;
    const marker = input[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > input.length) break;
    const length = input.readUInt16BE(offset);
    if (length < 2 || offset + length > input.length) break;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof && length >= 7) {
      return { width: input.readUInt16BE(offset + 5), height: input.readUInt16BE(offset + 3), type: 'jpg' };
    }
    offset += length;
  }
  return null;
}

function psd(input) {
  if (input.length < 26 || input.toString('ascii', 0, 4) !== '8BPS') return null;
  return { width: input.readUInt32BE(18), height: input.readUInt32BE(14), type: 'psd' };
}

function svg(input) {
  const text = input.toString('utf8', 0, Math.min(input.length, 1024));
  if (!/<svg(?:\s|>)/i.test(text)) return null;
  const viewBox = text.match(/\bviewBox\s*=\s*["']\s*[\d.+-]+\s+[\d.+-]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
  const width = text.match(/\bwidth\s*=\s*["']\s*([\d.]+)(?:px)?\s*["']/i);
  const height = text.match(/\bheight\s*=\s*["']\s*([\d.]+)(?:px)?\s*["']/i);
  if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]), type: 'svg' };
  if (width && height) return { width: Number(width[1]), height: Number(height[1]), type: 'svg' };
  return null;
}

function imageSize(input) {
  if (typeof input === 'string') input = fs.readFileSync(input);
  if (!Buffer.isBuffer(input)) input = Buffer.from(input);
  if (input.length === 0) fail();
  const result = png(input) || jpeg(input) || gif(input) || webp(input) || bmp(input) || psd(input) || svg(input);
  if (!result || !Number.isFinite(result.width) || !Number.isFinite(result.height) || result.width <= 0 || result.height <= 0) fail();
  return result;
}

module.exports = imageSize;
module.exports.imageSize = imageSize;
module.exports.default = imageSize;