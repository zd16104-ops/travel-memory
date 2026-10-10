/**
 * 轨迹解析器 — 统一模块
 * 借鉴 GPXSee 架构：一个格式一个解析器，统一输出 TrackData 数据模型。
 *
 * 数据模型（对应 GPXSee TrackData / Trackpoint）：
 *   TrackData = {
 *     name: string,            // 轨迹名称
 *     segments: [Segment],     // 段列表（保持文档顺序/录制顺序，不做贪婪重排序）
 *     distance: number,        // 总距离（米）
 *     format: string,          // 源格式 'KML' | 'GPX' | 'KMZ'
 *     whenCount: number,       // 时间戳数量
 *   }
 *
 *   Segment = [TrackPoint, ...]
 *
 *   TrackPoint = {
 *     lng: number,             // 经度
 *     lat: number,             // 纬度
 *     ele: number,             // 海拔（可选，默认 0）
 *     time: number | null,     // 时间戳毫秒（可选）
 *   }
 */

// ==================== TrackPoint ====================

function makePoint(lng, lat, ele = 0, time = null) {
  return { lng, lat, ele, time };
}

function isValidPoint(lng, lat) {
  return Number.isFinite(lng) && Number.isFinite(lat)
    && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
}

// ==================== 坐标文本解析 ====================

/**
 * 解析 KML 坐标文本 "lng,lat,ele lng,lat,ele ..."
 * 对应 GPXSee KMLParser::lineCoordinates()
 */
function parseCoordinatesText(text) {
  const points = [];
  const raw = String(text || '').trim();
  if (!raw) return points;

  const chunks = raw.split(/\s+/);
  for (const chunk of chunks) {
    const parts = chunk.split(',');
    if (parts.length < 2) continue;
    const lng = parseFloat(parts[0]);
    const lat = parseFloat(parts[1]);
    if (!isValidPoint(lng, lat)) continue;
    points.push(makePoint(lng, lat, parts[2] ? parseFloat(parts[2]) : 0));
  }
  return points;
}

// ==================== KML 解析器 ====================

/**
 * KML 解析器
 * 对应 GPXSee KMLParser — 使用 getElementsByTagName（命名空间安全），
 * 按文档顺序提取段，不做贪婪重排序。
 */
function parseKML(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid XML');
  }

  const segments = [];
  const waypoints = [];

  // ① 解析 <gx:Track>（两步路等 app 导出格式）
  //    getElementsByTagName 比 querySelectorAll('gx\\:Track') 更可靠
  const gxTracks = doc.getElementsByTagName('gx:Track');
  for (let ti = 0; ti < gxTracks.length; ti++) {
    const segment = parseGxTrack(gxTracks[ti]);
    if (segment.length > 1) segments.push(segment);
  }

  // ② 兜底：解析 <LineString> / <LinearRing>
  //    一个 LineString = 一个段，保持文档顺序
  if (segments.length === 0) {
    const lineStrings = doc.querySelectorAll('LineString, LinearRing');
    lineStrings.forEach(el => {
      const coordEl = el.querySelector('coordinates');
      if (coordEl) {
        const pts = parseCoordinatesText(coordEl.textContent);
        if (pts.length > 1) segments.push(pts);
      }
    });
  }

  // ③ 再兜底：裸 <coordinates>（不在 LineString 下）
  if (segments.length === 0) {
    doc.querySelectorAll('coordinates').forEach(el => {
      const pts = parseCoordinatesText(el.textContent);
      if (pts.length > 1) segments.push(pts);
    });
  }

  // ④ 提取路标点（startPoint / endPoint / realPoint 等）
  doc.querySelectorAll('Point coordinates').forEach(el => {
    const pts = parseCoordinatesText(el.textContent);
    if (pts[0]) waypoints.push(pts[0]);
  });

  // ⑤ 极端兜底：老 KML 散落坐标
  if (segments.length === 0) {
    const fallback = [];
    doc.querySelectorAll('coordinates').forEach(el => {
      fallback.push(...parseCoordinatesText(el.textContent));
    });
    if (fallback.length > 1) segments.push(fallback);
  }

  // 获取轨迹名称
  let name = '';
  const docName = doc.querySelector('Document > name');
  if (docName) name = docName.textContent.trim();
  if (!name) {
    const nm = doc.getElementsByTagName('name')[0];
    if (nm) name = nm.textContent.trim();
  }

  // 统计 when 元素数量
  const whenCount = doc.getElementsByTagName('when').length;

  return makeTrackData(name, segments, 'KML', whenCount, waypoints.length);
}

/**
 * 解析单个 <gx:Track> 元素内的轨迹点
 * 对应 GPXSee KMLParser::track()
 *
 * 处理方式：gx:coord 和 when 分别收集，按文档顺序索引配对。
 * （两步路 KML 中 gx:coord 在前，when 在后，但顺序一致）
 */
function parseGxTrack(trackEl) {
  const segment = [];

  // 收集所有坐标点
  const coordEls = trackEl.getElementsByTagName('gx:coord');
  const coords = [];
  for (let i = 0; i < coordEls.length; i++) {
    const parts = (coordEls[i].textContent || '').trim().split(/\s+/);
    if (parts.length >= 2) {
      const lng = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (isValidPoint(lng, lat)) {
        coords.push({
          lng, lat,
          ele: parts[2] ? parseFloat(parts[2]) : 0,
        });
      }
    }
  }

  // 收集所有时间戳
  const whenEls = trackEl.getElementsByTagName('when');
  const times = [];
  for (let i = 0; i < whenEls.length; i++) {
    const ms = Date.parse(whenEls[i].textContent);
    times.push(isNaN(ms) ? null : ms);
  }

  // 按索引配对
  const n = Math.min(coords.length, times.length);
  for (let i = 0; i < n; i++) {
    segment.push(makePoint(coords[i].lng, coords[i].lat, coords[i].ele, times[i]));
  }

  // 如果没有 when 元素，直接用坐标
  if (times.length === 0) {
    for (const c of coords) {
      segment.push(makePoint(c.lng, c.lat, c.ele, null));
    }
  }

  return segment;
}

// ==================== GPX 解析器 ====================

/**
 * GPX 解析器
 * 对应 GPXSee GPXParser — 按 trkseg 分段，保持文档顺序
 */
function parseGPX(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid XML');
  }

  const segments = [];
  const trkptTags = ['trkpt', 'rtept'];

  // 优先按 <trkseg> 分段
  doc.querySelectorAll('trkseg').forEach(segEl => {
    const segment = [];
    segEl.querySelectorAll('trkpt').forEach(el => {
      const lat = parseFloat(el.getAttribute('lat'));
      const lon = parseFloat(el.getAttribute('lon'));
      if (!isValidPoint(lon, lat)) return;
      const eleEl = el.querySelector('ele');
      const timeEl = el.querySelector('time');
      segment.push(makePoint(
        lon, lat,
        eleEl ? parseFloat(eleEl.textContent) : 0,
        timeEl ? Date.parse(timeEl.textContent) : null
      ));
    });
    if (segment.length > 1) segments.push(segment);
  });

  // 兜底：散落 trkpt / rtept
  if (segments.length === 0) {
    const segment = [];
    trkptTags.forEach(tag => {
      doc.querySelectorAll(tag).forEach(el => {
        const lat = parseFloat(el.getAttribute('lat'));
        const lon = parseFloat(el.getAttribute('lon'));
        if (!isValidPoint(lon, lat)) return;
        const eleEl = el.querySelector('ele');
        const timeEl = el.querySelector('time');
        segment.push(makePoint(
          lon, lat,
          eleEl ? parseFloat(eleEl.textContent) : 0,
          timeEl ? Date.parse(timeEl.textContent) : null
        ));
      });
    });
    if (segment.length > 1) segments.push(segment);
  }

  // 获取轨迹名称
  let name = '';
  const trkName = doc.querySelector('trk > name');
  if (trkName) name = trkName.textContent.trim();
  if (!name) {
    const nm = doc.getElementsByTagName('name')[0];
    if (nm) name = nm.textContent.trim();
  }

  return makeTrackData(name, segments, 'GPX', 0, 0);
}

// ==================== TrackData 工厂 ====================

function makeTrackData(name, segments, format, whenCount = 0, waypointCount = 0) {
  // 计算总距离（Haversine）
  let distance = 0;
  const R = 6371000;
  const rad = d => d * Math.PI / 180;

  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1], b = seg[i];
      const dLat = rad(b.lat - a.lat);
      const dLon = rad(b.lng - a.lng);
      const h = Math.sin(dLat / 2) ** 2
        + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
      distance += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }
  }

  // 总点数
  const totalPoints = segments.reduce((sum, s) => sum + s.length, 0);

  return {
    name,
    segments,
    distance: Math.round(distance * 100) / 100,
    totalPoints,
    format,
    whenCount,
    waypointCount,
  };
}

// ==================== 工具函数 ====================

function flattenPoints(trackData) {
  const result = [];
  for (const seg of trackData.segments) {
    for (const pt of seg) {
      result.push({ lng: pt.lng, lat: pt.lat });
    }
  }
  return result;
}

// Distribute totalPointCount across segments
function smoothSegments(trackData, totalPointCount) {
  // 为保持代码正文量，各段平均分配 500 / segments.length 个点
  const target = Math.max(120, Math.ceil(totalPointCount / Math.max(1, trackData.segments.length)));
  return trackData.segments.map(seg => smoothSegment(seg, target));
}

function smoothSegment(segment, targetCount) {
  if (segment.length >= targetCount || segment.length < 3) return segment.slice();

  // Catmull-Rom 插值
  const wrap = [...segment];
  const first = segment[0], last = segment[segment.length - 1];
  wrap.unshift(makePoint(first.lng * 2 - segment[1].lng, first.lat * 2 - segment[1].lat));
  wrap.push(makePoint(last.lng * 2 - segment[segment.length - 2].lng, last.lat * 2 - segment[segment.length - 2].lat));

  const perSegment = Math.ceil(targetCount / (segment.length - 1));
  const result = [];
  for (let i = 1; i < wrap.length - 2; i++) {
    const p0 = wrap[i - 1], p1 = wrap[i], p2 = wrap[i + 1], p3 = wrap[i + 2];
    const steps = (i === wrap.length - 3) ? 1 : perSegment;
    for (let t = 0; t < steps; t++) {
      const tt = t / steps;
      const tt2 = tt * tt, tt3 = tt2 * tt;
      result.push(makePoint(
        0.5 * ((2 * p1.lng) + (-p0.lng + p2.lng) * tt + (2 * p0.lng - 5 * p1.lng + 4 * p2.lng - p3.lng) * tt2 + (-p0.lng + 3 * p1.lng - 3 * p2.lng + p3.lng) * tt3),
        0.5 * ((2 * p1.lat) + (-p0.lat + p2.lat) * tt + (2 * p0.lat - 5 * p1.lat + 4 * p2.lat - p3.lat) * tt2 + (-p0.lat + 3 * p1.lat - 3 * p2.lat + p3.lat) * tt3)
      ));
    }
  }
  if (result.length === 0) result.push(makePoint(last.lng, last.lat));
  return result;
}

// Split segments by large jumps (for rendering distinct paths)
function splitByLargeJumps(trackData) {
  if (trackData.segments.length <= 1) return trackData.segments;

  // 如果只有一段，检查段内是否有大跳
  const segs = trackData.segments;
  const all = [];
  for (const s of segs) all.push(...s);

  // 投影到 Mercator 计算阈值
  const proj = all.map(p => ({
    x: p.lng * Math.PI / 180 * 6378137,
    y: 6378137 * Math.log(Math.tan(Math.PI / 4 + p.lat * Math.PI / 180 / 2))
  }));

  const dists = [];
  for (let i = 1; i < proj.length; i++) {
    dists.push(Math.hypot(proj[i].x - proj[i - 1].x, proj[i].y - proj[i - 1].y));
  }
  const sorted = dists.filter(d => d > 0).sort((a, b) => a - b);
  if (!sorted.length) return segs;
  const median = sorted[Math.floor(sorted.length / 2)];
  const xs = proj.map(p => p.x), ys = proj.map(p => p.y);
  const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const threshold = Math.max(median * 25, diagonal * 0.08);

  const parts = [[all[0]]];
  for (let i = 1; i < all.length; i++) {
    const d = Math.hypot(proj[i].x - proj[i - 1].x, proj[i].y - proj[i - 1].y);
    if (d > threshold && parts[parts.length - 1].length > 1) {
      parts.push([]);
    }
    parts[parts.length - 1].push(all[i]);
  }
  return parts.filter(p => p.length > 1);
}

// ==================== 格式分发 ====================

/**
 * 主入口 — 解析轨迹文件
 * 对应 GPXSee Data::Data(fileName)
 *
 * @param {File|{name:string, text:string}} file - 浏览器 File 对象或 {name, text}
 * @returns {Promise<TrackData|null>}
 */
async function parseTrackFile(file) {
  const name = (file.name || '').toLowerCase();
  let text;

  try {
    // 处理 KMZ（ZIP 压缩的 KML）
    if (name.endsWith('.kmz')) {
      if (!window.JSZip) throw new Error('JSZip 未加载，无法解压 KMZ');
      const buf = file.arrayBuffer ? await file.arrayBuffer() : file.buffer;
      const zip = await window.JSZip.loadAsync(buf);
      let kmlText = null;
      zip.forEach((relPath, entry) => {
        if (!kmlText && /\.kml$/i.test(relPath)) {
          kmlText = entry;
        }
      });
      if (!kmlText) throw new Error('KMZ 内未找到 .kml 文件');
      text = await kmlText.async('string');
    } else if (file.text) {
      // 浏览器 File 对象
      text = await file.text();
    } else if (typeof file === 'string') {
      text = file;
    } else {
      return null;
    }

    // KML
    if (name.endsWith('.kml') || name.endsWith('.kmz') || name.endsWith('.xml')) {
      return parseKML(text);
    }

    // GPX / TCX
    if (name.endsWith('.gpx') || name.endsWith('.tcx') || name.endsWith('.gpx+xml')) {
      return parseGPX(text);
    }

    // GeoJSON
    if (name.endsWith('.geojson') || name.endsWith('.json')) {
      try {
        const geo = JSON.parse(text);
        return parseGeoJSON(geo);
      } catch (e) {
        return null;
      }
    }

    // CSV / 纯文本坐标（lat,lng 格式）
    return parseCSV(text, name);
  } catch (e) {
    console.error('[TrackParser] 解析失败:', e.message);
    return null;
  }
}

function parseGeoJSON(geojson) {
  const segments = [];

  function walk(obj) {
    if (!obj) return;
    if (obj.type === 'LineString' && Array.isArray(obj.coordinates)) {
      const seg = [];
      for (const c of obj.coordinates) {
        if (c.length >= 2 && isValidPoint(c[0], c[1])) {
          seg.push(makePoint(c[0], c[1], c[2] || 0));
        }
      }
      if (seg.length > 1) segments.push(seg);
    }
    if (obj.type === 'MultiLineString' && Array.isArray(obj.coordinates)) {
      for (const line of obj.coordinates) {
        const seg = [];
        for (const c of line) {
          if (c.length >= 2 && isValidPoint(c[0], c[1])) {
            seg.push(makePoint(c[0], c[1], c[2] || 0));
          }
        }
        if (seg.length > 1) segments.push(seg);
      }
    }
    if (obj.features && Array.isArray(obj.features)) obj.features.forEach(walk);
    if (obj.geometry) walk(obj.geometry);
  }
  walk(geojson);

  const name = (geojson.properties && geojson.properties.name) || '';
  return makeTrackData(name, segments, 'GeoJSON');
}

function parseCSV(text, filename) {
  const lines = text.trim().split(/[\n\r]+/);
  const segment = [];
  for (const line of lines) {
    const parts = line.trim().split(/[,;\t\s]+/);
    if (parts.length >= 2) {
      const a = parseFloat(parts[0]), b = parseFloat(parts[1]);
      if (!isNaN(a) && !isNaN(b)) {
        // 判断 lat,lng 还是 lng,lat
        if (Math.abs(a) <= 180 && Math.abs(b) <= 90) {
          segment.push(makePoint(b, a));
        } else {
          segment.push(makePoint(a, b));
        }
      }
    }
  }
  const name = filename.replace(/\.[^.]+$/, '');
  return segment.length > 1
    ? makeTrackData(name, [segment], 'CSV')
    : null;
}

// ==================== 导出 ====================

// 浏览器环境
if (typeof window !== 'undefined') {
  window.TrackParser = {
    parseTrackFile,
    parseKML,
    parseGPX,
    parseGeoJSON,
    makeTrackData,
    makePoint,
    isValidPoint,
    parseCoordinatesText,
    flattenPoints,
    smoothSegments,
    smoothSegment,
    splitByLargeJumps,
  };
}

// ESM 导出（供 index.html: import * as TrackParser from '...' 使用）
// window.TrackParser 供 admin 页面（普通 script）使用
export {
  parseTrackFile,
  parseKML,
  parseGPX,
  parseGeoJSON,
  makeTrackData,
  makePoint,
  isValidPoint,
  parseCoordinatesText,
  flattenPoints,
  smoothSegments,
  smoothSegment,
  splitByLargeJumps,
};
