// ----------------------------------------------------
// 1. PWA Service Worker Ready & Update Notification
// ----------------------------------------------------
if ('serviceWorker' in navigator) {
  // 登録処理自体は index.html の head タグ内で最速実行されているため、
  // app.js 側では準備完了(ready)を待ってバックグラウンド更新のみを監視します
  navigator.serviceWorker.ready.then(reg => {
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (newWorker) {
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showToast("アプリアップデートを検出しました。再読み込み中...");
            setTimeout(() => { location.reload(); }, 1500);
          }
        });
      }
    });
  });
}

// ----------------------------------------------------
// 2. Constants & Global State
// ----------------------------------------------------
// UMD版の異なるグローバル名前空間（FFmpegWASM, FFmpegWasm, window）を安全にフォールバック
const FFmpegLib = window.FFmpegWASM || window.FFmpegWasm || window;
const FFmpegUtilLib = window.FFmpegUtil || window;

const { FFmpeg, toBlobURL } = FFmpegLib;
const { fetchFile } = FFmpegUtilLib;

let ffmpeg = null;
let originalFile = null;
let originalDuration = 0; // 秒
let calculatedBitrate = 0; // kbps
let progressTimer = null;
let startTime = 0;

// DOM Elements
const loaderOverlay = document.getElementById('loaderOverlay');
const loaderTitle = document.getElementById('loaderTitle');
const loaderDesc = document.getElementById('loaderDesc');

const stepUpload = document.getElementById('stepUpload');
const stepConfigure = document.getElementById('stepConfigure');
const stepProgress = document.getElementById('stepProgress');
const stepResult = document.getElementById('stepResult');

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

const inputVideoPreview = document.getElementById('inputVideoPreview');
const originalSizeVal = document.getElementById('originalSizeVal');
const originalDurationVal = document.getElementById('originalDurationVal');

const targetSizeRange = document.getElementById('targetSizeRange');
const targetSizeLabel = document.getElementById('targetSizeLabel');
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

const shareVideoBtn = document.getElementById('shareVideoBtn');
const downloadVideoBtn = document.getElementById('downloadVideoBtn');
const restartBtn = document.getElementById('restartBtn');

const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toastMessage');

// Output Blob reference for sharing/downloading
let compressedBlob = null;
let compressedFileName = "compressed_line.mp4";

// ----------------------------------------------------
// 3. Initialize FFmpeg.wasm
// ----------------------------------------------------
async function initFFmpeg() {
  try {
    ffmpeg = new FFmpeg();

    // ffmpeg-coreのロード設定 (CDN経由)
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    
    // progressイベントの設定（ロード中の進捗ではなく、エンコード中の進捗を監視）
    ffmpeg.on('progress', ({ progress }) => {
      const percentage = Math.round(progress * 100);
      progressBar.style.width = `${percentage}%`;
      progressPercent.textContent = `${percentage}%`;
    });

    // ログ出力の設定 (デバッグ用)
    ffmpeg.on('log', ({ message }) => {
      console.log("[FFmpeg Log]", message);
      // メッセージ内容から現在処理中のステージを推測してUIに表示
      if (message.includes('Error') || message.includes('failed')) {
        progressStatus.textContent = 'エラーが発生しました';
      } else if (message.includes('Reading')) {
        progressStatus.textContent = '動画を読み込み中...';
      } else if (message.includes('Encoding') || message.includes('frame=')) {
        progressStatus.textContent = 'エンコード中...';
      }
    });

    loaderTitle.textContent = "コアファイルを読み込み中...";
    
    // WASMモジュールのロード
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    // 初期化完了。ローディング画面を非表示にする
    loaderOverlay.classList.add('hidden');
    showToast("FFmpegの準備が完了しました！");
  } catch (error) {
    console.error("FFmpeg initialization failed:", error);
    loaderTitle.textContent = "初期化に失敗しました";
    loaderDesc.innerHTML = `<span style="color: var(--error-color)">エラー: SharedArrayBufferがブロックされているか、ネットワークエラーです。ブラウザを再読み込みするか、セキュアな通信環境(HTTPS)でアクセスしているか確認してください。</span>`;
  }
}

// アプリ起動時にFFmpegを初期化
window.addEventListener('DOMContentLoaded', initFFmpeg);

// ----------------------------------------------------
// 4. File Handling & Metadata Analysis
// ----------------------------------------------------
// Drag and drop event listeners
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
  if (files.length > 0 && files[0].type.startsWith('video/')) {
    handleVideoSelect(files[0]);
  } else {
    showToast("有効な動画ファイルを選択してください");
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleVideoSelect(e.target.files[0]);
  }
});

// 動画が選択された時の処理
function handleVideoSelect(file) {
  originalFile = file;
  
  // 元のファイルサイズ表示 (MB単位)
  const sizeInMB = file.size / (1024 * 1024);
  originalSizeVal.textContent = `${sizeInMB.toFixed(1)} MB`;
  
  // 動画の長さ（Duration）を取得するためのテンポラリビデオ要素
  const tempVideo = document.createElement('video');
  tempVideo.preload = 'metadata';
  tempVideo.src = URL.createObjectURL(file);
  
  tempVideo.onloadedmetadata = function() {
    originalDuration = tempVideo.duration;
    URL.revokeObjectURL(tempVideo.src);
    
    // 再生時間表示 (MM:SS)
    const minutes = Math.floor(originalDuration / 60);
    const seconds = Math.floor(originalDuration % 60);
    originalDurationVal.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    
    // プレビュー表示
    inputVideoPreview.src = URL.createObjectURL(file);
    
    // 目標サイズスライダーの最大値を設定 (元のサイズ以下に抑える)
    const maxTarget = Math.max(5, Math.min(95, Math.floor(sizeInMB - 1)));
    targetSizeRange.max = Math.max(maxTarget, 5); // 最低でも5MB
    if (sizeInMB <= 30) {
      targetSizeRange.value = Math.max(5, Math.floor(sizeInMB * 0.7)); // すでに30MB以下なら70%に
    } else {
      targetSizeRange.value = 30; // デフォルトは30MB
    }
    
    // ビットレート計算
    calculateOptimalBitrate();
    
    // 画面遷移
    switchStep(stepUpload, stepConfigure);
  };

  tempVideo.onerror = function() {
    showToast("動画メタデータの読み込みに失敗しました");
  };
}

// ----------------------------------------------------
// 5. LINE Optimization Logic & Bitrate Calculation
// ----------------------------------------------------
function calculateOptimalBitrate() {
  const targetMB = parseInt(targetSizeRange.value);
  targetSizeLabel.textContent = `${targetMB} MB`;
  
  if (originalDuration <= 0) return;

  // LINE最適化計算式
  // 目標全体のビットレート (kbps) = (目標サイズ(MB) * 8 * 1024) / 長さ(秒)
  const totalBitrate = (targetMB * 8 * 1024) / originalDuration;
  
  // 音声ビットレートに128kbpsを割り当て、残りを映像ビットレートにする
  // ただし、極端に低い値や高い値にならないように制限する
  const audioBitrate = 128;
  calculatedBitrate = Math.round(totalBitrate - audioBitrate);
  
  // 映像ビットレートの制限
  // 映像ビットレート下限: 150kbps (これ未満だと画質が破綻する)
  // 映像ビットレート上限: 4000kbps (LINEで送るには十分な高画質)
  if (calculatedBitrate < 150) {
    calculatedBitrate = 150;
    calculatedBitrateLabel.textContent = `${calculatedBitrate} kbps (下限固定)`;
    document.getElementById('bitrateExplanation').textContent = `動画が長いため、画質維持のため圧縮後のサイズが目標(${targetMB}MB)を超える可能性があります。`;
  } else if (calculatedBitrate > 4000) {
    calculatedBitrate = 4000;
    calculatedBitrateLabel.textContent = `${calculatedBitrate} kbps (上限固定)`;
    document.getElementById('bitrateExplanation').textContent = `動画が短いため、最高画質設定で処理します。サイズは目標(${targetMB}MB)より大幅に小さくなります。`;
  } else {
    calculatedBitrateLabel.textContent = `${calculatedBitrate} kbps`;
    document.getElementById('bitrateExplanation').textContent = `目標サイズ ${targetMB}MB に収まるように最適化されています。`;
  }
}

// スライダー操作時に再計算
targetSizeRange.addEventListener('input', calculateOptimalBitrate);

// ----------------------------------------------------
// 6. Video Encoding & Compression
// ----------------------------------------------------
async function compressVideo() {
  if (!ffmpeg || !originalFile) {
    showToast("準備が整っていません");
    return;
  }

  // 画面遷移
  switchStep(stepConfigure, stepProgress);
  progressStatus.textContent = '動画を読み込んでいます...';
  progressBar.style.width = '0%';
  progressPercent.textContent = '0%';
  
  // 経過時間タイマーの開始
  let elapsedSeconds = 0;
  timeElapsed.textContent = `経過時間: 0秒`;
  startTime = Date.now();
  
  progressTimer = setInterval(() => {
    elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    timeElapsed.textContent = `経過時間: ${elapsedSeconds}秒`;
  }, 1000);

  try {
    const inputFileName = 'input_' + Date.now() + '_' + originalFile.name;
    const outputFileName = 'output_' + Date.now() + '.mp4';
    compressedFileName = `compressed_${Date.now()}_line.mp4`;

    // 1. ファイルをWASMの仮想ファイルシステムに書き込む
    const fileData = await fetchFile(originalFile);
    await ffmpeg.writeFile(inputFileName, fileData);
    
    progressStatus.textContent = '圧縮処理を開始しています...';

    // 2. ffmpeg コマンドを実行する
    // H.264 / AAC / MP4 形式に固定してエンコード
    // ピクセルフォーマット yuv420p はスマホ再生で必須
    // preset: fast で処理速度と画質のバランスを取る
    await ffmpeg.exec([
      '-i', inputFileName,
      '-vcodec', 'libx264',
      '-acodec', 'aac',
      '-b:v', `${calculatedBitrate}k`,
      '-b:a', '128k',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      '-movflags', '+faststart',
      outputFileName
    ]);

    progressStatus.textContent = '処理を完了しています...';

    // 3. 圧縮後のファイルを仮想ファイルシステムから読み込む
    const data = await ffmpeg.readFile(outputFileName);
    compressedBlob = new Blob([data.buffer], { type: 'video/mp4' });

    // クリーンアップ (仮想メモリの解放)
    try {
      await ffmpeg.deleteFile(inputFileName);
      await ffmpeg.deleteFile(outputFileName);
    } catch (e) {
      console.warn("Clean up failed:", e);
    }

    // タイマー停止
    clearInterval(progressTimer);

    // 4. 結果の解析と表示
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

    // 出力プレビューの設定
    outputVideoPreview.src = URL.createObjectURL(compressedBlob);

    // Web Share APIのサポート状態によって共有ボタンを制御
    const shareFile = new File([compressedBlob], compressedFileName, { type: 'video/mp4' });
    if (navigator.canShare && navigator.canShare({ files: [shareFile] })) {
      shareVideoBtn.classList.remove('hidden');
    } else {
      // 共有できないブラウザ（PCや一部のAndroid/iOSブラウザ）では共有ボタンを隠す
      shareVideoBtn.classList.add('hidden');
    }

    // 画面遷移
    switchStep(stepProgress, stepResult);
    showToast("圧縮が正常に完了しました！");

  } catch (error) {
    console.error("Compression process failed:", error);
    clearInterval(progressTimer);
    showToast("圧縮中にエラーが発生しました。");
    // 設定画面へ戻す
    switchStep(stepProgress, stepConfigure);
  }
}

startCompressBtn.addEventListener('click', compressVideo);

// ----------------------------------------------------
// 7. Sharing & Downloading Logic
// ----------------------------------------------------
// Web Share APIを使用してLINEや他アプリに送る
async function shareVideo() {
  if (!compressedBlob) return;

  const shareFile = new File([compressedBlob], compressedFileName, { type: 'video/mp4' });

  try {
    if (navigator.share) {
      await navigator.share({
        files: [shareFile],
        title: 'LINEで送る動画',
        text: '圧縮した動画です。LINE等で共有できます。'
      });
      showToast("共有メニューを開きました");
    } else {
      showToast("このブラウザは直接共有に対応していません");
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error("Sharing failed:", error);
      showToast("共有に失敗しました。ダウンロードをお試しください。");
    }
  }
}

// ファイルをローカルにダウンロード保存する
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
  showToast("ダウンロードを開始しました");
}

shareVideoBtn.addEventListener('click', shareVideo);
downloadVideoBtn.addEventListener('click', downloadVideo);

// ----------------------------------------------------
// 8. Navigation & Reset Logic
// ----------------------------------------------------
function switchStep(fromStep, toStep) {
  fromStep.classList.add('hidden');
  toStep.classList.remove('hidden');
}

// 動画を選び直す
changeVideoBtn.addEventListener('click', () => {
  resetState();
  switchStep(stepConfigure, stepUpload);
});

// 最初からやり直す
restartBtn.addEventListener('click', () => {
  resetState();
  switchStep(stepResult, stepUpload);
});

function resetState() {
  originalFile = null;
  originalDuration = 0;
  calculatedBitrate = 0;
  
  if (compressedBlob) {
    compressedBlob = null;
  }
  
  // ビデオのリソース解放
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
