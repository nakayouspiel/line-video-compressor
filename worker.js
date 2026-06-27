// Web Worker for running FFmpeg.wasm in a single-threaded configuration
importScripts("https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js");

const { createFFmpeg } = FFmpeg;

// シングルスレッド対応コアを明示指定 (SharedArrayBuffer/COOP/COEP制限を完全回避)
const ffmpeg = createFFmpeg({
  log: true,
  corePath: 'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js'
});

// メインスレッドからのコマンドを受け取る
self.onmessage = async (e) => {
  const { type, data } = e.data;

  if (type === 'init') {
    try {
      await ffmpeg.load();
      self.postMessage({ type: 'ready' });
    } catch (err) {
      console.error("FFmpeg Load Error inside Worker:", err);
      self.postMessage({ type: 'error', data: 'ちっちゃくするプログラムの読み込みに失敗しました。' });
    }
  } 
  
  else if (type === 'compress') {
    const { file, bitrate, targetSize } = data;
    const inputFileName = 'input.mp4';
    const outputFileName = 'output.mp4';

    try {
      // 1. 進捗リスナーの設定 (比率を%に変換してメインスレッドに通知)
      ffmpeg.setProgress(({ ratio }) => {
        const progress = Math.min(99, Math.round(ratio * 100));
        self.postMessage({ type: 'progress', data: progress });
      });

      // 2. メモリ上に入力データを書き込み (ArrayBuffer からの書き込み)
      ffmpeg.FS('writeFile', inputFileName, new Uint8Array(file));

      // 3. FFmpeg実行コマンド引数の構築
      // 音声トラック(aac)と等倍速を完全に維持
      const args = [
        '-i', inputFileName,
        '-vcodec', 'libx264',
        '-acodec', 'aac',
        '-b:v', `${bitrate}k`,
        '-b:a', '128k',
        '-pix_fmt', 'yuv420p',
        '-preset', 'fast',
        '-movflags', '+faststart'
      ];

      // 5MB（爆速・軽量）の時は解像度を少し縮小 (横幅640pxにアスペクト比維持で縮小、縦幅は偶数指定)
      if (targetSize === 5) {
        args.push('-vf', 'scale=640:-2');
      }

      args.push(outputFileName);

      // 4. 圧縮エンコードの実行
      await ffmpeg.run(...args);

      // 5. 圧縮後の成果物を読み込み
      const outputData = ffmpeg.FS('readFile', outputFileName);

      // 6. メモリ解放
      try {
        ffmpeg.FS('unlink', inputFileName);
        ffmpeg.FS('unlink', outputFileName);
      } catch (err) {
        console.warn("Cleanup FS error:", err);
      }

      // 成果物の ArrayBuffer をメインスレッドに返却 (Transferable Objectsで高速転送)
      self.postMessage({ type: 'done', data: outputData.buffer }, [outputData.buffer]);

    } catch (err) {
      console.error("FFmpeg Run Error inside Worker:", err);
      self.postMessage({ type: 'error', data: 'ちっちゃくするエンコード処理中にエラーが発生しました。' });
      
      // エラー時もメモリ解放を試みる
      try {
        ffmpeg.FS('unlink', inputFileName);
        ffmpeg.FS('unlink', outputFileName);
      } catch (e) {}
    }
  }
};
