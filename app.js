// ----------------------------------------------------
// 1. PWA Service Worker Ready & Update Notification
// ----------------------------------------------------
if ('serviceWorker' in navigator) {
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
// 2. Global State
// ----------------------------------------------------
let originalFile = null;
let originalDuration = 0; // 秒
let calculatedBitrate = 0; // bps (MediaRecorder用)
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
// 3. File Handling & Metadata Analysis
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

function handleVideoSelect(file) {
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
    
    const maxTarget = Math.max(5, Math.min(95, Math.floor(sizeInMB - 1)));
    targetSizeRange.max = Math.max(maxTarget, 5);
    if (sizeInMB <= 30) {
      targetSizeRange.value = Math.max(5, Math.floor(sizeInMB * 0.7));
    } else {
      targetSizeRange.value = 30;
    }
    
    calculateOptimalBitrate();
    switchStep(stepUpload, stepConfigure);
  };

  tempVideo.onerror = function() {
    showToast("動画メタデータの読み込みに失敗しました");
  };
}

// ----------------------------------------------------
// 4. LINE Optimization Logic & Bitrate Calculation
// ----------------------------------------------------
function calculateOptimalBitrate() {
  const targetMB = parseInt(targetSizeRange.value);
  targetSizeLabel.textContent = `${targetMB} MB`;
  
  if (originalDuration <= 0) return;

  // 目標の総ビットレート (bps)
  const totalBitrateBps = (targetMB * 8 * 1024 * 1024) / originalDuration;
  
  // 音声に 128kbps (128,000 bps) 割り当て、残りを映像ビットレートにする
  const audioBitrateBps = 128000;
  calculatedBitrate = Math.round(totalBitrateBps - audioBitrateBps);
  
  // 映像ビットレートの安全制限 (300kbps〜4000kbps)
  const minVideoBitrate = 300000;
  const maxVideoBitrate = 4000000;
  
  if (calculatedBitrate < minVideoBitrate) {
    calculatedBitrate = minVideoBitrate;
    calculatedBitrateLabel.textContent = `${Math.round(calculatedBitrate / 1000)} kbps (下限固定)`;
    document.getElementById('bitrateExplanation').textContent = `動画が長いため、画質維持のため圧縮後のサイズが目標(${targetMB}MB)を超える可能性があります。`;
  } else if (calculatedBitrate > maxVideoBitrate) {
    calculatedBitrate = maxVideoBitrate;
    calculatedBitrateLabel.textContent = `${Math.round(calculatedBitrate / 1000)} kbps (上限固定)`;
    document.getElementById('bitrateExplanation').textContent = `動画が短いため、最高画質設定で処理します。サイズは目標(${targetMB}MB)より大幅に小さくなります。`;
  } else {
    calculatedBitrateLabel.textContent = `${Math.round(calculatedBitrate / 1000)} kbps`;
    document.getElementById('bitrateExplanation').textContent = `目標サイズ ${targetMB}MB に収まるように最適化されています。`;
  }
}

targetSizeRange.addEventListener('input', calculateOptimalBitrate);

// ----------------------------------------------------
// 5. Video Encoding via Canvas + Web Audio API + MediaRecorder
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
  progressStatus.textContent = '圧縮処理を準備中...';
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
    activeRecorderVideo.muted = false; // 音声をキャプチャするためにmuted=false
    activeRecorderVideo.volume = 0.001; // 再生音が聞こえないように音量を極小に設定

    // 2. 映像描画用キャンバスの設定
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // 3. メタデータロード完了時のメイン処理
    activeRecorderVideo.onloadedmetadata = () => {
      canvas.width = activeRecorderVideo.videoWidth;
      canvas.height = activeRecorderVideo.videoHeight;
      
      // 4. Web Audio APIの設定（無音で音声ストリームをキャプチャ）
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      activeAudioCtx = new AudioContextClass();
      
      const source = activeAudioCtx.createMediaElementSource(activeRecorderVideo);
      const dest = activeAudioCtx.createMediaStreamDestination();
      source.connect(dest); // キャプチャ用へ接続
      
      // スピーカー出力用のゲインを0にする（無音化の徹底）
      const gainNode = activeAudioCtx.createGain();
      gainNode.gain.value = 0;
      source.connect(gainNode).connect(activeAudioCtx.destination);

      // 5. ストリームの結合 (Canvas映像 30fps + Web Audio音声)
      const videoStream = canvas.captureStream(30);
      const combinedStream = new MediaStream();
      
      videoStream.getVideoTracks().forEach(track => combinedStream.addTrack(track));
      dest.stream.getAudioTracks().forEach(track => combinedStream.addTrack(track));

      // 6. MediaRecorderの初期化
      let options = {
        mimeType: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
        videoBitsPerSecond: calculatedBitrate,
        audioBitsPerSecond: 128000
      };

      // ブラウザの対応状況に応じたフォールバック
      if (MediaRecorder.isTypeSupported(options.mimeType)) {
        activeRecorder = new MediaRecorder(combinedStream, options);
      } else if (MediaRecorder.isTypeSupported('video/mp4')) {
        activeRecorder = new MediaRecorder(combinedStream, { mimeType: 'video/mp4', videoBitsPerSecond: calculatedBitrate });
      } else if (MediaRecorder.isTypeSupported('video/webm; codecs=h264')) {
        activeRecorder = new MediaRecorder(combinedStream, { mimeType: 'video/webm; codecs=h264', videoBitsPerSecond: calculatedBitrate });
      } else if (MediaRecorder.isTypeSupported('video/webm')) {
        activeRecorder = new MediaRecorder(combinedStream, { mimeType: 'video/webm', videoBitsPerSecond: calculatedBitrate });
      } else {
        activeRecorder = new MediaRecorder(combinedStream, { videoBitsPerSecond: calculatedBitrate });
      }

      // ファイル拡張子の動的決定
      const extension = activeRecorder.mimeType.includes('webm') ? 'webm' : 'mp4';
      compressedFileName = `compressed_${Date.now()}_line.${extension}`;

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

        // 共有メニューの利用可否
        const shareFile = new File([compressedBlob], compressedFileName, { type: compressedBlob.type });
        if (navigator.canShare && navigator.canShare({ files: [shareFile] })) {
          shareVideoBtn.classList.remove('hidden');
        } else {
          shareVideoBtn.classList.add('hidden');
        }

        switchStep(stepProgress, stepResult);
        showToast("圧縮が完了しました！");
      };

      // 7. 描画ループ関数の定義
      const drawFrame = () => {
        if (activeRecorderVideo.paused || activeRecorderVideo.ended) return;
        ctx.drawImage(activeRecorderVideo, 0, 0, canvas.width, canvas.height);
        
        // 進捗率の計算と更新 (currentTime / duration)
        const progress = Math.min(99, Math.round((activeRecorderVideo.currentTime / originalDuration) * 100));
        progressBar.style.width = `${progress}%`;
        progressPercent.textContent = `${progress}%`;
        
        activeAnimationFrameId = requestAnimationFrame(drawFrame);
      };

      // 8. 録画と再生の開始
      activeRecorder.start();
      activeAudioCtx.resume().then(() => {
        activeRecorderVideo.play();
        // スマホの負荷を抑えつつ高速化するため、2.0倍速でエンコード処理を実施
        activeRecorderVideo.playbackRate = 2.0; 
        drawFrame();
        progressStatus.textContent = '動画を圧縮エンコード中...';
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
    showToast("圧縮中にエラーが発生しました。");
    switchStep(stepProgress, stepConfigure);
  }
}

startCompressBtn.addEventListener('click', compressVideo);

// ----------------------------------------------------
// 6. Sharing & Downloading Logic
// ----------------------------------------------------
async function shareVideo() {
  if (!compressedBlob) return;

  const shareFile = new File([compressedBlob], compressedFileName, { type: compressedBlob.type });

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
