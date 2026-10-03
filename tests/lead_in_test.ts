import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { renderRichsyncToElrc, fetchElrc, fetchLrc, RichsyncLine } from '../server/musixmatch.js';
import { findExistingElrc, findExistingNormalLrc } from '../server/scanner.js';

async function testUnitRichsyncRule() {
  console.log('--- UNIT TEST: 500ms Lead-In and Clamping ---');

  // Case 1: Standard offset >= 0.50s
  const sampleLines1: RichsyncLine[] = [
    {
      ts: 2.48,
      te: 4.50,
      l: [
        { c: 'Oh,', o: 0.00 },
        { c: ' ', o: 0.20 },
        { c: 'oh,', o: 0.42 },
        { c: ' ', o: 0.60 },
        { c: 'girl,', o: 0.77 },
      ]
    }
  ];

  const res1 = renderRichsyncToElrc(sampleLines1, 500);
  console.log('Result 1:\n', res1);
  // Word 1 is at 2.48 + 0.00 = 2.48 -> <00:02.48>
  // Line ts = 2.48 - 0.50 = 1.98 -> [00:01.98]
  assert.strictEqual(
    res1,
    '[00:01.98] <00:02.48>Oh, <00:02.90>oh, <00:03.25>girl,'
  );

  // Case 2: Early offset < 0.50s (Clamped to 00:00.00)
  const sampleLines2: RichsyncLine[] = [
    {
      ts: 0.30,
      te: 2.00,
      l: [
        { c: 'First', o: 0.00 },
        { c: ' ', o: 0.50 },
        { c: 'word', o: 0.60 },
      ]
    }
  ];

  const res2 = renderRichsyncToElrc(sampleLines2, 500);
  console.log('Result 2:\n', res2);
  // Word 1 is at 0.30 -> <00:00.30>
  // Line ts = 0.30 - 0.50 = -0.20 -> clamped to [00:00.00]
  assert.strictEqual(
    res2,
    '[00:00.00] <00:00.30>First <00:00.90>word'
  );

  // Case 3: First chunk is whitespace, first actual word offset > 0
  const sampleLines3: RichsyncLine[] = [
    {
      ts: 10.00,
      te: 14.00,
      l: [
        { c: '   ', o: 0.00 },
        { c: 'Start', o: 0.80 },
        { c: ' ', o: 1.20 },
        { c: 'here', o: 1.50 },
      ]
    }
  ];

  const res3 = renderRichsyncToElrc(sampleLines3, 500);
  console.log('Result 3:\n', res3);
  // First word is 'Start' at 10.00 + 0.80 = 10.80 -> <00:10.80>
  // Line ts = 10.80 - 0.50 = 10.30 -> [00:10.30]
  assert.strictEqual(
    res3,
    '[00:10.30] <00:10.80>Start <00:11.50>here'
  );

  console.log('✓ All unit assertions passed!\n');
}

async function testLiveSongs() {
  console.log('--- LIVE TEST: 3 Songs from Musixmatch ---');

  const songs = [
    { artist: '98 Degrees', title: 'I Do (Cherish You)', base: '98 Degrees - I Do (Cherish You)' },
    { artist: 'Alicia Keys', title: "If I Ain't Got You", base: "Alicia Keys - If I Ain't Got You" },
    { artist: 'Queen', title: 'Bohemian Rhapsody', base: 'Queen - Bohemian Rhapsody' },
  ];

  const testDir = path.join(process.cwd(), 'live_lead_in_test_out');
  fs.mkdirSync(testDir, { recursive: true });

  for (const song of songs) {
    console.log(`\n======================================================`);
    console.log(`Checking: ${song.artist} — ${song.title}`);
    console.log(`======================================================`);

    const elrcRes = await fetchElrc(song.title, song.artist);
    const lrcRes = await fetchLrc(song.title, song.artist);

    assert.strictEqual(elrcRes.success, true, 'eLRC fetch must succeed');
    assert.strictEqual(lrcRes.success, true, 'LRC fetch must succeed');
    assert.ok(elrcRes.elrc, 'eLRC text must be non-empty');
    assert.ok(lrcRes.lrc, 'LRC text must be non-empty');

    const elrcLines = elrcRes.elrc!.split('\n').filter(Boolean);
    const lrcLines = lrcRes.lrc!.split('\n').filter(Boolean);

    console.log(`Downloaded ${elrcLines.length} eLRC lines, ${lrcLines.length} LRC lines.`);

    // Check first 5 lines for the 500ms lead-in rule
    console.log('\nVerifying 500ms lead-in on lines:');
    for (let i = 0; i < Math.min(5, elrcLines.length); i++) {
      const line = elrcLines[i];
      // Match outer [mm:ss.xx] and first inner <mm:ss.xx>
      const outerMatch = line.match(/^\[(\d{2}):(\d{2}\.\d{2})\]/);
      const firstWordMatch = line.match(/<(\d{2}):(\d{2}\.\d{2})>/);

      if (outerMatch && firstWordMatch) {
        const outerSec = parseInt(outerMatch[1], 10) * 60 + parseFloat(outerMatch[2]);
        const wordSec = parseInt(firstWordMatch[1], 10) * 60 + parseFloat(firstWordMatch[2]);
        const expectedOuterSec = Math.max(0, Math.round((wordSec - 0.50) * 100) / 100);

        console.log(`  Line ${i + 1}:`);
        console.log(`    Original First Word Time: ${firstWordMatch[1]}:${firstWordMatch[2]} (${wordSec.toFixed(2)}s)`);
        console.log(`    Calculated Line Time:     ${outerMatch[1]}:${outerMatch[2]} (${outerSec.toFixed(2)}s)`);
        console.log(`    Expected Line Time:       ${expectedOuterSec.toFixed(2)}s (diff = ${(wordSec - outerSec).toFixed(2)}s)`);
        console.log(`    Line string: ${line.substring(0, 70)}...`);

        assert.strictEqual(
          Math.abs(outerSec - expectedOuterSec) < 0.011,
          true,
          `Line ${i + 1} outer timestamp must equal first word - 500ms (clamped)`
        );
      }
    }

    // Check that LRC does NOT contain word timestamps <...>
    for (const lrcLine of lrcLines) {
      assert.strictEqual(/<\d{2}:\d{2}\.\d{2}>/.test(lrcLine), false, 'LRC must not contain word-level <...> tags');
    }

    // Save files and test scanner separation
    const elrcPath = path.join(testDir, `${song.base}.elrc.lrc`);
    const lrcPath = path.join(testDir, `${song.base}.lrc`);
    const dummyAudio = path.join(testDir, `${song.base}.mp3`);

    fs.writeFileSync(elrcPath, elrcRes.elrc!, 'utf-8');
    fs.writeFileSync(lrcPath, lrcRes.lrc!, 'utf-8');
    fs.writeFileSync(dummyAudio, 'dummy');

    const foundElrc = findExistingElrc(dummyAudio);
    const foundLrc = findExistingNormalLrc(dummyAudio);

    assert.strictEqual(foundElrc, elrcPath);
    assert.strictEqual(foundLrc, lrcPath);
    console.log(`✓ Scanner separation verified: .elrc.lrc and .lrc recognized independently.`);
  }

  console.log('\n✓ All 3 live song downloads passed all assertions!');
}

async function run() {
  await testUnitRichsyncRule();
  await testLiveSongs();
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
