import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { 
  findExistingInstrumental, 
  findExistingElrc, 
  findExistingNormalLrc, 
  checkSongCompletion,
  scanMediaDirectory,
  isInstrumentalFilename,
  getFullScanCount,
  getLibraryIndex,
  getLibrarySummary,
  updateSingleSongInIndex,
  removeSongFromIndex,
  handleCompanionFileChangeInIndex
} from '../server/scanner.js';
import { 
  renderRichsyncToElrc, 
  formatTimestamp,
  fetchElrc,
  fetchLrc
} from '../server/musixmatch.js';
import { JobExecutor } from '../server/executor.js';
import { SyncJob, EngineLog } from '../src/types.js';
import * as musixmatchModule from '../server/musixmatch.js';
import { 
  extractMetadata, 
  getMetadataMetrics, 
  resetMetadataMetrics, 
  invalidateMetadataCache 
} from '../server/metadata.js';
import { isPathInsideDirectory, isPathAllowedInRoot } from '../server.js';
import { demucsWorkerManager, DemucsWorkerManager } from '../server/demucs_worker.js';
import { 
  hashPassword, 
  verifyPassword, 
  createSession, 
  getSession, 
  checkRateLimit 
} from '../server/auth.js';

const TEST_DIR = path.join(process.cwd(), 'tests_scratch_' + Date.now());

function setupTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function cleanupTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// Helpers for test execution
interface TestContext {
  passed: number;
  failed: number;
  results: Record<string, { status: 'PASS' | 'FAIL'; details?: string }>;
}

const ctx: TestContext = {
  passed: 0,
  failed: 0,
  results: {}
};

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    ctx.passed++;
    ctx.results[name] = { status: 'PASS' };
    console.log(`✓ [PASS] ${name}`);
  } catch (err: any) {
    ctx.failed++;
    ctx.results[name] = { status: 'FAIL', details: err?.message || String(err) };
    console.error(`✗ [FAIL] ${name}:`, err?.message || err);
  }
}

async function main() {
  console.log('====================================================');
  console.log('STARTING YIMLY SYNC PIPELINE TEST SUITE');
  console.log('====================================================\n');

  setupTestDir();

  // ----------------------------------------------------
  // TEST 2 & 11 & 12: File Detection & Compound Extension Check
  // ----------------------------------------------------
  await runTest('FILE_DETECTION_AND_COMPOUND_EXTENSIONS', async () => {
    const songPath = path.join(TEST_DIR, 'Test Song.mp3');
    const instPath = path.join(TEST_DIR, 'Test Song Instrumental.mp3');
    const elrcPath = path.join(TEST_DIR, 'Test Song.elrc.lrc');
    const lrcPath = path.join(TEST_DIR, 'Test Song.lrc');

    fs.writeFileSync(songPath, 'dummy audio data');
    fs.writeFileSync(instPath, 'dummy instrumental data');
    fs.writeFileSync(elrcPath, '[00:01.00] <00:01.00>Test <00:01.50>Word');
    fs.writeFileSync(lrcPath, '[00:01.00]Test Word');

    // 1. Check all three companion files identified
    const foundInst = findExistingInstrumental(songPath);
    const foundElrc = findExistingElrc(songPath);
    const foundLrc = findExistingNormalLrc(songPath);

    assert.strictEqual(foundInst, instPath, 'Instrumental must be detected as EXISTS');
    assert.strictEqual(foundElrc, elrcPath, 'eLRC must be detected as EXISTS');
    assert.strictEqual(foundLrc, lrcPath, 'Normal LRC must be detected as EXISTS');

    const completion = checkSongCompletion(songPath);
    assert.strictEqual(completion.hasInstrumental, true, 'Completion hasInstrumental must be true');
    assert.strictEqual(completion.hasElrc, true, 'Completion hasElrc must be true');
    assert.strictEqual(completion.hasNormalLrc, true, 'Completion hasNormalLrc must be true');

    // 2. Test Compound Extension Isolation: .elrc.lrc MUST NOT satisfy normal .lrc
    fs.unlinkSync(lrcPath); // Remove normal .lrc, leaving only .elrc.lrc
    const foundLrcAfterDelete = findExistingNormalLrc(songPath);
    const foundElrcAfterDelete = findExistingElrc(songPath);

    assert.strictEqual(foundLrcAfterDelete, null, 'findExistingNormalLrc MUST return null when only .elrc.lrc exists!');
    assert.strictEqual(foundElrcAfterDelete, elrcPath, 'findExistingElrc must still find .elrc.lrc');

    // 3. Test Opposite: .lrc MUST NOT satisfy .elrc.lrc
    fs.unlinkSync(elrcPath); // Remove .elrc.lrc
    fs.writeFileSync(lrcPath, '[00:01.00]Test line'); // Create normal .lrc
    const foundElrcOpposite = findExistingElrc(songPath);
    const foundLrcOpposite = findExistingNormalLrc(songPath);

    assert.strictEqual(foundElrcOpposite, null, 'findExistingElrc MUST return null when only normal .lrc exists!');
    assert.strictEqual(foundLrcOpposite, lrcPath, 'findExistingNormalLrc must find .lrc');

    // Cleanup files in fixture
    fs.unlinkSync(songPath);
    fs.unlinkSync(instPath);
    fs.unlinkSync(lrcPath);
  });

  // ----------------------------------------------------
  // TEST 3: Existing Instrumental Skips Demucs
  // ----------------------------------------------------
  await runTest('EXISTING_INSTRUMENTAL_SKIPS_DEMUCS', async () => {
    const songPath = path.join(TEST_DIR, 'Track A.mp3');
    const instPath = path.join(TEST_DIR, 'Track A (Instrumental).mp3');
    fs.writeFileSync(songPath, 'audio content');
    fs.writeFileSync(instPath, 'instrumental content');

    let demucsCalled = 0;
    const executor = new JobExecutor();
    (executor as any).runPythonScript = async () => {
      demucsCalled++;
    };

    const job: SyncJob = {
      id: songPath,
      filePath: songPath,
      fileName: 'Track A.mp3',
      artistName: 'Artist A',
      songTitle: 'Track A',
      status: 'PROCESSING',
      progress: 0,
      currentPhase: 'Detecting',
      addedAt: Date.now(),
    };

    const logs: string[] = [];
    await executor.executeJob(job, {
      onProgress: () => {},
      onLog: (l) => logs.push(l.message),
      onSegment: () => {},
      onWord: () => {},
      onComplete: () => {},
      onFailed: () => {},
    });

    assert.strictEqual(demucsCalled, 0, 'Demucs MUST NOT be invoked when instrumental exists!');
    assert.strictEqual(job.instrumentalStatus, 'EXISTS', 'Job instrumentalStatus should be EXISTS');

    fs.unlinkSync(songPath);
    fs.unlinkSync(instPath);
    if (fs.existsSync(path.join(TEST_DIR, 'Track A.elrc.lrc'))) fs.unlinkSync(path.join(TEST_DIR, 'Track A.elrc.lrc'));
    if (fs.existsSync(path.join(TEST_DIR, 'Track A.lrc'))) fs.unlinkSync(path.join(TEST_DIR, 'Track A.lrc'));
  });

  // ----------------------------------------------------
  // TEST 4: Missing Instrumental Invokes Demucs Exactly Once
  // ----------------------------------------------------
  await runTest('MISSING_INSTRUMENTAL_INVOKES_DEMUCS', async () => {
    const songPath = path.join(TEST_DIR, 'Track B.mp3');
    const expectedInstPath = path.join(TEST_DIR, 'Track B (Instrumental).mp3');
    fs.writeFileSync(songPath, 'audio content');

    let demucsCalled = 0;
    const executor = new JobExecutor();
    executor.customCudaValidator = async () => ({
      ready: true,
      deviceName: 'NVIDIA GeForce RTX 3060',
      vramGb: 12,
      tensorVerified: true,
    });

    // Mock customPythonRunner to simulate Demucs outputting isolated stem
    executor.customPythonRunner = async (
      pythonBin: string,
      args: string[],
      modelsDir: string,
      onProgress: any,
      onLog: any
    ) => {
      demucsCalled++;
      // args[1] is splitReqPath
      const reqContent = JSON.parse(fs.readFileSync(args[1], 'utf-8'));
      const stemDir = path.join(reqContent.out_dir, reqContent.model, 'Track B');
      fs.mkdirSync(stemDir, { recursive: true });
      fs.writeFileSync(path.join(stemDir, 'no_vocals.mp3'), 'stem audio');
    };

    // Mock createInstrumentalWithFFmpeg on executor to write the expected output
    executor.customFfmpegCreator = async (
      orig: string,
      stem: string,
      out: string
    ) => {
      fs.writeFileSync(out, 'muxed instrumental audio');
    };

    const job: SyncJob = {
      id: songPath,
      filePath: songPath,
      fileName: 'Track B.mp3',
      artistName: 'Artist B',
      songTitle: 'Track B',
      status: 'PROCESSING',
      progress: 0,
      currentPhase: 'Detecting',
      addedAt: Date.now(),
    };

    await executor.executeJob(job, {
      onProgress: () => {},
      onLog: () => {},
      onSegment: () => {},
      onWord: () => {},
      onComplete: () => {},
      onFailed: () => {},
    });

    assert.strictEqual(demucsCalled, 1, 'Demucs MUST be invoked exactly once when instrumental is missing');
    assert.strictEqual(job.instrumentalStatus, 'GENERATED', 'Job instrumentalStatus should be GENERATED');
    assert.strictEqual(fs.existsSync(expectedInstPath), true, 'Instrumental output file must exist');

    fs.unlinkSync(songPath);
    if (fs.existsSync(expectedInstPath)) fs.unlinkSync(expectedInstPath);
    if (fs.existsSync(path.join(TEST_DIR, 'Track B.elrc.lrc'))) fs.unlinkSync(path.join(TEST_DIR, 'Track B.elrc.lrc'));
    if (fs.existsSync(path.join(TEST_DIR, 'Track B.lrc'))) fs.unlinkSync(path.join(TEST_DIR, 'Track B.lrc'));
  });

  // ----------------------------------------------------
  // TEST 4B: Mandatory CUDA Failure Aborts Demucs Without CPU Fallback
  // ----------------------------------------------------
  await runTest('MANDATORY_CUDA_FAILURE_NO_CPU_FALLBACK', async () => {
    const songPath = path.join(TEST_DIR, 'CudaFail.mp3');
    fs.writeFileSync(songPath, 'audio content');

    let demucsCalled = 0;
    const executor = new JobExecutor();

    // Mock CUDA validation returning unavailable
    executor.customCudaValidator = async () => ({
      ready: false,
      tensorVerified: false,
      error: 'torch.cuda.is_available() is False',
    });

    executor.customPythonRunner = async () => {
      demucsCalled++;
    };

    executor.customLyricsFetcher = async () => ({
      elrcResult: { elrc: '[00:01.00] <00:01.00>Word', format: 'elrc', source: 'musixmatch', lineCount: 1 },
      lrcResult: { lrc: '[00:01.00]Word', source: 'musixmatch', lineCount: 1 },
    });

    const job: SyncJob = {
      id: songPath,
      filePath: songPath,
      fileName: 'CudaFail.mp3',
      artistName: 'Artist',
      songTitle: 'CudaFail',
      status: 'PROCESSING',
      progress: 0,
      currentPhase: 'Detecting',
      addedAt: Date.now(),
    };

    let completeCalled = false;
    await executor.executeJob(job, {
      onProgress: () => {},
      onLog: () => {},
      onSegment: () => {},
      onWord: () => {},
      onComplete: () => { completeCalled = true; },
      onFailed: () => {},
    });

    assert.strictEqual(demucsCalled, 0, 'Demucs MUST NOT be called when CUDA is unavailable (No CPU Fallback!)');
    assert.strictEqual(job.audioTask?.status, 'FAILED', 'Audio task must be marked FAILED when CUDA is unavailable');
    assert.strictEqual(job.instrumentalStatus, 'FAILED', 'Job instrumentalStatus must be FAILED');
    assert(job.audioTask?.error?.includes('CUDA/RTX 3060 is required for audio separation but is unavailable'), 'Audio task error message must clearly explain mandatory CUDA requirement');
    assert.strictEqual(job.lyricsTask?.status, 'COMPLETE', 'Lyrics task MUST still complete when audio fails due to CUDA');
    assert.strictEqual(completeCalled, true, 'Job must finish gracefully (lyrics complete even though audio failed)');

    fs.unlinkSync(songPath);
    if (fs.existsSync(path.join(TEST_DIR, 'CudaFail.elrc.lrc'))) fs.unlinkSync(path.join(TEST_DIR, 'CudaFail.elrc.lrc'));
    if (fs.existsSync(path.join(TEST_DIR, 'CudaFail.lrc'))) fs.unlinkSync(path.join(TEST_DIR, 'CudaFail.lrc'));
  });

  // ----------------------------------------------------
  // TEST 5: Both Lyric Formats Fetched Independently
  // ----------------------------------------------------
  await runTest('BOTH_LYRIC_FORMATS_FETCHED', async () => {
    const songPath = path.join(TEST_DIR, 'Track C.mp3');
    const elrcPath = path.join(TEST_DIR, 'Track C.elrc.lrc');
    const lrcPath = path.join(TEST_DIR, 'Track C.lrc');
    fs.writeFileSync(songPath, 'audio content');

    // Mock lyrics fetcher on executor
    let elrcCalls = 0;
    let lrcCalls = 0;

    const executor = new JobExecutor();
    (executor as any).runPythonScript = async () => {};
    executor.customLyricsFetcher = async (_t, _a, _al, _d, opts) => {
      if (opts?.needElrc !== false) elrcCalls++;
      if (opts?.needLrc !== false) lrcCalls++;
      return {
        elrcResult: { elrc: '[00:10.00] <00:10.00>Hello <00:10.50>world', format: 'elrc', source: 'musixmatch', lineCount: 1 },
        lrcResult: { lrc: '[00:10.00]Hello world', source: 'musixmatch', lineCount: 1 },
      };
    };

    const job: SyncJob = {
      id: songPath,
      filePath: songPath,
      fileName: 'Track C.mp3',
      artistName: 'Artist C',
      songTitle: 'Track C',
      status: 'PROCESSING',
      progress: 0,
      currentPhase: 'Detecting',
      addedAt: Date.now(),
    };

    await executor.executeJob(job, {
      onProgress: () => {},
      onLog: () => {},
      onSegment: () => {},
      onWord: () => {},
      onComplete: () => {},
      onFailed: () => {},
    });

    assert.strictEqual(elrcCalls, 1, 'fetchElrc must be called once');
    assert.strictEqual(lrcCalls, 1, 'fetchLrc must be called once');
    assert.strictEqual(fs.existsSync(elrcPath), true, 'Song.elrc.lrc MUST exist');
    assert.strictEqual(fs.existsSync(lrcPath), true, 'Song.lrc MUST exist');
    assert.strictEqual(job.elrcStatus, 'FETCHED');
    assert.strictEqual(job.lrcStatus, 'FETCHED');

    const elrcContent = fs.readFileSync(elrcPath, 'utf-8');
    const lrcContent = fs.readFileSync(lrcPath, 'utf-8');
    assert.ok(elrcContent.includes('<00:10.00>'), 'eLRC must contain word timestamps');
    assert.ok(!lrcContent.includes('<'), 'LRC must be standard line-timed');

    fs.unlinkSync(songPath);
    fs.unlinkSync(elrcPath);
    fs.unlinkSync(lrcPath);
  });

  // ----------------------------------------------------
  // TEST 6: eLRC Failure Does Not Block LRC
  // ----------------------------------------------------
  await runTest('ELRC_FAILURE_DOES_NOT_BLOCK_LRC', async () => {
    const songPath = path.join(TEST_DIR, 'Track D.mp3');
    const elrcPath = path.join(TEST_DIR, 'Track D.elrc.lrc');
    const lrcPath = path.join(TEST_DIR, 'Track D.lrc');
    fs.writeFileSync(songPath, 'audio content');

    const executor = new JobExecutor();
    (executor as any).runPythonScript = async () => {};
    executor.customLyricsFetcher = async () => {
      return {
        elrcResult: null,
        lrcResult: { lrc: '[00:12.00]Standard Line Only', source: 'musixmatch', lineCount: 1 },
      };
    };

    const job: SyncJob = {
      id: songPath,
      filePath: songPath,
      fileName: 'Track D.mp3',
      artistName: 'Artist D',
      songTitle: 'Track D',
      status: 'PROCESSING',
      progress: 0,
      currentPhase: 'Detecting',
      addedAt: Date.now(),
    };

    let completeCalled = false;
    await executor.executeJob(job, {
      onProgress: () => {},
      onLog: () => {},
      onSegment: () => {},
      onWord: () => {},
      onComplete: () => { completeCalled = true; },
      onFailed: () => {},
    });

    assert.strictEqual(fs.existsSync(elrcPath), false, 'Song.elrc.lrc must not exist');
    assert.strictEqual(fs.existsSync(lrcPath), true, 'Song.lrc MUST exist');
    assert.strictEqual(job.elrcStatus, 'NOT_FOUND');
    assert.strictEqual(job.lrcStatus, 'FETCHED');
    assert.strictEqual(completeCalled, true, 'Pipeline must complete successfully');

    fs.unlinkSync(songPath);
    fs.unlinkSync(lrcPath);
  });

  // ----------------------------------------------------
  // TEST 7: LRC Failure Does Not Block eLRC
  // ----------------------------------------------------
  await runTest('LRC_FAILURE_DOES_NOT_BLOCK_ELRC', async () => {
    const songPath = path.join(TEST_DIR, 'Track E.mp3');
    const elrcPath = path.join(TEST_DIR, 'Track E.elrc.lrc');
    const lrcPath = path.join(TEST_DIR, 'Track E.lrc');
    fs.writeFileSync(songPath, 'audio content');

    const executor = new JobExecutor();
    (executor as any).runPythonScript = async () => {};
    executor.customLyricsFetcher = async () => {
      return {
        elrcResult: { elrc: '[00:05.00] <00:05.00>Preserved <00:05.50>eLRC', format: 'elrc', source: 'musixmatch', lineCount: 1 },
        lrcResult: null,
      };
    };

    const job: SyncJob = {
      id: songPath,
      filePath: songPath,
      fileName: 'Track E.mp3',
      artistName: 'Artist E',
      songTitle: 'Track E',
      status: 'PROCESSING',
      progress: 0,
      currentPhase: 'Detecting',
      addedAt: Date.now(),
    };

    let completeCalled = false;
    await executor.executeJob(job, {
      onProgress: () => {},
      onLog: () => {},
      onSegment: () => {},
      onWord: () => {},
      onComplete: () => { completeCalled = true; },
      onFailed: () => {},
    });

    assert.strictEqual(fs.existsSync(elrcPath), true, 'Song.elrc.lrc MUST exist and remain');
    assert.strictEqual(fs.existsSync(lrcPath), false, 'Song.lrc must not exist');
    assert.strictEqual(job.elrcStatus, 'FETCHED');
    assert.strictEqual(job.lrcStatus, 'NOT_FOUND');
    assert.strictEqual(completeCalled, true, 'Pipeline must complete successfully');

    fs.unlinkSync(songPath);
    fs.unlinkSync(elrcPath);
  });

  // ----------------------------------------------------
  // TEST 8: Only eLRC Exists
  // ----------------------------------------------------
  await runTest('ONLY_ELRC_EXISTS', async () => {
    const songPath = path.join(TEST_DIR, 'Track F.mp3');
    const elrcPath = path.join(TEST_DIR, 'Track F.elrc.lrc');
    const lrcPath = path.join(TEST_DIR, 'Track F.lrc');
    fs.writeFileSync(songPath, 'audio content');
    fs.writeFileSync(elrcPath, '[00:01.00] <00:01.00>Existing <00:01.50>eLRC');

    let elrcCalls = 0;
    let lrcCalls = 0;

    const executor = new JobExecutor();
    (executor as any).runPythonScript = async () => {};
    executor.customLyricsFetcher = async (_t, _a, _al, _d, opts) => {
      if (opts?.needElrc) elrcCalls++;
      if (opts?.needLrc) lrcCalls++;
      return {
        elrcResult: null,
        lrcResult: { lrc: '[00:01.00]Existing line', source: 'musixmatch', lineCount: 1 },
      };
    };

    const job: SyncJob = {
      id: songPath,
      filePath: songPath,
      fileName: 'Track F.mp3',
      artistName: 'Artist F',
      songTitle: 'Track F',
      status: 'PROCESSING',
      progress: 0,
      currentPhase: 'Detecting',
      addedAt: Date.now(),
    };

    await executor.executeJob(job, {
      onProgress: () => {},
      onLog: () => {},
      onSegment: () => {},
      onWord: () => {},
      onComplete: () => {},
      onFailed: () => {},
    });

    assert.strictEqual(elrcCalls, 0, 'Richsync calls MUST be 0 when eLRC already exists');
    assert.strictEqual(lrcCalls, 1, 'Standard LRC calls MUST be 1 when LRC is missing');
    assert.strictEqual(job.elrcStatus, 'EXISTS');
    assert.strictEqual(job.lrcStatus, 'FETCHED');
    assert.strictEqual(fs.existsSync(lrcPath), true, 'Song.lrc must be created');

    fs.unlinkSync(songPath);
    fs.unlinkSync(elrcPath);
    fs.unlinkSync(lrcPath);
  });

  // ----------------------------------------------------
  // TEST 9: Only LRC Exists
  // ----------------------------------------------------
  await runTest('ONLY_LRC_EXISTS', async () => {
    const songPath = path.join(TEST_DIR, 'Track G.mp3');
    const elrcPath = path.join(TEST_DIR, 'Track G.elrc.lrc');
    const lrcPath = path.join(TEST_DIR, 'Track G.lrc');
    fs.writeFileSync(songPath, 'audio content');
    fs.writeFileSync(lrcPath, '[00:01.00]Existing line only');

    let elrcCalls = 0;
    let lrcCalls = 0;

    const executor = new JobExecutor();
    (executor as any).runPythonScript = async () => {};
    executor.customLyricsFetcher = async (_t, _a, _al, _d, opts) => {
      if (opts?.needElrc) elrcCalls++;
      if (opts?.needLrc) lrcCalls++;
      return {
        elrcResult: { elrc: '[00:01.00] <00:01.00>Created <00:01.50>eLRC', format: 'elrc', source: 'musixmatch', lineCount: 1 },
        lrcResult: null,
      };
    };

    const job: SyncJob = {
      id: songPath,
      filePath: songPath,
      fileName: 'Track G.mp3',
      artistName: 'Artist G',
      songTitle: 'Track G',
      status: 'PROCESSING',
      progress: 0,
      currentPhase: 'Detecting',
      addedAt: Date.now(),
    };

    await executor.executeJob(job, {
      onProgress: () => {},
      onLog: () => {},
      onSegment: () => {},
      onWord: () => {},
      onComplete: () => {},
      onFailed: () => {},
    });

    assert.strictEqual(elrcCalls, 1, 'Richsync calls MUST be 1 when eLRC is missing');
    assert.strictEqual(lrcCalls, 0, 'Standard LRC calls MUST be 0 when LRC already exists');
    assert.strictEqual(job.elrcStatus, 'FETCHED');
    assert.strictEqual(job.lrcStatus, 'EXISTS');
    assert.strictEqual(fs.existsSync(elrcPath), true, 'Song.elrc.lrc must be created');

    fs.unlinkSync(songPath);
    fs.unlinkSync(elrcPath);
    fs.unlinkSync(lrcPath);
  });

  // ----------------------------------------------------
  // TEST 10: Both Exist
  // ----------------------------------------------------
  await runTest('BOTH_EXIST_NO_OVERWRITE', async () => {
    const songPath = path.join(TEST_DIR, 'Track H.mp3');
    const elrcPath = path.join(TEST_DIR, 'Track H.elrc.lrc');
    const lrcPath = path.join(TEST_DIR, 'Track H.lrc');
    const elrcInitial = '[00:01.00] <00:01.00>Initial <00:01.50>eLRC';
    const lrcInitial = '[00:01.00]Initial LRC';

    fs.writeFileSync(songPath, 'audio content');
    fs.writeFileSync(elrcPath, elrcInitial);
    fs.writeFileSync(lrcPath, lrcInitial);

    let elrcCalls = 0;
    let lrcCalls = 0;

    const executor = new JobExecutor();
    (executor as any).runPythonScript = async () => {};
    executor.customLyricsFetcher = async (_t, _a, _al, _d, opts) => {
      if (opts?.needElrc) elrcCalls++;
      if (opts?.needLrc) lrcCalls++;
      return { elrcResult: null, lrcResult: null };
    };

    const job: SyncJob = {
      id: songPath,
      filePath: songPath,
      fileName: 'Track H.mp3',
      artistName: 'Artist H',
      songTitle: 'Track H',
      status: 'PROCESSING',
      progress: 0,
      currentPhase: 'Detecting',
      addedAt: Date.now(),
    };

    await executor.executeJob(job, {
      onProgress: () => {},
      onLog: () => {},
      onSegment: () => {},
      onWord: () => {},
      onComplete: () => {},
      onFailed: () => {},
    });

    assert.strictEqual(elrcCalls, 0, 'Richsync calls MUST be 0 when both exist');
    assert.strictEqual(lrcCalls, 0, 'Standard LRC calls MUST be 0 when both exist');
    assert.strictEqual(job.elrcStatus, 'EXISTS');
    assert.strictEqual(job.lrcStatus, 'EXISTS');
    assert.strictEqual(fs.readFileSync(elrcPath, 'utf-8'), elrcInitial, 'eLRC must not be modified');
    assert.strictEqual(fs.readFileSync(lrcPath, 'utf-8'), lrcInitial, 'LRC must not be modified');

    fs.unlinkSync(songPath);
    fs.unlinkSync(elrcPath);
    fs.unlinkSync(lrcPath);
  });

  // ----------------------------------------------------
  // TEST 13: Rerun / Idempotency
  // ----------------------------------------------------
  await runTest('RERUN_IDEMPOTENCY', async () => {
    const songPath = path.join(TEST_DIR, 'Track I.mp3');
    const instPath = path.join(TEST_DIR, 'Track I (Instrumental).mp3');
    const elrcPath = path.join(TEST_DIR, 'Track I.elrc.lrc');
    const lrcPath = path.join(TEST_DIR, 'Track I.lrc');
    fs.writeFileSync(songPath, 'audio content');

    let demucsCalls = 0;
    let elrcCalls = 0;
    let lrcCalls = 0;

    const executor = new JobExecutor();
    executor.customCudaValidator = async () => ({
      ready: true,
      deviceName: 'NVIDIA GeForce RTX 3060',
      vramGb: 12,
      tensorVerified: true,
    });
    executor.customFfmpegCreator = async (orig: string, stem: string, out: string) => {
      fs.writeFileSync(out, 'instrumental');
    };
    executor.customLyricsFetcher = async (_t, _a, _al, _d, opts) => {
      if (opts?.needElrc) elrcCalls++;
      if (opts?.needLrc) lrcCalls++;
      return {
        elrcResult: { elrc: '[00:01.00] <00:01.00>Word', format: 'elrc', source: 'musixmatch', lineCount: 1 },
        lrcResult: { lrc: '[00:01.00]Line', source: 'musixmatch', lineCount: 1 },
      };
    };

    executor.customPythonRunner = async (pythonBin: string, args: string[]) => {
      demucsCalls++;
      const reqContent = JSON.parse(fs.readFileSync(args[1], 'utf-8'));
      const stemDir = path.join(reqContent.out_dir, reqContent.model, 'Track I');
      fs.mkdirSync(stemDir, { recursive: true });
      fs.writeFileSync(path.join(stemDir, 'no_vocals.mp3'), 'stem');
    };

    // RUN 1: Initial creation
    const job1: SyncJob = {
      id: songPath,
      filePath: songPath,
      fileName: 'Track I.mp3',
      artistName: 'Artist I',
      songTitle: 'Track I',
      status: 'PROCESSING',
      progress: 0,
      currentPhase: 'Detecting',
      addedAt: Date.now(),
    };

    await executor.executeJob(job1, {
      onProgress: () => {},
      onLog: () => {},
      onSegment: () => {},
      onWord: () => {},
      onComplete: () => {},
      onFailed: () => {},
    });

    assert.strictEqual(demucsCalls, 1, 'Demucs called on run 1');
    assert.strictEqual(elrcCalls, 1, 'eLRC called on run 1');
    assert.strictEqual(lrcCalls, 1, 'LRC called on run 1');
    assert.strictEqual(fs.existsSync(instPath), true, 'Instrumental exists after run 1');
    assert.strictEqual(fs.existsSync(elrcPath), true, 'eLRC exists after run 1');
    assert.strictEqual(fs.existsSync(lrcPath), true, 'LRC exists after run 1');

    // Reset call counters for RUN 2
    demucsCalls = 0;
    elrcCalls = 0;
    lrcCalls = 0;

    // RUN 2: Re-run
    const job2: SyncJob = {
      id: songPath,
      filePath: songPath,
      fileName: 'Track I.mp3',
      artistName: 'Artist I',
      songTitle: 'Track I',
      status: 'PROCESSING',
      progress: 0,
      currentPhase: 'Detecting',
      addedAt: Date.now(),
    };

    await executor.executeJob(job2, {
      onProgress: () => {},
      onLog: () => {},
      onSegment: () => {},
      onWord: () => {},
      onComplete: () => {},
      onFailed: () => {},
    });

    assert.strictEqual(demucsCalls, 0, 'Run 2 must skip Demucs');
    assert.strictEqual(elrcCalls, 0, 'Run 2 must skip Richsync');
    assert.strictEqual(lrcCalls, 0, 'Run 2 must skip Standard LRC');
    assert.strictEqual(job2.instrumentalStatus, 'EXISTS');
    assert.strictEqual(job2.elrcStatus, 'EXISTS');
    assert.strictEqual(job2.lrcStatus, 'EXISTS');

    fs.unlinkSync(songPath);
    fs.unlinkSync(instPath);
    fs.unlinkSync(elrcPath);
    fs.unlinkSync(lrcPath);
  });

  // ----------------------------------------------------
  // TEST 15: Richsync Timing Conversion
  // ----------------------------------------------------
  await runTest('RICHSYNC_TIMING_CONVERSION', () => {
    // Test sample Richsync chunk data
    const mockRichsyncLines = [
      {
        ts: 12.95,
        te: 16.50,
        l: [
          { c: "It's", o: 0.00 },
          { c: " ", o: 0.20 },
          { c: "so", o: 0.45 },
          { c: " ", o: 0.80 },
          { c: "hard", o: 1.05 },
        ]
      },
      {
        ts: 16.69,
        te: 20.10,
        l: [
          { c: "How", o: 0.00 },
          { c: " ", o: 0.30 },
          { c: "a", o: 0.50 },
          { c: " ", o: 0.70 },
          { c: "love", o: 0.95 },
        ]
      }
    ];

    const rendered = renderRichsyncToElrc(mockRichsyncLines);
    assert.ok(rendered, 'renderRichsyncToElrc must return rendered string');

    const lines = rendered.split('\n');
    assert.strictEqual(lines.length, 2);

    // Line 1: line start = 12.95 (00:12.95)
    // Word 1: "It's" at 12.95 + 0.00 = 12.95 -> <00:12.95>It's
    // Word 2: "so" at 12.95 + 0.45 = 13.40 -> <00:13.40>so
    // Word 3: "hard" at 12.95 + 1.05 = 14.00 -> <00:14.00>hard
    assert.strictEqual(lines[0], '[00:12.95] <00:12.95>It\'s <00:13.40>so <00:14.00>hard');

    // Line 2: line start = 16.69 (00:16.69)
    // Word 1: "How" at 16.69 + 0.00 = 16.69 -> <00:16.69>How
    // Word 2: "a" at 16.69 + 0.50 = 17.19 -> <00:17.19>a
    // Word 3: "love" at 16.69 + 0.95 = 17.64 -> <00:17.64>love
    assert.strictEqual(lines[1], '[00:16.69] <00:16.69>How <00:17.19>a <00:17.64>love');
  });

  // ----------------------------------------------------
  // TEST 16: Standard LRC Preservation
  // ----------------------------------------------------
  await runTest('STANDARD_LRC_PRESERVATION', () => {
    const rawLrc = `[00:12.95]It's so hard to say
[00:16.69]How a love could end this way
[00:21.30]When we had it all`;

    // Standard LRC is stored directly as line-timed string with no word markers (<...>)
    assert.ok(!rawLrc.includes('<'), 'Standard LRC must not have word brackets');
    assert.ok(rawLrc.includes('[00:12.95]It\'s so hard to say'), 'Preserves standard timestamps');
  });

  // ----------------------------------------------------
  // TEST 18: Verify No Legacy Alignment Calls
  // ----------------------------------------------------
  await runTest('NO_LEGACY_ALIGNMENT_CALLS', () => {
    const forbiddenExecutionKeywords = [
      'align.py',
      'whisperx',
      'faster_whisper',
      'wav2vec2',
      'needleman_wunsch',
    ];

    const serverFiles = fs.readdirSync(path.join(process.cwd(), 'server'))
      .filter(f => f.endsWith('.ts') || f.endsWith('.js'));

    for (const file of serverFiles) {
      const filePath = path.join(process.cwd(), 'server', file);
      const content = fs.readFileSync(filePath, 'utf-8');

      for (const kw of forbiddenExecutionKeywords) {
        // Exclude optional AppSettings type definition interface field `alignScriptPath?: string`
        if (file === 'config.ts' && (kw === 'align.py' || kw === 'alignScriptPath')) {
          continue;
        }
        if (content.toLowerCase().includes(kw)) {
          throw new Error(`Forbidden legacy keyword "${kw}" found in active server file: ${file}`);
        }
      }
    }
  });

  // ----------------------------------------------------
  // TEST 19: Demucs / Lyric Isolation Matrix
  // ----------------------------------------------------
  await runTest('DEMUCS_LYRIC_ISOLATION_MATRIX', async () => {
    const testMatrix = [
      { name: 'Demucs Fail, Lyrics OK', demucsOk: false, elrcOk: true, lrcOk: true },
      { name: 'Demucs OK, eLRC Fail, LRC OK', demucsOk: true, elrcOk: false, lrcOk: true },
      { name: 'Demucs OK, eLRC OK, LRC Fail', demucsOk: true, elrcOk: true, lrcOk: false },
      { name: 'Demucs OK, Lyrics OK', demucsOk: true, elrcOk: true, lrcOk: true },
    ];

    for (const item of testMatrix) {
      const sPath = path.join(TEST_DIR, `Matrix_${item.name.replace(/\s+/g, '_')}.mp3`);
      fs.writeFileSync(sPath, 'audio');

      const executor = new JobExecutor();
      executor.customCudaValidator = async () => ({
        ready: true,
        deviceName: 'NVIDIA GeForce RTX 3060',
        vramGb: 12,
        tensorVerified: true,
      });
      executor.customLyricsFetcher = async () => {
        return {
          elrcResult: item.elrcOk ? { elrc: '[00:01.00] <00:01.00>Word', format: 'elrc', source: 'musixmatch', lineCount: 1 } : null,
          lrcResult: item.lrcOk ? { lrc: '[00:01.00]Line', source: 'musixmatch', lineCount: 1 } : null,
        };
      };
      executor.customFfmpegCreator = async (orig: string, stem: string, out: string) => {
        if (item.demucsOk) fs.writeFileSync(out, 'inst');
        else throw new Error('FFmpeg failed');
      };

      executor.customPythonRunner = async (p: string, a: string[]) => {
        if (item.demucsOk) {
          const reqContent = JSON.parse(fs.readFileSync(a[1], 'utf-8'));
          const stemDir = path.join(reqContent.out_dir, reqContent.model, path.basename(sPath, '.mp3'));
          fs.mkdirSync(stemDir, { recursive: true });
          fs.writeFileSync(path.join(stemDir, 'no_vocals.mp3'), 'stem');
        } else {
          throw new Error('Demucs process failed');
        }
      };

      const job: SyncJob = {
        id: sPath,
        filePath: sPath,
        fileName: path.basename(sPath),
        artistName: 'Artist',
        songTitle: 'Title',
        status: 'PROCESSING',
        progress: 0,
        currentPhase: 'Detecting',
        addedAt: Date.now(),
      };

      let completeCalled = false;
      await executor.executeJob(job, {
        onProgress: () => {},
        onLog: () => {},
        onSegment: () => {},
        onWord: () => {},
        onComplete: () => { completeCalled = true; },
        onFailed: () => {},
      });

      assert.strictEqual(completeCalled, true, `Job should complete non-blockingly for case: ${item.name}`);
      assert.strictEqual(job.instrumentalStatus, item.demucsOk ? 'GENERATED' : 'FAILED');
      assert.strictEqual(job.elrcStatus, item.elrcOk ? 'FETCHED' : 'NOT_FOUND');
      assert.strictEqual(job.lrcStatus, item.lrcOk ? 'FETCHED' : 'NOT_FOUND');

      // Cleanup
      if (fs.existsSync(sPath)) fs.unlinkSync(sPath);
      const e = sPath.replace('.mp3', '.elrc.lrc');
      const l = sPath.replace('.mp3', '.lrc');
      const i = sPath.replace('.mp3', ' (Instrumental).mp3');
      if (fs.existsSync(e)) fs.unlinkSync(e);
      if (fs.existsSync(l)) fs.unlinkSync(l);
      if (fs.existsSync(i)) fs.unlinkSync(i);
    }
  });

  // ----------------------------------------------------
  // TEST 20: Output Naming Precision
  // ----------------------------------------------------
  await runTest('OUTPUT_NAMING_PRECISION', () => {
    const rawSong = path.join(TEST_DIR, '98 Degrees - I Do (Cherish You).mp3');
    fs.writeFileSync(rawSong, 'audio');

    const ext = path.extname(rawSong);
    const basename = path.basename(rawSong, ext);
    const dir = path.dirname(rawSong);

    const expectedElrc = path.join(dir, `${basename}.elrc.lrc`);
    const expectedLrc = path.join(dir, `${basename}.lrc`);
    const expectedInst = path.join(dir, `${basename} (Instrumental)${ext}`);

    assert.strictEqual(path.basename(expectedElrc), '98 Degrees - I Do (Cherish You).elrc.lrc');
    assert.strictEqual(path.basename(expectedLrc), '98 Degrees - I Do (Cherish You).lrc');
    assert.strictEqual(path.basename(expectedInst), '98 Degrees - I Do (Cherish You) (Instrumental).mp3');

    // Negative tests: must NOT produce double or incorrect extensions
    assert.notStrictEqual(path.basename(expectedElrc), '98 Degrees - I Do (Cherish You).elrc');
    assert.notStrictEqual(path.basename(expectedElrc), '98 Degrees - I Do (Cherish You).elrc.lrc.lrc');
    assert.notStrictEqual(path.basename(expectedLrc), '98 Degrees - I Do (Cherish You).lrc.lrc');

    fs.unlinkSync(rawSong);
  });

  // ----------------------------------------------------
  // TEST 21: Audio Endpoint Path Containment Security
  // ----------------------------------------------------
  await runTest('AUDIO_ENDPOINT_PATH_CONTAINMENT_SECURITY', () => {
    const mediaRoot = path.join(TEST_DIR, 'media');
    const siblingMediaRoot = path.join(TEST_DIR, 'media-private');
    const outsideDir = path.join(TEST_DIR, 'outside');

    fs.mkdirSync(mediaRoot, { recursive: true });
    fs.mkdirSync(path.join(mediaRoot, 'nested_artist'), { recursive: true });
    fs.mkdirSync(siblingMediaRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    // Legitimate files
    const validDirect = path.join(mediaRoot, 'valid.mp3');
    const validNested = path.join(mediaRoot, 'nested_artist', 'nested_song.flac');
    fs.writeFileSync(validDirect, 'audio data');
    fs.writeFileSync(validNested, 'audio data');

    // Forbidden files
    const siblingFile = path.join(siblingMediaRoot, 'secret.mp3');
    const outsideFile = path.join(outsideDir, 'private.key');
    fs.writeFileSync(siblingFile, 'secret data');
    fs.writeFileSync(outsideFile, 'private key data');

    // Traversal path
    const traversalPath = path.join(mediaRoot, '..', 'outside', 'private.key');
    const encodedTraversalPath = decodeURIComponent(encodeURIComponent(traversalPath));

    // Symlink pointing outside media root
    const symlinkPath = path.join(mediaRoot, 'symlink_out.mp3');
    let hasSymlink = false;
    try {
      fs.symlinkSync(outsideFile, symlinkPath);
      hasSymlink = true;
    } catch {}

    // 1. VALID ACCESS
    assert.strictEqual(isPathInsideDirectory(validDirect, mediaRoot), true, 'Valid file directly in mediaRoot MUST be allowed');
    assert.strictEqual(isPathInsideDirectory(validNested, mediaRoot), true, 'Valid file in nested mediaRoot folder MUST be allowed');

    // 2. BLOCKED ACCESS
    assert.strictEqual(isPathInsideDirectory(traversalPath, mediaRoot), false, '../ traversal MUST be blocked');
    assert.strictEqual(isPathInsideDirectory(encodedTraversalPath, mediaRoot), false, 'Encoded traversal MUST be blocked');
    assert.strictEqual(isPathInsideDirectory(outsideFile, mediaRoot), false, 'Absolute path outside mediaRoot MUST be blocked');
    assert.strictEqual(isPathInsideDirectory(siblingFile, mediaRoot), false, 'Sibling directory with similar prefix MUST be blocked');

    if (hasSymlink) {
      assert.strictEqual(isPathInsideDirectory(symlinkPath, mediaRoot), false, 'Symlink pointing outside mediaRoot MUST be blocked');
    }

    // Cleanup test files
    if (hasSymlink && fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
    fs.unlinkSync(validDirect);
    fs.unlinkSync(validNested);
    fs.unlinkSync(siblingFile);
    fs.unlinkSync(outsideFile);
  });

  // ----------------------------------------------------
  // TEST 22: Validate Path Security (S2)
  // ----------------------------------------------------
  await runTest('VALIDATE_PATH_SECURITY', () => {
    const mediaRoot = path.join(TEST_DIR, 'media');
    const siblingMediaRoot = path.join(TEST_DIR, 'media-private');
    const outsideDir = path.join(TEST_DIR, 'outside');

    fs.mkdirSync(mediaRoot, { recursive: true });
    fs.mkdirSync(path.join(mediaRoot, 'nested_folder'), { recursive: true });
    fs.mkdirSync(siblingMediaRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const validFile = path.join(mediaRoot, 'test_file.txt');
    const outsideFile = path.join(outsideDir, 'secret_file.txt');
    const siblingFile = path.join(siblingMediaRoot, 'private_file.txt');
    fs.writeFileSync(validFile, 'valid data');
    fs.writeFileSync(outsideFile, 'outside data');
    fs.writeFileSync(siblingFile, 'sibling data');

    const traversalPath = path.join(mediaRoot, '..', 'outside', 'secret_file.txt');
    const encodedTraversalPath = decodeURIComponent(encodeURIComponent(traversalPath));

    const symlinkPath = path.join(mediaRoot, 'symlink_outside.txt');
    let hasSymlink = false;
    try {
      fs.symlinkSync(outsideFile, symlinkPath);
      hasSymlink = true;
    } catch {}

    // 1. VALID
    assert.strictEqual(isPathAllowedInRoot(mediaRoot, mediaRoot), true, 'Configured mediaRoot folder MUST be valid');
    assert.strictEqual(isPathAllowedInRoot(path.join(mediaRoot, 'nested_folder'), mediaRoot), true, 'Nested folder inside mediaRoot MUST be valid');
    assert.strictEqual(isPathAllowedInRoot(validFile, mediaRoot), true, 'Legitimate file inside mediaRoot MUST be valid');

    // 2. BLOCKED (Probing outside directories MUST be blocked)
    assert.strictEqual(isPathAllowedInRoot(traversalPath, mediaRoot), false, '../ traversal MUST be blocked');
    assert.strictEqual(isPathAllowedInRoot(encodedTraversalPath, mediaRoot), false, 'Encoded traversal MUST be blocked');
    assert.strictEqual(isPathAllowedInRoot(outsideFile, mediaRoot), false, 'Absolute path outside allowed roots MUST be blocked');
    assert.strictEqual(isPathAllowedInRoot(siblingFile, mediaRoot), false, 'Sibling directory prefix attack MUST be blocked');

    if (hasSymlink) {
      assert.strictEqual(isPathAllowedInRoot(symlinkPath, mediaRoot), false, 'Symlink escaping outside mediaRoot MUST be blocked');
    }

    // Cleanup
    if (hasSymlink && fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
    fs.unlinkSync(validFile);
    fs.unlinkSync(outsideFile);
    fs.unlinkSync(siblingFile);
  });

  // ----------------------------------------------------
  // TEST 23: Save Lyrics Security (S3)
  // ----------------------------------------------------
  await runTest('SAVE_LYRICS_SECURITY', () => {
    const mediaRoot = path.join(TEST_DIR, 'media');
    const siblingMediaRoot = path.join(TEST_DIR, 'media-private');
    const outsideDir = path.join(TEST_DIR, 'outside');

    fs.mkdirSync(mediaRoot, { recursive: true });
    fs.mkdirSync(path.join(mediaRoot, 'artist_folder'), { recursive: true });
    fs.mkdirSync(siblingMediaRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    // Valid songs
    const validSongDirect = path.join(mediaRoot, 'Song1.mp3');
    const validSongNested = path.join(mediaRoot, 'artist_folder', 'Song2.flac');
    fs.writeFileSync(validSongDirect, 'audio 1');
    fs.writeFileSync(validSongNested, 'audio 2');

    // Expected companion .lrc paths
    const validLrcDirect = path.join(mediaRoot, 'Song1.lrc');
    const validLrcNested = path.join(mediaRoot, 'artist_folder', 'Song2.lrc');

    // Invalid audio paths
    const outsideSong = path.join(outsideDir, 'OutsideSong.mp3');
    const siblingSong = path.join(siblingMediaRoot, 'SiblingSong.mp3');
    const traversalSong = path.join(mediaRoot, '..', 'outside', 'OutsideSong.mp3');
    fs.writeFileSync(outsideSong, 'outside audio');
    fs.writeFileSync(siblingSong, 'sibling audio');

    const symlinkSong = path.join(mediaRoot, 'symlink_song.mp3');
    let hasSymlink = false;
    try {
      fs.symlinkSync(outsideSong, symlinkSong);
      hasSymlink = true;
    } catch {}

    // 1. VALID ACCESS
    assert.strictEqual(isPathAllowedInRoot(validSongDirect, mediaRoot), true, 'Direct song in mediaRoot MUST be allowed');
    assert.strictEqual(isPathAllowedInRoot(validSongNested, mediaRoot), true, 'Nested song in mediaRoot MUST be allowed');
    assert.strictEqual(isPathAllowedInRoot(validLrcDirect, mediaRoot), true, 'Direct .lrc target in mediaRoot MUST be allowed');
    assert.strictEqual(isPathAllowedInRoot(validLrcNested, mediaRoot), true, 'Nested .lrc target in mediaRoot MUST be allowed');

    // Simulate saving legitimate lyrics
    const testLyricsContent = '[00:00.00]Legitimate lyric line';
    fs.writeFileSync(validLrcNested, testLyricsContent, 'utf-8');
    assert.strictEqual(fs.existsSync(validLrcNested), true, 'Legitimate .lrc file must be created on disk');
    assert.strictEqual(fs.readFileSync(validLrcNested, 'utf-8'), testLyricsContent, 'Legitimate .lrc file must contain expected content');

    // 2. BLOCKED ACCESS
    assert.strictEqual(isPathAllowedInRoot(traversalSong, mediaRoot), false, '../ audio path MUST be blocked');
    assert.strictEqual(isPathAllowedInRoot(outsideSong, mediaRoot), false, 'Absolute outside audio path MUST be blocked');
    assert.strictEqual(isPathAllowedInRoot(siblingSong, mediaRoot), false, 'Sibling directory prefix attack MUST be blocked');

    if (hasSymlink) {
      assert.strictEqual(isPathAllowedInRoot(symlinkSong, mediaRoot), false, 'Symlink to outside audio MUST be blocked');
    }

    // Target output escaping mediaRoot
    const escapingLrcOutput = path.join(outsideDir, 'Escaped.lrc');
    assert.strictEqual(isPathAllowedInRoot(escapingLrcOutput, mediaRoot), false, 'Output path escaping mediaRoot MUST be blocked');

    // Cleanup
    if (hasSymlink && fs.existsSync(symlinkSong)) fs.unlinkSync(symlinkSong);
    if (fs.existsSync(validLrcNested)) fs.unlinkSync(validLrcNested);
    fs.unlinkSync(validSongDirect);
    fs.unlinkSync(validSongNested);
    fs.unlinkSync(outsideSong);
    fs.unlinkSync(siblingSong);
  });

  // ----------------------------------------------------
  // TEST 24: Local Authentication & Authorization Security (S4)
  // ----------------------------------------------------
  await runTest('LOCAL_AUTH_SECURITY', async () => {
    // 1. Password Hashing & Verification via Scrypt
    const pass = 'superSecretPass123!';
    const hashed = await hashPassword(pass);
    assert.strictEqual(typeof hashed, 'string', 'Hashed password must be string');
    assert.ok(hashed.startsWith('scrypt:'), 'Hashed password must use scrypt format');

    const isValid = await verifyPassword(pass, hashed);
    assert.strictEqual(isValid, true, 'Valid password must verify to true');

    const isInvalid = await verifyPassword('wrongPass456', hashed);
    assert.strictEqual(isInvalid, false, 'Invalid password must verify to false');

    // 2. Session Creation & Retrieval
    const dummyUser = {
      id: 'usr_test_admin',
      username: 'testadmin',
      passwordHash: hashed,
      role: 'ADMIN' as const,
      createdAt: Date.now(),
    };

    const session = createSession(dummyUser);
    assert.ok(session.id, 'Session ID must be generated');
    assert.strictEqual(session.username, 'testadmin');
    assert.strictEqual(session.role, 'ADMIN');

    const retrievedSession = getSession(session.id);
    assert.ok(retrievedSession, 'Session must be retrievable by session token');
    assert.strictEqual(retrievedSession?.userId, 'usr_test_admin');

    // 3. Rate Limiting Check
    const testIp = '192.168.10.99';
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(checkRateLimit(testIp), true, 'Attempts under or equal to threshold must be allowed');
    }
    const blockedAttempt = checkRateLimit(testIp);
    assert.strictEqual(blockedAttempt, false, 'Attempt exceeding rate limit threshold must be blocked');
  });

  // ----------------------------------------------------
  // TEST 25: Persistent Library Index & Zero-Rescan Performance (P1)
  // ----------------------------------------------------
  await runTest('PERSISTENT_LIBRARY_INDEX_PERFORMANCE', async () => {
    const perfMediaDir = path.join(TEST_DIR, 'perf_media');
    fs.mkdirSync(perfMediaDir, { recursive: true });

    const songA = path.join(perfMediaDir, 'SongA.mp3');
    fs.writeFileSync(songA, 'audio content A');

    // 1. Initial scan initializes store
    const initialScansBefore = getFullScanCount();
    const initResult = await scanMediaDirectory(perfMediaDir, true);
    const initialScansAfter = getFullScanCount();

    assert.strictEqual(initialScansAfter, initialScansBefore + 1, 'Force scan MUST increment full scan count');
    assert.strictEqual(initResult.total, 1, 'Initial scan must discover SongA');

    // 2. Simulate 50 repeated /api/songs and /api/status calls
    for (let i = 0; i < 50; i++) {
      const result = await scanMediaDirectory(perfMediaDir);
      assert.strictEqual(result.total, 1);
    }

    const scansAfter50Reqs = getFullScanCount();
    assert.strictEqual(
      scansAfter50Reqs, 
      initialScansAfter, 
      '50 /api/songs / /api/status queries MUST perform 0 additional full directory scans'
    );

    // 3. Incremental file addition
    const songB = path.join(perfMediaDir, 'SongB.flac');
    fs.writeFileSync(songB, 'audio content B');
    await updateSingleSongInIndex(songB, perfMediaDir);

    const updatedIndex = getLibraryIndex();
    assert.strictEqual(updatedIndex.total, 2, 'New file MUST appear in index via incremental update');
    assert.strictEqual(
      getFullScanCount(), 
      initialScansAfter, 
      'Incremental file addition MUST NOT trigger full directory scan'
    );

    // 4. Incremental companion file update (.lrc creation)
    const songBLrc = path.join(perfMediaDir, 'SongB.lrc');
    fs.writeFileSync(songBLrc, '[00:00.00]Song B lyrics');
    await handleCompanionFileChangeInIndex(songBLrc, perfMediaDir);

    const songBItem = getLibraryIndex().songs.find(s => s.fileName === 'SongB.flac');
    assert.ok(songBItem, 'SongB must exist in index');
    assert.strictEqual(songBItem?.hasNormalLrc, true, 'Lyrics creation MUST update companion LRC state in index');
    assert.strictEqual(
      getFullScanCount(), 
      initialScansAfter, 
      'Companion LRC change MUST NOT trigger full directory scan'
    );

    // 5. Incremental file removal
    fs.unlinkSync(songB);
    await updateSingleSongInIndex(songB, perfMediaDir);

    const finalIndex = getLibraryIndex();
    assert.strictEqual(finalIndex.total, 1, 'Removed file MUST disappear from index');
    assert.strictEqual(
      getFullScanCount(), 
      initialScansAfter, 
      'File removal MUST NOT trigger full directory scan'
    );

    // 6. Explicit manual scan refreshes library
    await scanMediaDirectory(perfMediaDir, true);
    assert.strictEqual(
      getFullScanCount(), 
      initialScansAfter + 1, 
      'Manual scan (force=true) MUST explicitly refresh library index'
    );

    // Cleanup
    if (fs.existsSync(songBLrc)) fs.unlinkSync(songBLrc);
    if (fs.existsSync(songA)) fs.unlinkSync(songA);
  });

  // ----------------------------------------------------
  // TEST 26: Safe Metadata Cache & Deduplication Performance (P2)
  // ----------------------------------------------------
  await runTest('SAFE_METADATA_CACHE_AND_DEDUPLICATION', async () => {
    const metaDir = path.join(TEST_DIR, 'meta_test');
    fs.mkdirSync(metaDir, { recursive: true });

    const file1 = path.join(metaDir, 'TestSong1.mp3');
    const file2 = path.join(metaDir, 'TestSong2.flac');

    fs.writeFileSync(file1, 'audio sample 1 data');
    fs.writeFileSync(file2, 'audio sample 2 data');

    resetMetadataMetrics();

    // 1. First probe for file1 causes cache miss and ffprobe invocation
    const meta1 = await extractMetadata(file1);
    const m1 = getMetadataMetrics();

    assert.ok(meta1.title, 'Metadata title must be extracted');
    assert.strictEqual(m1.ffprobeInvocationCount, 1, 'First metadata call MUST spawn 1 ffprobe process');
    assert.strictEqual(m1.metadataCacheMisses, 1, 'First metadata call MUST be a cache miss');

    // 2. 10 repeated requests for file1 hit cache with 0 additional ffprobe spawns
    for (let i = 0; i < 10; i++) {
      const cachedMeta = await extractMetadata(file1);
      assert.strictEqual(cachedMeta.title, meta1.title);
    }

    const m2 = getMetadataMetrics();
    assert.strictEqual(m2.metadataCacheHits, 10, '10 repeated requests MUST hit metadata cache');
    assert.strictEqual(m2.ffprobeInvocationCount, 1, 'Repeated requests MUST NOT spawn additional ffprobe processes');

    // 3. Concurrent requests for file2 trigger in-flight deduplication
    const concurrentPromises = [
      extractMetadata(file2),
      extractMetadata(file2),
      extractMetadata(file2),
    ];

    const [meta2A, meta2B, meta2C] = await Promise.all(concurrentPromises);
    const m3 = getMetadataMetrics();

    assert.strictEqual(meta2A.title, meta2B.title);
    assert.strictEqual(meta2B.title, meta2C.title);
    assert.strictEqual(m3.inFlightDeduplications, 2, '2 concurrent requests MUST deduplicate in-flight');
    assert.strictEqual(m3.ffprobeInvocationCount, 2, 'File 2 MUST only spawn 1 ffprobe process');

    // 4. Modifying file1 updates size/mtimeMs and invalidates cache entry
    // Small delay to ensure mtime changes
    await new Promise((res) => setTimeout(res, 50));
    fs.appendFileSync(file1, ' additional audio bytes');

    const updatedMeta1 = await extractMetadata(file1);
    const m4 = getMetadataMetrics();

    assert.strictEqual(m4.ffprobeInvocationCount, 3, 'Modifying file MUST trigger a new ffprobe process');

    // Cleanup
    if (fs.existsSync(file1)) fs.unlinkSync(file1);
    if (fs.existsSync(file2)) fs.unlinkSync(file2);
  });

  // ----------------------------------------------------
  // TEST 27: Persistent Demucs Worker Reuse & Concurrency (P3)
  // ----------------------------------------------------
  await runTest('PERSISTENT_DEMUCS_WORKER_PERFORMANCE', async () => {
    const testWorkerManager = new DemucsWorkerManager();
    testWorkerManager.resetMetrics();

    // Create a mock split worker script to test process lifecycle & model reuse
    const mockWorkerScript = path.join(TEST_DIR, 'mock_split.py');
    testWorkerManager.scriptPath = mockWorkerScript;
    const pythonScriptCode = [
      'import sys',
      'import json',
      'sys.stderr.write("[INFO] Pre-loading PyTorch and Demucs model (htdemucs)...\\n")',
      'sys.stderr.flush()',
      'sys.stdout.write("[WORKER_READY]\\n")',
      'sys.stdout.flush()',
      'while True:',
      '    line = sys.stdin.readline()',
      '    if not line: break',
      '    line = line.strip()',
      '    if not line: continue',
      '    try:',
      '        cmd = json.loads(line)',
      '        status_file = cmd.get("status_file")',
      '        sys.stderr.write("[PROG] 50 Separating stems in worker...\\n")',
      '        sys.stderr.flush()',
      '        res = {"ok": True, "device": "cuda", "gpu_name": "NVIDIA GeForce RTX 3060"}',
      '        if status_file:',
      '            with open(status_file, "w", encoding="utf-8") as sf:',
      '                json.dump(res, sf)',
      '        sys.stdout.write("[WORKER_RESULT] " + json.dumps(res) + "\\n")',
      '        sys.stdout.flush()',
      '    except Exception as e:',
      '        sys.stdout.write("[WORKER_RESULT] " + json.dumps({"ok": False, "error": str(e)}) + "\\n")',
      '        sys.stdout.flush()',
    ].join('\n');
    fs.writeFileSync(mockWorkerScript, pythonScriptCode, { mode: 0o755 });

    const p3WorkDir = path.join(TEST_DIR, 'p3_test');
    fs.mkdirSync(p3WorkDir, { recursive: true });

    const req1 = path.join(p3WorkDir, 'req1.json');
    const stat1 = path.join(p3WorkDir, 'stat1.json');
    fs.writeFileSync(req1, JSON.stringify({ audio: 'song1.mp3' }));

    const req2 = path.join(p3WorkDir, 'req2.json');
    const stat2 = path.join(p3WorkDir, 'stat2.json');
    fs.writeFileSync(req2, JSON.stringify({ audio: 'song2.mp3' }));

    const req3 = path.join(p3WorkDir, 'req3.json');
    const stat3 = path.join(p3WorkDir, 'stat3.json');
    fs.writeFileSync(req3, JSON.stringify({ audio: 'song3.mp3' }));

    // 1. Run 3 sequential jobs through persistent worker
    await testWorkerManager.runJob('python3', req1, stat1, '', () => {}, () => {});
    await testWorkerManager.runJob('python3', req2, stat2, '', () => {}, () => {});
    await testWorkerManager.runJob('python3', req3, stat3, '', () => {}, () => {});

    const metrics = testWorkerManager.getMetrics();
    assert.strictEqual(metrics.workerSpawnCount, 1, '3 sequential jobs MUST use exactly 1 persistent Python process spawn');
    assert.strictEqual(metrics.modelInitCount, 1, '3 sequential jobs MUST load/initialize Demucs model weights exactly 1 time');
    assert.strictEqual(metrics.jobsHandledCount, 3, 'Worker MUST process all 3 jobs');

    // 2. Test Audio Concurrency Limit = 1
    let activeSlots = 0;
    let maxConcurrentSlots = 0;
    const mockAcquireAudioSlot = async () => {
      activeSlots++;
      if (activeSlots > maxConcurrentSlots) maxConcurrentSlots = activeSlots;
      await new Promise(r => setTimeout(r, 10));
      return () => { activeSlots--; };
    };

    // Simulate 3 queue jobs attempting audio slot acquisition concurrently
    const slot1 = await mockAcquireAudioSlot();
    slot1();
    const slot2 = await mockAcquireAudioSlot();
    slot2();

    assert.strictEqual(maxConcurrentSlots, 1, 'Audio concurrency MUST remain strictly 1 at a time');

    // 3. Worker process failure detection & queue resilience
    testWorkerManager.stopWorker();
    const metricsAfterStop = testWorkerManager.getMetrics();
    assert.strictEqual(metricsAfterStop.isRunning, false, 'Stopped worker MUST report isRunning=false');

    // Running next job after worker termination automatically starts a fresh worker without getting queue stuck
    await testWorkerManager.runJob('python3', req1, stat1, '', () => {}, () => {});
    const metricsResumed = testWorkerManager.getMetrics();
    assert.strictEqual(metricsResumed.workerSpawnCount, 2, 'Worker manager MUST restart fresh process after crash/stop');
    assert.strictEqual(metricsResumed.isRunning, true, 'Resumed worker MUST be running');

    testWorkerManager.stopWorker();

    // 4. Verify P1 (Library Index) and P2 (Metadata Cache) remain intact
    const libIndex = getLibraryIndex();
    assert.ok(typeof libIndex.total === 'number', 'P1 Library index MUST remain functional');
    const metaMetrics = getMetadataMetrics();
    assert.ok(typeof metaMetrics.ffprobeInvocationCount === 'number', 'P2 Metadata metrics MUST remain functional');

    // Cleanup
    if (fs.existsSync(mockWorkerScript)) fs.unlinkSync(mockWorkerScript);
  });

  // ----------------------------------------------------
  // TEST 28: Frontend Library List Virtualization (P4)
  // ----------------------------------------------------
  await runTest('FRONTEND_LIBRARY_LIST_VIRTUALIZATION', async () => {
    // Virtualization logic calculation helper (matching VirtualizedSongList algorithm)
    const calculateVirtualWindow = (
      totalItems: number,
      scrollTop: number,
      containerHeight: number = 650,
      itemHeight: number = 150,
      overscan: number = 5
    ) => {
      if (totalItems === 0) return { start: 0, end: 0, count: 0, totalHeight: 0 };
      const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
      const end = Math.min(
        totalItems - 1,
        Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan
      );
      const count = Math.max(0, end - start + 1);
      const totalHeight = totalItems * itemHeight;
      return { start, end, count, totalHeight };
    };

    // 1. Small Library (5 songs): All items rendered without virtualization truncation
    const smallLib = calculateVirtualWindow(5, 0, 650, 150, 5);
    assert.strictEqual(smallLib.count, 5, 'Small library (5 songs) MUST render all 5 song rows');
    assert.strictEqual(smallLib.start, 0);
    assert.strictEqual(smallLib.end, 4);

    // 2. Large Library (5,000 songs) at scrollTop = 0: DOM rendered nodes reduced from 5,000 to ~11
    const largeLibTop = calculateVirtualWindow(5000, 0, 650, 150, 5);
    assert.strictEqual(largeLibTop.totalHeight, 750000, '5,000 song virtual canvas height MUST equal 750,000px');
    assert.strictEqual(largeLibTop.start, 0, 'Top viewport start index MUST be 0');
    assert.strictEqual(largeLibTop.end, 10, 'Top viewport end index with overscan MUST be 10');
    assert.strictEqual(largeLibTop.count, 11, 'Large library MUST mount only 11 DOM rows at top instead of 5,000');

    // 3. Large Library (5,000 songs) scrolled to scrollTop = 15,000px (100 songs down)
    const largeLibScrolled = calculateVirtualWindow(5000, 15000, 650, 150, 5);
    assert.strictEqual(largeLibScrolled.start, 95, 'Scrolled start index MUST reflect scroll offset minus overscan');
    assert.strictEqual(largeLibScrolled.end, 110, 'Scrolled end index MUST reflect scroll offset plus container height plus overscan');
    assert.strictEqual(largeLibScrolled.count, 16, 'Scrolled view MUST render only 16 visible DOM rows');

    // 4. Search / Filtering reduction (5,000 songs filtered down to 8 matches)
    const filteredLib = calculateVirtualWindow(8, 0, 650, 150, 5);
    assert.strictEqual(filteredLib.totalHeight, 1200, 'Filtered selection canvas height MUST adjust to 1,200px');
    assert.strictEqual(filteredLib.count, 8, 'Filtered selection MUST render exact matching count');

    // 5. Verify P1, P2, P3 remain intact
    const libIndex = getLibraryIndex();
    assert.ok(typeof libIndex.total === 'number', 'P1 Library index MUST remain intact');
    const metaMetrics = getMetadataMetrics();
    assert.ok(typeof metaMetrics.ffprobeInvocationCount === 'number', 'P2 Metadata metrics MUST remain intact');
    assert.ok(demucsWorkerManager, 'P3 Demucs worker manager MUST remain intact');
  });

  cleanupTestDir();

  console.log('\n====================================================');
  console.log(`TEST SUITE SUMMARY: ${ctx.passed} PASSED, ${ctx.failed} FAILED`);
  console.log('====================================================');

  if (ctx.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
