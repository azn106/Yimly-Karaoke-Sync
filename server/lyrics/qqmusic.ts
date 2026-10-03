import zlib from 'zlib';
import {
  RawLyricLine,
  RawLyricResult,
  RawLyricWord,
  calculateMatchScore,
  renderRawLinesToElrc,
  renderRawLinesToLrc,
  FetchLyricOptions,
  MIN_MATCH_SCORE,
  isValidFineGrainedPayload,
} from './types.js';

// Constant 3DES key from LDDC
const QRC_KEY = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'utf8');

// Exact port of LDDC tripledes.py
const ENCRYPT = 1;
const DECRYPT = 0;

const sbox = [
  // sbox1
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
   0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
   4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
   15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  // sbox2
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
   3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,
   0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
   13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  // sbox3
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
   13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
   13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
   1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  // sbox4
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
   13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
   10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
   3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  // sbox5
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
   14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
   4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
   11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  // sbox6
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
   10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
   9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
   4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  // sbox7
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
   13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
   1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
   6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  // sbox8
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
   1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
   7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
   2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

function bitnum(a: Buffer | Uint8Array, b: number, c: number): number {
  const byteIdx = Math.floor(b / 32) * 4 + 3 - Math.floor((b % 32) / 8);
  return (((a[byteIdx] >> (7 - (b % 8))) & 1) << c) >>> 0;
}

function bitnum_intr(a: number, b: number, c: number): number {
  return (((a >>> (31 - b)) & 1) << c) >>> 0;
}

function bitnum_intl(a: number, b: number, c: number): number {
  return ((((a << b) >>> 0) & 0x80000000) >>> c) >>> 0;
}

function sbox_bit(a: number): number {
  return ((a & 32) | ((a & 31) >> 1) | ((a & 1) << 4)) >>> 0;
}

function initial_permutation(input: Buffer | Uint8Array): [number, number] {
  const s0 =
    bitnum(input, 57, 31) | bitnum(input, 49, 30) | bitnum(input, 41, 29) | bitnum(input, 33, 28) |
    bitnum(input, 25, 27) | bitnum(input, 17, 26) | bitnum(input, 9, 25) | bitnum(input, 1, 24) |
    bitnum(input, 59, 23) | bitnum(input, 51, 22) | bitnum(input, 43, 21) | bitnum(input, 35, 20) |
    bitnum(input, 27, 19) | bitnum(input, 19, 18) | bitnum(input, 11, 17) | bitnum(input, 3, 16) |
    bitnum(input, 61, 15) | bitnum(input, 53, 14) | bitnum(input, 45, 13) | bitnum(input, 37, 12) |
    bitnum(input, 29, 11) | bitnum(input, 21, 10) | bitnum(input, 13, 9) | bitnum(input, 5, 8) |
    bitnum(input, 63, 7) | bitnum(input, 55, 6) | bitnum(input, 47, 5) | bitnum(input, 39, 4) |
    bitnum(input, 31, 3) | bitnum(input, 23, 2) | bitnum(input, 15, 1) | bitnum(input, 7, 0);

  const s1 =
    bitnum(input, 56, 31) | bitnum(input, 48, 30) | bitnum(input, 40, 29) | bitnum(input, 32, 28) |
    bitnum(input, 24, 27) | bitnum(input, 16, 26) | bitnum(input, 8, 25) | bitnum(input, 0, 24) |
    bitnum(input, 58, 23) | bitnum(input, 50, 22) | bitnum(input, 42, 21) | bitnum(input, 34, 20) |
    bitnum(input, 26, 19) | bitnum(input, 18, 18) | bitnum(input, 10, 17) | bitnum(input, 2, 16) |
    bitnum(input, 60, 15) | bitnum(input, 52, 14) | bitnum(input, 44, 13) | bitnum(input, 36, 12) |
    bitnum(input, 28, 11) | bitnum(input, 20, 10) | bitnum(input, 12, 9) | bitnum(input, 4, 8) |
    bitnum(input, 62, 7) | bitnum(input, 54, 6) | bitnum(input, 46, 5) | bitnum(input, 38, 4) |
    bitnum(input, 30, 3) | bitnum(input, 22, 2) | bitnum(input, 14, 1) | bitnum(input, 6, 0);

  return [s0 >>> 0, s1 >>> 0];
}

function inverse_permutation(s0: number, s1: number): Buffer {
  const data = Buffer.alloc(8);
  data[3] = (bitnum_intr(s1, 7, 7) | bitnum_intr(s0, 7, 6) | bitnum_intr(s1, 15, 5) |
             bitnum_intr(s0, 15, 4) | bitnum_intr(s1, 23, 3) | bitnum_intr(s0, 23, 2) |
             bitnum_intr(s1, 31, 1) | bitnum_intr(s0, 31, 0)) >>> 0;
  data[2] = (bitnum_intr(s1, 6, 7) | bitnum_intr(s0, 6, 6) | bitnum_intr(s1, 14, 5) |
             bitnum_intr(s0, 14, 4) | bitnum_intr(s1, 22, 3) | bitnum_intr(s0, 22, 2) |
             bitnum_intr(s1, 30, 1) | bitnum_intr(s0, 30, 0)) >>> 0;
  data[1] = (bitnum_intr(s1, 5, 7) | bitnum_intr(s0, 5, 6) | bitnum_intr(s1, 13, 5) |
             bitnum_intr(s0, 13, 4) | bitnum_intr(s1, 21, 3) | bitnum_intr(s0, 21, 2) |
             bitnum_intr(s1, 29, 1) | bitnum_intr(s0, 29, 0)) >>> 0;
  data[0] = (bitnum_intr(s1, 4, 7) | bitnum_intr(s0, 4, 6) | bitnum_intr(s1, 12, 5) |
             bitnum_intr(s0, 12, 4) | bitnum_intr(s1, 20, 3) | bitnum_intr(s0, 20, 2) |
             bitnum_intr(s1, 28, 1) | bitnum_intr(s0, 28, 0)) >>> 0;
  data[7] = (bitnum_intr(s1, 3, 7) | bitnum_intr(s0, 3, 6) | bitnum_intr(s1, 11, 5) |
             bitnum_intr(s0, 11, 4) | bitnum_intr(s1, 19, 3) | bitnum_intr(s0, 19, 2) |
             bitnum_intr(s1, 27, 1) | bitnum_intr(s0, 27, 0)) >>> 0;
  data[6] = (bitnum_intr(s1, 2, 7) | bitnum_intr(s0, 2, 6) | bitnum_intr(s1, 10, 5) |
             bitnum_intr(s0, 10, 4) | bitnum_intr(s1, 18, 3) | bitnum_intr(s0, 18, 2) |
             bitnum_intr(s1, 26, 1) | bitnum_intr(s0, 26, 0)) >>> 0;
  data[5] = (bitnum_intr(s1, 1, 7) | bitnum_intr(s0, 1, 6) | bitnum_intr(s1, 9, 5) |
             bitnum_intr(s0, 9, 4) | bitnum_intr(s1, 17, 3) | bitnum_intr(s0, 17, 2) |
             bitnum_intr(s1, 25, 1) | bitnum_intr(s0, 25, 0)) >>> 0;
  data[4] = (bitnum_intr(s1, 0, 7) | bitnum_intr(s0, 0, 6) | bitnum_intr(s1, 8, 5) |
             bitnum_intr(s0, 8, 4) | bitnum_intr(s1, 16, 3) | bitnum_intr(s0, 16, 2) |
             bitnum_intr(s1, 24, 1) | bitnum_intr(s0, 24, 0)) >>> 0;
  return data;
}

function f(state: number, key: number[]): number {
  const t1 = (bitnum_intl(state, 31, 0) | (((state & 0xf0000000) >>> 1) >>> 0) | bitnum_intl(state, 4, 5) |
              bitnum_intl(state, 3, 6) | (((state & 0x0f000000) >>> 3) >>> 0) | bitnum_intl(state, 8, 11) |
              bitnum_intl(state, 7, 12) | (((state & 0x00f00000) >>> 5) >>> 0) | bitnum_intl(state, 12, 17) |
              bitnum_intl(state, 11, 18) | (((state & 0x000f0000) >>> 7) >>> 0) | bitnum_intl(state, 16, 23)) >>> 0;

  const t2 = (bitnum_intl(state, 15, 0) | (((state & 0x0000f000) << 15) >>> 0) | bitnum_intl(state, 20, 5) |
              bitnum_intl(state, 19, 6) | (((state & 0x00000f00) << 13) >>> 0) | bitnum_intl(state, 24, 11) |
              bitnum_intl(state, 23, 12) | (((state & 0x000000f0) << 11) >>> 0) | bitnum_intl(state, 28, 17) |
              bitnum_intl(state, 27, 18) | (((state & 0x0000000f) << 9) >>> 0) | bitnum_intl(state, 0, 23)) >>> 0;

  const lrgstate = [
    (t1 >>> 24) & 0xff,
    (t1 >>> 16) & 0xff,
    (t1 >>> 8) & 0xff,
    (t2 >>> 24) & 0xff,
    (t2 >>> 16) & 0xff,
    (t2 >>> 8) & 0xff,
  ];

  for (let i = 0; i < 6; i++) {
    lrgstate[i] ^= key[i];
  }

  const st = (
    ((sbox[0][sbox_bit(lrgstate[0] >> 2)] << 28) >>> 0) |
    ((sbox[1][sbox_bit(((lrgstate[0] & 0x03) << 4) | (lrgstate[1] >> 4))] << 24) >>> 0) |
    ((sbox[2][sbox_bit(((lrgstate[1] & 0x0f) << 2) | (lrgstate[2] >> 6))] << 20) >>> 0) |
    ((sbox[3][sbox_bit(lrgstate[2] & 0x3f)] << 16) >>> 0) |
    ((sbox[4][sbox_bit(lrgstate[3] >> 2)] << 12) >>> 0) |
    ((sbox[5][sbox_bit(((lrgstate[3] & 0x03) << 4) | (lrgstate[4] >> 4))] << 8) >>> 0) |
    ((sbox[6][sbox_bit(((lrgstate[4] & 0x0f) << 2) | (lrgstate[5] >> 6))] << 4) >>> 0) |
    (sbox[7][sbox_bit(lrgstate[5] & 0x3f)])
  ) >>> 0;

  return (
    bitnum_intl(st, 15, 0) | bitnum_intl(st, 6, 1) | bitnum_intl(st, 19, 2) |
    bitnum_intl(st, 20, 3) | bitnum_intl(st, 28, 4) | bitnum_intl(st, 11, 5) |
    bitnum_intl(st, 27, 6) | bitnum_intl(st, 16, 7) | bitnum_intl(st, 0, 8) |
    bitnum_intl(st, 14, 9) | bitnum_intl(st, 22, 10) | bitnum_intl(st, 25, 11) |
    bitnum_intl(st, 4, 12) | bitnum_intl(st, 17, 13) | bitnum_intl(st, 30, 14) |
    bitnum_intl(st, 9, 15) | bitnum_intl(st, 1, 16) | bitnum_intl(st, 7, 17) |
    bitnum_intl(st, 23, 18) | bitnum_intl(st, 13, 19) | bitnum_intl(st, 31, 20) |
    bitnum_intl(st, 26, 21) | bitnum_intl(st, 2, 22) | bitnum_intl(st, 8, 23) |
    bitnum_intl(st, 18, 24) | bitnum_intl(st, 12, 25) | bitnum_intl(st, 29, 26) |
    bitnum_intl(st, 5, 27) | bitnum_intl(st, 21, 28) | bitnum_intl(st, 10, 29) |
    bitnum_intl(st, 3, 30) | bitnum_intl(st, 24, 31)
  ) >>> 0;
}

function crypt(input: Buffer | Uint8Array, keyRounds: number[][]): Buffer {
  let [s0, s1] = initial_permutation(input);
  for (let idx = 0; idx < 15; idx++) {
    const prevS1 = s1;
    s1 = (f(s1, keyRounds[idx]) ^ s0) >>> 0;
    s0 = prevS1;
  }
  s0 = (f(s1, keyRounds[15]) ^ s0) >>> 0;
  return inverse_permutation(s0, s1);
}

const key_rnd_shift = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const key_perm_c = [56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35];
const key_perm_d = [62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3];
const key_compression = [
  13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1, 40, 51, 30, 36,
  46, 54, 29, 39, 50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31,
];

function key_schedule(key: Buffer, mode: number): number[][] {
  const schedule: number[][] = Array.from({ length: 16 }, () => new Array(6).fill(0));
  let c = 0;
  for (let i = 0; i < 28; i++) {
    c = (c + bitnum(key, key_perm_c[i], 31 - i)) >>> 0;
  }
  let d = 0;
  for (let i = 0; i < 28; i++) {
    d = (d + bitnum(key, key_perm_d[i], 31 - i)) >>> 0;
  }

  for (let i = 0; i < 16; i++) {
    const shift = key_rnd_shift[i];
    c = (((c << shift) | (c >>> (28 - shift))) & 0xfffffff0) >>> 0;
    d = (((d << shift) | (d >>> (28 - shift))) & 0xfffffff0) >>> 0;

    const togen = mode === DECRYPT ? 15 - i : i;
    for (let j = 0; j < 6; j++) {
      schedule[togen][j] = 0;
    }
    for (let j = 0; j < 24; j++) {
      schedule[togen][Math.floor(j / 8)] |= bitnum_intr(c, key_compression[j], 7 - (j % 8));
    }
    for (let j = 24; j < 48; j++) {
      schedule[togen][Math.floor(j / 8)] |= bitnum_intr(d, key_compression[j] - 27, 7 - (j % 8));
    }
  }
  return schedule;
}

function tripledes_key_setup(key: Buffer, mode: number): number[][][] {
  if (mode === ENCRYPT) {
    return [
      key_schedule(key.subarray(0, 8), ENCRYPT),
      key_schedule(key.subarray(8, 16), DECRYPT),
      key_schedule(key.subarray(16, 24), ENCRYPT),
    ];
  }
  return [
    key_schedule(key.subarray(16, 24), DECRYPT),
    key_schedule(key.subarray(8, 16), ENCRYPT),
    key_schedule(key.subarray(0, 8), DECRYPT),
  ];
}

/**
 * Decrypts QQ Music encrypted QRC hex payload into uncompressed XML
 */
export function qrcDecrypt(encryptedHexOrBuffer: string | Buffer): string {
  const buf = typeof encryptedHexOrBuffer === 'string'
    ? Buffer.from(encryptedHexOrBuffer, 'hex')
    : encryptedHexOrBuffer;

  const schedule = tripledes_key_setup(QRC_KEY, DECRYPT);
  const decryptedBlocks: Buffer[] = [];

  for (let i = 0; i < buf.length; i += 8) {
    const block = buf.subarray(i, i + 8);
    if (block.length === 8) {
      let cur = Buffer.from(block);
      for (let r = 0; r < 3; r++) {
        cur = crypt(cur, schedule[r]);
      }
      decryptedBlocks.push(cur);
    }
  }

  const decrypted = Buffer.concat(decryptedBlocks);
  const inflated = zlib.inflateSync(decrypted);
  return inflated.toString('utf8');
}

/**
 * Parses QRC content into structured RawLyricLine[]
 * Format:
 * [lineStart, lineDuration]word(wordStart, wordDuration) ...
 */
export function parseQrc(qrcText: string): RawLyricLine[] {
  if (!qrcText || typeof qrcText !== 'string') return [];

  // Extract <Lyric_1 LyricContent="..."> if wrapped in XML
  let contentText = qrcText;
  const xmlMatch = qrcText.match(/LyricContent="([^"]+)"/);
  if (xmlMatch) {
    contentText = xmlMatch[1];
  }

  const rawLines = contentText.split('\n');
  const parsedLines: RawLyricLine[] = [];

  const lineRegex = /^\[(\d+),(\d+)\](.*)$/;
  // Exact regex pattern from LDDC parser/qrc.py
  const wordRegex = /(?:\[\d+,\d+\])?((?:(?!\(\d+,\d+\)).)*)\((\d+),(\d+)\)/g;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Skip metadata tags such as [ti:...], [ar:...], [al:...]
    if (/^\[[a-zA-Z]+:.*\]$/.test(trimmed)) {
      continue;
    }

    const match = trimmed.match(lineRegex);
    if (!match) continue;

    const lineStartMs = parseInt(match[1], 10);
    const lineDurationMs = parseInt(match[2], 10);
    const content = match[3];

    const words: RawLyricWord[] = [];
    let wMatch: RegExpExecArray | null;
    wordRegex.lastIndex = 0;

    while ((wMatch = wordRegex.exec(content)) !== null) {
      const wText = wMatch[1];
      if (wText === '\r') continue;
      const wStartMs = parseInt(wMatch[2], 10);
      const wDurMs = parseInt(wMatch[3], 10);
      words.push({
        text: wText,
        startMs: wStartMs,
        durationMs: wDurMs,
      });
    }

    const lineText = words.map(w => w.text).join('').trim() || content.trim();

    parsedLines.push({
      startMs: lineStartMs,
      durationMs: lineDurationMs,
      words,
      text: lineText,
    });
  }

  return parsedLines;
}

let qqSession: { uid: string; sid: string; userip: string } | null = null;

async function getQQSession(): Promise<{ uid: string; sid: string; userip: string }> {
  if (qqSession) return qqSession;

  const comm = {
    ct: 11,
    cv: '1003006',
    v: '1003006',
    os_ver: '15',
    phonetype: '24122RKC7C',
    rom: 'Redmi/miro/miro:15/AE3A.240806.005/OS2.0.105.0.VOMCNXM:user/release-keys',
    tmeAppID: 'qqmusiclight',
    nettype: 'NETWORK_WIFI',
    udid: '0',
  };

  try {
    const sessPayload = {
      comm,
      request: {
        method: 'GetSession',
        module: 'music.getSession.session',
        param: { caller: 0, uid: '0', vkey: 0 },
      },
    };

    const sessRes = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessPayload),
      signal: AbortSignal.timeout(8000),
    });

    if (sessRes.ok) {
      const sessData: any = await sessRes.json();
      const session = sessData?.request?.data?.session;
      if (session) {
        qqSession = {
          uid: session.uid || '0',
          sid: session.sid || '0',
          userip: session.userip || '',
        };
        return qqSession;
      }
    }
  } catch {}

  qqSession = { uid: '0', sid: '0', userip: '' };
  return qqSession;
}

/**
 * Search QQ Music for matching songs and retrieve word-synced QRC lyrics
 */
export async function fetchQQMusicLyrics(
  title: string,
  artist: string,
  options?: FetchLyricOptions
): Promise<RawLyricResult> {
  const log = options?.onLog || (() => {});
  const query = `${title} ${artist}`.trim();
  log(`[QQ Music] Searching for "${query}" (musicu.fcg)...`);

  const session = await getQQSession();
  const comm = {
    ct: 11,
    cv: '1003006',
    v: '1003006',
    os_ver: '15',
    phonetype: '24122RKC7C',
    rom: 'Redmi/miro/miro:15/AE3A.240806.005/OS2.0.105.0.VOMCNXM:user/release-keys',
    tmeAppID: 'qqmusiclight',
    nettype: 'NETWORK_WIFI',
    udid: '0',
    uid: session.uid,
    sid: session.sid,
    userip: session.userip,
  };

  const searchPayload = {
    comm,
    request: {
      method: 'DoSearchForQQMusicLite',
      module: 'music.search.SearchCgiService',
      param: {
        search_id: `${Date.now()}`,
        remoteplace: 'search.android.keyboard',
        query,
        search_type: 0,
        num_per_page: 8,
        page_num: 1,
        highlight: 0,
        nqc_flag: 0,
        page_id: 1,
        grp: 1,
      },
    },
  };

  try {
    const searchRes = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://y.qq.com/',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(searchPayload),
      signal: AbortSignal.timeout(8000),
    });

    if (!searchRes.ok) {
      return {
        success: false,
        source: 'qqmusic',
        format: 'QRC',
        error: `QQ Music search HTTP error: ${searchRes.status}`,
      };
    }

    const searchData: any = await searchRes.json();
    const songList = searchData?.request?.data?.body?.item_song || [];
    if (songList.length === 0) {
      log(`[QQ Music] No songs found matching "${query}".`);
      return {
        success: false,
        source: 'qqmusic',
        format: 'QRC',
        error: 'No matching tracks found on QQ Music',
      };
    }

    // Rank candidates
    interface Candidate {
      id: number;
      mid: string;
      name: string;
      singers: string;
      durationSec: number;
      score: number;
      reason: string;
    }

    const candidates: Candidate[] = [];

    for (const song of songList) {
      if (!song.id || !song.mid) continue;

      const songTitle = song.title || song.name || '';
      const songSingers = Array.isArray(song.singer)
        ? song.singer.map((s: any) => s.name).join(', ')
        : '';
      const durationSec = song.interval || 0;

      const match = calculateMatchScore(
        title,
        artist,
        songTitle,
        songSingers,
        options?.duration,
        durationSec
      );

      if (match.durationPassed && match.isValid && match.score >= MIN_MATCH_SCORE) {
        candidates.push({
          id: song.id,
          mid: song.mid,
          name: songTitle,
          singers: songSingers,
          durationSec,
          score: match.score,
          reason: match.reason,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      log(`[QQ Music] Found ${songList.length} results, but none satisfied duration/metadata thresholds.`);
      return {
        success: false,
        source: 'qqmusic',
        format: 'QRC',
        error: 'No candidate satisfied duration tolerance and metadata score',
      };
    }

    // Query lyrics for top candidates
    for (let i = 0; i < Math.min(3, candidates.length); i++) {
      const cand = candidates[i];
      log(`[QQ Music] Querying lyrics for candidate #${i + 1}: "${cand.name}" by "${cand.singers}" (mid: ${cand.mid}, score: ${cand.score})...`);

      const lyricPayload = {
        comm,
        request: {
          method: 'GetPlayLyricInfo',
          module: 'music.musichallSong.PlayLyricInfo',
          param: {
            songMID: cand.mid,
            songID: cand.id,
            qrc: 1,
            qrc_t: 0,
            roma: 1,
            trans: 1,
            crypt: 1,
          },
        },
      };

      const lyricRes = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://y.qq.com/',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(lyricPayload),
        signal: AbortSignal.timeout(8000),
      });

      if (!lyricRes.ok) continue;

      const lyricData: any = await lyricRes.json();
      const lyricInfo = lyricData?.request?.data || lyricData?.playLyricInfo?.data;
      const hexLyric = lyricInfo?.lyric;

      if (hexLyric && typeof hexLyric === 'string' && hexLyric.length > 16) {
        try {
          const decryptedQrc = qrcDecrypt(hexLyric);
          const lines = parseQrc(decryptedQrc);
          const payloadCheck = isValidFineGrainedPayload(lines);

          if (!payloadCheck.valid) {
            log(`[QQ Music] Candidate #${i + 1} QRC rejected: ${payloadCheck.reason}`);
            continue;
          }

          const elrc = renderRawLinesToElrc(lines, options?.leadInMs ?? 500);
          const lrc = renderRawLinesToLrc(lines);

          log(`[QQ Music] Successfully decrypted and parsed raw QRC (${lines.length} lines, word-synced) for "${cand.name}".`);
          return {
            success: true,
            source: 'qqmusic',
            format: 'QRC',
            trackTitle: cand.name,
            trackArtist: cand.singers,
            trackId: cand.mid,
            lines,
            elrc: elrc || undefined,
            lrc: lrc || undefined,
          };
        } catch (decErr: any) {
          log(`[QQ Music] Candidate #${i + 1} QRC decryption failed: ${decErr.message}`);
        }
      }
    }

    return {
      success: false,
      source: 'qqmusic',
      format: 'QRC',
      error: 'Candidates found, but none contained word-synced QRC lyrics',
    };
  } catch (err: any) {
    log(`[QQ Music] Request error: ${err.message}`);
    return {
      success: false,
      source: 'qqmusic',
      format: 'QRC',
      error: err.message || 'Unknown QQ Music error',
    };
  }
}
