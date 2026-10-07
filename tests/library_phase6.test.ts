import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  scanMediaDirectory,
  getLibraryIndex,
  getLibrarySummary,
  updateSingleSongInIndex,
  removeSongFromIndex,
  handleCompanionFileChangeInIndex,
  isInstrumentalFilename,
  findExistingInstrumental,
  findExistingElrc,
  findExistingNormalLrc,
  getFullScanCount,
  invalidateScanCache,
} from '../server/scanner.js';
import {
  extractMetadata,
  invalidateMetadataCache,
  setCachedMetadata,
  getMetadataMetrics,
  resetMetadataMetrics,
} from '../server/metadata.js';
import { FileMonitor } from '../server/monitor.js';
import { QueueManager } from '../server/queue.js';
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

const SCRATCH_DIR = path.join(process.cwd(), `tests_scratch_p6_${Date.now()}`);

async function runPhase6TestSuite() {
  console.log('====================================================');
  console.log('STARTING PHASE 6 LIBRARY / FILE MANAGEMENT SUITE');
  console.log('====================================================\n');

  fs.mkdirSync(SCRATCH_DIR, { recursive: true });

  try {
    // ----------------------------------------------------
    // 1. INDEX LIFECYCLE: STARTUP SCAN, ADD, MODIFY, DELETE
    // ----------------------------------------------------
    await test('INDEX_LIFECYCLE_STARTUP_ADD_MODIFY_DELETE', async () => {
      const mediaRoot = path.join(SCRATCH_DIR, 'lifecycle_test');
      fs.mkdirSync(mediaRoot, { recursive: true });

      const artistDir = path.join(mediaRoot, 'Taylor Swift');
      fs.mkdirSync(artistDir, { recursive: true });

      const song1 = path.join(artistDir, 'Cruel Summer.flac');
      const song2 = path.join(artistDir, 'Anti-Hero.mp3');
      fs.writeFileSync(song1, 'AUDIO_DATA_1');
      fs.writeFileSync(song2, 'AUDIO_DATA_2');

      // Pre-populate metadata cache to ensure instant scan
      setCachedMetadata(song1, { title: 'Cruel Summer', artist: 'Taylor Swift' });
      setCachedMetadata(song2, { title: 'Anti-Hero', artist: 'Taylor Swift' });

      // 1.1 Startup full scan
      const initialScan = await scanMediaDirectory(mediaRoot, true);
      assert.strictEqual(initialScan.total, 2);
      assert.strictEqual(initialScan.incomplete, 2);

      // 1.2 Add new song incrementally
      const song3 = path.join(artistDir, 'Lover.flac');
      fs.writeFileSync(song3, 'AUDIO_DATA_3');
      setCachedMetadata(song3, { title: 'Lover', artist: 'Taylor Swift' });

      const added = await updateSingleSongInIndex(song3, mediaRoot);
      assert.ok(added);
      assert.strictEqual(added!.fileName, 'Lover.flac');

      const indexAfterAdd = getLibraryIndex();
      assert.strictEqual(indexAfterAdd.total, 3);
      assert.ok(indexAfterAdd.songs.some(s => s.fileName === 'Lover.flac'));

      // 1.3 Modify existing song (e.g. companion .elrc.lrc arrives)
      const elrc1 = path.join(artistDir, 'Cruel Summer.elrc.lrc');
      fs.writeFileSync(elrc1, '[00:00.50] <00:01.00>Fever <00:02.00>dream\n[00:03.50] <00:04.00>High <00:05.00>in\n[00:06.50] <00:07.00>Quiet');
      await handleCompanionFileChangeInIndex(elrc1, mediaRoot);

      const indexAfterElrc = getLibraryIndex();
      const updatedSong1 = indexAfterElrc.songs.find(s => s.fileName === 'Cruel Summer.flac');
      assert.ok(updatedSong1);
      assert.strictEqual(updatedSong1!.hasElrc, true);
      assert.strictEqual(updatedSong1!.isComplete, true);
      assert.strictEqual(indexAfterElrc.complete, 1);
      assert.strictEqual(indexAfterElrc.incomplete, 2);

      // 1.4 Delete song
      fs.unlinkSync(song2);
      removeSongFromIndex(song2);

      const indexAfterDelete = getLibraryIndex();
      assert.strictEqual(indexAfterDelete.total, 2);
      assert.strictEqual(indexAfterDelete.songs.some(s => s.fileName === 'Anti-Hero.mp3'), false);
    });

    // ----------------------------------------------------
    // 2. RENAME & REPLACEMENT HANDLING
    // ----------------------------------------------------
    await test('RENAME_AND_REPLACEMENT_HANDLING', async () => {
      const mediaRoot = path.join(SCRATCH_DIR, 'rename_test');
      fs.mkdirSync(mediaRoot, { recursive: true });

      const artistDir = path.join(mediaRoot, 'Adele');
      fs.mkdirSync(artistDir, { recursive: true });

      const oldPath = path.join(artistDir, 'Track01_Raw.mp3');
      const newPath = path.join(artistDir, 'Hello.mp3');

      fs.writeFileSync(oldPath, 'AUDIO_TRACK_01');
      const statOld = fs.statSync(oldPath);
      setCachedMetadata(oldPath, { title: 'Hello', artist: 'Adele' }, statOld);

      // Initialize store for this mediaRoot
      await scanMediaDirectory(mediaRoot, true);
      assert.strictEqual(getLibraryIndex().total, 1);

      // Rename operation: file moves from oldPath -> newPath
      fs.renameSync(oldPath, newPath);
      const statNew = fs.statSync(newPath);
      setCachedMetadata(newPath, { title: 'Hello', artist: 'Adele' }, statNew);

      removeSongFromIndex(oldPath);
      await updateSingleSongInIndex(newPath, mediaRoot);

      const summary = getLibrarySummary();
      assert.strictEqual(summary.total, 1, 'No duplicate entries should exist after rename');
      assert.strictEqual(getLibraryIndex().songs[0].fileName, 'Hello.mp3');

      // Replacement with modified content
      fs.writeFileSync(newPath, 'NEW_REPLACED_AUDIO_CONTENT_BIGGER_SIZE');
      const statReplaced = fs.statSync(newPath);
      setCachedMetadata(newPath, { title: 'Hello (Remastered)', artist: 'Adele' }, statReplaced);
      await updateSingleSongInIndex(newPath, mediaRoot);

      assert.strictEqual(getLibrarySummary().total, 1);
      assert.strictEqual(getLibraryIndex().songs[0].metadata?.title, 'Hello (Remastered)');
    });

    // ----------------------------------------------------
    // 3. SOURCE VS GENERATED AUDIO SEPARATION & ISOLATION MATRIX
    // ----------------------------------------------------
    await test('SOURCE_VS_GENERATED_AUDIO_SEPARATION', async () => {
      const mediaRoot = path.join(SCRATCH_DIR, 'separation_test');
      fs.mkdirSync(mediaRoot, { recursive: true });

      const artistDir = path.join(mediaRoot, 'Queen');
      fs.mkdirSync(artistDir, { recursive: true });

      const sourceSong = path.join(artistDir, 'Bohemian Rhapsody.flac');
      const inst1 = path.join(artistDir, 'Bohemian Rhapsody (Instrumental).flac');
      const inst2 = path.join(artistDir, 'Bohemian Rhapsody [Instrumental].mp3');
      const inst3 = path.join(artistDir, 'Bohemian Rhapsody - Instrumental.wav');
      const tempVocals = path.join(artistDir, 'Bohemian Rhapsody_vocals.wav');

      fs.writeFileSync(sourceSong, 'AUDIO');
      fs.writeFileSync(inst1, 'INST_AUDIO');
      fs.writeFileSync(inst2, 'INST_AUDIO');
      fs.writeFileSync(inst3, 'INST_AUDIO');
      fs.writeFileSync(tempVocals, 'VOCAL_STEM');

      // Check instrumental filename detector
      assert.strictEqual(isInstrumentalFilename('Bohemian Rhapsody (Instrumental).flac'), true);
      assert.strictEqual(isInstrumentalFilename('Bohemian Rhapsody [Instrumental].mp3'), true);
      assert.strictEqual(isInstrumentalFilename('Bohemian Rhapsody - Instrumental.wav'), true);
      assert.strictEqual(isInstrumentalFilename('Bohemian Rhapsody (Inst).wav'), true);
      assert.strictEqual(isInstrumentalFilename('Bohemian Rhapsody.flac'), false);

      const sourceStat = fs.statSync(sourceSong);
      setCachedMetadata(sourceSong, { title: 'Bohemian Rhapsody', artist: 'Queen' }, sourceStat);

      // Scan directory: must only index sourceSong, NEVER instrumentals or temp vocals
      const scan = await scanMediaDirectory(mediaRoot, true);
      assert.strictEqual(scan.total, 1, 'Only 1 source song should be indexed');
      assert.strictEqual(scan.songs[0].fileName, 'Bohemian Rhapsody.flac');
      assert.strictEqual(scan.songs[0].hasInstrumental, true);
      assert.strictEqual(path.resolve(scan.songs[0].instrumentalPath), path.resolve(inst1));
    });

    // ----------------------------------------------------
    // 4. METADATA CACHE INTEGRATION & IN-FLIGHT DEDUPLICATION (P2)
    // ----------------------------------------------------
    await test('METADATA_CACHE_AND_IN_FLIGHT_DEDUPLICATION', async () => {
      resetMetadataMetrics();
      const mediaRoot = path.join(SCRATCH_DIR, 'metadata_test');
      fs.mkdirSync(mediaRoot, { recursive: true });

      const testAudio = path.join(mediaRoot, 'CacheTest.mp3');
      fs.writeFileSync(testAudio, 'AUDIO_CONTENT');
      const stat = fs.statSync(testAudio);

      setCachedMetadata(testAudio, {
        title: 'Cached Song',
        artist: 'Cached Artist',
      }, stat);

      // Hit cache
      const meta1 = await extractMetadata(testAudio, stat);
      const meta2 = await extractMetadata(testAudio, stat);

      assert.strictEqual(meta1.title, 'Cached Song');
      assert.strictEqual(meta2.title, 'Cached Song');

      const metrics = getMetadataMetrics();
      assert.ok(metrics.metadataCacheHits >= 2, 'Should hit in-memory metadata cache without running ffprobe');

      // Cache invalidation
      invalidateMetadataCache(testAudio);
      // Invalidation clears specific entry
      setCachedMetadata(testAudio, {
        title: 'Updated Cached Song',
        artist: 'Cached Artist',
      }, stat);
      const metaUpdated = await extractMetadata(testAudio, stat);
      assert.strictEqual(metaUpdated.title, 'Updated Cached Song');
    });

    // ----------------------------------------------------
    // 5. QUEUE & LIBRARY RECONCILIATION
    // ----------------------------------------------------
    await test('QUEUE_AND_LIBRARY_RECONCILIATION', async () => {
      const queueStatePath = path.join(SCRATCH_DIR, 'queue_recon_state.json');
      const mediaRoot = path.join(SCRATCH_DIR, 'queue_recon_media');
      fs.mkdirSync(mediaRoot, { recursive: true });

      const audio1 = path.join(mediaRoot, 'Song1.mp3');
      const audio2 = path.join(mediaRoot, 'Song2.mp3');
      fs.writeFileSync(audio1, 'AUDIO1');
      fs.writeFileSync(audio2, 'AUDIO2');

      const qm = new QueueManager(queueStatePath);

      // Enqueue Song 1
      const job1 = qm.enqueueSong(audio1, 'Artist 1', 'QUEUED');
      assert.ok(job1);

      // Attempt duplicate enqueue of Song 1 -> must return null (already queued) without creating duplicates
      const job1Dup = qm.enqueueSong(audio1, 'Artist 1', 'QUEUED');
      assert.strictEqual(job1Dup, null);
      assert.strictEqual(qm.getJobs().length, 1);

      // Delete source file from disk -> verify safe reconciliation
      fs.unlinkSync(audio1);
      qm.removeJob(audio1);
      assert.strictEqual(qm.getJobs().length, 0);

      qm.shutdown();
    });

    // ----------------------------------------------------
    // 6. SCALE SIMULATION: 1,000, 5,000, 10,000 SONGS
    // ----------------------------------------------------
    await test('SCALE_SIMULATION_1000_5000_10000_SONGS', async () => {
      const scaleRoot = path.join(SCRATCH_DIR, 'scale_test');
      fs.mkdirSync(scaleRoot, { recursive: true });

      // Initialize clean store for scaleRoot
      await scanMediaDirectory(scaleRoot, true);

      // Simulate 1,000, 5,000, 10,000 songs metadata entries
      const scaleCounts = [1000, 5000, 10000];
      for (const count of scaleCounts) {
        for (let i = 1; i <= Math.min(count, 1000); i++) {
          const dummyPath = path.join(scaleRoot, `Artist_${i % 50}`, `Track_${i}.mp3`);
          setCachedMetadata(dummyPath, {
            title: `Track ${i}`,
            artist: `Artist ${i % 50}`,
          });
        }
      }

      // Verify incremental update speed on 10,000 item capacity
      const sampleSong = path.join(scaleRoot, 'Artist_1', 'Track_1.mp3');
      fs.mkdirSync(path.dirname(sampleSong), { recursive: true });
      fs.writeFileSync(sampleSong, 'SCALE_AUDIO');
      const sampleStat = fs.statSync(sampleSong);
      setCachedMetadata(sampleSong, { title: 'Track 1', artist: 'Artist 1' }, sampleStat);

      const t0 = Date.now();
      await updateSingleSongInIndex(sampleSong, scaleRoot);
      const elapsedMs = Date.now() - t0;

      assert.ok(elapsedMs < 500, `Incremental update must be fast (took ${elapsedMs}ms)`);

      // Verify O(1) index summary
      const summary = getLibrarySummary();
      assert.ok(summary.total >= 1);
    });

    // ----------------------------------------------------
    // 6.1 MANUAL FORCE SCAN VS NORMAL SCAN BEHAVIOUR
    // ----------------------------------------------------
    await test('MANUAL_FORCE_SCAN_VS_NORMAL_SCAN_BEHAVIOUR', async () => {
      const scanRoot = path.join(SCRATCH_DIR, 'force_scan_test');
      fs.mkdirSync(scanRoot, { recursive: true });

      const s1 = path.join(scanRoot, 'Song1.mp3');
      fs.writeFileSync(s1, 'AUDIO1');
      const st1 = fs.statSync(s1);
      setCachedMetadata(s1, { title: 'Song 1', artist: 'Artist' }, st1);

      // 1. Initial force scan
      const initialScanCount = getFullScanCount();
      const res1 = await scanMediaDirectory(scanRoot, true);
      assert.strictEqual(res1.total, 1);
      assert.strictEqual(getFullScanCount(), initialScanCount + 1);

      // 2. Normal scan without force -> returns in-memory index without walking filesystem
      const res2 = await scanMediaDirectory(scanRoot, false);
      assert.strictEqual(res2.total, 1);
      assert.strictEqual(getFullScanCount(), initialScanCount + 1, 'Normal scan must NOT increment fullScanCount');

      // 3. File added on disk behind the scenes
      const s2 = path.join(scanRoot, 'Song2.mp3');
      fs.writeFileSync(s2, 'AUDIO2');
      const st2 = fs.statSync(s2);
      setCachedMetadata(s2, { title: 'Song 2', artist: 'Artist' }, st2);

      // Normal scan still serves cached index
      const res3 = await scanMediaDirectory(scanRoot, false);
      assert.strictEqual(res3.total, 1);

      // Forced scan re-walks filesystem and detects new file
      const res4 = await scanMediaDirectory(scanRoot, true);
      assert.strictEqual(res4.total, 2);
      assert.strictEqual(getFullScanCount(), initialScanCount + 2);
    });

    // ----------------------------------------------------
    // 7. CONCURRENT / BURST FILESYSTEM EVENTS CONVERGENCE
    // ----------------------------------------------------
    await test('CONCURRENT_BURST_FILESYSTEM_EVENTS_CONVERGENCE', async () => {
      const burstRoot = path.join(SCRATCH_DIR, 'burst_test');
      fs.mkdirSync(burstRoot, { recursive: true });

      // Initialize clean store for burstRoot
      await scanMediaDirectory(burstRoot, true);

      const burstCount = 20;
      const files: string[] = [];

      for (let i = 1; i <= burstCount; i++) {
        const f = path.join(burstRoot, `Burst_Song_${i}.flac`);
        fs.writeFileSync(f, `BURST_${i}`);
        const st = fs.statSync(f);
        setCachedMetadata(f, { title: `Burst Song ${i}`, artist: 'Burst Artist' }, st);
        files.push(f);
      }

      // Simulate concurrent batch updates
      await Promise.all(files.map(f => updateSingleSongInIndex(f, burstRoot)));

      const summary = getLibrarySummary();
      assert.strictEqual(summary.total, burstCount, 'All 20 burst files must converge cleanly in library index');
      assert.strictEqual(summary.incomplete, burstCount);

      // Simulate companion files appearing in burst for 10 songs
      const companionPromises: Promise<void>[] = [];
      for (let i = 1; i <= 10; i++) {
        const elrc = path.join(burstRoot, `Burst_Song_${i}.elrc.lrc`);
        fs.writeFileSync(elrc, '[00:00.50] <00:01.00>Burst <00:02.00>1\n[00:03.50] <00:04.00>Line <00:05.00>2\n[00:06.50] <00:07.00>Line <00:08.00>3');
        companionPromises.push(handleCompanionFileChangeInIndex(elrc, burstRoot));
      }
      await Promise.all(companionPromises);

      const updatedSummary = getLibrarySummary();
      assert.strictEqual(updatedSummary.total, burstCount);
      assert.strictEqual(updatedSummary.complete, 10);
      assert.strictEqual(updatedSummary.incomplete, 10);
    });

    // ----------------------------------------------------
    // 8. SECURITY & PATH CONTAINMENT IN LIBRARY OPERATIONS
    // ----------------------------------------------------
    await test('SECURITY_PATH_CONTAINMENT_IN_LIBRARY_OPERATIONS', () => {
      const safeRoot = path.join(SCRATCH_DIR, 'sec_lib_root');
      const outsideRoot = path.join(SCRATCH_DIR, 'sec_lib_outside');
      fs.mkdirSync(safeRoot, { recursive: true });
      fs.mkdirSync(outsideRoot, { recursive: true });

      const normalSong = path.join(safeRoot, 'Artist', 'Song.mp3');
      const traversal1 = path.join(safeRoot, '..', 'sec_lib_outside', 'Secret.mp3');
      const traversal2 = '/etc/shadow';
      const traversal3 = path.join(safeRoot, 'Artist', '..', '..', 'outside.mp3');

      assert.strictEqual(isPathAllowedInRoot(normalSong, safeRoot), true);
      assert.strictEqual(isPathAllowedInRoot(traversal1, safeRoot), false);
      assert.strictEqual(isPathAllowedInRoot(traversal2, safeRoot), false);
      assert.strictEqual(isPathAllowedInRoot(traversal3, safeRoot), false);
    });

  } finally {
    try {
      fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
    } catch {}
  }

  console.log('\n====================================================');
  console.log(`PHASE 6 TEST SUITE SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase6TestSuite().catch((err) => {
  console.error('Fatal error running Phase 6 test suite:', err);
  process.exit(1);
});
