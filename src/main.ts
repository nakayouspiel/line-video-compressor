import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// Global variables
let ffmpeg: FFmpeg | null = null;
let selectedFile: File | null = null;
let targetSizeMB: number = 30; // Default 30MB (High quality)
let videoDuration: number = 0;
let progressTimer: number | null = null;
let startTime: number = 0;
let wakeLock: WakeLockSentinel | null = null;
let compressedBlob: Blob | null = null;

// DOM Elements
const modeHigh = document.getElementById('modeHigh') as HTMLButtonElement;
const modeFast = document.getElementById('modeFast') as HTMLButtonElement;
const dropzone = document.getElementById('dropzone') as HTMLDivElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const uploadText = document.getElementById('uploadText') as HTMLParagraphElement;
const uploadSubtext = document.getElementById('uploadSubtext') as HTMLParagraphElement;
const fileInfo = document.getElementById('fileInfo') as HTMLParagraphElement;
const startCompressBtn = document.getElementById('startCompressBtn') as HTMLButtonElement;

const progressSection = document.getElementById('progressSection') as HTMLDivElement;
const progressPercent = document.getElementById('progressPercent') as HTMLSpanElement;
const progressBar = document.getElementById('progressBar') as HTMLDivElement;
const progressStatus = document.getElementById('progressStatus') as HTMLSpanElement;
const elapsedTimeLabel = document.getElementById('elapsedTime') as HTMLParagraphElement;

const resultSection = document.getElementById('resultSection') as HTMLDivElement;
const beforeSizeVal = document.getElementById('beforeSizeVal') as HTMLSpanElement;
const afterSizeVal = document.getElementById('afterSizeVal') as HTMLSpanElement;
const downloadBtn = document.getElementById('downloadBtn') as HTMLButtonElement;
const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement;

// 1. Wake Lock API (画面スリープ防止)
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('Screen Wake Lock acquired.');
    } catch (err: any) {
      console.warn(`Wake Lock failed: ${err.name}, ${err.message}`);
    }
  }
}

function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release()
      .then(() => {
        wakeLock = null;
        console.log('Screen Wake Lock released.');
      })
      .catch((err) => {
        console.error('Failed to release Wake Lock:', err);
      });
  }
}

// 2. Mode Selection Toggle
modeHigh.addEventListener('click', () => {
  targetSizeMB = 30;
  modeHigh.classList.add('active');
  modeFast.classList.remove('active');
});

modeFast.addEventListener('click', () => {
  targetSizeMB = 5;
  modeFast.classList.add('active');
  modeHigh.classList.remove('active');
});

// 3. File Picker & Dropzone Events
dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.style.borderColor = 'var(--primary)';
});

dropzone.addEventListener('dragleave', () => {
  dropzone.style.borderColor = 'var(--border-color)';
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.style.borderColor = 'var(--border-color)';
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    handleFileSelection(files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement;
  if (target.files && target.files.length > 0) {
    handleFileSelection(target.files[0]);
  }
});

function handleFileSelection(file: File) {
  if (!file.type.startsWith('video/')) {
    alert('動画ファイルを選んでね！');
    fileInput.value = '';
    return;
  }

  selectedFile = file;
  compressedBlob = null;

  // Show selected video details
  const sizeMB = file.size / (1024 * 1024);
  
  // Extract video duration using dummy video element
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.src = URL.createObjectURL(file);
  
  video.onloadedmetadata = () => {
    videoDuration = video.duration;
    URL.revokeObjectURL(video.src);

    const min = Math.floor(videoDuration / 60);
    const sec = Math.floor(videoDuration % 60);
    const durationText = `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;

    uploadText.textContent = '動画変更';
    uploadSubtext.textContent = 'タップすると別の動画を選び直せます';
    fileInfo.classList.remove('hidden');
    fileInfo.textContent = `${file.name} (${sizeMB.toFixed(1)} MB | ${durationText})`;
    dropzone.classList.add('has-file');
    startCompressBtn.removeAttribute('disabled');
  };

  video.onerror = () => {
    alert('動画メタデータの読み込みに失敗しました。別の動画ファイルを試してください。');
  };
}

// 4. FFmpeg Loading & Processing
async function initFFmpeg() {
  if (ffmpeg) return ffmpeg;
  
  ffmpeg = new FFmpeg();
  
  progressStatus.textContent = '圧縮エンジンの読み込み中...';
  
  // Load using local wasm files from public/ffmpeg/ to avoid CORS block
  const baseURL = window.location.origin + '/ffmpeg';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
  });

  return ffmpeg;
}

async function startCompression() {
  if (!selectedFile || videoDuration <= 0) return;

  // UI Setup for execution status
  modeHigh.setAttribute('disabled', 'true');
  modeFast.setAttribute('disabled', 'true');
  dropzone.style.pointerEvents = 'none';
  startCompressBtn.setAttribute('disabled', 'true');
  progressSection.classList.remove('hidden');
  resultSection.classList.add('hidden');

  progressPercent.textContent = '0%';
  progressBar.style.width = '0%';
  progressStatus.textContent = '準備中...';

  // Timer run
  startTime = Date.now();
  elapsedTimeLabel.textContent = '経過時間: 0秒';
  progressTimer = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    elapsedTimeLabel.textContent = `経過時間: ${elapsed}秒`;
  }, 1000);

  try {
    // Acquire wake lock to block sleep on mobile
    await requestWakeLock();

    // Initialize/Load ffmpeg
    const instance = await initFFmpeg();

    // Setup real-time progress callback
    instance.on('progress', ({ progress }) => {
      const percentage = Math.min(99, Math.round(progress * 100));
      progressPercent.textContent = `${percentage}%`;
      progressBar.style.width = `${percentage}%`;
      progressStatus.textContent = 'ちっちゃく加工中...';
    });

    // Write file to internal Wasm virtual filesystem
    await instance.writeFile('input.mp4', await fetchFile(selectedFile));

    // Optimal video bitrate calculations (total target size minus audio 128k, clamped to safe ranges)
    const totalBitrateKbps = (targetSizeMB * 8 * 1024) / videoDuration;
    const calculatedVideoBitrate = Math.round(totalBitrateKbps - 128).coerceIn(150, 4000);

    // Build FFmpeg CLI arguments
    const args = [
      '-i', 'input.mp4',
      '-vcodec', 'libx264',
      '-acodec', 'aac',
      '-b:v', `${calculatedVideoBitrate}k`,
      '-b:a', '128k',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      '-movflags', '+faststart'
    ];

    // Scale down width to 640px preserving aspect ratio for 5MB constraint mode
    if (targetSizeMB === 5) {
      args.push('-vf', 'scale=640:-2');
    }

    args.push('output.mp4');

    // Run compile task
    progressStatus.textContent = 'エンコードを開始します...';
    await instance.exec(args);

    // Read result binary buffer from Wasm FS
    progressStatus.textContent = '最終処理中...';
    const outputData = await instance.readFile('output.mp4');
    if (outputData instanceof Uint8Array) {
      compressedBlob = new Blob([outputData.buffer as ArrayBuffer], { type: 'video/mp4' });
    } else {
      throw new Error('期待されたバイナリデータが取得できませんでした');
    }

    // Cleanup files in Virtual FS to free up browser memory
    await instance.deleteFile('input.mp4');
    await instance.deleteFile('output.mp4');

    // UI Finish update
    if (progressTimer) clearInterval(progressTimer);
    releaseWakeLock();

    const beforeMB = selectedFile.size / (1024 * 1024);
    const afterMB = compressedBlob.size / (1024 * 1024);

    beforeSizeVal.textContent = `${beforeMB.toFixed(1)} MB`;
    afterSizeVal.textContent = `${afterMB.toFixed(1)} MB`;

    progressSection.classList.add('hidden');
    resultSection.classList.remove('hidden');

  } catch (error: any) {
    console.error('Encoding process failure:', error);
    alert('圧縮処理中にエラーが発生しました。別の動画を試すか、再度やり直してください。');
    
    // Safety cleanup
    if (progressTimer) clearInterval(progressTimer);
    releaseWakeLock();
    resetUI();
  }
}

startCompressBtn.addEventListener('click', startCompression);

// Number prototype helper to clamp values
// Add locally as inline extension function helper to avoid prototype pollution issues
Number.prototype.coerceIn = function(min: number, max: number): number {
  return Math.max(min, Math.min(max, this.valueOf()));
};
// TypeScript typing definition for coerceIn
declare global {
  interface Number {
    coerceIn(min: number, max: number): number;
  }
}

// 5. Download Trigger & Reset UI
downloadBtn.addEventListener('click', () => {
  if (!compressedBlob) return;
  const url = URL.createObjectURL(compressedBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chiccha_${Date.now()}.mp4`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

resetBtn.addEventListener('click', () => {
  resetUI();
});

function resetUI() {
  selectedFile = null;
  compressedBlob = null;
  videoDuration = 0;
  fileInput.value = '';
  
  uploadText.textContent = '① 動画を選ぶ';
  uploadSubtext.textContent = 'タップして動画ファイルを選択してください';
  fileInfo.classList.add('hidden');
  dropzone.classList.remove('has-file');
  
  modeHigh.removeAttribute('disabled');
  modeFast.removeAttribute('disabled');
  dropzone.style.pointerEvents = 'auto';
  startCompressBtn.setAttribute('disabled', 'true');
  
  progressSection.classList.add('hidden');
  resultSection.classList.add('hidden');
}
