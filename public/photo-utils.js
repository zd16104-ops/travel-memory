/**
 * 实况照片 / HEIC 自动转换工具
 * 透明集成到上传流程：HEIC→JPEG，动态照片→提取静态帧
 */

// ==================== 动态照片解析 ====================

/**
 * 检测是否为安卓动态照片（单文件 JPG 末尾嵌入了 MP4 视频）
 * 原理：读取 XMP 元数据中的 MicroVideoOffset / VideoLength，定位视频起始位置
 */
async function extractMotionPhoto(file) {
  if (!file.type.startsWith('image/')) return null;

  try {
    // 只读取前 128KB 查找 XMP（避免把整个文件解码为文本，大文件会卡）
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const headSize = Math.min(131072, bytes.byteLength);
    const text = new TextDecoder().decode(bytes.slice(0, headSize));

    // 查找 XMP 元数据
    const xmpStart = text.indexOf('<x:xmpmeta');
    if (xmpStart === -1) return null;

    const xmpEnd = text.indexOf('</x:xmpmeta>') + 12;
    if (xmpEnd < 12) return null;
    const xmp = text.slice(xmpStart, xmpEnd);

    // 尝试从 XMP 中提取视频长度
    let videoLength = 0;
    let match;

    // Google Motion Photo: Container:Directory → Item:Length
    match = xmp.match(/Item:Length="(\d+)"/);
    if (match) videoLength = parseInt(match[1]);

    // Google Camera 旧格式: GCamera:MicroVideoOffset
    if (!videoLength) {
      match = xmp.match(/GCamera:MicroVideoOffset="(\d+)"/);
      if (match) videoLength = parseInt(match[1]);
    }

    // OPPO: OpCamera:VideoLength
    if (!videoLength) {
      match = xmp.match(/OpCamera:VideoLength="(\d+)"/);
      if (match) videoLength = parseInt(match[1]);
    }

    // 如果都没找到，尝试搜索 MP4 头部特征码 ftyp（只在前 256KB 搜）
    if (!videoLength) {
      const searchSize = Math.min(262144, bytes.byteLength);
      const ftypIdx = indexOfBytes(bytes.slice(0, searchSize), [0x66, 0x74, 0x79, 0x70]); // "ftyp"
      if (ftypIdx > 0) {
        const mp4Start = ftypIdx - 4;
        videoLength = bytes.byteLength - mp4Start;
      }
    }

    if (isNaN(videoLength) || videoLength <= 0 || videoLength >= bytes.byteLength) return null;

    const imageSize = bytes.byteLength - videoLength;
    if (imageSize <= 0) return null;

    // 提取纯 JPG 部分
    const jpgBytes = bytes.slice(0, imageSize);
    const jpgBlob = new Blob([jpgBytes], { type: 'image/jpeg' });

    console.log('[动态照片] 已提取静态帧，原文件', (bytes.byteLength / 1024).toFixed(0) + 'KB',
                '→ JPG', (imageSize / 1024).toFixed(0) + 'KB');

    return jpgBlob;
  } catch (e) {
    console.warn('[动态照片] 解析失败:', e.message);
    return null;
  }
}

/** 在 Uint8Array 中查找字节序列 */
function indexOfBytes(haystack, needle) {
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

// ==================== HEIC 转换 ====================

let heicToReady = false;
let heicToLoading = false;

/** 懒加载 heic-to 库（只在需要时下载 3MB WASM） */
async function ensureHeicTo() {
  if (heicToReady) return;
  if (heicToLoading) {
    // 等待正在进行的加载
    return new Promise(resolve => {
      const check = setInterval(() => { if (heicToReady) { clearInterval(check); resolve(); } }, 100);
    });
  }
  heicToLoading = true;
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = '/heic-to.iife.js';
    script.onload = () => { heicToReady = true; heicToLoading = false; resolve(); };
    script.onerror = () => { heicToLoading = false; resolve(); };
    document.head.appendChild(script);
  });
}

/**
 * 将 HEIC 文件转为 JPEG Blob
 * @param {File|Blob} file - HEIC 文件
 * @param {number} quality - JPEG 质量 0-1
 * @returns {Promise<Blob>} JPEG Blob
 */
async function convertHeicToJpeg(file, quality = 0.9) {
  await ensureHeicTo();
  if (!heicToReady) {
    console.warn('[HEIC] heic-to 库加载失败，跳过转换');
    return null;
  }
  try {
    const jpegBlob = await HeicTo({ blob: file, type: 'image/jpeg', quality });
    console.log('[HEIC] 已转为 JPEG，', (jpegBlob.size / 1024).toFixed(0) + 'KB');
    return jpegBlob;
  } catch (e) {
    console.warn('[HEIC] 转换失败:', e.message);
    return null;
  }
}

// ==================== 统一入口 ====================

/**
 * 处理上传的图片文件，自动识别并转换 HEIC / 动态照片
 * @param {File} file - 原始文件
 * @returns {Promise<{blob: Blob, converted: boolean, type: string}>}
 */
async function autoConvertPhoto(file) {
  // 1. HEIC 检测（检查文件名后缀）
  const name = file.name.toLowerCase();
  const isHeic = name.endsWith('.heic') || name.endsWith('.heif');

  if (isHeic) {
    const jpeg = await convertHeicToJpeg(file);
    if (jpeg) return { blob: jpeg, converted: true, type: 'heic' };
  }

  // 2. 动态照片检测（JPG 文件内嵌 MP4）
  if (file.type === 'image/jpeg' || name.endsWith('.jpg') || name.endsWith('.jpeg')) {
    const jpg = await extractMotionPhoto(file);
    if (jpg) return { blob: jpg, converted: true, type: 'motion' };
  }

  // 3. 普通图片，原样返回
  return { blob: file, converted: false, type: 'normal' };
}
