import fs from 'fs';
import path from 'path';
import os from 'os';
import { AppSettings } from '../src/types.js';

const SETTINGS_FILE = path.join(process.cwd(), 'yimly_settings.json');

export function getAppPythonPath(): string {
  if (process.platform === 'win32') {
    return path.join(process.cwd(), 'python_env', 'Scripts', 'python.exe');
  }
  const localVenvPython = path.join(process.cwd(), 'python_env', 'bin', 'python');
  if (fs.existsSync(localVenvPython)) {
    return localVenvPython;
  }
  return 'python3';
}

export function getSplitScriptPath(): string {
  return path.join(process.cwd(), 'split.py');
}

export function getAlignScriptPath(): string {
  return path.join(process.cwd(), 'align.py');
}

export function getModelsDir(): string {
  return path.join(process.cwd(), 'models');
}

export function sanitizeLeadInMs(val: any): number {
  const num = typeof val === 'number' ? val : (typeof val === 'string' ? parseInt(val, 10) : NaN);
  if (isNaN(num) || !isFinite(num)) {
    return 500;
  }
  return Math.max(0, Math.min(5000, Math.round(num)));
}

export const defaultSettings: AppSettings = {
  mediaRoot: path.join(process.cwd(), 'media'),
  modelsDir: getModelsDir(),
  pythonPath: getAppPythonPath(),
  splitScriptPath: getSplitScriptPath(),
  isConfigured: false,
  useGpu: true,
  demucs: {
    model: 'htdemucs',
    stems: 'vocals',
    format: 'flac',
    mp3Bitrate: 320,
    shifts: 1,
    overlap: 0.25,
    useGpu: true,
  },
  lyrics: {
    fetchElrc: true,
    fetchLrc: true,
    overwriteExisting: false,
    elrcLineLeadInMs: 500,
  },
  ffmpegPath: 'ffmpeg',
  tempDir: path.join(os.tmpdir(), 'yimly_sync_temp'),
  autoStartMonitoring: true,
  fileStabilityDelayMs: 2000,
};

let currentSettings: AppSettings = { ...defaultSettings };

export function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const parsed = JSON.parse(data);

      let mediaRoot = parsed.mediaRoot;
      if (!mediaRoot || (typeof mediaRoot === 'string' && !fs.existsSync(mediaRoot))) {
        mediaRoot = path.join(process.cwd(), 'media');
      }

      const parsedLyrics = parsed.lyrics || {};
      const leadInMs = sanitizeLeadInMs(parsedLyrics.elrcLineLeadInMs ?? (parsed as any).elrcLineLeadInMs ?? 500);

      currentSettings = {
        ...defaultSettings,
        ...parsed,
        mediaRoot: mediaRoot || defaultSettings.mediaRoot,
        pythonPath: getAppPythonPath(),
        splitScriptPath: getSplitScriptPath(),
        modelsDir: parsed.modelsDir && fs.existsSync(parsed.modelsDir) ? parsed.modelsDir : getModelsDir(),
        demucs: { ...defaultSettings.demucs, ...(parsed.demucs || {}) },
        lyrics: {
          ...defaultSettings.lyrics,
          ...parsedLyrics,
          elrcLineLeadInMs: leadInMs,
        },
      };
    } else {
      currentSettings = { ...defaultSettings };
      saveSettings(currentSettings);
    }
  } catch (err) {
    console.error('Error loading settings:', err);
    currentSettings = { ...defaultSettings };
  }
  return currentSettings;
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
  try {
    const incomingLyrics = settings.lyrics || {};
    const leadInMs = sanitizeLeadInMs(
      (incomingLyrics as any).elrcLineLeadInMs ?? (settings as any).elrcLineLeadInMs ?? currentSettings.lyrics?.elrcLineLeadInMs ?? 500
    );

    currentSettings = {
      ...currentSettings,
      ...settings,
      pythonPath: getAppPythonPath(),
      splitScriptPath: getSplitScriptPath(),
      modelsDir: settings.modelsDir || getModelsDir(),
      demucs: { ...currentSettings.demucs, ...(settings.demucs || {}) },
      lyrics: {
        ...currentSettings.lyrics,
        ...incomingLyrics,
        elrcLineLeadInMs: leadInMs,
      },
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(currentSettings, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving settings:', err);
  }
  return currentSettings;
}

export function getSettings(): AppSettings {
  return currentSettings;
}
