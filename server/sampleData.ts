import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { getSettings } from './config.js';

export async function ensureSampleLibrary(): Promise<void> {
  const settings = getSettings();
  const mediaRoot = settings.mediaRoot;

  try {
    if (!fs.existsSync(mediaRoot)) {
      fs.mkdirSync(mediaRoot, { recursive: true });
    }

    // Check if mediaRoot has any audio files
    const entries = fs.readdirSync(mediaRoot);
    if (entries.length > 0) {
      return; // Already populated
    }

    console.log('[Sample Library] Generating realistic sample music library for demonstration...');

    // 1. Adele - Hello (Incomplete: has normal .lrc, missing instrumental & .elrc.lrc)
    const adeleDir = path.join(mediaRoot, 'Adele');
    fs.mkdirSync(adeleDir, { recursive: true });
    createSampleAudio(path.join(adeleDir, 'Hello.flac'), 'Hello', 'Adele', '25', 8);
    fs.writeFileSync(
      path.join(adeleDir, 'Hello.lrc'),
      `[ti:Hello]\n[ar:Adele]\n[al:25]\n[00:00.00]Hello, it's me\n[00:02.50]I was wondering if after all these years you'd like to meet\n[00:06.00]To go over everything\n[00:08.50]They say that time's supposed to heal ya`,
      'utf-8'
    );

    // 2. ABBA - Dancing Queen (Incomplete: has instrumental, missing .elrc.lrc)
    const abbaDir = path.join(mediaRoot, 'ABBA');
    fs.mkdirSync(abbaDir, { recursive: true });
    createSampleAudio(path.join(abbaDir, 'Dancing Queen.mp3'), 'Dancing Queen', 'ABBA', 'Arrival', 6);
    createSampleAudio(path.join(abbaDir, 'Dancing Queen (Instrumental).mp3'), 'Dancing Queen (Instrumental)', 'ABBA', 'Arrival', 6);
    fs.writeFileSync(
      path.join(abbaDir, 'Dancing Queen.txt'),
      `You can dance, you can jive\nHaving the time of your life\nSee that girl, watch that scene\nDigging the dancing queen`,
      'utf-8'
    );

    // 3. Lady Gaga - Poker Face (Incomplete: fresh song, needs both)
    const gagaDir = path.join(mediaRoot, 'Lady Gaga');
    fs.mkdirSync(gagaDir, { recursive: true });
    createSampleAudio(path.join(gagaDir, 'Poker Face.flac'), 'Poker Face', 'Lady Gaga', 'The Fame', 7);
    fs.writeFileSync(
      path.join(gagaDir, 'Poker Face.lrc'),
      `[00:00.00]Mum mum mum mah\n[00:02.00]I wanna hold 'em like they do in Texas, please\n[00:04.50]Fold 'em, let 'em hit me, raise it, baby, stay with me`,
      'utf-8'
    );

    // 4. Queen - Bohemian Rhapsody (COMPLETE: has original, (Instrumental), and .elrc.lrc)
    const queenDir = path.join(mediaRoot, 'Queen');
    fs.mkdirSync(queenDir, { recursive: true });
    createSampleAudio(path.join(queenDir, 'Bohemian Rhapsody.flac'), 'Bohemian Rhapsody', 'Queen', 'A Night at the Opera', 6);
    createSampleAudio(path.join(queenDir, 'Bohemian Rhapsody (Instrumental).flac'), 'Bohemian Rhapsody (Instrumental)', 'Queen', 'A Night at the Opera', 6);
    fs.writeFileSync(
      path.join(queenDir, 'Bohemian Rhapsody.elrc.lrc'),
      `[ti:Bohemian Rhapsody]\n[ar:Queen]\n[al:A Night at the Opera]\n[by:Yimly Sync]\n[re:Yimly Sync (forced-alignment)]\n\n[00:00.00] <00:00.00>Is <00:00.40>this <00:00.80>the <00:01.10>real <00:01.50>life? <00:02.00>\n[00:02.10] <00:02.10>Is <00:02.50>this <00:02.90>just <00:03.20>fantasy? <00:04.00>`,
      'utf-8'
    );

    console.log('[Sample Library] Sample music library initialized successfully.');
  } catch (err) {
    console.error('[Sample Library] Error creating sample files:', err);
  }
}

function createSampleAudio(targetPath: string, title: string, artist: string, album: string, durationSec: number = 6) {
  try {
    const ext = path.extname(targetPath).toLowerCase();
    const codec = ext === '.mp3' ? '-c:a libmp3lame -b:a 320k' : (ext === '.flac' ? '-c:a flac' : '-c:a pcm_s16le');
    // Generates a clean synth acoustic chord progression using ffmpeg sine filters
    const filter = `sine=frequency=440:duration=${durationSec}[s1];sine=frequency=554:duration=${durationSec}[s2];sine=frequency=659:duration=${durationSec}[s3];[s1][s2][s3]amix=inputs=3:duration=first[a]`;
    
    execSync(
      `ffmpeg -y -f lavfi -i "${filter}" -map "[a]" ${codec} -metadata title="${title}" -metadata artist="${artist}" -metadata album="${album}" "${targetPath}" 2>/dev/null`,
      { timeout: 8000 }
    );
  } catch (e) {
    // If ffmpeg fails, write small dummy file
    try {
      fs.writeFileSync(targetPath, Buffer.alloc(1024, 0));
    } catch {}
  }
}
