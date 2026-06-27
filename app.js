// ----------------------------------------------------
// 1. PWA Service Worker Registration
// ----------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        console.log('Service Worker registered successfully:', reg.scope);
        // 新しいサービスワーカーの有無を確認して更新を促す
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showToast("アプリの更新があります。再読み込み中...");
              setTimeout(() => { location.reload(); }, 1500);
            }
          });
        });
      })
      .catch(err => console.error('Service Worker registration failed:', err));
  });
}

// ----------------------------------------------------
// 2. Global State & Settings
// ----------------------------------------------------
let originalFile = null;
let originalDuration = 0; // 秒
let calculatedBitrate = 0; // kbps
let targetSize = 15; // デフォルト 15MB
let progressTimer = null;
let startTime = 0;

// ffmpeg.wasm v0.11.6 の初期設定 (グローバル変数 FFmpeg より取得)
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({
  log: true,
  // シングルスレッド対応コアを明示指定 (これでSharedArrayBufferおよびCOOP/COEP制限を完全回避)
  corePath: 'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js'
});

// DOM Elements
const stepUpload = document.getElementById('stepUpload');
const stepConfigure = document.getElementById('stepConfigure');
const stepProgress = document.getElementById('stepProgress');
const stepResult = document.getElementById('stepResult');

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

const inputVideoPreview = document.getElementById('inputVideoPreview');
const originalSizeVal = document.getElementById('originalSizeVal');
const originalDurationVal = document.getElementById('originalDurationVal');

// Mode buttons
const modeHighBtn = document.getElementById('modeHigh');
const modeFastBtn = document.getElementById('modeFast');
const calculatedBitrateLabel = document.getElementById('calculatedBitrateLabel');
const startCompressBtn = document.getElementById('startCompressBtn');
const changeVideoBtn = document.getElementById('changeVideoBtn');

const progressBar = document.getElementById('progressBar');
const progressPercent = document.getElementById('progressPercent');
const progressStatus = document.getElementById('progressStatus');
const timeElapsed = document.getElementById('timeElapsed');

const outputVideoPreview = document.getElementById('outputVideoPreview');
const beforeSizeVal = document.getElementById('beforeSizeVal');
const afterSizeVal = document.getElementById('afterSizeVal');
const reductionRatioVal = document.getElementById('reductionRatioVal');
const reductionBadge = document.getElementById('reductionBadge');

const downloadVideoBtn = document.getElementById('downloadVideoBtn');
const restartBtn = document.getElementById('restartBtn');

const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toastMessage');

// Output Blob reference for downloading
let compressedBlob = null;
let compressedFileName = "compressed_line.mp4";

// ----------------------------------------------------
// 3. Initialize FFmpeg.wasm (Single Thread)
// ----------------------------------------------------
async function initFFmpeg() {
  try {
    // 進行状況の監視を設定
    ffmpeg.setProgress(({ ratio }) => {
      const percentage = Math.round(ratio * 100);
      progressBar.style.width = `${percentage}%`;
      progressPercent.textContent = `${percentage}%`;
    });

    // WASMモジュールのロード
    await ffmpeg.load();

    document.getElementById('loaderOverlay').classList.add('hidden');
    showToast("準備が完了しました！");
  } catch (error) {
    console.error("FFmpeg initialization failed:", error);
    document.getElementById('loaderTitle').textContent = "準備に失敗しました";
    document.getElementById('loaderDesc').innerHTML = `<span style="color: var(--error-color)">エラー: ちっちゃくするプログラムのロード中に問題が発生しました。もう一度再読み込みをお試しください。</span>`;
  }
}

// アプリ起動時にFFmpegを初期化
window.addEventListener('DOMContentLoaded', initFFmpeg);

// ----------------------------------------------------
// 4. File Handling & Error Checks
// ----------------------------------------------------
dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    handleVideoSelect(files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleVideoSelect(e.target.files[0]);
  }
});

function handleVideoSelect(file) {
  // 動画ファイル以外のファイルが選択された場合のエラーハンドリング
  if (!file.type.startsWith('video/')) {
    alert("動画ファイルを選んでね！");
    fileInput.value = '';
    return;
  }

  originalFile = file;
  
  const sizeInMB = file.size / (1024 * 1024);
  originalSizeVal.textContent = `${sizeInMB.toFixed(1)} MB`;
  
  const tempVideo = document.createElement('video');
  tempVideo.preload = 'metadata';
  tempVideo.src = URL.createObjectURL(file);
  
  tempVideo.onloadedmetadata = function() {
    originalDuration = tempVideo.duration;
    URL.revokeObjectURL(tempVideo.src);
    
    const minutes = Math.floor(originalDuration / 60);
    const seconds = Math.floor(originalDuration % 60);
    originalDurationVal.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    
    inputVideoPreview.src = URL.createObjectURL(file);
    
    // スライダー廃止に伴い、選択されたモードのビットレート計算を初期実行
    calculateOptimalBitrate();
    switchStep(stepUpload, stepConfigure);
  };

  tempVideo.onerror = function() {
    alert("動画の読み込みに失敗しちゃいました。別の動画を選んでみてね。");
  };
}

// ----------------------------------------------------
// 5. Mode Selection & Bitrate Calculation
// ----------------------------------------------------
modeHighBtn.addEventListener('click', () => {
  targetSize = 15;
  modeHighBtn.classList.add('active');
  modeFastBtn.classList.remove('active');
  calculateOptimalBitrate();
});

modeFastBtn.addEventListener('click', () => {
  targetSize = 5;
  modeFastBtn.classList.add('active');
  modeHighBtn.classList.remove('active');
  calculateOptimalBitrate();
});

function calculateOptimalBitrate() {
  if (originalDuration <= 0) return;

  // 目標の総ビットレート (kbps)
  const totalBitrateKbps = (targetSize * 8 * 1024) / originalDuration;
  
  // 音声に 128kbps 割り当て、残りを映像ビットレートにする
  const audioBitrateKbps = 128;
  calculatedBitrate = Math.round(totalBitrateKbps - audioBitrateKbps);
  
  // 映像ビットレートの安全制限 (150kbps〜4000kbps)
  const minVideoBitrate = 150;
  const maxVideoBitrate = 4000;
  
  if (calculatedBitrate < minVideoBitrate) {
    calculatedBitrate = minVideoBitrate;
    calculatedBitrateLabel.textContent = `${calculatedBitrate} kbps (下限固定)`;
    document.getElementById('bitrateExplanation').textContent = `動画が長いため、画質維持のため圧縮後のサイズが目標(${targetSize}MB)を超える可能性があります。`;
  } else if (calculatedBitrate > maxVideoBitrate) {
    calculatedBitrate = maxVideoBitrate;
    calculatedBitrateLabel.textContent = `${calculatedBitrate} kbps (上限固定)`;
    document.getElementById('bitrateExplanation').textContent = `動画が短いため、最高画質設定で処理します。サイズは目標(${targetSize}MB)より大幅に小さくなります。`;
  } else {
    calculatedBitrateLabel.textContent = `${calculatedBitrate} kbps`;
    document.getElementById('bitrateExplanation').textContent = `目標サイズ ${targetSize}MB に収まるように最適化されています。`;
  }
}

// ----------------------------------------------------
// 6. Video Encoding via FFmpeg (Single Thread Mode)
// ----------------------------------------------------
async function compressVideo() {
  if (!ffmpeg || !originalFile) {
    showToast("プログラムが準備できていません");
    return;
  }

  // 画面遷移
  switchStep(stepConfigure, stepProgress);
  progressStatus.textContent = '動画ファイルを準備中...';
  progressBar.style.width = '0%';
  progressPercent.textContent = '0%';
  
  let elapsedSeconds = 0;
  timeElapsed.textContent = `経過時間: 0秒`;
  startTime = Date.now();
  
  progressTimer = setInterval(() => {
    elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    timeElapsed.textContent = `経過時間: ${elapsedSeconds}秒`;
  }, 1000);

  try {
    const inputFileName = 'input.mp4';
    const outputFileName = 'output.mp4';
    compressedFileName = `chiccha_${Date.now()}.mp4`;

    // 1. ファイルをWASM仮想メモリへ書き込み
    ffmpeg.FS('writeFile', inputFileName, await fetchFile(originalFile));
    progressStatus.textContent = '動画をちっちゃく加工中...';

    // 2. FFmpegを実行（等倍速・音声ありの正しい圧縮）
    await ffmpeg.run(
      '-i', inputFileName,
      '-vcodec', 'libx264',
      '-acodec', 'aac',
      '-b:v', `${calculatedBitrate}k`,
      '-b:a', '128k',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      '-movflags', '+faststart',
      outputFileName
    );

    progressStatus.textContent = '処理を完了しています...';

    // 3. 圧縮後のファイルを仮想メモリから読み込み
    const data = ffmpeg.FS('readFile', outputFileName);
    compressedBlob = new Blob([data.buffer], { type: 'video/mp4' });

    // 4. メモリ解放
    try {
      ffmpeg.FS('unlink', inputFileName);
      ffmpeg.FS('unlink', outputFileName);
    } catch (e) {
      console.warn("Clean up failed:", e);
    }

    clearInterval(progressTimer);

    // 圧縮結果の解析
    const originalSizeMB = originalFile.size / (1024 * 1024);
    const compressedSizeMB = compressedBlob.size / (1024 * 1024);
    const reductionRatio = Math.max(0, Math.round((1 - (compressedSizeMB / originalSizeMB)) * 100));

    beforeSizeVal.textContent = `${originalSizeMB.toFixed(1)} MB`;
    afterSizeVal.textContent = `${compressedSizeMB.toFixed(1)} MB`;
    reductionRatioVal.textContent = `${reductionRatio}%`;
    
    if (reductionRatio > 0) {
      reductionBadge.textContent = 'SAVE';
      reductionBadge.style.background = 'rgba(16, 185, 129, 0.15)';
      reductionBadge.style.color = '#34d399';
    } else {
      reductionBadge.textContent = 'SAME';
      reductionBadge.style.background = 'rgba(239, 68, 68, 0.15)';
      reductionBadge.style.color = '#f87171';
    }

    outputVideoPreview.src = URL.createObjectURL(compressedBlob);

    switchStep(stepProgress, stepResult);
    showToast("ちっちゃくなりました！");

  } catch (error) {
    console.error("Compression process failed:", error);
    clearInterval(progressTimer);
    alert("ちっちゃくする処理でエラーが発生しました。");
    switchStep(stepProgress, stepConfigure);
  }
}

startCompressBtn.addEventListener('click', compressVideo);

// ----------------------------------------------------
// 7. Downloading Logic
// ----------------------------------------------------
function downloadVideo() {
  if (!compressedBlob) return;

  const url = URL.createObjectURL(compressedBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = compressedFileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("動画の保存を開始しました");
}

downloadVideoBtn.addEventListener('click', downloadVideo);

// ----------------------------------------------------
// 8. Navigation & Reset Logic
// ----------------------------------------------------
function switchStep(fromStep, toStep) {
  fromStep.classList.add('hidden');
  toStep.classList.remove('hidden');
}

changeVideoBtn.addEventListener('click', () => {
  resetState();
  switchStep(stepConfigure, stepUpload);
});

restartBtn.addEventListener('click', () => {
  resetState();
  switchStep(stepResult, stepUpload);
});

function resetState() {
  originalFile = null;
  originalDuration = 0;
  calculatedBitrate = 0;
  
  if (progressTimer) clearInterval(progressTimer);
  
  compressedBlob = null;
  
  inputVideoPreview.pause();
  inputVideoPreview.removeAttribute('src');
  inputVideoPreview.load();
  
  outputVideoPreview.pause();
  outputVideoPreview.removeAttribute('src');
  outputVideoPreview.load();
  
  fileInput.value = '';
}

// ----------------------------------------------------
// 9. Toast Notification Helper
// ----------------------------------------------------
function showToast(message) {
  toastMessage.textContent = message;
  toast.classList.add('show');
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}
