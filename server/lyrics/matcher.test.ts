import {
  calculateMatchScore,
  calculateTitleSimilarity,
  calculateArtistSimilarity,
  cleanTitle,
  cleanArtist,
  extractArtistTokens,
  MIN_MATCH_SCORE,
  isValidFineGrainedPayload,
  RawLyricLine,
} from './types.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, details?: string) {
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${testName} ${details ? `(${details})` : ''}`);
    failed++;
  }
}

console.log('====================================================');
console.log('Running Lyric Matcher & Candidate Validation Tests');
console.log('====================================================\n');

// ----------------------------------------------------
// TEST 1: Specific User Case - 2Pac - Lil' Homies vs Saint Harison
// ----------------------------------------------------
{
  const queryTitle = "Lil' Homies";
  const queryArtist = '2Pac';
  const candTitle = 'homies';
  const candArtist = 'Saint Harison, Tiana Major9';

  const match = calculateMatchScore(queryTitle, queryArtist, candTitle, candArtist);
  assert(
    !match.isValid && match.score < MIN_MATCH_SCORE,
    'REJECT low-score wrong candidate: 2Pac - Lil\' Homies vs homies - Saint Harison',
    `Expected isValid=false and score < ${MIN_MATCH_SCORE}, got score=${match.score}, isValid=${match.isValid}`
  );
}

// ----------------------------------------------------
// TEST 2: Correct Match for 2Pac - Lil' Homies (QQ Music Candidate)
// ----------------------------------------------------
{
  const queryTitle = "Lil' Homies";
  const queryArtist = '2Pac';
  const candTitle = "Lil' Homies (Explicit)";
  const candArtist = '2Pac';

  const match = calculateMatchScore(queryTitle, queryArtist, candTitle, candArtist);
  assert(
    match.isValid && match.score >= 80,
    'ACCEPT correct candidate: 2Pac - Lil\' Homies (Explicit)',
    `Expected isValid=true and score >= 80, got score=${match.score}`
  );
}

// ----------------------------------------------------
// TEST 3: Multi-artist track - Semicolon Delimiters & Feat Titles
// Chris Brown;Kevin McCall - No BS (feat. Kevin McCall)
// ----------------------------------------------------
{
  const queryTitle = 'No BS (feat. Kevin McCall)';
  const queryArtist = 'Chris Brown;Kevin McCall';
  const candTitle = 'No BS (Explicit)';
  const candArtist = 'Chris Brown, Kevin McCall';

  const match = calculateMatchScore(queryTitle, queryArtist, candTitle, candArtist, 247.9, 247.0);
  assert(
    match.isValid && match.score >= 80,
    'ACCEPT multi-artist track: Chris Brown;Kevin McCall - No BS',
    `Expected isValid=true and score >= 80, got score=${match.score}`
  );
}

// ----------------------------------------------------
// TEST 4: Multi-artist with Chinese separator 、 (Kugou style)
// ----------------------------------------------------
{
  const queryTitle = 'No BS (feat. Kevin McCall)';
  const queryArtist = 'Chris Brown;Kevin McCall';
  const candTitle = 'No BS (Explicit)';
  const candArtist = 'Chris Brown、Kevin Mccall';

  const match = calculateMatchScore(queryTitle, queryArtist, candTitle, candArtist, 247.9, 247.0);
  assert(
    match.isValid && match.score >= 80,
    'ACCEPT multi-artist with Kugou "、" delimiter',
    `Expected isValid=true and score >= 80, got score=${match.score}`
  );
}

// ----------------------------------------------------
// TEST 5: Triple Artist with slash & comma separators
// Chris Brown;Tyga;Kevin McCall - Deuces (feat. Tyga & Kevin McCall)
// ----------------------------------------------------
{
  const queryTitle = 'Deuces (feat. Tyga & Kevin McCall)';
  const queryArtist = 'Chris Brown;Tyga;Kevin McCall';
  const candTitle = 'Deuces (Explicit Version)';
  const candArtist = 'Chris Brown, Tyga, Kevin McCall';

  const match = calculateMatchScore(queryTitle, queryArtist, candTitle, candArtist, 276.6, 276.0);
  assert(
    match.isValid && match.score >= 80,
    'ACCEPT triple artist track: Deuces (Explicit Version)',
    `Expected isValid=true and score >= 80, got score=${match.score}`
  );
}

// ----------------------------------------------------
// TEST 6: Multi-artist track - 2 Chainz, Drake - No Lie
// ----------------------------------------------------
{
  const queryTitle = 'No Lie';
  const queryArtist = '2 Chainz, Drake';
  const candTitle = 'No Lie (Explicit)';
  const candArtist = '2 Chainz feat. Drake';

  const match = calculateMatchScore(queryTitle, queryArtist, candTitle, candArtist);
  assert(
    match.isValid && match.score >= 80,
    'ACCEPT: 2 Chainz, Drake - No Lie vs 2 Chainz feat. Drake',
    `Expected isValid=true and score >= 80, got score=${match.score}`
  );
}

// ----------------------------------------------------
// TEST 7: Strip Title & Feat Matching
// ----------------------------------------------------
{
  const queryTitle = 'Strip (feat. Kevin McCall)';
  const queryArtist = 'Chris Brown;Kevin McCall';
  const candTitle = 'Strip (Explicit)';
  const candArtist = 'Chris Brown、Kevin Mccall';

  const match = calculateMatchScore(queryTitle, queryArtist, candTitle, candArtist, 167.8, 167.0);
  assert(
    match.isValid && match.score >= 80,
    'ACCEPT: Strip (feat. Kevin McCall) vs Strip (Explicit)',
    `Expected isValid=true and score >= 80, got score=${match.score}`
  );
}

// ----------------------------------------------------
// TEST 8: Duration Tolerance Boundary Checks
// ----------------------------------------------------
{
  // Within tolerance (5.8s <= 6.0s) -> PASS
  const matchPass = calculateMatchScore(
    'Sensational',
    'Chris Brown, Davido, Lojay',
    'Sensational (Explicit)',
    'Chris Brown, Davido, Lojay',
    231.0,
    236.8
  );
  assert(
    matchPass.durationPassed && matchPass.isValid,
    'PASS duration boundary within tolerance (5.8s <= 6.0s)',
    `Expected durationPassed=true, got ${matchPass.durationPassed}`
  );

  // Exceeding tolerance (6.5s > 6.0s) -> FAIL
  const matchFail = calculateMatchScore(
    'Sensational',
    'Chris Brown, Davido, Lojay',
    'Sensational (Explicit)',
    'Chris Brown, Davido, Lojay',
    231.0,
    237.5
  );
  assert(
    !matchFail.durationPassed && !matchFail.isValid,
    'REJECT duration boundary exceeding tolerance (6.5s > 6.0s)',
    `Expected durationPassed=false, got ${matchFail.durationPassed}`
  );
}

// ----------------------------------------------------
// TEST 9: Incomplete / Stub Fine-Grained Payload Validation
// (e.g. Sensational 2-line/28-word metadata header)
// ----------------------------------------------------
{
  // 2-line metadata stub
  const stubLines: RawLyricLine[] = [
    {
      startMs: 0,
      durationMs: 310,
      words: [
        { text: 'Sensational', startMs: 0, durationMs: 200 },
        { text: 'Chris Brown / Davido / Lojay', startMs: 200, durationMs: 110 },
      ],
      text: 'Sensational - Chris Brown / Davido / Lojay',
    },
    {
      startMs: 310,
      durationMs: 3000,
      words: [
        { text: 'Lyrics by:', startMs: 310, durationMs: 500 },
        { text: 'Chris Brown / Philip Constable', startMs: 810, durationMs: 2500 },
      ],
      text: 'Lyrics by: Chris Brown / Philip Constable',
    },
  ];

  const stubCheck = isValidFineGrainedPayload(stubLines);
  assert(
    !stubCheck.valid,
    'REJECT incomplete/stub fine-grained payload (2 metadata lines, 0 real lyrics)',
    `Expected valid=false, got valid=${stubCheck.valid} (reason: ${stubCheck.reason})`
  );

  // Substantive 50-line lyric payload
  const realLines: RawLyricLine[] = Array.from({ length: 40 }, (_, i) => ({
    startMs: i * 3000,
    durationMs: 2500,
    words: [
      { text: 'Yeah', startMs: i * 3000, durationMs: 500 },
      { text: 'she', startMs: i * 3000 + 500, durationMs: 500 },
      { text: 'sensational', startMs: i * 3000 + 1000, durationMs: 1500 },
    ],
    text: 'Yeah she sensational',
  }));

  const realCheck = isValidFineGrainedPayload(realLines);
  assert(
    realCheck.valid,
    'ACCEPT complete fine-grained payload (40 substantive lyric lines, 120 words)',
    `Expected valid=true, got valid=${realCheck.valid}`
  );
}

// ----------------------------------------------------
// TEST 10: Completely Unrelated Song / Low Match Rejection
// ----------------------------------------------------
{
  const match = calculateMatchScore(
    'Blank Space',
    'Taylor Swift',
    'Shape of You',
    'Ed Sheeran'
  );

  assert(
    !match.isValid && match.score === 0,
    'REJECT completely unrelated song (score: 0)',
    `Expected isValid=false, got score=${match.score}`
  );
}

console.log('\n====================================================');
console.log(`Summary: ${passed} passed, ${failed} failed`);
console.log('====================================================');

if (failed > 0) {
  process.exit(1);
}
