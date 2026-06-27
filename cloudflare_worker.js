// Cloudflare Workers Script - line-video-chiccha-kun API
// wrangler でデプロイするための worker 定義スクリプト (ESモジュール形式)
//
// 動作概要:
// 1. フロントから FormData を受信 (動画データ、目標ビットレート、サイズ設定)
// 2. シングルスレッド版の ffmpeg.wasm をロードして実行
// 3. 5MB設定時は -vf scale=640:-2 で自動リサイズを実行
// 4. 等倍速・音声トラック維持でエンコードしたMP4バイナリをフロントへ返却します。

import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg';

// 注意: Cloudflare Workers ではメモリや実行時間制限があるため、
// 本稼働時は「Node.js 互換フラグ (node_compat = true)」および「CPU制限に配慮した有料プラン (Workers Unbound)」の利用を推奨します。
const ffmpeg = createFFmpeg({
  log: true,
  // シングルスレッド対応のコアパスを指定
  corePath: 'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js'
});

let isLoaded = false;

async function loadFFmpeg() {
  if (!isLoaded) {
    await ffmpeg.load();
    isLoaded = true;
  }
}

export default {
  async fetch(request, env, ctx) {
    // CORS プリフライト対応
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { 
        status: 405, 
        headers: { "Access-Control-Allow-Origin": "*" } 
      });
    }

    try {
      // 1. FormData からデータ取得
      const formData = await request.formData();
      const videoFile = formData.get("video");
      const targetSize = parseInt(formData.get("targetSize") || "30");
      const bitrate = parseInt(formData.get("bitrate") || "1000");

      if (!videoFile) {
        return new Response("動画ファイルが見つかりません。", { 
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" } 
        });
      }

      // 2. ffmpeg.load() の実行
      await loadFFmpeg();

      // 3. データの仮想ファイルシステムへの書き込み
      const arrayBuffer = await videoFile.arrayBuffer();
      const inputName = 'input.mp4';
      const outputName = 'output.mp4';

      ffmpeg.FS('writeFile', inputName, new Uint8Array(arrayBuffer));

      // 4. 引数の組み立て (音声・等倍速の完全維持)
      const args = [
        '-i', inputName,
        '-vcodec', 'libx264',
        '-acodec', 'aac',
        '-b:v', `${bitrate}k`,
        '-b:a', '128k',
        '-pix_fmt', 'yuv420p',
        '-preset', 'fast',
        '-movflags', '+faststart'
      ];

      // 5MB（爆速・軽量）の場合は解像度を少し縮小 (縦横比維持で横640px)
      if (targetSize === 5) {
        args.push('-vf', 'scale=640:-2');
      }

      args.push(outputName);

      // 5. エンコード実行
      await ffmpeg.run(...args);

      // 6. 出力ファイルを仮想FSから読み出し
      const data = ffmpeg.FS('readFile', outputName);

      // 7. メモリクリーンアップ
      try {
        ffmpeg.FS('unlink', inputName);
        ffmpeg.FS('unlink', outputName);
      } catch (err) {
        console.warn("Cleanup FS error:", err);
      }

      // 8. 成果物の返却
      return new Response(data.buffer, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "video/mp4",
          "Content-Length": data.byteLength.toString()
        }
      });

    } catch (err) {
      console.error("Cloudflare Worker processing failed:", err);
      return new Response(`処理に失敗しました: ${err.message}`, { 
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" } 
      });
    }
  }
}
