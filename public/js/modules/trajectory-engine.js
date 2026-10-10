/**
 * TrajectoryEngine — 轨迹识别引擎
 *
 * 完全参考 GPXSee (https://github.com/tumic0/GPXSee) 架构：
 *   - Parser 接口：每个格式一个解析器，统一输出 TrackData
 *   - TrackData = 段列表，段 = 点列表（段保持文档顺序，不贪婪重排序）
 *   - TrackPoint = 坐标 + 海拔 + 时间戳 + 可选指标
 *   - Parser Registry：扩展名 → 解析器映射
 *
 * 支持格式：KML (.kml), KMZ (.kmz), GPX (.gpx), TCX (.tcx), GeoJSON (.geojson/.json), CSV (.csv)
 *
 * 使用方式：
 *   <script src="trajectory-engine.js"></script>
 *   const engine = new TrajectoryEngine();
 *   const result = await engine.parse(file);  // File 对象
 *   // result = { tracks: [TrackData, ...], routes: [], waypoints: [] }
 */

// ═══════════════════════════════════════════════════════════════════════════
// 数据模型 — 对应 GPXSee TrackPoint / TrackData / Track
// ═══════════════════════════════════════════════════════════════════════════

/**
 * TrackPoint — 轨迹点
 * 对应 GPXSee Trackpoint
 * 可选字段用 null 表示"不存在"（对应 GPXSee 的 NAN 哨兵）
 */
class TrackPoint {
  constructor(lng, lat, ele = null, time = null) {
    this.lng = lng;         // 经度 (-180..180)
    this.lat = lat;         // 纬度 (-90..90)
    this.ele = ele;         // 海拔 (m)，null = 不存在
    this.time = time;       // 时间戳 (毫秒)，null = 不存在
    this.speed = null;      // 速度 (m/s)
    this.heartRate = null;  // 心率 (bpm)
    this.cadence = null;    // 踏频 (rpm)
    this.power = null;      // 功率 (W)
    this.temperature = null; // 温度 (°C)
  }

  hasElevation()  { return this.ele !== null; }
  hasTimestamp()  { return this.time !== null; }
  hasSpeed()      { return this.speed !== null; }
  hasHeartRate()  { return this.heartRate !== null; }
}

/**
 * Segment — 段 = 点数组
 * 对应 GPXSee SegmentData (typedef QVector<Trackpoint>)
 */
class Segment extends Array {
  // Array of TrackPoint
  get start() { return this[0]; }
  get end()   { return this[this.length - 1]; }

  /** 段长度（米，Haversine） */
  distance() {
    let d = 0;
    for (let i = 1; i < this.length; i++)
      d += TrackPoint_distance(this[i - 1], this[i]);
    return d;
  }
}

/**
 * TrackData — 轨迹 = 段列表
 * 对应 GPXSee TrackData (QList<SegmentData>)
 */
class TrackData {
  constructor(name = '') {
    this.name = name || '';          // 轨迹名称
    this.description = '';           // 描述
    this.segments = [];              // Segment[]
    this._file = '';                 // 源文件路径
  }

  /** 添加一个段 */
  addSegment(points) {
    if (points && points.length > 1) {
      this.segments.push(new Segment(...points));
    }
  }

  /** 总点数 */
  get totalPoints() {
    return this.segments.reduce((s, seg) => s + seg.length, 0);
  }

  /** 总距离（米） */
  get distance() {
    return this.segments.reduce((s, seg) => s + seg.distance(), 0);
  }

  /** 扁平化为点数组 [{lng, lat}, ...] */
  flatten() {
    const result = [];
    for (const seg of this.segments) {
      for (const pt of seg)
        result.push({ lng: pt.lng, lat: pt.lat });
    }
    return result;
  }

  /** 起止时间 */
  get startTime() {
    for (const seg of this.segments)
      for (const pt of seg)
        if (pt.time) return pt.time;
    return null;
  }
  get endTime() {
    for (let s = this.segments.length - 1; s >= 0; s--)
      for (let i = this.segments[s].length - 1; i >= 0; i--)
        if (this.segments[s][i].time) return this.segments[s][i].time;
    return null;
  }

  /** 海拔范围 */
  elevationRange() {
    let min = Infinity, max = -Infinity;
    for (const seg of this.segments) {
      for (const pt of seg) {
        if (pt.ele !== null) {
          if (pt.ele < min) min = pt.ele;
          if (pt.ele > max) max = pt.ele;
        }
      }
    }
    return min === Infinity ? null : { min, max, gain: Math.max(0, max - min) };
  }
}

/** Haversine 距离（米）—— 对应 GPXSee Coordinates::distanceTo() */
function TrackPoint_distance(a, b) {
  const R = 6371000;
  const rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ═══════════════════════════════════════════════════════════════════════════
// 坐标校验 — 对应 GPXSee Coordinates::isValid()
// ═══════════════════════════════════════════════════════════════════════════

function isValidCoord(lng, lat) {
  return Number.isFinite(lng) && Number.isFinite(lat)
    && Math.abs(lng) <= 180 && Math.abs(lat) <= 90
    && !(lng === 0 && lat === 0); // reject null-island
}

// ═══════════════════════════════════════════════════════════════════════════
// 坐标文本解析 — 对应 GPXSee KMLParser::lineCoordinates() / coord()
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 解析 KML 坐标文本 "lng,lat,ele lng,lat,ele ..."
 * 对应 GPXSee lineCoordinates() — 空格分隔三元组
 */
function parseLineCoordinates(text) {
  const points = [];
  const raw = String(text || '').trim();
  if (!raw) return points;

  const chunks = raw.split(/\s+/);
  for (const chunk of chunks) {
    const parts = chunk.split(',');
    if (parts.length < 2) continue;
    const lng = parseFloat(parts[0]);
    const lat = parseFloat(parts[1]);
    if (!isValidCoord(lng, lat)) continue;
    const ele = parts.length > 2 ? parseFloat(parts[2]) : null;
    points.push(new TrackPoint(lng, lat, isNaN(ele) ? null : ele));
  }
  return points;
}

/**
 * 解析 gx:coord 文本 "lng lat ele"
 * 对应 GPXSee coord() — 空格分隔（无逗号）
 */
function parseGxCoord(text) {
  const parts = String(text || '').trim().split(/\s+/);
  if (parts.length < 2) return null;
  const lng = parseFloat(parts[0]);
  const lat = parseFloat(parts[1]);
  if (!isValidCoord(lng, lat)) return null;
  const ele = parts.length > 2 ? parseFloat(parts[2]) : null;
  return new TrackPoint(lng, lat, isNaN(ele) ? null : ele);
}

// ═══════════════════════════════════════════════════════════════════════════
// Parser 接口 — 对应 GPXSee Parser (抽象基类)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ParseResult — 对应 GPXSee Data 对象的输出
 * 包含所有从文件中解析出的数据
 */
class ParseResult {
  constructor() {
    /** @type {TrackData[]} — 对应 GPXSee QList<TrackData> */
    this.tracks = [];
    /** @type {TrackPoint[]} — 路标点，对应 GPXSee QVector<Waypoint> */
    this.waypoints = [];
    /** @type {string} — 错误信息，无错误则为 null */
    this.error = null;
    /** @type {number} — 错误行号 */
    this.errorLine = 0;
  }

  get ok() { return this.error === null && this.tracks.length > 0; }
  get trackCount() { return this.tracks.length; }
  get totalPoints() { return this.tracks.reduce((s, t) => s + t.totalPoints, 0); }

  /** 合并另一个 ParseResult */
  merge(other) {
    this.tracks.push(...other.tracks);
    this.waypoints.push(...other.waypoints);
    if (!this.error) this.error = other.error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// KML 解析器 — 对应 GPXSee KMLParser
// ═══════════════════════════════════════════════════════════════════════════

class KMLParser {
  /**
   * parse(text) → ParseResult
   * 对应 GPXSee KMLParser::parse()
   */
  parse(text) {
    const result = new ParseResult();

    let doc;
    try {
      doc = new DOMParser().parseFromString(text, 'application/xml');
    } catch (e) {
      result.error = 'XML 解析失败: ' + e.message;
      return result;
    }
    if (doc.querySelector('parsererror')) {
      result.error = '无效的 XML 文档';
      return result;
    }

    // 查找 <kml> 根元素
    // 用 localName 比较避免 CSS querySelector 的命名空间兼容问题
    let kmlRoot = doc.documentElement;
    if (!kmlRoot || kmlRoot.localName !== 'kml') {
      const kmlNodes = doc.getElementsByTagName('kml');
      if (kmlNodes.length === 0) {
        result.error = '不是有效的 KML 文件';
        return result;
      }
      kmlRoot = kmlNodes[0];
    }

    // 递归处理 Document / Folder / Placemark
    // 对应 GPXSee kml() → document() → folder() → placemark()
    this._processContainer(kmlRoot, result);

    return result;
  }

  /** 对应 GPXSee kml() / document() / folder() */
  _processContainer(parent, result) {
    // 收集 Style 定义
    // （GPXSee 会存 StyleMap 用于后续渲染，这里仅跳过不做解析）

    const children = parent.children || parent.childNodes;
    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      if (el.nodeType !== 1) continue; // 跳过非元素节点

      switch (el.localName) {
        case 'Document':
        case 'Folder':
          this._processContainer(el, result);
          break;
        case 'Placemark':
          this._processPlacemark(el, result);
          break;
        case 'PhotoOverlay':
          this._processPhotoOverlay(el, result);
          break;
        // Style / StyleMap — 忽略（本引擎不处理颜色/图标）
      }
    }
  }

  /**
   * 对应 GPXSee placemark()
   *
   * 从 Placemark 中提取 trail/waypoint 数据。
   * 先累积名称/描述，再处理子元素，最后应用元数据到新创建的 tracks/waypoints。
   */
  _processPlacemark(el, result) {
    // 累积名称和描述（对应 GPXSee placemark 的 name/desc 变量）
    let name = '';
    let desc = '';
    const trackIdxBefore = result.tracks.length;
    const wptIdxBefore = result.waypoints.length;

    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i];

      switch (child.localName) {
        case 'name':
          name = (child.textContent || '').trim();
          break;
        case 'description':
          desc = (child.textContent || '').trim();
          break;

        // —— Track 元素 ——
        case 'LineString':
        case 'LinearRing':
          // 对应 GPXSee: 创建新 TrackData，添加一个 Segment
          {
            const coordEl = child.querySelector('coordinates');
            if (coordEl) {
              const pts = parseLineCoordinates(coordEl.textContent);
              if (pts.length > 1) {
                const track = new TrackData(name);
                track.description = desc;
                track.addSegment(pts);
                result.tracks.push(track);
              }
            }
          }
          break;

        case 'Track':
          // 对应 GPXSee: <gx:Track> — 带时间戳的密集轨迹点
          {
            const track = new TrackData(name);
            track.description = desc;
            const segment = this._parseGxTrack(child);
            if (segment && segment.length > 1) {
              track.addSegment(segment);
              result.tracks.push(track);
            }
          }
          break;

        case 'MultiTrack':
          // 对应 GPXSee multiTrack(): 每个 <Track> 子元素追加一个段
          {
            const track = new TrackData(name);
            track.description = desc;
            let hasData = false;
            const childTracks = child.getElementsByTagName('gx:Track');
            for (let ti = 0; ti < childTracks.length; ti++) {
              const segment = this._parseGxTrack(childTracks[ti]);
              if (segment && segment.length > 1) {
                track.addSegment(segment);
                hasData = true;
              }
            }
            if (hasData) result.tracks.push(track);
          }
          break;

        case 'MultiGeometry':
          // 对应 GPXSee multiGeometry()
          this._processMultiGeometry(child, name, desc, result);
          break;

        // —— Waypoint 元素 ——
        case 'Point':
          {
            const coordEl = child.querySelector('coordinates');
            if (coordEl) {
              const pts = parseLineCoordinates(coordEl.textContent);
              if (pts[0]) {
                const wpt = pts[0];
                // 应用元数据
                result.waypoints.push(wpt);
              }
            }
          }
          break;
      }
    }

    // 应用 name/desc 到新创建的 waypoints（对应 GPXSee placemark 末尾循环）
    for (let i = wptIdxBefore; i < result.waypoints.length; i++) {
      const wpt = result.waypoints[i];
      if (name) wpt.name = name;
      if (desc) wpt.description = desc;
    }
  }

  /**
   * 对应 GPXSee multiGeometry() — 包含混合内容（Point + LineString + Polygon）
   */
  _processMultiGeometry(el, name, desc, result) {
    let track = null;

    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i];

      switch (child.localName) {
        case 'Point':
          {
            const coordEl = child.querySelector('coordinates');
            if (coordEl) {
              const pts = parseLineCoordinates(coordEl.textContent);
              if (pts[0]) result.waypoints.push(pts[0]);
            }
          }
          break;

        case 'LineString':
          {
            const coordEl = child.querySelector('coordinates');
            if (coordEl) {
              const pts = parseLineCoordinates(coordEl.textContent);
              if (pts.length > 1) {
                if (!track) {
                  track = new TrackData(name);
                  track.description = desc;
                  result.tracks.push(track);
                }
                track.addSegment(pts);
              }
            }
          }
          break;
      }
    }
  }

  /**
   * 解析单个 <gx:Track> 元素内的轨迹点
   * 对应 GPXSee track()
   *
   * 处理 when/coord 交错或分开排列的两种情况。
   * when[i] 与 coord[i] 一一对应。
   */
  _parseGxTrack(el) {
    const points = [];

    // 收集所有 <when> 的时间戳
    const whenEls = el.getElementsByTagName('when');
    const times = [];
    for (let i = 0; i < whenEls.length; i++) {
      const ms = Date.parse(whenEls[i].textContent);
      times.push(isNaN(ms) ? null : ms);
    }

    // 收集所有 <gx:coord> 的坐标
    // 使用 getElementsByTagName（命名空间安全，对应 GPXSee 的 namespace-ignorant QXmlStreamReader）
    const coordEls = el.getElementsByTagName('gx:coord');
    for (let i = 0; i < coordEls.length; i++) {
      const pt = parseGxCoord(coordEls[i].textContent);
      if (!pt) continue;

      // 索引配对（对应 GPXSee track() 的 i 计数器）
      if (i < times.length && times[i] !== null) {
        pt.time = times[i];
      }
      points.push(pt);
    }

    // 处理 ExtendedData 中的运动指标（心率/踏频/功率等）
    // 对应 GPXSee extendedData() → schemaData()
    this._parseExtendedData(el, points);

    return points;
  }

  /**
   * 解析 ExtendedData 中的生物力学数据
   * 对应 GPXSee extendedData() → schemaData() → heartRate/cadence/speed/temperature/power
   */
  _parseExtendedData(el, segment) {
    const extData = el.querySelector('ExtendedData');
    if (!extData) return;

    // SchemaData — 包含 SimpleArrayData
    extData.querySelectorAll('SchemaData').forEach(schema => {
      schema.querySelectorAll('SimpleArrayData').forEach(arr => {
        const attrib = arr.getAttribute('name');
        if (!attrib) return;
        const name = attrib.toLowerCase();

        // 数据字段名映射
        const fieldMap = {
          'heartrate':    'heartRate',
          'cadence':      'cadence',
          'speed':        'speed',
          'temperature':  'temperature',
          'power':        'power',
        };
        const field = fieldMap[name];
        if (!field) return;

        // 按索引写入对应 TrackPoint
        const values = arr.querySelectorAll('value');
        for (let i = 0; i < Math.min(values.length, segment.length); i++) {
          const v = parseFloat(values[i].textContent);
          if (!isNaN(v)) segment[i][field] = v;
        }
      });
    });
  }

  /**
   * 对应 GPXSee photoOverlay() — 提取航点
   */
  _processPhotoOverlay(el, result) {
    let name = '';
    let imgPath = '';

    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i];
      switch (child.localName) {
        case 'name':
          name = (child.textContent || '').trim();
          break;
        case 'Icon': {
          const href = child.querySelector('href');
          if (href) imgPath = (href.textContent || '').trim();
          break;
        }
        case 'Point': {
          const coordEl = child.querySelector('coordinates');
          if (coordEl) {
            const pts = parseLineCoordinates(coordEl.textContent);
            if (pts[0]) {
              if (name) pts[0].name = name;
              if (imgPath) pts[0].image = imgPath;
              result.waypoints.push(pts[0]);
            }
          }
          break;
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GPX 解析器 — 对应 GPXSee GPXParser
// ═══════════════════════════════════════════════════════════════════════════

class GPXParser {
  /**
   * parse(text) → ParseResult
   * 对应 GPXSee GPXParser::parse()
   */
  parse(text) {
    const result = new ParseResult();

    let doc;
    try {
      doc = new DOMParser().parseFromString(text, 'application/xml');
    } catch (e) {
      result.error = 'XML 解析失败: ' + e.message;
      return result;
    }
    if (doc.querySelector('parsererror')) {
      result.error = '无效的 XML 文档';
      return result;
    }

    // 处理 <trk> 元素 — 对应 GPXSee gpx() → track() → trackpoints()
    this._parseTracks(doc, result);

    // 处理 <rte> 元素 — 对应 GPXSee routepoints()
    this._parseRoutes(doc, result);

    // 处理 <wpt> 元素 — 对应 GPXSee waypointData()
    this._parseWaypoints(doc, result);

    return result;
  }

  /**
   * 对应 GPXSee track() + trackpoints()
   * 每个 <trk> = 一个 TrackData，每个 <trkseg> = 一个 Segment
   */
  _parseTracks(doc, result) {
    doc.querySelectorAll('trk').forEach(trkEl => {
      const track = new TrackData();

      // 轨道名称
      const nameEl = trkEl.querySelector(':scope > name');
      if (nameEl) track.name = nameEl.textContent.trim();

      // 段 (<trkseg>)
      trkEl.querySelectorAll('trkseg').forEach(segEl => {
        const pts = [];
        segEl.querySelectorAll('trkpt').forEach(ptEl => {
          const lat = parseFloat(ptEl.getAttribute('lat'));
          const lon = parseFloat(ptEl.getAttribute('lon'));
          if (!isValidCoord(lon, lat)) return;

          const pt = new TrackPoint(lon, lat);

          // 海拔 — 对应 GPXSee trackpointData() → <ele>
          const eleEl = ptEl.querySelector('ele');
          if (eleEl) {
            const v = parseFloat(eleEl.textContent);
            if (!isNaN(v)) pt.ele = v;
          }

          // 时间戳 — 对应 GPXSee <time>
          const timeEl = ptEl.querySelector('time');
          if (timeEl) {
            const ms = Date.parse(timeEl.textContent);
            if (!isNaN(ms)) pt.time = ms;
          }

          // Garmin 扩展数据 — 对应 GPXSee tpExtension()
          this._parseGarminExtensions(ptEl, pt);

          pts.push(pt);
        });
        if (pts.length > 1) track.addSegment(pts);
      });

      // 兜底：散落的 trkpt（无 trkseg 包裹）
      if (track.segments.length === 0) {
        const pts = [];
        trkEl.querySelectorAll(':scope > trkpt').forEach(ptEl => {
          const lat = parseFloat(ptEl.getAttribute('lat'));
          const lon = parseFloat(ptEl.getAttribute('lon'));
          if (!isValidCoord(lon, lat)) return;
          pts.push(new TrackPoint(lon, lat));
        });
        if (pts.length > 1) track.addSegment(pts);
      }

      if (track.segments.length > 0) result.tracks.push(track);
    });
  }

  /**
   * Garmin TrackPointExtension
   * 对应 GPXSee trkptExtensions() → tpExtension()
   */
  _parseGarminExtensions(ptEl, pt) {
    const ext = ptEl.querySelector('extensions');
    if (!ext) return;
    const tpe = ext.querySelector('TrackPointExtension');
    const searchEl = tpe || ext;

    const fields = [
      ['heartRate', ['hr', 'heartrate'], parseFloat],
      ['cadence',   ['cad', 'cadence'], parseFloat],
      ['speed',     ['speed'], parseFloat],
      ['temperature', ['atemp', 'wtemp', 'temp'], parseFloat],
      ['power',     ['power', 'PowerInWatts'], parseFloat],
    ];

    for (const [prop, tags, fn] of fields) {
      for (const tag of tags) {
        const el = searchEl.querySelector(tag);
        if (el) {
          const v = fn(el.textContent);
          if (!isNaN(v)) pt[prop] = v;
          break;
        }
      }
    }
  }

  /**
   * 对应 GPXSee routepoints()
   */
  _parseRoutes(doc, result) {
    doc.querySelectorAll('rte').forEach(rteEl => {
      const pts = [];
      rteEl.querySelectorAll('rtept').forEach(ptEl => {
        const lat = parseFloat(ptEl.getAttribute('lat'));
        const lon = parseFloat(ptEl.getAttribute('lon'));
        if (isValidCoord(lon, lat))
          pts.push(new TrackPoint(lon, lat));
      });
      if (pts.length > 1) {
        const track = new TrackData();
        const nameEl = rteEl.querySelector(':scope > name');
        if (nameEl) track.name = nameEl.textContent.trim();
        track.addSegment(pts);
        result.tracks.push(track);
      }
    });
  }

  /**
   * 对应 GPXSee waypointData()
   */
  _parseWaypoints(doc, result) {
    doc.querySelectorAll('wpt').forEach(wptEl => {
      const lat = parseFloat(wptEl.getAttribute('lat'));
      const lon = parseFloat(wptEl.getAttribute('lon'));
      if (!isValidCoord(lon, lat)) return;

      const pt = new TrackPoint(lon, lat);
      const nameEl = wptEl.querySelector('name');
      if (nameEl) pt.name = nameEl.textContent.trim();

      result.waypoints.push(pt);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GeoJSON 解析器 — 对应 GPXSee GeoJSONParser
// ═══════════════════════════════════════════════════════════════════════════

class GeoJSONParser {
  parse(text) {
    const result = new ParseResult();

    let obj;
    try { obj = JSON.parse(text); }
    catch (e) { result.error = 'JSON 解析失败'; return result; }

    if (!obj) { result.error = '空数据'; return result; }

    this._walk(obj, result);
    return result;
  }

  _walk(obj, result) {
    if (!obj) return;

    // FeatureCollection
    if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) {
      obj.features.forEach(f => this._walkFeature(f, result));
      return;
    }

    // Feature
    if (obj.type === 'Feature') {
      this._walkFeature(obj, result);
      return;
    }

    // 直接几何
    if (obj.type === 'LineString' && Array.isArray(obj.coordinates)) {
      this._addLineString(obj.coordinates, result);
      return;
    }
    if (obj.type === 'MultiLineString' && Array.isArray(obj.coordinates)) {
      const track = new TrackData();
      let hasData = false;
      for (const line of obj.coordinates) {
        const pts = this._coordsToPoints(line);
        if (pts.length > 1) { track.addSegment(pts); hasData = true; }
      }
      if (hasData) result.tracks.push(track);
      return;
    }
    if (obj.type === 'Point' && Array.isArray(obj.coordinates)) {
      const c = obj.coordinates;
      if (isValidCoord(c[0], c[1]))
        result.waypoints.push(new TrackPoint(c[0], c[1], c[2] || null));
      return;
    }
  }

  _walkFeature(feature, result) {
    if (!feature) return;
    const name = (feature.properties && feature.properties.name) || '';
    const wptBefore = result.waypoints.length;

    if (feature.geometry) this._walk(feature.geometry, result);

    // 应用名称到新创建的 waypoints
    if (name) {
      for (let i = wptBefore; i < result.waypoints.length; i++)
        result.waypoints[i].name = name;
    }
  }

  _addLineString(coords, result) {
    const pts = this._coordsToPoints(coords);
    if (pts.length > 1) {
      const track = new TrackData();
      track.addSegment(pts);
      result.tracks.push(track);
    }
  }

  _coordsToPoints(coords) {
    const pts = [];
    for (const c of coords) {
      if (c.length >= 2 && isValidCoord(c[0], c[1]))
        pts.push(new TrackPoint(c[0], c[1], c[2] || null));
    }
    return pts;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CSV / 纯文本解析器 — 对应 GPXSee CSVParser / TXTParser
// ═══════════════════════════════════════════════════════════════════════════

class CSVParser {
  parse(text, filename = '') {
    const result = new ParseResult();
    const lines = text.trim().split(/[\n\r]+/);
    const pts = [];

    for (const line of lines) {
      const parts = line.trim().split(/[,;\t\s]+/);
      if (parts.length >= 2) {
        const a = parseFloat(parts[0]), b = parseFloat(parts[1]);
        if (!isNaN(a) && !isNaN(b)) {
          // 自动判断 lng,lat 还是 lat,lng
          const lng = (Math.abs(a) <= 180 && Math.abs(b) <= 90) ? a : b;
          const lat = (Math.abs(a) <= 180 && Math.abs(b) <= 90) ? b : a;
          if (isValidCoord(lng, lat))
            pts.push(new TrackPoint(lng, lat));
        }
      }
    }

    if (pts.length > 1) {
      const track = new TrackData(filename.replace(/\.[^.]+$/, ''));
      track.addSegment(pts);
      result.tracks.push(track);
    }
    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Parser Registry — 对应 GPXSee static parsers() 映射
// ═══════════════════════════════════════════════════════════════════════════

/**
 * TrajectoryEngine — 轨迹识别引擎入口
 * 对应 GPXSee Data 类 — facade/门面
 *
 * 使用方式:
 *   const engine = new TrajectoryEngine();
 *   const result = await engine.parse(file);
 */
class TrajectoryEngine {
  constructor() {
    // 解析器注册表 — 对应 GPXSee static QMultiMap parsers()
    /** @type {Map<string, object>} */
    this._parsers = new Map();
    this._parsers.set('kml', new KMLParser());
    this._parsers.set('kmz', new KMLParser());  // KMZ 解压后交给 KMLParser
    this._parsers.set('gpx', new GPXParser());
    this._parsers.set('tcx', new GPXParser());  // TCX 类似 GPX
    this._parsers.set('geojson', new GeoJSONParser());
    this._parsers.set('json', new GeoJSONParser());
  }

  /**
   * 解析文件 — 对应 GPXSee Data::Data(fileName)
   *
   * @param {File|{name:string, text:string}} file — 浏览器 File 对象 或 {name, text}
   * @returns {Promise<ParseResult>}
   */
  async parse(file) {
    const name = (file.name || '').toLowerCase();
    const ext = name.split('.').pop();

    let text;
    try {
      // KMZ 解压
      if (ext === 'kmz') {
        text = await this._unzipKMZ(file);
        if (!text) {
          const result = new ParseResult();
          result.error = 'KMZ 内未找到 KML 文件';
          return result;
        }
      } else if (file.text) {
        text = await file.text();
      } else {
        const result = new ParseResult();
        result.error = '不支持的文件类型';
        return result;
      }
    } catch (e) {
      const result = new ParseResult();
      result.error = '读取文件失败: ' + e.message;
      return result;
    }

    return this.parseText(text, ext);
  }

  /**
   * 从文本解析 — 按扩展名分发
   * 对应 GPXSee Data 构造函数中的 parser lookup
   */
  parseText(text, ext) {
    ext = ext.toLowerCase();

    // 精确匹配
    const parser = this._parsers.get(ext);
    if (parser) return parser.parse(text);

    // KML 可能是 .xml 扩展名
    if (ext === 'xml') return this._parsers.get('kml').parse(text);

    // 尝试 CSV
    const csvResult = new CSVParser().parse(text);
    if (csvResult.ok) return csvResult;

    const result = new ParseResult();
    result.error = '无法识别文件格式: .' + ext;
    return result;
  }

  /**
   * 解压 KMZ (ZIP 格式)
   * 对应 GPXSee KMLParser::parse() 中对 QZipReader 的处理
   */
  async _unzipKMZ(file) {
    // 需要 JSZip 库
    if (typeof JSZip === 'undefined') {
      throw new Error('需要 JSZip 库来解压 KMZ 文件。请引入 <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>');
    }

    let buf;
    if (file.arrayBuffer) {
      buf = await file.arrayBuffer();
    } else if (file.buffer) {
      buf = file.buffer;
    } else {
      throw new Error('无法读取文件内容');
    }

    const zip = await JSZip.loadAsync(buf);
    let kmlText = null;

    zip.forEach((relativePath, entry) => {
      if (!kmlText && /\.kml$/i.test(relativePath)) {
        kmlText = entry;
      }
    });

    if (!kmlText) return null;
    return await kmlText.async('string');
  }

  /**
   * 批量解析多个文件
   * @param {File[]} files
   * @returns {Promise<ParseResult>}
   */
  async parseMultiple(files) {
    const combined = new ParseResult();

    for (const file of files) {
      const r = await this.parse(file);
      if (r.ok) {
        combined.merge(r);
      } else if (r.error && !combined.error) {
        combined.error = file.name + ': ' + r.error;
      }
    }

    return combined;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 全局导出
// ═══════════════════════════════════════════════════════════════════════════

if (typeof window !== 'undefined') {
  window.TrajectoryEngine = TrajectoryEngine;
  window.TrackData = TrackData;
  window.TrackPoint = TrackPoint;
  window.Segment = Segment;
  window.ParseResult = ParseResult;
  window.KMLParser = KMLParser;
  window.GPXParser = GPXParser;
  window.GeoJSONParser = GeoJSONParser;
  window.CSVParser = CSVParser;
}

// ESM 导出
export {
  TrajectoryEngine,
  TrackData,
  TrackPoint,
  Segment,
  ParseResult,
  KMLParser,
  GPXParser,
  GeoJSONParser,
  CSVParser,
};
