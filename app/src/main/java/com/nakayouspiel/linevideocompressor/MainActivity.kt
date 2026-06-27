package com.nakayouspiel.linevideocompressor

import android.content.ContentValues
import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.ReturnCode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            LineCompressorApp(
                onCompressStart = { window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) },
                onCompressEnd = { window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LineCompressorApp(
    onCompressStart: () -> Unit,
    onCompressEnd: () -> Unit
) {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()

    // App State
    var selectedVideoUri by remember { mutableStateOf<Uri?>(null) }
    var videoName by remember { mutableStateOf("") }
    var videoSizeMB by remember { mutableStateOf(0.0) }
    var videoDurationSec by remember { mutableStateOf(0.0) }

    var targetSizeMB by remember { mutableStateOf(30) } // デフォルト 30MB (高画質)
    var isCompressing by remember { mutableStateOf(false) }
    var elapsedSeconds by remember { mutableStateOf(0) }
    var isSuccess by remember { mutableStateOf<Boolean?>(null) }
    var outputSizeMB by remember { mutableStateOf(0.0) }

    // Calculated optimal video bitrate
    val calculatedBitrate = remember(videoDurationSec, targetSizeMB) {
        if (videoDurationSec <= 0.0) return@remember 1000
        val totalBitrate = (targetSizeMB * 8 * 1024) / videoDurationSec
        val videoBitrate = (totalBitrate - 128).toInt()
        videoBitrate.coerceIn(150, 4000)
    }

    // Video selector launcher
    val videoPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        
        val mimeType = context.contentResolver.getType(uri)
        if (mimeType == null || !mimeType.startsWith("video/")) {
            Toast.makeText(context, "動画ファイルを選んでね！", Toast.LENGTH_SHORT).show()
            return@rememberLauncherForActivityResult
        }

        selectedVideoUri = uri
        isSuccess = null
        elapsedSeconds = 0

        // Extract video info
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(context, uri)
            val durationStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
            videoDurationSec = (durationStr?.toDoubleOrNull() ?: 0.0) / 1000.0

            context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (cursor.moveToFirst()) {
                    videoName = cursor.getString(nameIndex) ?: "Selected Video"
                    val sizeBytes = cursor.getLong(sizeIndex)
                    videoSizeMB = sizeBytes.toDouble() / (1024.0 * 1024.0)
                }
            }
        } catch (e: Exception) {
            Toast.makeText(context, "動画の読み込みに失敗しました。", Toast.LENGTH_SHORT).show()
        } finally {
            retriever.release()
        }
    }

    // Custom Theme Colors (Dark Theme)
    val backgroundStart = Color(0xFF0F172A)
    val backgroundEnd = Color(0xFF1E293B)
    val cardBackground = Color(0xFF1E293B)
    val primaryColor = Color(0xFF10B981) // Green

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Brush.verticalGradient(listOf(backgroundStart, backgroundEnd)))
            .padding(16.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight()
                .padding(bottom = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Header Logo & Title
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(top = 16.dp)
            ) {
                Text(
                    text = "🎬 ライン動画ちっちゃ君",
                    color = Color.White,
                    fontSize = 24.sp,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center
                )
            }
            Text(
                text = "動画をLINEで送れるサイズに自動でぎゅっと圧縮！",
                color = Color.LightGray,
                fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(bottom = 16.dp)
            )

            if (!isCompressing && isSuccess == null) {
                // STEP 1: UPLOAD AREA
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .clickable { videoPickerLauncher.launch("video/*") },
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(containerColor = cardBackground)
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .border(2.dp, Color.DarkGray, RoundedCornerShape(16.dp)),
                        contentAlignment = Alignment.Center
                    ) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center,
                            modifier = Modifier.padding(16.dp)
                        ) {
                            Text(
                                text = "📤",
                                fontSize = 48.sp,
                                modifier = Modifier.padding(bottom = 8.dp)
                            )
                            Text(
                                text = if (selectedVideoUri == null) "動画をタップして選択" else "動画を選び直す",
                                color = Color.White,
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 16.sp
                            )
                            if (selectedVideoUri != null) {
                                Spacer(modifier = Modifier.height(12.dp))
                                Text(
                                    text = videoName,
                                    color = Color.LightGray,
                                    fontSize = 13.sp,
                                    textAlign = TextAlign.Center
                                )
                                Text(
                                    text = String.format("サイズ: %.1f MB  |  長さ: %d秒", videoSizeMB, videoDurationSec.toInt()),
                                    color = primaryColor,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold
                                )
                            }
                        }
                    }
                }

                // STEP 2: SETTINGS (ONLY WHEN SELECTED)
                AnimatedVisibility(visible = selectedVideoUri != null) {
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Text(
                            text = "ちっちゃさ（目標サイズ）の選択",
                            color = Color.White,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold
                        )

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            // Target size 30MB
                            Button(
                                onClick = { targetSizeMB = 30 },
                                shape = RoundedCornerShape(12.dp),
                                modifier = Modifier
                                    .weight(1f)
                                    .height(60.dp),
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = if (targetSizeMB == 30) primaryColor else Color(0xFF334155)
                                )
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text("高画質", fontWeight = FontWeight.Bold, color = Color.White)
                                    Text("30MB以内 (おすすめ)", fontSize = 10.sp, color = Color.White)
                                }
                            }

                            // Target size 5MB
                            Button(
                                onClick = { targetSizeMB = 5 },
                                shape = RoundedCornerShape(12.dp),
                                modifier = Modifier
                                    .weight(1f)
                                    .height(60.dp),
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = if (targetSizeMB == 5) primaryColor else Color(0xFF334155)
                                )
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text("爆速・軽量", fontWeight = FontWeight.Bold, color = Color.White)
                                    Text("5MB以内 (縮小)", fontSize = 10.sp, color = Color.White)
                                }
                            }
                        }

                        // Bitrate details
                        Text(
                            text = String.format("計算されたビットレート: %d kbps\n※目標サイズに収まるよう自動最適化されています。", calculatedBitrate),
                            color = Color.Gray,
                            fontSize = 11.sp,
                            lineHeight = 16.sp
                        )

                        Spacer(modifier = Modifier.height(8.dp))

                        // Trigger Button
                        Button(
                            onClick = {
                                val uri = selectedVideoUri ?: return@Button
                                isCompressing = true
                                isSuccess = null
                                onCompressStart()

                                coroutineScope.launch {
                                    val result = performCompression(
                                        context = context,
                                        inputUri = uri,
                                        targetSizeMB = targetSizeMB,
                                        bitrate = calculatedBitrate
                                    )
                                    isCompressing = false
                                    onCompressEnd()
                                    if (result != null) {
                                        isSuccess = true
                                        outputSizeMB = result.length().toDouble() / (1024.0 * 1024.0)
                                        Toast.makeText(context, "ギャラリーに保存しました！", Toast.LENGTH_LONG).show()
                                    } else {
                                        isSuccess = false
                                        Toast.makeText(context, "圧縮に失敗しました。", Toast.LENGTH_SHORT).show()
                                    }
                                }
                            },
                            shape = RoundedCornerShape(16.dp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(56.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = primaryColor)
                        ) {
                            Text("② ちっちゃくする！", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                        }
                    }
                }
            }

            // STEP 3: COMPRESSING PROGRESS
            if (isCompressing) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(containerColor = cardBackground)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        CircularProgressIndicator(color = primaryColor, strokeWidth = 4.dp)
                        Spacer(modifier = Modifier.height(24.dp))
                        Text("動画をちっちゃくしています...", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = "アプリを閉じたり、画面をオフにしないでください。\n(スリープ防止機能作動中)",
                            color = Color.LightGray,
                            fontSize = 11.sp,
                            textAlign = TextAlign.Center
                        )
                    }
                }
            }

            // STEP 4: COMPLETED
            if (isSuccess != null) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(containerColor = cardBackground)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        if (isSuccess == true) {
                            Text("✅", fontSize = 64.sp)
                            Spacer(modifier = Modifier.height(16.dp))
                            Text("ちっちゃくなった！", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                            Spacer(modifier = Modifier.height(8.dp))
                            Text("Movies/LineChiccha フォルダに保存されました。", color = Color.LightGray, fontSize = 12.sp, textAlign = TextAlign.Center)
                            
                            Spacer(modifier = Modifier.height(24.dp))
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(16.dp)
                            ) {
                                Card(
                                    modifier = Modifier.weight(1f),
                                    colors = CardDefaults.cardColors(containerColor = Color(0xFF334155))
                                ) {
                                    Column(
                                        modifier = Modifier.padding(12.dp),
                                        horizontalAlignment = Alignment.CenterHorizontally
                                    ) {
                                        Text("圧縮前", fontSize = 10.sp, color = Color.Gray)
                                        Text(String.format("%.1f MB", videoSizeMB), fontWeight = FontWeight.Bold, color = Color.White)
                                    }
                                }
                                Card(
                                    modifier = Modifier.weight(1f),
                                    colors = CardDefaults.cardColors(containerColor = Color(0xFF334155))
                                ) {
                                    Column(
                                        modifier = Modifier.padding(12.dp),
                                        horizontalAlignment = Alignment.CenterHorizontally
                                    ) {
                                        Text("圧縮後", fontSize = 10.sp, color = Color.Gray)
                                        Text(String.format("%.1f MB", outputSizeMB), fontWeight = FontWeight.Bold, color = primaryColor)
                                    }
                                }
                            }
                        } else {
                            Text("❌", fontSize = 64.sp)
                            Spacer(modifier = Modifier.height(16.dp))
                            Text("圧縮に失敗しました", color = Color.Red, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                            Spacer(modifier = Modifier.height(8.dp))
                            Text("別の動画や設定を試してください。", color = Color.LightGray, fontSize = 12.sp, textAlign = TextAlign.Center)
                        }

                        Spacer(modifier = Modifier.height(32.dp))
                        Button(
                            onClick = {
                                selectedVideoUri = null
                                isSuccess = null
                            },
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(50.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = primaryColor)
                        ) {
                            Text("別の動画をちっちゃくする", color = Color.White, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }
}

// Perform compression using FFmpegKit on Dispatchers.IO background thread
private suspend fun performCompression(
    context: Context,
    inputUri: Uri,
    targetSizeMB: Int,
    bitrate: Int
): File? = withContext(Dispatchers.IO) {
    try {
        // Create local temp cache workspace files
        val tempInputFile = File(context.cacheDir, "input_${System.currentTimeMillis()}.mp4")
        val tempOutputFile = File(context.cacheDir, "chiccha_out_${System.currentTimeMillis()}.mp4")

        // Copy source video stream to cache file
        context.contentResolver.openInputStream(inputUri)?.use { inputStream ->
            tempInputFile.outputStream().use { outputStream ->
                inputStream.copyTo(outputStream)
            }
        }

        // Construct ffmpeg execution command args
        val cmd = mutableListOf(
            "-y",
            "-i", tempInputFile.absolutePath,
            "-vcodec", "libx264",
            "-acodec", "aac",
            "-b:v", "${bitrate}k",
            "-b:a", "128k",
            "-pix_fmt", "yuv420p",
            "-preset", "fast",
            "-movflags", "+faststart"
        )

        // Rescale for 5MB constraint mode
        if (targetSizeMB == 5) {
            cmd.add("-vf")
            cmd.add("scale=640:-2")
        }

        cmd.add(tempOutputFile.absolutePath)

        // Run FFmpeg synchronously on IO thread
        val session = FFmpegKit.execute(cmd.toTypedArray())

        val returnCode = session.returnCode
        if (ReturnCode.isSuccess(returnCode)) {
            // Save final output file to MediaStore Video Gallery
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, "chiccha_${System.currentTimeMillis()}.mp4")
                put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/LineChiccha")
            }

            val galleryUri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
            galleryUri?.let { destUri ->
                resolver.openOutputStream(destUri)?.use { outputStream ->
                    tempOutputFile.inputStream().use { inputStream ->
                        inputStream.copyTo(outputStream)
                    }
                }
            }

            // Cleanup local temp cache files
            tempInputFile.delete()
            tempOutputFile.delete()

            return@withContext tempOutputFile
        } else {
            tempInputFile.delete()
            tempOutputFile.delete()
            return@withContext null
        }
    } catch (e: Exception) {
        e.printStackTrace()
        return@withContext null
    }
}
