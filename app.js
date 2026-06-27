// ----------------------------------------------------
// 1. PWA Service Worker Registration
// ----------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        console.log('Service Worker registered successfully:', reg.scope);
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
let calculatedBitrate = 0; // bps (MediaRecorder用)
let targetSize = 15; // デフォルト 15MB
let progressTimer = null;
let startTime = 0;

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
// 3. File Handling & Error Checks
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
// 4. Mode Selection & Bitrate Calculation
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

  // 目標の総ビットレート (bps)
  const totalBitrateBps = (targetSize * 8 * 1024 * 1024) / originalDuration;
  
  // 音声に 128kbps (128,000 bps) 割り当て、残りを映像ビットレートにする
  const audioBitrateBps = 128000;
  calculatedBitrate = Math.round(totalBitrateBps - audioBitrateBps);
  
  // 映像ビットレートの安全制限 (150kbps〜4000kbps)
  const minVideoBitrate = 150000;
  const maxVideoBitrate = 4000000;
  
  if (calculatedBitrate < minVideoBitrate) {
    calculatedBitrate = minVideoBitrate;
  } else if (calculatedBitrate > maxVideoBitrate) {
    calculatedBitrate = maxVideoBitrate;
  }
  
  calculatedBitrateLabel.textContent = `${Math.round(calculatedBitrate / 1000)} kbps`;
  document.getElementById('bitrateExplanation').textContent = `目標サイズ ${targetSize}MB に収まるように最適化されています。`;
}

// ----------------------------------------------------
// 5. Video Encoding via pure Canvas + Web Audio + MediaRecorder
// ----------------------------------------------------
let activeAudioCtx = null;
let activeRecorderVideo = null;
let activeRecorder = null;
let activeAnimationFrameId = null;

async function compressVideo() {
  if (!originalFile) {
    showToast("ファイルが選択されていません");
    return;
  }

  // 画面遷移
  switchStep(stepConfigure, stepProgress);
  progressStatus.textContent = 'ちっちゃくする準備中...';
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
    // 1. 非表示のビデオ要素を生成してロード
    activeRecorderVideo = document.createElement('video');
    activeRecorderVideo.src = URL.createObjectURL(originalFile);
    activeRecorderVideo.playsInline = true;
    activeRecorderVideo.muted = false; // 音声をキャプチャするためにmuted=falseにする必要あり
    activeRecorderVideo.volume = 0.001; // 音漏れを防ぐためにスピーカーの再生音量を極小に

    // 2. 映像描画用キャンバスの設定
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // 3. メタデータロード完了時のメイン処理
    activeRecorderVideo.onloadedmetadata = () => {
      canvas.width = activeRecorderVideo.videoWidth;
      canvas.height = activeRecorderVideo.videoHeight;
      
      // 4. Web Audio APIの設定（無音で高音質音声ストリームをキャプチャ）
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      activeAudioCtx = new AudioContextClass();
      
      const source = activeAudioCtx.createMediaElementSource(activeRecorderVideo);
      const dest = activeAudioCtx.createMediaStreamDestination();
      source.connect(dest); // キャプチャ先へ直接接続
      
      // スピーカー出力への接続はゲイン0にして音漏れを完全防止
      const gainNode = activeAudioCtx.createGain();
      gainNode.gain.value = 0;
      source.connect(gainNode).connect(activeAudioCtx.destination);

      // 5. ストリームの結合 (Canvas映像 30fps に音声トラックを追加)
      // 互換性対策として、Canvasのストリームに直接トラックを追加する方式を採用
      const videoStream = canvas.captureStream(30);
      const audioTrack = dest.stream.getAudioTracks()[0];
      if (audioTrack) {
        videoStream.addTrack(audioTrack);
      }

      // 6. MediaRecorderの初期化 (安全なコーデックとビットレートの設定)
      let options = {
        mimeType: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
        videoBitsPerSecond: calculatedBitrate,
        audioBitsPerSecond: 128000
      };

      // ブラウザの対応状況に応じたフォールバック
      if (MediaRecorder.isTypeSupported(options.mimeType)) {
        activeRecorder = new MediaRecorder(videoStream, options);
      } else if (MediaRecorder.isTypeSupported('video/mp4')) {
        activeRecorder = new MediaRecorder(videoStream, { mimeType: 'video/mp4', videoBitsPerSecond: calculatedBitrate });
      } else if (MediaRecorder.isTypeSupported('video/webm; codecs=h264')) {
        activeRecorder = new MediaRecorder(videoStream, { mimeType: 'video/webm; codecs=h264', videoBitsPerSecond: calculatedBitrate });
      } else if (MediaRecorder.isTypeSupported('video/webm')) {
        activeRecorder = new MediaRecorder(videoStream, { mimeType: 'video/webm', videoBitsPerSecond: calculatedBitrate });
      } else {
        activeRecorder = new MediaRecorder(videoStream, { videoBitsPerSecond: calculatedBitrate });
      }

      // ファイル拡張子の動的決定
      const extension = activeRecorder.mimeType.includes('webm') ? 'webm' : 'mp4';
      compressedFileName = `chiccha_${Date.now()}.${extension}`;

      const chunks = [];
      activeRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      activeRecorder.onstop = () => {
        // タイマーと描画ループのクリーンアップ
        clearInterval(progressTimer);
        cancelAnimationFrame(activeAnimationFrameId);
        if (activeAudioCtx && activeAudioCtx.state !== 'closed') {
          activeAudioCtx.close();
        }
        
        compressedBlob = new Blob(chunks, { type: activeRecorder.mimeType });
        
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
      };

      // 7. 描画ループ関数の定義
      const drawFrame = () => {
        if (activeRecorderVideo.paused || activeRecorderVideo.ended) return;
        ctx.drawImage(activeRecorderVideo, 0, 0, canvas.width, canvas.height);
        
        // 等倍速エンコード時の進捗率の計算と更新 (currentTime / duration)
        const progress = Math.min(99, Math.round((activeRecorderVideo.currentTime / originalDuration) * 100));
        progressBar.style.width = `${progress}%`;
        progressPercent.textContent = `${progress}%`;
        
        activeAnimationFrameId = requestAnimationFrame(drawFrame);
      };

      // 8. 録画と再生の開始 (等倍速かつ高音質を100%維持してエンコード)
      activeRecorder.start();
      activeAudioCtx.resume().then(() => {
        activeRecorderVideo.play();
        activeRecorderVideo.playbackRate = 1.0; // 音声同期とピッチ維持のため「等倍速」で確実にキャプチャ
        drawFrame();
        progressStatus.textContent = '動画をちっちゃく加工中...';
      });

      // 9. 再生終了時のトリガー
      activeRecorderVideo.onended = () => {
        if (activeRecorder && activeRecorder.state !== 'inactive') {
          activeRecorder.stop();
        }
      };
    };
  } catch (error) {
    console.error("Compression process failed:", error);
    clearInterval(progressTimer);
    cancelAnimationFrame(activeAnimationFrameId);
    alert("ちっちゃくする処理の途中でエラーが発生しました。");
    switchStep(stepProgress, stepConfigure);
  }
}

startCompressBtn.addEventListener('click', compressVideo);

// ----------------------------------------------------
// 6. Downloading Logic
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
// 7. Navigation & Reset Logic
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
  
  if (activeAnimationFrameId) cancelAnimationFrame(activeAnimationFrameId);
  if (progressTimer) clearInterval(progressTimer);
  
  if (activeRecorderVideo) {
    activeRecorderVideo.pause();
    activeRecorderVideo.src = "";
    activeRecorderVideo.load();
    activeRecorderVideo = null;
  }
  
  if (activeAudioCtx && activeAudioCtx.state !== 'closed') {
    activeAudioCtx.close();
    activeAudioCtx = null;
  }
  
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
// 8. Toast Notification Helper
// ----------------------------------------------------
function showToast(message) {
  toastMessage.textContent = message;
  toast.classList.add('show');
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}
