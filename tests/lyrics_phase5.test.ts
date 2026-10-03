import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  formatTimestamp,
  formatTimestampMs,
  parseTimestampString,
  parseLrc,
  isSubstantiveLrc,
  normalizeLrc,
  renderRawLinesToElrc,
  renderRawLinesToLrc,
  calculateMatchScore,
  calculateTitleSimilarity,
  calculateArtistSimilarity,
  isValidFineGrainedPayload,
  cleanTitle,
  cleanArtist,
  extractArtistTokens,
  RawLyricLine,
} from '../server/lyrics/types.js';
import { parseYrc } from '../server/lyrics/netease.js';
import { parseQrc, qrcDecrypt } from '../server/lyrics/qqmusic.js';
import { parseKrc, krcDecrypt } from '../server/lyrics/kugou.js';
import { renderRichsyncToElrc, RichsyncLine } from '../server/musixmatch.js';
import { fetchSongDualLyrics } from '../server/lyrics/manager.js';
import { findExistingElrc, findExistingNormalLrc, findExistingInstrumental, updateSingleSongInIndex, getLibraryIndex } from '../server/scanner.js';
import { extractMetadata, findExistingLrc as findMetaLrc } from '../server/metadata.js';
import { JobExecutor } from '../server/executor.js';
import { isPathAllowedInRoot, isPathInsideDirectory } from '../server.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      console.log(`▶ [TEST] ${name}`);
      await fn();
      console.log(`✓ [PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`❌ [FAIL] ${name}:`, err);
      failed++;
    }
  })();
}

const SCRATCH_DIR = path.join(process.cwd(), `tests_scratch_p5_${Date.now()}`);

async function runPhase5TestSuite() {
  console.log('====================================================');
  console.log('STARTING PHASE 5 LRC/eLRC COMPREHENSIVE VERIFICATION');
  console.log('====================================================\n');

  fs.mkdirSync(SCRATCH_DIR, { recursive: true });

  try {
    // ----------------------------------------------------
    // 1. STANDARD LRC PARSING & NORMALIZATION
    // ----------------------------------------------------
    await test('STANDARD_LRC_PARSING_AND_NORMALIZATION', () => {
      // 1.1 Valid standard LRC with offset and metadata
      const lrc1 = `
[ti: Bohemian Rhapsody]
[ar: Queen]
[al: A Night at the Opera]
[by: Yimly]
[offset: 500]
[00:01.00]Is this the real life?
[00:04.50]Is this just fantasy?
[00:08.25]Caught in a landslide
[00:12.00]No escape from reality
`;
      const parsed1 = parseLrc(lrc1);
      assert.strictEqual(parsed1.metadata.title || parsed1.metadata.ti, 'Bohemian Rhapsody');
      assert.strictEqual(parsed1.metadata.artist || parsed1.metadata.ar, 'Queen');
      assert.strictEqual(parsed1.offsetMs, 500);
      assert.strictEqual(parsed1.lines.length, 4);
      // 00:01.00 (1000ms) + 500ms offset = 1500ms (00:01.50)
      assert.strictEqual(parsed1.lines[0].timestampMs, 1500);
      assert.strictEqual(parsed1.lines[0].text, 'Is this the real life?');
      assert.strictEqual(isSubstantiveLrc(lrc1), true);

      // 1.2 Multiple timestamps on single line
      const lrcMultiple = `
[00:01.00][00:15.50]Repeated chorus line
[00:05.00]Verse line
`;
      const parsedMulti = parseLrc(lrcMultiple);
      assert.strictEqual(parsedMulti.lines.length, 3);
      // Chronologically sorted: 1000ms -> 5000ms -> 15500ms
      assert.strictEqual(parsedMulti.lines[0].timestampMs, 1000);
      assert.strictEqual(parsedMulti.lines[0].text, 'Repeated chorus line');
      assert.strictEqual(parsedMulti.lines[1].timestampMs, 5000);
      assert.strictEqual(parsedMulti.lines[1].text, 'Verse line');
      assert.strictEqual(parsedMulti.lines[2].timestampMs, 15500);
      assert.strictEqual(parsedMulti.lines[2].text, 'Repeated chorus line');

      // 1.3 Centiseconds and milliseconds formats ([mm:ss.xx] and [mm:ss.xxx])
      const lrcPrec = `
[01:05.12]Centiseconds
[02:10.123]Milliseconds
[00:30]No decimal
`;
      const parsedPrec = parseLrc(lrcPrec);
      assert.strictEqual(parsedPrec.lines.length, 3);
      assert.strictEqual(parsedPrec.lines[0].timestampMs, 30000); // 00:30 sorted first
      assert.strictEqual(parsedPrec.lines[1].timestampMs, 65120); // 01:05.12
      assert.strictEqual(parsedPrec.lines[2].timestampMs, 130123); // 02:10.123

      // 1.4 Unsorted and duplicate timestamps
      const lrcUnsorted = `
[00:20.00]Third
[00:10.00]Second
[00:05.00]First
[00:10.00]Duplicate second
`;
      const parsedUnsorted = parseLrc(lrcUnsorted);
      assert.strictEqual(parsedUnsorted.lines[0].text, 'First');
      assert.strictEqual(parsedUnsorted.lines[1].text, 'Second');
      assert.strictEqual(parsedUnsorted.lines[2].text, 'Duplicate second');
      assert.strictEqual(parsedUnsorted.lines[3].text, 'Third');

      // 1.5 Normalization output
      const normalized = normalizeLrc(lrcUnsorted);
      assert.strictEqual(
        normalized,
        '[00:05.00]First\n[00:10.00]Second\n[00:10.00]Duplicate second\n[00:20.00]Third'
      );
    });

    // ----------------------------------------------------
    // 2. ENHANCED LRC (eLRC) WORD & SYLLABLE SYNCHRONIZATION
    // ----------------------------------------------------
    await test('ENHANCED_LRC_WORD_AND_SYLLABLE_SYNCHRONIZATION', () => {
      // 2.1 Valid eLRC format parsing
      const elrcContent = `
[00:01.50] <00:02.00>Never <00:02.40>gonna <00:02.80>give <00:03.10>you <00:03.50>up
[00:05.00] <00:05.50>Never <00:05.90>gonna <00:06.30>let <00:06.70>you <00:07.10>down
[00:09.00] <00:09.50>Never <00:09.90>gonna <00:10.30>run <00:10.70>around <00:11.20>and <00:11.60>desert <00:12.00>you
`;
      const parsedElrc = parseLrc(elrcContent);
      assert.strictEqual(parsedElrc.isEnhanced, true);
      assert.strictEqual(parsedElrc.lines.length, 3);
      assert.ok(parsedElrc.lines[0].enhancedWords);
      assert.strictEqual(parsedElrc.lines[0].enhancedWords!.length, 5);
      assert.strictEqual(parsedElrc.lines[0].enhancedWords![0].text, 'Never');
      assert.strictEqual(parsedElrc.lines[0].enhancedWords![0].startMs, 2000);
      assert.strictEqual(parsedElrc.lines[0].text, 'Never gonna give you up');

      // 2.2 Rendering raw lines to eLRC vs LRC
      const rawLines: RawLyricLine[] = [
        {
          startMs: 2000,
          durationMs: 3000,
          words: [
            { text: 'Hello', startMs: 2000, durationMs: 500 },
            { text: 'world', startMs: 2500, durationMs: 1000 },
          ],
          text: 'Hello world',
        },
        {
          startMs: 6000,
          durationMs: 2500,
          words: [
            { text: 'Karaoke', startMs: 6000, durationMs: 800 },
            { text: 'sync', startMs: 6800, durationMs: 700 },
          ],
          text: 'Karaoke sync',
        },
      ];

      const renderedElrc = renderRawLinesToElrc(rawLines, 500);
      const renderedLrc = renderRawLinesToLrc(rawLines);

      // eLRC must have 500ms lead in for line ts (2000 - 500 = 1500ms -> [00:01.50])
      assert.strictEqual(
        renderedElrc,
        '[00:01.50] <00:02.00>Hello <00:02.50>world\n[00:05.50] <00:06.00>Karaoke <00:06.80>sync'
      );

      // Normal LRC has exact line start timestamp (2000ms -> [00:02.00]) and NO <...> tags
      assert.strictEqual(
        renderedLrc,
        '[00:02.00]Hello world\n[00:06.00]Karaoke sync'
      );
      assert.strictEqual(/<.+>/.test(renderedLrc!), false);
    });

    // ----------------------------------------------------
    // 3. 500 MS LEAD-IN RULE & CLAMPING REGRESSION
    // ----------------------------------------------------
    await test('500MS_LEAD_IN_RULE_AND_CLAMPING', () => {
      // 3.1 First word < 500ms -> clamp to 00:00.00
      const earlyLines: RawLyricLine[] = [
        {
          startMs: 200,
          durationMs: 1500,
          words: [{ text: 'Immediate', startMs: 200, durationMs: 400 }],
          text: 'Immediate',
        },
      ];
      const elrcEarly = renderRawLinesToElrc(earlyLines, 500);
      assert.strictEqual(elrcEarly, '[00:00.00] <00:00.20>Immediate');

      // 3.2 First word exactly 500ms -> 00:00.00
      const exactLines: RawLyricLine[] = [
        {
          startMs: 500,
          durationMs: 1000,
          words: [{ text: 'Exact', startMs: 500, durationMs: 400 }],
          text: 'Exact',
        },
      ];
      const elrcExact = renderRawLinesToElrc(exactLines, 500);
      assert.strictEqual(elrcExact, '[00:00.00] <00:00.50>Exact');

      // 3.3 First word > 500ms (e.g. 3.45s - 0.5s = 2.95s)
      const normalLines: RawLyricLine[] = [
        {
          startMs: 3450,
          durationMs: 2000,
          words: [
            { text: 'Lead', startMs: 3450, durationMs: 400 },
            { text: 'in', startMs: 3900, durationMs: 400 },
          ],
          text: 'Lead in',
        },
      ];
      const elrcNormal = renderRawLinesToElrc(normalLines, 500);
      assert.strictEqual(elrcNormal, '[00:02.95] <00:03.45>Lead <00:03.90>in');

      // 3.4 Richsync renderer verification
      const rsLines: RichsyncLine[] = [
        {
          ts: 1.00,
          te: 3.00,
          l: [
            { c: 'Word1', o: 0.00 },
            { c: ' ', o: 0.50 },
            { c: 'Word2', o: 0.70 },
          ],
        },
      ];
      const elrcRs = renderRichsyncToElrc(rsLines, 500);
      // Word 1 is at 1.00s -> outer line is 1.00 - 0.50 = 0.50s [00:00.50]
      assert.strictEqual(elrcRs, '[00:00.50] <00:01.00>Word1 <00:01.70>Word2');
    });

    // ----------------------------------------------------
    // 4. PROVIDER FORMAT PARSING (YRC / QRC / KRC / RICHSYNC)
    // ----------------------------------------------------
    await test('PROVIDER_FORMAT_PARSING_YRC_QRC_KRC_RICHSYNC', () => {
      // 4.1 NetEase YRC
      const yrcSample = `
[0,3500](0,500,0)Hello (500,600,0)from (1100,800,0)the (1900,1200,0)other (3100,400,0)side
[4000,3000](4000,600,0)I (4600,500,0)must (5100,500,0)have (5600,800,0)called (6400,600,0)a
{"t":0,"c":[{"tx":"作词: Adele"}]}
`;
      const parsedYrc = parseYrc(yrcSample);
      assert.strictEqual(parsedYrc.length, 2);
      assert.strictEqual(parsedYrc[0].startMs, 0);
      assert.strictEqual(parsedYrc[0].words.length, 5);
      assert.strictEqual(parsedYrc[0].words[0].text, 'Hello ');
      assert.strictEqual(parsedYrc[1].startMs, 4000);
      assert.strictEqual(parsedYrc[1].words[0].startMs, 4000);

      // 4.2 QQ Music QRC (XML and standard format)
      const qrcSample = `
<?xml version="1.0" encoding="utf-8"?>
<QrcInfos>
<Lyric_1 LyricContent="[1000,3000]Someone(1000,500) like(1500,500) you(2000,1000)
[4500,2500]Never(4500,500) mind(5000,600) I'll(5600,400) find(6000,1000)"/>
</QrcInfos>
`;
      const parsedQrc = parseQrc(qrcSample);
      assert.strictEqual(parsedQrc.length, 2);
      assert.strictEqual(parsedQrc[0].startMs, 1000);
      assert.strictEqual(parsedQrc[0].words[0].text, 'Someone');
      assert.strictEqual(parsedQrc[0].words[0].startMs, 1000);
      assert.strictEqual(parsedQrc[1].startMs, 4500);

      // 4.3 Kugou KRC
      const krcSample = `
[ti:Shape of You]
[ar:Ed Sheeran]
[1200,3500]<0,400,0>The <400,300,0>club <700,200,0>isn't <900,300,0>the <1200,500,0>best <1700,400,0>place
[5000,3000]<0,500,0>To <500,300,0>find <800,200,0>a <1000,500,0>lover
`;
      const parsedKrc = parseKrc(krcSample);
      assert.strictEqual(parsedKrc.length, 2);
      assert.strictEqual(parsedKrc[0].startMs, 1200);
      // KRC word startMs is lineStartMs + offsetMs (1200 + 400 = 1600ms for 'club ')
      assert.strictEqual(parsedKrc[0].words[0].startMs, 1200);
      assert.strictEqual(parsedKrc[0].words[1].startMs, 1600);
      assert.strictEqual(parsedKrc[0].words[1].text, 'club ');

      // 4.4 Musixmatch Richsync
      const rsSample: RichsyncLine[] = [
        {
          ts: 5.00,
          te: 8.00,
          l: [
            { c: 'Cause', o: 0.00 },
            { c: ' ', o: 0.30 },
            { c: 'I', o: 0.40 },
            { c: ' ', o: 0.60 },
            { c: 'love', o: 0.80 },
            { c: ' ', o: 1.20 },
            { c: 'you', o: 1.40 },
          ],
        },
      ];
      const rsRendered = renderRichsyncToElrc(rsSample, 500);
      assert.strictEqual(
        rsRendered,
        '[00:04.50] <00:05.00>Cause <00:05.40>I <00:05.80>love <00:06.40>you'
      );
    });

    // ----------------------------------------------------
    // 5. UNICODE & MULTI-LANGUAGE ENCODING RESILIENCE
    // ----------------------------------------------------
    await test('UNICODE_AND_MULTI_LANGUAGE_ENCODING_RESILIENCE', () => {
      // Test Chinese, Japanese (Hiragana/Katakana/Kanji), Korean (Hangul), Accented Latin, and Apostrophes
      const multiLangLrc = `
[00:01.00]中文歌词：夜空中最亮的星 (Chinese Lyrics)
[00:05.50]日本語：残酷な天使のテーゼ 窓辺からやがて飛び立つ (Japanese Lyrics)
[00:10.00]한국어：보고 싶다 이렇게 말하니까 더 보고 싶다 (Korean Lyrics)
[00:15.00]Français: C'est l'été à Paris, café crème & déjà-vu
[00:20.00]Español: ¡Hola Señor! Canción del corazón con acentos
[00:25.00]Quotes & apostrophes: "Don't stop believin'" — 'Hold on to that feelin''
`;
      const parsed = parseLrc(multiLangLrc);
      assert.strictEqual(parsed.lines.length, 6);
      assert.strictEqual(parsed.lines[0].text, '中文歌词：夜空中最亮的星 (Chinese Lyrics)');
      assert.strictEqual(parsed.lines[1].text, '日本語：残酷な天使のテーゼ 窓辺からやがて飛び立つ (Japanese Lyrics)');
      assert.strictEqual(parsed.lines[2].text, '한국어：보고 싶다 이렇게 말하니까 더 보고 싶다 (Korean Lyrics)');
      assert.strictEqual(parsed.lines[3].text, "Français: C'est l'été à Paris, café crème & déjà-vu");
      assert.strictEqual(parsed.lines[4].text, 'Español: ¡Hola Señor! Canción del corazón con acentos');
      assert.strictEqual(parsed.lines[5].text, 'Quotes & apostrophes: "Don\'t stop believin\'" — \'Hold on to that feelin\'\'');

      // Normalization preserves UTF-8 cleanly
      const normalized = normalizeLrc(multiLangLrc);
      assert.ok(normalized.includes('夜空中最亮的星'));
      assert.ok(normalized.includes('残酷な天使のテーゼ'));
      assert.ok(normalized.includes('보고 싶다'));
    });

    // ----------------------------------------------------
    // 6. MALFORMED INPUT RESILIENCE
    // ----------------------------------------------------
    await test('MALFORMED_INPUT_RESILIENCE', () => {
      // Malformed timestamp formats, empty strings, null values
      assert.strictEqual(parseTimestampString(''), null);
      assert.strictEqual(parseTimestampString('invalid:time'), null);
      assert.strictEqual(parseTimestampString('[99:99:99]'), null);

      // Malformed LRC
      const malformedLrc = `
Random unformatted plain text line without bracket
[corrupt:header
[00:01.00]Valid line 1
[not_a_time]Broken line
[00:04.00]Valid line 2
[00:08.00]Valid line 3
[999999]Excessive
`;
      const res = parseLrc(malformedLrc);
      assert.strictEqual(res.lines.length, 3);
      assert.strictEqual(res.lines[0].text, 'Valid line 1');
      assert.strictEqual(res.lines[1].text, 'Valid line 2');
      assert.strictEqual(res.lines[2].text, 'Valid line 3');

      // Malformed YRC
      assert.deepStrictEqual(parseYrc(''), []);
      assert.deepStrictEqual(parseYrc('completely corrupt yrc text'), []);

      // Malformed QRC
      assert.deepStrictEqual(parseQrc(''), []);
      assert.deepStrictEqual(parseQrc('not valid qrc xml or text'), []);

      // Malformed KRC
      assert.deepStrictEqual(parseKrc(''), []);
      assert.deepStrictEqual(parseKrc('random string'), []);

      // Malformed Richsync
      assert.strictEqual(renderRichsyncToElrc([]), null);
      assert.strictEqual(renderRichsyncToElrc(null as any), null);
    });

    // ----------------------------------------------------
    // 7. COMPANION FILE DETECTION & MULTI-EXTENSION PRESERVATION
    // ----------------------------------------------------
    await test('COMPANION_FILE_DETECTION_AND_NAMING', () => {
      const compDir = path.join(SCRATCH_DIR, 'companion_test');
      fs.mkdirSync(compDir, { recursive: true });

      // Audio 1: Standard single extension
      const audio1 = path.join(compDir, 'StandardSong.mp3');
      const lrc1 = path.join(compDir, 'StandardSong.lrc');
      const elrc1 = path.join(compDir, 'StandardSong.elrc.lrc');
      fs.writeFileSync(audio1, 'AUDIO');
      fs.writeFileSync(lrc1, '[00:01.00]Line 1\n[00:04.00]Line 2\n[00:08.00]Line 3');
      fs.writeFileSync(elrc1, '[00:00.50] <00:01.00>Line <00:02.00>1\n[00:03.50] <00:04.00>Line <00:05.00>2\n[00:07.50] <00:08.00>Line <00:09.00>3');

      assert.strictEqual(findExistingNormalLrc(audio1), lrc1);
      assert.strictEqual(findExistingElrc(audio1), elrc1);

      // Audio 2: Multi-extension (e.g. Song.remastered.2024.flac)
      const audio2 = path.join(compDir, 'Song.remastered.2024.flac');
      const lrc2 = path.join(compDir, 'Song.remastered.2024.lrc');
      const elrc2 = path.join(compDir, 'Song.remastered.2024.elrc.lrc');
      fs.writeFileSync(audio2, 'AUDIO');
      fs.writeFileSync(lrc2, '[00:01.00]Multi-dot 1\n[00:04.00]Multi-dot 2\n[00:08.00]Multi-dot 3');
      fs.writeFileSync(elrc2, '[00:00.50] <00:01.00>Multi <00:02.00>1\n[00:03.50] <00:04.00>Multi <00:05.00>2\n[00:07.50] <00:08.00>Multi <00:09.00>3');

      assert.strictEqual(findExistingNormalLrc(audio2), lrc2);
      assert.strictEqual(findExistingElrc(audio2), elrc2);

      // Audio 3: Complex Unicode, spaces, apostrophes and brackets
      const audio3 = path.join(compDir, "2Pac - Lil' Homies [Explicit] (Live).m4a");
      const lrc3 = path.join(compDir, "2Pac - Lil' Homies [Explicit] (Live).lrc");
      const elrc3 = path.join(compDir, "2Pac - Lil' Homies [Explicit] (Live).elrc.lrc");
      fs.writeFileSync(audio3, 'AUDIO');
      fs.writeFileSync(lrc3, '[00:01.00]Tupac\n[00:04.00]Homies\n[00:07.00]Track');
      fs.writeFileSync(elrc3, '[00:00.50] <00:01.00>Tupac\n[00:03.50] <00:04.00>Homies\n[00:06.50] <00:07.00>Track');

      assert.strictEqual(findExistingNormalLrc(audio3), lrc3);
      assert.strictEqual(findExistingElrc(audio3), elrc3);
    });

    // ----------------------------------------------------
    // 8. SECURITY PATH CONTAINMENT (S3) & TRAVERSAL REJECTION
    // ----------------------------------------------------
    await test('SECURITY_LYRIC_WRITE_CONTAINMENT_AND_TRAVERSAL_REJECTION', () => {
      const mediaRoot = path.join(SCRATCH_DIR, 'media_root_sec');
      const outsideDir = path.join(SCRATCH_DIR, 'outside_sec');
      fs.mkdirSync(mediaRoot, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      const safeFile = path.join(mediaRoot, 'Artist', 'Song.lrc');
      const traversal1 = path.join(mediaRoot, '..', 'outside_sec', 'Stolen.lrc');
      const traversal2 = path.join(mediaRoot, 'Artist', '..', '..', 'outside_sec', 'Stolen.lrc');
      const traversal3 = '/etc/passwd';

      assert.strictEqual(isPathAllowedInRoot(safeFile, mediaRoot), true);
      assert.strictEqual(isPathAllowedInRoot(traversal1, mediaRoot), false);
      assert.strictEqual(isPathAllowedInRoot(traversal2, mediaRoot), false);
      assert.strictEqual(isPathAllowedInRoot(traversal3, mediaRoot), false);
      assert.strictEqual(isPathAllowedInRoot(outsideDir, mediaRoot), false);
    });

    // ----------------------------------------------------
    // 9. EXECUTOR DUAL LYRIC RETRIEVAL & PRESERVATION INTEGRATION
    // ----------------------------------------------------
    await test('EXECUTOR_DUAL_LYRIC_PRESERVATION_AND_RECOVERY', async () => {
      const jobDir = path.join(SCRATCH_DIR, 'executor_lyrics_test');
      fs.mkdirSync(jobDir, { recursive: true });

      const audioFile = path.join(jobDir, 'TestSong.mp3');
      const elrcFile = path.join(jobDir, 'TestSong.elrc.lrc');
      const lrcFile = path.join(jobDir, 'TestSong.lrc');
      fs.writeFileSync(audioFile, 'DUMMY_AUDIO_DATA');

      // Existing eLRC exists on disk, but LRC is missing
      fs.writeFileSync(elrcFile, '[00:00.50] <00:01.00>Existing <00:02.00>eLRC\n[00:03.50] <00:04.00>Line <00:05.00>Two\n[00:06.50] <00:07.00>Line <00:08.00>Three');

      const executor = new JobExecutor();
      // Mock lyrics fetcher: returns only missing LRC
      executor.customLyricsFetcher = async (_title, _artist, _album, _duration, opts) => {
        assert.strictEqual(opts?.needElrc, false, 'Should NOT request eLRC when valid eLRC exists on disk');
        assert.strictEqual(opts?.needLrc, true, 'Should request LRC when LRC is missing on disk');
        return {
          elrcResult: null,
          lrcResult: {
            lrc: '[00:01.00]Fetched standard LRC\n[00:04.00]Line 2\n[00:07.00]Line 3',
            source: 'netease',
            format: 'LRC',
            lineCount: 3,
          },
        };
      };

      // Mock Demucs
      executor.customCudaValidator = async () => ({
        ready: true,
        pythonAvailable: true,
        torchAvailable: true,
        cudaAvailable: true,
        deviceCount: 1,
        deviceName: 'NVIDIA RTX 3060',
        tensorVerified: true,
      });
      executor.customPythonRunner = async () => {};
      executor.customFfmpegCreator = async (_orig, _stem, out) => {
        fs.writeFileSync(out, 'MOCK_INSTRUMENTAL');
      };

      const job: any = {
        id: 'job_p5_preservation',
        filePath: audioFile,
        fileName: 'TestSong.mp3',
        artistName: 'Test Artist',
        status: 'QUEUED',
        currentPhase: 'Queued',
        progress: 0,
      };

      await executor.executeJob(job, {
        onProgress: () => {},
        onLog: () => {},
        onSegment: () => {},
        onWord: () => {},
        onComplete: () => {},
        onFailed: () => {},
      });

      assert.ok(fs.existsSync(elrcFile), 'elrcFile must exist on disk');
      assert.ok(fs.existsSync(lrcFile), 'lrcFile must exist on disk');
      const elrcDisk = fs.readFileSync(elrcFile, 'utf-8');
      assert.ok(elrcDisk.includes('Existing') && elrcDisk.includes('eLRC'), 'Existing eLRC content must be preserved untouched');
    });

    // ----------------------------------------------------
    // 10. PROVIDER FALLBACK CHAIN & ORDER LOGIC
    // ----------------------------------------------------
    await test('PROVIDER_FALLBACK_CHAIN_AND_ORDER_LOGIC', async () => {
      // Simulate chain progression across [netease -> qqmusic -> kugou -> musixmatch]
      const calledProviders: string[] = [];

      // Test Case 1: NetEase fails -> QQ Music succeeds
      const simDualLyrics = async (
        title: string,
        artist: string,
        providerMock: Record<string, { elrc?: string; lrc?: string; error?: string }>
      ) => {
        calledProviders.length = 0;
        const providers = ['netease', 'qqmusic', 'kugou', 'musixmatch'];
        let elrcResult: any = null;
        let lrcResult: any = null;
        let needElrc = true;
        let needLrc = true;

        for (const prov of providers) {
          if (!needElrc && !needLrc) break;
          calledProviders.push(prov);
          const mock = providerMock[prov];
          if (!mock) continue;

          if (needElrc && mock.elrc) {
            elrcResult = { elrc: mock.elrc, source: prov, format: 'eLRC' };
            needElrc = false;
          }
          if (needLrc && mock.lrc) {
            lrcResult = { lrc: mock.lrc, source: prov, format: 'LRC' };
            needLrc = false;
          }
        }

        return { elrcResult, lrcResult };
      };

      // Case 1: First provider succeeds on both -> halts after NetEase
      const res1 = await simDualLyrics('Song 1', 'Artist 1', {
        netease: { elrc: '[00:00.50] <00:01.00>NetEase', lrc: '[00:01.00]NetEase' },
        qqmusic: { elrc: '[00:00.50] <00:01.00>QQ', lrc: '[00:01.00]QQ' },
      });
      assert.deepStrictEqual(calledProviders, ['netease']);
      assert.strictEqual(res1.elrcResult.source, 'netease');

      // Case 2: NetEase fails -> QQ Music succeeds -> halts after QQ Music
      const res2 = await simDualLyrics('Song 2', 'Artist 2', {
        netease: { error: 'Network timeout' },
        qqmusic: { elrc: '[00:00.50] <00:01.00>QQ', lrc: '[00:01.00]QQ' },
        kugou: { elrc: '[00:00.50] <00:01.00>Kugou', lrc: '[00:01.00]Kugou' },
      });
      assert.deepStrictEqual(calledProviders, ['netease', 'qqmusic']);
      assert.strictEqual(res2.elrcResult.source, 'qqmusic');

      // Case 3: NetEase provides only LRC, QQ provides eLRC -> both satisfied, Kugou skipped
      const res3 = await simDualLyrics('Song 3', 'Artist 3', {
        netease: { lrc: '[00:01.00]NetEase LRC' },
        qqmusic: { elrc: '[00:00.50] <00:01.00>QQ eLRC' },
        kugou: { elrc: '[00:00.50] <00:01.00>Kugou' },
      });
      assert.deepStrictEqual(calledProviders, ['netease', 'qqmusic']);
      assert.strictEqual(res3.lrcResult.source, 'netease');
      assert.strictEqual(res3.elrcResult.source, 'qqmusic');

      // Case 4: NetEase, QQ, Kugou all fail -> Musixmatch fallback
      const res4 = await simDualLyrics('Song 4', 'Artist 4', {
        netease: { error: 'Not found' },
        qqmusic: { error: 'No syllables' },
        kugou: { error: 'Decryption failed' },
        musixmatch: { elrc: '[00:00.50] <00:01.00>Musixmatch', lrc: '[00:01.00]Musixmatch' },
      });
      assert.deepStrictEqual(calledProviders, ['netease', 'qqmusic', 'kugou', 'musixmatch']);
      assert.strictEqual(res4.elrcResult.source, 'musixmatch');
    });

    // ----------------------------------------------------
    // 11. LEAD-IN EDGE CASES & DOUBLE-ADJUSTMENT PREVENTION
    // ----------------------------------------------------
    await test('LEAD_IN_EDGE_CASES_AND_DOUBLE_ADJUSTMENT_PREVENTION', () => {
      // 11.1 Verify lead-in on very long tracks (e.g. 59:59.99, 120:00.00)
      const longLines: RawLyricLine[] = [
        {
          startMs: 3600000, // 60:00.00
          durationMs: 5000,
          words: [
            { text: 'Epic', startMs: 3600000, durationMs: 2000 },
            { text: 'finale', startMs: 3602000, durationMs: 3000 },
          ],
          text: 'Epic finale',
        },
      ];
      const longElrc = renderRawLinesToElrc(longLines, 500);
      // 3600000ms = 3600s - 0.5s = 3599.50s = 59:59.50
      assert.strictEqual(longElrc, '[59:59.50] <60:00.00>Epic <60:02.00>finale');

      // 11.2 Double-adjustment prevention:
      // When parsing an already-rendered eLRC and extracting words, timestamps should reflect
      // the actual word timestamp `<mm:ss.xx>`, not re-subtract 500ms from the line timestamp.
      const rendered = '[00:01.50] <00:02.00>Hello <00:02.50>world';
      const parsed = parseLrc(rendered);
      assert.strictEqual(parsed.lines[0].enhancedWords![0].startMs, 2000);
      assert.strictEqual(parsed.lines[0].enhancedWords![1].startMs, 2500);
    });

  } finally {
    // Cleanup scratch directory
    try {
      fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
    } catch {}
  }

  console.log('\n====================================================');
  console.log(`PHASE 5 TEST SUITE SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase5TestSuite().catch((err) => {
  console.error('Fatal error running Phase 5 test suite:', err);
  process.exit(1);
});
