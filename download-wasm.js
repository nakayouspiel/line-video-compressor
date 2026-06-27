import fs from 'fs';
import path from 'path';
import https from 'https';

const destDir = path.join(process.cwd(), 'public', 'ffmpeg');

// Ensure directory exists
if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

const files = [
  'ffmpeg-core.js',
  'ffmpeg-core.wasm',
  'ffmpeg-core.worker.js'
];

const baseUrl = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm';

function downloadFile(fileName) {
  const fileUrl = `${baseUrl}/${fileName}`;
  const filePath = path.join(destDir, fileName);
  
  console.log(`Downloading ${fileName} from unpkg...`);

  const request = (url) => {
    https.get(url, (response) => {
      // Handle redirect
      if (response.statusCode === 301 || response.statusCode === 302) {
        request(response.headers.location);
        return;
      }

      if (response.statusCode !== 200) {
        console.error(`Failed to download ${fileName}. Status code: ${response.statusCode}`);
        return;
      }

      const fileStream = fs.createWriteStream(filePath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        console.log(`Downloaded ${fileName} successfully!`);
      });
    }).on('error', (err) => {
      console.error(`Error downloading ${fileName}:`, err.message);
    });
  };

  request(fileUrl);
}

files.forEach(downloadFile);
