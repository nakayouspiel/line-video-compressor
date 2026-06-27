import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// グローバルステート
let ffmpeg: FFmpeg | null = null;
let selectedFile: File | null = null;
let targetSizeMB: number = 30; // デフォルト 30MB
let videoDuration: number = 0;
let progressTimer: number | null = null;
let startTime: number = 0;
let wakeLock: WakeLockSentinel | null = null;
let compressedBlob: Blob | null = null;
let deferredPrompt: any = null;

// DOM要素の参照
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

const installArea = document.getElementById('installArea') as HTMLDivElement;
const installBtn = document.getElementById('installBtn') as HTMLButtonElement;
const iosInstallGuide = document.getElementById('iosInstallGuide') as HTMLParagraphElement;

// 1. PWA インストール導線の制御 (iOS配慮含む)
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone;

if (!isStandalone) {
  // iOS判定
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
  if (isIOS) {
    installArea.classList.remove('hidden');
    iosInstallGuide.classList.remove('hidden');
    installBtn.classList.add('hidden');
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  // Android等でホーム画面追加プロンプトが実行可能な場合
  e.preventDefault();
  deferredPrompt = e;
  if (!isStandalone) {
    installArea.classList.remove('hidden');
    installBtn.classList.remove('hidden');
    iosInstallGuide.classList.add('hidden');
  }
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  console.log(`User response to install prompt: ${outcome}`);
  deferredPrompt = null;
  installArea.classList.add('hidden');
});

// 2. Screen Wake Lock API (画面スリープ防止)
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

// 3. 誤操作防止のブラウザアンロード警告
function preventUnload(e: BeforeUnloadEvent) {
  e.preventDefault();
  e.returnValue = '動画をちっちゃくしている最中です。途中で閉じるとやり直しになりますが、本当に閉じますか？';
  return e.returnValue;
}

// 4. 2択トグルのクリック制御
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

// 5. 動画選択・ドロップエリアの制御
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
  // メタデータ読み込みが終わるまで実行ボタンを完全にdisabledにする
  startCompressBtn.setAttribute('disabled', 'true');

  const sizeMB = file.size / (1024 * 1024);
  
  // ダミーvideoで再生時間を正確に取得
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.src = URL.createObjectURL(file);
  
  video.onloadedmetadata = () => {
    videoDuration = video.duration;
    URL.revokeObjectURL(video.src);

    const min = Math.floor(videoDuration / 60);
    const sec = Math.floor(videoDuration % 60);
    
    let durationText = '';
    if (min > 0) {
      durationText = `${min}分${sec}秒`;
    } else {
      durationText = `${sec}秒`;
    }

    uploadText.textContent = '動画変更';
    uploadSubtext.textContent = 'タップすると別の動画を選び直せます';
    fileInfo.classList.remove('hidden');
    // 英数字のファイル名はフールプルーフのために一切見せず、容量と長さだけを表示する
    fileInfo.textContent = `元の動画: ${sizeMB.toFixed(1)}MB / ${durationText}`;
    dropzone.classList.add('has-file');
    // 読み込みがすべて正常終了したので、圧縮ボタンを有効にする
    startCompressBtn.removeAttribute('disabled');
  };

  video.onerror = () => {
    alert('動画メタデータの読み込みに失敗しました。別の動画ファイルを試してください。');
    startCompressBtn.setAttribute('disabled', 'true');
  };
}

// 6. ffmpeg.wasm 初期化 & 読み込み
async function initFFmpeg() {
  if (ffmpeg) return ffmpeg;
  
  ffmpeg = new FFmpeg();
  progressStatus.textContent = '圧縮エンジンの読み込み中...';
  
  // 同一ドメインからWasmをロードすることでCORSエラーを完全に回避
  const baseURL = window.location.origin + '/ffmpeg';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
  });

  return ffmpeg;
}

// 7. 圧縮のメイン実行処理
async function startCompression() {
  if (!selectedFile || videoDuration <= 0) return;

  // 誤操作による画面離脱やリロードを防ぐイベントを追加
  window.addEventListener('beforeunload', preventUnload);

  // UIを処理中モードへロック
  modeHigh.setAttribute('disabled', 'true');
  modeFast.setAttribute('disabled', 'true');
  dropzone.style.pointerEvents = 'none';
  startCompressBtn.setAttribute('disabled', 'true');
  progressSection.classList.remove('hidden');
  resultSection.classList.add('hidden');

  progressPercent.textContent = '0%';
  progressBar.style.width = '0%';
  progressStatus.textContent = '準備中...';

  // 経過時間カウントの開始
  startTime = Date.now();
  elapsedTimeLabel.textContent = '経過時間: 0秒';
  progressTimer = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    elapsedTimeLabel.textContent = `経過時間: ${elapsed}秒`;
  }, 1000);

  try {
    // 画面消灯をブロック
    await requestWakeLock();

    // FFmpegエンジンのロード
    const instance = await initFFmpeg();

    // 進行状況のイベント監視
    instance.on('progress', ({ progress }) => {
      const percentage = Math.min(99, Math.round(progress * 100));
      progressPercent.textContent = `${percentage}%`;
      progressBar.style.width = `${percentage}%`;
      progressStatus.textContent = 'ちっちゃく加工中...';
    });

    // 仮想FSに入力動画ファイルを書き込み
    await instance.writeFile('input.mp4', await fetchFile(selectedFile));

    // 目標サイズに合わせたビデオビットレートの最適化計算 (音声128kを除外)
    const totalBitrateKbps = (targetSizeMB * 8 * 1024) / videoDuration;
    const calculatedVideoBitrate = Math.round(totalBitrateKbps - 128).coerceIn(150, 4000);

    // FFmpeg引数 (等倍速、音声保持)
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

    // 5MB軽量モード選択時は解像度リサイズを挿入
    if (targetSizeMB === 5) {
      args.push('-vf', 'scale=640:-2');
    }

    args.push('output.mp4');

    // エンコードの開始
    progressStatus.textContent = 'エンコードを実行中...';
    await instance.exec(args);

    // 圧縮後のバイナリを仮想FSから読み出し
    progressStatus.textContent = '最終出力ファイルを作成中...';
    const outputData = await instance.readFile('output.mp4');
    
    // SharedArrayBufferの型エラーを防ぎつつBlobへ変換
    if (outputData instanceof Uint8Array) {
      compressedBlob = new Blob([outputData.buffer as ArrayBuffer], { type: 'video/mp4' });
    } else {
      throw new Error('期待されたバイナリデータが取得できませんでした');
    }

    // 仮想FSのメモリ解放
    await instance.deleteFile('input.mp4');
    await instance.deleteFile('output.mp4');

    // リフレッシュ・後処理
    if (progressTimer) clearInterval(progressTimer);
    window.removeEventListener('beforeunload', preventUnload);
    releaseWakeLock();

    // 削減サイズ表示の設定
    const beforeMB = selectedFile.size / (1024 * 1024);
    const afterMB = compressedBlob.size / (1024 * 1024);

    beforeSizeVal.textContent = `${beforeMB.toFixed(1)} MB`;
    afterSizeVal.textContent = `${afterMB.toFixed(1)} MB`;

    progressSection.classList.add('hidden');
    resultSection.classList.remove('hidden');

  } catch (error: any) {
    console.error('Encoding process failure:', error);
    alert('圧縮処理中にエラーが発生しました。別の動画を試すか、再度やり直してください。');
    
    if (progressTimer) clearInterval(progressTimer);
    window.removeEventListener('beforeunload', preventUnload);
    releaseWakeLock();
    resetUI();
  }
}

startCompressBtn.addEventListener('click', startCompression);

// coerceIn 拡張関数定義
Number.prototype.coerceIn = function(min: number, max: number): number {
  return Math.max(min, Math.min(max, this.valueOf()));
};
declare global {
  interface Number {
    coerceIn(min: number, max: number): number;
  }
}

// 8. ローカルダウンロード処理
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

// 9. もう一回やる（リセット処理）
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
