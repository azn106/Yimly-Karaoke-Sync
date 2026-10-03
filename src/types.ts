export type JobStatus =
  | 'DETECTED'
  | 'WAITING_FOR_FILE'
  | 'QUEUED'
  | 'PROCESSING'
  | 'VERIFYING'
  | 'COMPLETE'
  | 'FAILED'
  | 'SKIPPED'
  | 'PAUSED';

export type ProcessingPhase =
  | 'Detecting'
  | 'Preparing'
  | 'Checking instrumental'
  | 'Separating vocals'
  | 'Creating instrumental'
  | 'Reading metadata'
  | 'Fetching eLRC'
  | 'Fetching LRC'
  | 'Writing eLRC'
  | 'Writing LRC'
  | 'Writing lyrics'
  | 'Verifying outputs'
  | 'Cleaning temporary files'
  | 'Complete'
  | 'Failed';

export interface SongMetadata {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  track?: string;
  disc?: string;
  date?: string;
  composer?: string;
  copyright?: string;
  duration?: number;
  hasArtwork?: boolean;
  hasEmbeddedLyrics?: boolean;
  embeddedLyrics?: string;
  lyricsSource?: 'embedded' | 'companion_lrc' | 'companion_txt' | 'musixmatch_elrc' | 'musixmatch_lrc' | 'none';
  lyricsPreview?: string;
}

export interface SongItem {
  id: string; // Absolute path to original file
  filePath: string;
  fileName: string;
  basename: string;
  ext: string;
  artistDir: string;
  artistName: string;
  sizeBytes: number;
  lastModified: number;
  
  // Output status
  hasInstrumental: boolean;
  instrumentalPath?: string;
  hasElrc: boolean;
  elrcPath?: string;
  hasNormalLrc: boolean;
  normalLrcPath?: string;
  
  isComplete: boolean;
  metadata?: SongMetadata;
}

export type SubTaskStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETE' | 'FAILED' | 'SKIPPED';

export interface SubTaskState {
  status: SubTaskStatus;
  progress: number; // 0-100
  message?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  device?: 'cuda' | 'cpu' | 'network' | 'cache' | 'none';
}

export interface SyncJob {
  id: string; // original file path
  filePath: string;
  fileName: string;
  artistName: string;
  songTitle: string;
  status: JobStatus;
  progress: number; // 0-100
  currentPhase: ProcessingPhase;
  phaseMessage?: string;
  error?: string;
  addedAt: number;
  startedAt?: number;
  completedAt?: number;
  
  // Independent concurrent task states
  audioTask?: SubTaskState;
  lyricsTask?: SubTaskState;
  executionDevice?: 'cuda' | 'cpu' | 'none';

  // Output results summary
  instrumentalStatus?: 'EXISTS' | 'GENERATED' | 'FAILED' | 'SKIPPED';
  elrcStatus?: 'EXISTS' | 'FETCHED' | 'NOT_FOUND' | 'SKIPPED';
  lrcStatus?: 'EXISTS' | 'FETCHED' | 'NOT_FOUND' | 'SKIPPED';

  // Live output streaming data
  liveSegments?: Array<{ start: number; end: number; text: string }>;
  liveWords?: Array<{ time: number; userWord: string; whisperWord: string }>;
  logs?: string[];
  retryCount?: number;
  interrupted?: boolean;
}

export interface AppSettings {
  mediaRoot: string;
  modelsDir: string;
  pythonPath: string;
  splitScriptPath: string;
  alignScriptPath?: string;
  isConfigured: boolean;
  useGpu: boolean;
  demucs: {
    model: 'htdemucs' | 'htdemucs_ft' | 'htdemucs_6s' | 'mdx_extra' | 'mdx';
    stems: 'vocals' | 'all';
    format: 'wav' | 'flac' | 'mp3';
    mp3Bitrate: number;
    shifts: number;
    overlap: number;
    useGpu: boolean;
  };
  lyrics: {
    fetchElrc: boolean;
    fetchLrc: boolean;
    overwriteExisting: boolean;
    elrcLineLeadInMs?: number;
    providers?: ('musixmatch' | 'netease' | 'qqmusic' | 'kugou')[];
  };
  ffmpegPath: string;
  tempDir: string;
  autoStartMonitoring: boolean;
  fileStabilityDelayMs: number;
}

export interface EngineLog {
  id: string;
  timestamp: number;
  level: 'INFO' | 'WARN' | 'ERR' | 'PROG' | 'SEG' | 'WORD';
  message: string;
  jobId?: string;
}

export interface SystemStatus {
  monitoring: boolean;
  queuePaused: boolean;
  activeJobId: string | null;
  activeJobIds?: string[];
  totalSongs: number;
  completedSongs: number;
  incompleteSongs: number;
  queuedJobs: number;
  failedJobs: number;
  concurrency?: {
    maxConcurrentSongs: number;
    maxConcurrentAudio: number;
    maxConcurrentLyrics: number;
    activeAudio: number;
    activeLyrics: number;
  };
  pythonInfo?: {
    available: boolean;
    version: string;
    hasTorch: boolean;
    cudaAvailable: boolean;
    deviceCount: number;
    deviceName?: string;
    vramGb?: number;
    cudaVersion?: string;
    cudnnVersion?: string;
    tensorVerified?: boolean;
    hasDemucs: boolean;
    torchError?: string;
    tensorError?: string;
    // Paths
    pythonPath: string;
    splitScriptPath: string;
    mediaRoot: string;
    modelsDir: string;
  };
  ffmpegInfo?: {
    available: boolean;
    hasFfprobe: boolean;
    version: string;
    hasCudaHwaccel?: boolean;
    audioEncoders?: string[];
  };
  musixmatchInfo?: {
    authenticated: boolean;
    tokenPreview?: string;
  };
}

export interface AuthUser {
  id: string;
  username: string;
  role: 'ADMIN' | 'USER';
  createdAt?: number;
}
