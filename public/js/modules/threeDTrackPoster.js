/**
 * ============================================================================
 *  3D 轨迹视觉海报生成器  (3D Track Poster Generator)
 *  ---------------------------------------------------------------------------
 *  完全独立的 ES6 模块，零外部 3D 库（手写 Mercator 投影 / Catmull-Rom 插值 /
 *  mat4 透视相机 / WebGL 三角带幕墙）。仅可选复用全局 window.Coloris 调色盘。
 *
 *  设计目标：
 *    - 命名空间隔离：所有 DOM / 样式以 `t3d-` 前缀，类实例封装全部状态，
 *      不污染、不依赖宿主页面的图片模板功能。
 *    - 风格一致：玻璃态面板 + 玻璃态滑块（原生 CSS，backdrop-filter）。
 *    - 实时闭环：滑块 input → 更新 uniform → requestAnimationFrame 重绘。
 *
 *  用法：
 *    import { ThreeDTrackPoster } from './js/modules/threeDTrackPoster.js';
 *    new ThreeDTrackPoster(document.getElementById('mount')).init();
 * ============================================================================
 */

import Tracker from './tracker.js';

export class ThreeDTrackPoster {
  /**
   * @param {HTMLElement} mountEl 挂载容器（模块会在其中构建全部 UI）
   * @param {object} [opts]
   */
  constructor(mountEl, opts = {}) {
    if (!mountEl) throw new Error('[ThreeDTrackPoster] 需要一个挂载容器');
    this.root = mountEl;
    this.opts = opts;

    // —— 渲染参数（uniform 的 JS 镜像）——
    this.state = {
      pitch: 55,            // 俯仰角（度）
      yaw: -25,             // 偏航角（度）
      rotationSpeed: 30,    // 自动旋转速度（度/秒）
      zoom: 1.0,            // 缩放（相机距离的倒数因子）
      wallHeight: 0.55,     // 幕墙高度比例
      gradientPower: 2.2,   // 渐变指数（shader pow 指数）
      trackWidth: 0.012,    // 轨迹带半宽（世界单位，GPU 挤出宽度）
      glow: 0.6,            // 轨迹边缘发光强度 0..1（增强 shader 默认更亮）
      shadowOpacity: 0.20,  // 阴影浓度上限 0..0.5
      shadowAngle: -45,     // 阳光角度（度），影响阴影投影方向
      maxOpacity: 0.95,     // 幕墙顶部最大不透明度（固定）
      wallColor: [0.984, 0.573, 0.235],  // 3D幕墙颜色，默认 #fb923c
      trackColor: [0.984, 0.573, 0.235], // 2D轨迹带颜色，默认 #fb923c
      // —— 轨迹带始终单色（热力模式已移除，保留 dummy 值供 shader uniform）——
      coldColor: [0,0,0],
      hotColor: [0,0,0],
      // —— 数据文字排版 ——
      fontColor: '#ffffff',  // 所有文字 CSS 颜色
      fontSize: 30,          // 数值字号(px)，标签按 0.4 倍联动缩放
      labels: { distance: '距离', gain: '累计爬升', duration: '移动时间' },
      bgDarken: false,      // 背景图片变暗效果
      brandText: '',         // 底部品牌/俱乐部文字
      showMilestones: {      // 独立控制每面旗帜的显示
        peak: true,
        half: true,
        speed: true,
        gradient: true,
      },
      customMetrics: [],     // [{label:'卡路里', value:'3200 kcal'}]
    };

    // —— 几何 / 数据 ——
    this.wallVertexCount = 0;
    this.trackVertexCount = 0;
    this.stats = null;        // {distanceKm, gainM, durationSec, maxEle, points}
    this.milestones = null;   // {peak:{x,z,hf,ele}|null, half:{x,z,hf,distKm}} 世界坐标里程碑
    this.trackName = '';
    this._rawPts = null;     // 原始轨迹点（热力模式切换时重建几何用）
    this.bgImage = null;      // HTMLImageElement 背景风景图
    this._bgUrl = null;       // 背景图 objectURL（用于及时回收）
    this._brandEdited = false; // 用户是否手动改过底部品牌文字

    // —— WebGL 句柄 ——
    this.gl = null;
    this.program = null;
    this.loc = {};            // attrib / uniform 位置
    this.buffers = {};        // 顶点缓冲

    // —— 复用的矩阵（避免每帧 GC）——
    this._proj = new Float32Array(16);
    this._view = new Float32Array(16);
    this._mvp = new Float32Array(16);

    this._startTime = performance.now();
    this._rafPending = false;
    this._rotating = false;       // 自动旋转状态
    this._rotationRAF = null;     // 旋转动画帧 ID
    this._recordingFullscreen = false;
    this._fullscreenChangeHandler = () => this._handleFullscreenChange();
    this._injectedStyleId = 't3d-styles';
  }

  // ==========================================================================
  //  初始化
  // ==========================================================================
  init() {
    this._injectStyles();
    this._buildDOM();
    this._initGL();
    this._bindControls();
    this._bindFileZone();
    this._bindImageUpload();
    this._initColoris();
    this._bindTextControls();
    this._applyTextStyle();
    this._bindCanvasInteraction();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    // 初始化埋点（复用全局 Tracker 实例，若未创建则新建）
    this.tracker = window._tracker || new Tracker({ debug: false });
    if (!window._tracker) window._tracker = this.tracker;
    this.requestRender();
    return this;
  }

  // ==========================================================================
  //  样式注入（仅一次；全部以 .t3d- 前缀作用域隔离）
  // ==========================================================================
  _injectStyles() {
    if (document.getElementById(this._injectedStyleId)) return;
    const css = `
.t3d-wrap{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;
  font-family:'Nunito','PingFang SC','Microsoft YaHei',sans-serif;color:rgba(255,252,248,0.98);}
.t3d-stage{position:relative;flex:1 1 460px;min-width:320px;border-radius:24px;overflow:hidden;
  background:radial-gradient(120% 120% at 50% 0%,rgba(40,44,60,0.55),rgba(10,11,16,0.75));
  border:1px solid rgba(255,255,255,0.10);box-shadow:0 8px 32px rgba(0,0,0,0.35),inset 0 1px 0 rgba(255,255,255,0.05);
  aspect-ratio:3/4;cursor:grab;touch-action:none;
  /* 三层 drop-shadow 霓虹光晕（匹配导出时的 Canvas shadowBlur 效果） */
  filter:drop-shadow(0 0 16px rgba(251,146,60,0.70))
         drop-shadow(0 0 42px rgba(251,146,60,0.30))
         drop-shadow(0 -2px 22px rgba(255,220,180,0.20));}
.t3d-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;}
.t3d-annot{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;z-index:3;}
.t3d-checkrow{display:flex;align-items:center;}
.t3d-check{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;
  color:rgba(255,252,248,0.86);user-select:none;}
.t3d-check input{width:15px;height:15px;accent-color:#fb923c;cursor:pointer;}
.t3d-metric-row{display:flex;align-items:center;gap:6px;margin:4px 0;}
.t3d-metric-row input{flex:1;min-width:0;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:8px;color:rgba(255,252,248,0.95);padding:4px 8px;font-size:0.7rem;font-family:inherit;}
.t3d-metric-row input:focus{border-color:rgba(251,146,60,0.5);outline:none;}
.t3d-metric-row .t3d-rm-btn{background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:0.85rem;padding:0 2px;}
.t3d-metric-row .t3d-rm-btn:hover{color:#ef4444;}
.t3d-stage.dragging{cursor:grabbing;}
.t3d-stage.t3d-recording{cursor:none;filter:none;border:0;border-radius:0;box-shadow:none;}
.t3d-stage:fullscreen,.t3d-stage:-webkit-full-screen{width:100vw!important;height:100vh!important;
  min-width:0;max-width:none;flex:none;aspect-ratio:auto;border:0;border-radius:0;box-shadow:none;
  background:#0a0b10;}
.t3d-empty{position:absolute;inset:0;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;
  pointer-events:none;color:rgba(255,252,248,0.55);font-size:14px;text-align:center;padding:24px;transition:opacity .3s;}
.t3d-empty .big{font-size:40px;opacity:.8;}

/* —— 玻璃态侧边面板 —— */
.t3d-panel{flex:0 0 308px;max-width:340px;display:flex;flex-direction:column;gap:16px;padding:20px;border-radius:24px;
  background:rgba(18,18,18,0.50);border:1px solid rgba(255,255,255,0.10);
  box-shadow:0 8px 32px rgba(0,0,0,0.30),inset 0 1px 0 rgba(255,255,255,0.05);
  backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);}
.t3d-title{font-size:16px;font-weight:800;letter-spacing:.3px;display:flex;align-items:center;gap:8px;}
.t3d-title .dot{width:9px;height:9px;border-radius:50%;background:linear-gradient(135deg,#fb923c,#f472b6);box-shadow:0 0 10px #fb923c;}
.t3d-sub{font-size:12px;color:rgba(255,252,248,0.55);margin-top:-8px;}

/* —— 拖拽上传区 —— */
.t3d-drop{position:relative;border:1.6px dashed rgba(255,255,255,0.28);border-radius:16px;padding:16px 14px;
  text-align:center;cursor:pointer;transition:.2s;background:rgba(255,255,255,0.04);}
.t3d-drop:hover{border-color:rgba(251,146,60,0.6);background:rgba(251,146,60,0.06);}
.t3d-drop.drag{border-color:#fb923c;background:rgba(251,146,60,0.12);transform:scale(1.01);}
.t3d-drop .ico{font-size:24px;}
.t3d-drop .t{font-size:13px;font-weight:700;margin-top:4px;}
.t3d-drop .h{font-size:11px;color:rgba(255,252,248,0.55);margin-top:2px;}
.t3d-drop input{display:none;}
.t3d-loaded{font-size:11.5px;color:#4ade80;margin-top:6px;word-break:break-all;}

/* —— 控件分组 —— */
.t3d-group{display:flex;flex-direction:column;gap:13px;}
.t3d-ctrl{display:flex;flex-direction:column;gap:6px;}
.t3d-ctrl .lab{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;font-weight:700;}
.t3d-ctrl .val{font-size:11.5px;font-weight:600;color:#fb923c;font-variant-numeric:tabular-nums;}

/* —— 玻璃态滑块 —— */
.t3d-range{-webkit-appearance:none;appearance:none;width:100%;height:22px;background:transparent;cursor:pointer;}
.t3d-range::-webkit-slider-runnable-track{height:6px;border-radius:6px;
  background:linear-gradient(90deg,rgba(251,146,60,0.85),rgba(244,114,182,0.55)),rgba(255,255,255,0.10);
  background-blend-mode:overlay;box-shadow:inset 0 1px 2px rgba(0,0,0,0.4),0 1px 0 rgba(255,255,255,0.06);}
.t3d-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:18px;height:18px;margin-top:-6px;border-radius:50%;
  background:radial-gradient(circle at 35% 30%,rgba(255,255,255,0.95),rgba(230,230,235,0.7) 60%,rgba(200,200,210,0.5));
  border:1px solid rgba(255,255,255,0.7);box-shadow:0 2px 6px rgba(0,0,0,0.45),0 0 0 4px rgba(251,146,60,0.18),
    inset 0 1px 1px rgba(255,255,255,0.9);transition:box-shadow .15s,transform .1s;}
.t3d-range:active::-webkit-slider-thumb{transform:scale(1.12);box-shadow:0 2px 8px rgba(0,0,0,0.5),0 0 0 6px rgba(251,146,60,0.28);}
.t3d-range::-moz-range-track{height:6px;border-radius:6px;background:rgba(255,255,255,0.14);}
.t3d-range::-moz-range-progress{height:6px;border-radius:6px;background:linear-gradient(90deg,#fb923c,#f472b6);}
.t3d-range::-moz-range-thumb{width:17px;height:17px;border-radius:50%;border:1px solid rgba(255,255,255,0.7);
  background:radial-gradient(circle at 35% 30%,#fff,#cfcfd6);box-shadow:0 2px 6px rgba(0,0,0,0.45);}

/* —— 颜色行 —— */
.t3d-colorrow{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px;font-weight:700;}
.t3d-colorrow input[type=text]{width:30px;height:30px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);
  background:transparent;color:transparent;cursor:pointer;font-size:0;padding:0;caret-color:transparent;}

.t3d-select{width:100%;padding:7px 10px;border-radius:9px;font-size:12.5px;font-weight:600;
  background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
  color:rgba(255,252,248,0.95);font-family:inherit;cursor:pointer;appearance:none;
  -webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='rgba(255,252,248,0.4)'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 10px center;padding-right:28px;}
.t3d-select:focus{outline:none;border-color:rgba(251,146,60,0.5);}
.t3d-select option{background:#1a1c22;color:rgba(255,252,248,0.95);}
.t3d-heatrow{display:flex;flex-direction:column;gap:9px;}

/* —— 按钮 —— */
.t3d-actions{display:flex;flex-direction:column;gap:9px;}
.t3d-btn{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;padding:11px;border-radius:13px;
  font-size:13.5px;font-weight:800;cursor:pointer;border:1px solid rgba(255,255,255,0.12);transition:.18s;
  background:rgba(255,255,255,0.06);color:rgba(255,252,248,0.98);}
.t3d-btn:hover{background:rgba(255,255,255,0.12);}
.t3d-btn.rotating{background:rgba(74,222,128,0.18);border-color:rgba(74,222,128,0.55);color:#4ade80;
  box-shadow:0 0 14px rgba(74,222,128,0.35);animation:t3d-pulse 1.2s ease-in-out infinite;}
.t3d-btn.recording-ready{background:rgba(251,146,60,0.14);border-color:rgba(251,146,60,0.50);color:#fdba74;
  box-shadow:0 0 14px rgba(251,146,60,0.22);}
@keyframes t3d-pulse{0%,100%{box-shadow:0 0 8px rgba(74,222,128,0.25);}50%{box-shadow:0 0 20px rgba(74,222,128,0.55);}}
.t3d-btn.primary{background:linear-gradient(135deg,#fb923c,#f472b6);border-color:transparent;color:#1a1014;
  box-shadow:0 6px 18px rgba(251,146,60,0.35);}
.t3d-btn.primary:hover{filter:brightness(1.06);}
.t3d-btn:disabled{opacity:.4;cursor:not-allowed;}

/* —— 数据徽标 —— */
.t3d-stats{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;}
.t3d-stats span{padding:4px 9px;border-radius:9px;background:rgba(255,255,255,0.07);
  border:1px solid rgba(255,255,255,0.08);font-weight:700;}
.t3d-stats b{color:#fb923c;}
/* —— 舞台背景图层（垫在透明 WebGL 画布之下，3D 轨迹后方透出）—— */
.t3d-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;}
/* —— 上传背景图按钮区 —— */
.t3d-imgrow{display:flex;flex-direction:column;gap:7px;}
.t3d-imghint{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;
  color:#4ade80;background:rgba(74,222,128,0.08);border:1px solid rgba(74,222,128,0.22);
  border-radius:10px;padding:6px 10px;}
.t3d-imghint .name{word-break:break-all;}
.t3d-imghint .clr{cursor:pointer;color:rgba(255,255,255,0.6);font-weight:800;flex-shrink:0;padding:0 3px;}
.t3d-imghint .clr:hover{color:#ff5252;}
/* —— 数据文字预览图层（叠在 3D 画布之上，指针穿透不挡 3D 交互）—— */
.t3d-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:space-between;padding:8% 6% 6%;pointer-events:none;z-index:4;text-align:center;
  font-family:'Nunito','PingFang SC',sans-serif;color:#fff;opacity:0;transition:opacity .3s;}
.t3d-metrics{display:flex;flex-direction:column;align-items:center;gap:14px;}
.t3d-metrics .metric{display:flex;flex-direction:column;align-items:center;line-height:1.04;}
.t3d-metrics .label{font-weight:400;opacity:0.92;letter-spacing:.5px;text-shadow:0 1px 4px rgba(0,0,0,0.6);}
.t3d-metrics .value{font-weight:800;text-shadow:0 2px 9px rgba(0,0,0,0.55);}
.t3d-brand{font-weight:400;letter-spacing:1.5px;opacity:0.95;text-shadow:0 1px 6px rgba(0,0,0,0.65);}
/* —— 文字排版控制分组 —— */
.t3d-textgroup{display:flex;flex-direction:column;gap:11px;}
.t3d-grp-title{font-size:12.5px;font-weight:800;opacity:.85;margin-bottom:-2px;}
.t3d-tin{width:100%;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
  border-radius:9px;padding:7px 10px;color:rgba(255,252,248,0.95);font-size:12.5px;font-family:inherit;}
.t3d-tin::placeholder{color:rgba(255,252,248,0.4);}
.t3d-tin:focus{outline:none;border-color:rgba(251,146,60,0.5);background:rgba(255,255,255,0.09);}
.t3d-labelrow{display:flex;align-items:center;gap:9px;}
.t3d-labelrow .k{font-size:11px;color:rgba(255,252,248,0.5);width:34px;flex-shrink:0;}
@media(max-width:760px){
  .t3d-wrap{gap:12px;align-items:flex-start;}
  .t3d-stage{flex:0 0 auto;width:100%;min-width:0;border-radius:16px;}
  .t3d-panel{flex:1 1 100%;width:100%;max-width:none;padding:14px;border-radius:16px;gap:14px;}
  .t3d-range{height:44px;}
  .t3d-range::-webkit-slider-thumb{width:24px;height:24px;margin-top:-9px;}
  .t3d-range::-moz-range-thumb{width:22px;height:22px;}
  .t3d-btn{min-height:44px;padding:10px 8px;font-size:12.5px;}
  .t3d-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;}
  .t3d-actions .t3d-ctrl{grid-column:1/-1;}
  .t3d-check input{width:20px;height:20px;}
  .t3d-checkrow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 10px;}
  .t3d-checkrow .t3d-grp-title{grid-column:1/-1;}
  .t3d-checkrow .t3d-check{min-height:40px;}
}
`;
    const style = document.createElement('style');
    style.id = this._injectedStyleId;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ==========================================================================
  //  DOM 构建
  // ==========================================================================
  _buildDOM() {
    const uid = 't3d_' + Math.random().toString(36).slice(2, 7);
    this.uid = uid;
    this.root.innerHTML = `
<div class="t3d-wrap">
  <div class="t3d-stage">
    <img class="t3d-bg" id="${uid}_bg" alt="">
    <canvas class="t3d-canvas" id="${uid}_cv"></canvas>
    <canvas class="t3d-annot" id="${uid}_annot"></canvas>
    <div class="t3d-empty" id="${uid}_empty">
      <div class="big">🏔️</div>
      <div>拖入 GPX / KML / KMZ 轨迹文件<br><span style="font-size:11px;opacity:0.55;">GPX 格式包含高度数据，3D 效果更佳</span></div>
    </div>
    <div class="t3d-overlay" id="${uid}_overlay">
      <div class="t3d-metrics">
        <div class="metric"><div class="label" data-k="distance">距离</div><div class="value" data-k="distance">--</div></div>
        <div class="metric"><div class="label" data-k="gain">累计爬升</div><div class="value" data-k="gain">--</div></div>
        <div class="metric"><div class="label" data-k="duration">移动时间</div><div class="value" data-k="duration">--</div></div>
      </div>
      <div class="t3d-brand" id="${uid}_brand"></div>
    </div>
  </div>
  <div class="t3d-panel glass-keep">
    <div>
      <div class="t3d-title"><span class="dot"></span>3D 轨迹海报</div>
      <div class="t3d-sub" style="display:none"></div>
    </div>

    <label class="t3d-drop" id="${uid}_drop">
      <div class="ico">📁</div>
      <div class="t">拖拽或点击上传轨迹文件</div>
      <div class="h">GPX / KML / KMZ / TCX / FIT / GeoJSON<br><b>推荐 GPX</b>（含高度数据，3D 幕墙更立体）</div>
      <div class="t3d-loaded" id="${uid}_loaded"></div>
      <input type="file" id="${uid}_file" accept=".gpx,.kml,.kmz,.tcx,.fit,.geojson,.json,application/gpx+xml,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/octet-stream,image/*" multiple>
    </label>

    <div class="t3d-imgrow">
      <button class="t3d-btn" id="${uid}_imgbtn">🖼️ 上传背景图片</button>
      <div class="t3d-imghint" id="${uid}_imghint" style="display:none;">
        <span class="name"></span>
        <span class="clr" id="${uid}_imgclear" title="移除背景图">✕</span>
      </div>
      <input type="file" id="${uid}_imgfile" accept="image/*" hidden>
    </div>
    <div class="t3d-ctrl t3d-imgrow" style="margin-top:-2px;">
      <label class="t3d-check"><input type="checkbox" id="${uid}_bgDarken"><span>🌙 背景变暗（导出时）</span></label>
    </div>

    <div class="t3d-stats" id="${uid}_stats" style="display:none;"></div>

    <div class="t3d-actions">
      ${this._sliderHTML(uid, 'rotationSpeed', '旋转速度 Speed', 5, 60, 5, this.state.rotationSpeed, '°/秒')}
      <button class="t3d-btn" id="${uid}_rotate" disabled>🔄 自动旋转</button>
      <button class="t3d-btn" id="${uid}_fullscreen" disabled title="请先上传轨迹并开启自动旋转">⛶ 全屏录制</button>
      <button class="t3d-btn" id="${uid}_reset">↺ 复位视角</button>
      <button class="t3d-btn primary" id="${uid}_export" disabled>🖼️ 生成海报并下载</button>
    </div>

    <div class="t3d-group">
      ${this._sliderHTML(uid, 'pitch', '俯仰角 Pitch', 5, 85, 1, this.state.pitch, '°')}
      ${this._sliderHTML(uid, 'yaw', '偏航角 Yaw', -180, 180, 1, this.state.yaw, '°')}
      ${this._sliderHTML(uid, 'zoom', '缩放 Zoom', 0.3, 2.5, 0.01, this.state.zoom, '×')}
      ${this._sliderHTML(uid, 'wallHeight', '幕墙高度 Height', 0.05, 1.5, 0.01, this.state.wallHeight, '')}
      ${this._sliderHTML(uid, 'gradientPower', '渐变指数 Power', 0.3, 6, 0.1, this.state.gradientPower, '')}
      ${this._sliderHTML(uid, 'trackWidth', '轨迹粗细 Width', 0.004, 0.05, 0.001, this.state.trackWidth, '')}
      ${this._sliderHTML(uid, 'glow', '边缘发光 Glow', 0, 1, 0.05, this.state.glow, '')}
      ${this._sliderHTML(uid, 'shadowOpacity', '阴影浓度 Shadow', 0, 0.5, 0.01, this.state.shadowOpacity, '')}
      ${this._sliderHTML(uid, 'shadowAngle', '阳光角度 Sun', -90, 90, 1, this.state.shadowAngle, '°')}
    </div>

    <div class="t3d-ctrl">
      <div class="lab"><span>🎨 3D幕墙颜色</span></div>
      <div class="t3d-colorrow">
        <span>幕墙</span>
        <input type="text" id="${uid}_wallColor" value="#fb923c" data-coloris readonly>
      </div>
    </div>
    <div class="t3d-ctrl">
      <div class="lab"><span>🎨 2D轨迹带颜色</span></div>
      <div class="t3d-colorrow">
        <span>轨迹</span>
        <input type="text" id="${uid}_trackColor" value="#fb923c" data-coloris readonly>
      </div>
    </div>

    <div class="t3d-ctrl t3d-checkrow">
      <div class="t3d-grp-title" style="margin-bottom:4px;">🚩 高程旗帜（独立开关）</div>
      <label class="t3d-check"><input type="checkbox" id="${uid}_flag_peak" checked><span>🏔️ 最高海拔</span></label>
      <label class="t3d-check"><input type="checkbox" id="${uid}_flag_half" checked><span>🏁 半程点</span></label>
      <label class="t3d-check"><input type="checkbox" id="${uid}_flag_speed" checked><span>⚡ 最快速度</span></label>
      <label class="t3d-check"><input type="checkbox" id="${uid}_flag_gradient" checked><span>📐 平均坡度</span></label>
    </div>

    <div class="t3d-ctrl" id="${uid}_customMetricsContainer">
      <div class="t3d-grp-title" style="display:flex;align-items:center;justify-content:space-between;">
        <span>📝 自定义指标</span>
        <button class="t3d-btn" id="${uid}_addMetricBtn" style="font-size:0.65rem;padding:2px 10px;">+ 添加</button>
      </div>
      <div id="${uid}_customMetricsList"></div>
    </div>

    <div class="t3d-textgroup">
      <div class="t3d-grp-title">✏️ 数据文字</div>
      ${this._sliderHTML(uid, 'fontSize', '数值字号 Size', 12, 64, 1, this.state.fontSize, 'px')}
      <div class="t3d-colorrow">
        <span>🎨 文字颜色</span>
        <input type="text" id="${uid}_fontColor" value="#ffffff" data-coloris readonly>
      </div>
      <div class="t3d-labelrow"><span class="k">距离</span>
        <input class="t3d-tin" id="${uid}_label_distance" value="距离" maxlength="14"></div>
      <div class="t3d-labelrow"><span class="k">爬升</span>
        <input class="t3d-tin" id="${uid}_label_gain" value="累计爬升" maxlength="14"></div>
      <div class="t3d-labelrow"><span class="k">时间</span>
        <input class="t3d-tin" id="${uid}_label_duration" value="移动时间" maxlength="14"></div>
      <input class="t3d-tin" id="${uid}_brandInput" placeholder="底部品牌文字（如 G8 Cycling Club）" maxlength="40">
    </div>

  </div>
</div>`;

    this.$ = (s) => this.root.querySelector('#' + uid + '_' + s);
    this.glCanvas = this.$('cv');
    this.annot = this.$('annot');
    this.annotCtx = this.annot.getContext('2d');
    this.emptyHint = this.$('empty');
    this.stageEl = this.root.querySelector('.t3d-stage');
  }

  _sliderHTML(uid, key, label, min, max, step, value, unit) {
    return `
<div class="t3d-ctrl">
  <div class="lab"><span>${label}</span><span class="val" id="${uid}_${key}_v">${this._fmt(value, step)}${unit}</span></div>
  <input class="t3d-range" type="range" id="${uid}_${key}" min="${min}" max="${max}" step="${step}" value="${value}"
    data-key="${key}" data-unit="${unit}">
</div>`;
  }

  _fmt(v, step) {
    const dec = (String(step).split('.')[1] || '').length;
    return Number(v).toFixed(dec);
  }

  // ==========================================================================
  //  WebGL 初始化
  // ==========================================================================
  _initGL() {
    const gl = this.glCanvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // 关键：海报合并时需读取当前帧
    });
    if (!gl) { this._fail('当前环境不支持 WebGL'); return; }
    this.gl = gl;

    // —— 幕墙着色器（渐变三角带）——
    const wallVs = `
attribute vec3 a_pos;
attribute float a_ratio;
uniform mat4 u_MVPMatrix;
uniform float u_wallHeight;
varying float v_ratio;
void main() {
  vec3 p = vec3(a_pos.x, a_pos.y * u_wallHeight, a_pos.z);
  gl_Position = u_MVPMatrix * vec4(p, 1.0);
  v_ratio = a_ratio;
}`;
    const wallFs = `
precision mediump float;
uniform vec3 u_color;
uniform float u_gradientPower;
uniform float u_maxOpacity;
varying float v_ratio;
void main() {
  // ① 下方幕墙的非线性淡出（幂函数控制衰减速度）
  float wallAlpha = pow(v_ratio, u_gradientPower) * u_maxOpacity * 0.70;

  // ② 顶端"霓虹核"发光带（ratio 0.93~1.0 区间形成高亮实体）
  float neonPeak = smoothstep(0.93, 1.0, v_ratio);

  // ③ 颜色过载：发光带颜色亮度翻倍，产生过曝荧光感
  vec3 glowColor = u_color * 1.7;
  vec3 finalColor = mix(u_color, glowColor, neonPeak);

  // ④ 发光带几乎不透明（alpha≈0.95），下方幕墙半透明渐变
  float finalAlpha = mix(wallAlpha, 0.92, neonPeak);

  gl_FragColor = vec4(finalColor, finalAlpha);
}`;
    this.program = this._buildProgram(wallVs, wallFs);
    this.loc.a_pos = gl.getAttribLocation(this.program, 'a_pos');
    this.loc.a_ratio = gl.getAttribLocation(this.program, 'a_ratio');
    this.loc.u_MVPMatrix = gl.getUniformLocation(this.program, 'u_MVPMatrix');
    this.loc.u_wallHeight = gl.getUniformLocation(this.program, 'u_wallHeight');
    this.loc.u_color = gl.getUniformLocation(this.program, 'u_color');
    this.loc.u_gradientPower = gl.getUniformLocation(this.program, 'u_gradientPower');
    this.loc.u_maxOpacity = gl.getUniformLocation(this.program, 'u_maxOpacity');

    // —— 轨迹带 Ribbon Mesh 着色器（几何条带 + 热力色插值 + 流光脉冲）——
    const trackVs = `
attribute vec3 a_center;
attribute vec2 a_normal;
attribute float a_dist;
attribute float a_metric;
attribute float a_percent;
uniform mat4 u_MVPMatrix;
uniform float u_halfWidth;
uniform highp int u_isShadow;
uniform float u_yBaseline;
uniform vec2 u_shadowOffset;
varying float v_dist;
varying float v_metric;
varying float v_percent;
void main() {
  vec3 p = a_center;
  p.x += a_normal.x * a_dist * u_halfWidth;
  p.z += a_normal.y * a_dist * u_halfWidth;
  // 阴影 Pass：拉平 Y 至基准面 + 施加阳光偏移
  if (u_isShadow == 1) {
    p.y = u_yBaseline;
    p.x += u_shadowOffset.x;
    p.z += u_shadowOffset.y;
  }
  gl_Position = u_MVPMatrix * vec4(p, 1.0);
  v_dist = a_dist;
  v_metric = a_metric;
  v_percent = a_percent;
}`;
    const trackFs = `
precision mediump float;
uniform vec3 u_color;
uniform vec3 u_coldColor;
uniform vec3 u_hotColor;
uniform float u_glow;
uniform float u_heatmap;
uniform highp int u_isShadow;
uniform float u_shadowOpacity;
uniform float u_time;
uniform float u_flowSpeed;
uniform float u_pulseLength;
varying float v_dist;
varying float v_metric;
varying float v_percent;
void main() {
  // —— 阴影 Pass：黑色 + 非线性边缘衰减（软阴影）——
  if (u_isShadow == 1) {
    // 越靠近条带中心越黑，越靠近两边越透明
    float shadowIntensity = 1.0 - abs(v_dist);
    shadowIntensity = pow(shadowIntensity, 2.0) * u_shadowOpacity;
    gl_FragColor = vec4(0.0, 0.0, 0.0, shadowIntensity);
    return;
  }

  // Outer glow pass. It is drawn on a wider ribbon so the glow can extend
  // beyond the solid track body instead of being hidden inside it.
  if (u_isShadow == 2) {
    float dist = abs(v_dist);
    float halo = 1.0 - smoothstep(0.10, 1.0, dist);
    halo = pow(halo, 1.7) * u_glow;

    float t = smoothstep(0.1, 0.9, v_metric);
    vec3 baseColor = mix(u_color, mix(u_coldColor, u_hotColor, t), u_heatmap);
    vec3 haloColor = mix(baseColor, vec3(1.0, 1.0, 1.0), 0.22);

    gl_FragColor = vec4(haloColor * 1.35, halo * 0.55);
    return;
  }

  // —— 轨迹本体：宽实心线 + 边缘窄辉光 ——
  float dist = abs(v_dist);                         // 0=中心, 1=条带几何边缘

  // ① 实心核：带宽 65% 均匀不透明，过渡极窄
  float coreHalf = 0.65;
  float core = 1.0 - smoothstep(coreHalf, coreHalf + 0.04, dist);

  // ② 边缘辉光：仅在核外侧很窄的带内衰减
  float glowStart = 0.58;
  float glow = 1.0 - smoothstep(glowStart, 1.0, dist);
  glow = pow(glow, 2.5) * u_glow;

  // 合并
  float alpha = max(core, glow);

  // 热力模式：冷→暖颜色插值；单色模式：使用 u_color
  float t = smoothstep(0.1, 0.9, v_metric);
  vec3 baseColor = mix(u_color, mix(u_coldColor, u_hotColor, t), u_heatmap);

  // 动态流光脉冲：仅在实心核上叠加
  float flowPos = fract(u_time * u_flowSpeed);
  float ringDist = abs(v_percent - flowPos);
  ringDist = min(ringDist, 1.0 - ringDist);
  float pulse = smoothstep(u_pulseLength, 0.0, ringDist) * core;

  // 流光叠加
  vec3 flowColor = vec3(1.0, 1.0, 1.0);
  vec3 finalColor = mix(baseColor, flowColor, pulse);
  float finalAlpha = alpha * mix(0.75, 1.0, pulse);

  gl_FragColor = vec4(finalColor * 1.5, finalAlpha);
}`;
    this.trackProgram = this._buildProgram(trackVs, trackFs);
    this.trackLoc = {
      a_center: gl.getAttribLocation(this.trackProgram, 'a_center'),
      a_normal: gl.getAttribLocation(this.trackProgram, 'a_normal'),
      a_dist: gl.getAttribLocation(this.trackProgram, 'a_dist'),
      a_metric: gl.getAttribLocation(this.trackProgram, 'a_metric'),
      a_percent: gl.getAttribLocation(this.trackProgram, 'a_percent'),
      u_MVPMatrix: gl.getUniformLocation(this.trackProgram, 'u_MVPMatrix'),
      u_halfWidth: gl.getUniformLocation(this.trackProgram, 'u_halfWidth'),
      u_color: gl.getUniformLocation(this.trackProgram, 'u_color'),
      u_coldColor: gl.getUniformLocation(this.trackProgram, 'u_coldColor'),
      u_hotColor: gl.getUniformLocation(this.trackProgram, 'u_hotColor'),
      u_glow: gl.getUniformLocation(this.trackProgram, 'u_glow'),
      u_heatmap: gl.getUniformLocation(this.trackProgram, 'u_heatmap'),
      u_isShadow: gl.getUniformLocation(this.trackProgram, 'u_isShadow'),
      u_yBaseline: gl.getUniformLocation(this.trackProgram, 'u_yBaseline'),
      u_shadowOffset: gl.getUniformLocation(this.trackProgram, 'u_shadowOffset'),
      u_shadowOpacity: gl.getUniformLocation(this.trackProgram, 'u_shadowOpacity'),
      u_time: gl.getUniformLocation(this.trackProgram, 'u_time'),
      u_flowSpeed: gl.getUniformLocation(this.trackProgram, 'u_flowSpeed'),
      u_pulseLength: gl.getUniformLocation(this.trackProgram, 'u_pulseLength'),
    };

    this.buffers.wallPos = gl.createBuffer();
    this.buffers.wallRatio = gl.createBuffer();
    this.buffers.trackCenter = gl.createBuffer();
    this.buffers.trackNormal = gl.createBuffer();
    this.buffers.trackDist = gl.createBuffer();
    this.buffers.trackMetric = gl.createBuffer();
    this.buffers.trackPercent = gl.createBuffer();

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
  }

  _buildProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('Shader 编译失败: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program 链接失败: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  // ==========================================================================
  //  控件绑定（滑块 input → uniform → 重绘）
  // ==========================================================================
  _bindControls() {
    this.root.querySelectorAll('.t3d-range').forEach((el) => {
      el.addEventListener('input', () => {
        const key = el.dataset.key;
        const val = parseFloat(el.value);
        this.state[key] = val;
        if (key === 'yaw' || key === 'pitch') this._stopRotation();
        const vEl = this.root.querySelector('#' + this.uid + '_' + key + '_v');
        if (vEl) vEl.textContent = this._fmt(val, el.step) + (el.dataset.unit || '');
        this.requestRender();
        if (key === 'fontSize') this._applyTextStyle();
        // 防抖埋点：累积所有调整参数，1 秒无操作后一并发送
        if (!this._pendingAdjusts) this._pendingAdjusts = {};
        this._pendingAdjusts[key] = val;
        clearTimeout(this._adjustDebounceId);
        this._adjustDebounceId = setTimeout(() => {
          const payload = { ...this._pendingAdjusts };
          this._pendingAdjusts = {};
          this.tracker?.sendEvent('adjust_3d_view', payload);
        }, 1000);
      });
    });

    this.$('rotate').addEventListener('click', () => this._toggleRotation());
    this.$('fullscreen').addEventListener('click', () => this._toggleRecordingFullscreen());
    this.$('reset').addEventListener('click', () => this._resetView());
    this.$('export').addEventListener('click', () => this.generatePoster());
    document.addEventListener('fullscreenchange', this._fullscreenChangeHandler);
    document.addEventListener('webkitfullscreenchange', this._fullscreenChangeHandler);

    // 背景变暗开关
    const bgDarkenCb = this.$('bgDarken');
    if (bgDarkenCb) bgDarkenCb.addEventListener('change', () => {
      this.state.bgDarken = bgDarkenCb.checked;
      this._updateBgDarkenPreview();
      this.requestRender();
    });

    // 高程旗帜独立开关
    ['peak', 'half', 'speed', 'gradient'].forEach(k => {
      const cb = this.$('flag_' + k);
      if (cb) cb.addEventListener('change', () => {
        this.state.showMilestones[k] = cb.checked;
        this.requestRender();
      });
    });

    // 自定义指标
    this.$('addMetricBtn').addEventListener('click', () => this._addCustomMetric());
    this._renderCustomMetricsList();
    this._syncRecordingControls();
  }

  // ==========================================================================
  //  自动旋转：持续更新 yaw，轨迹旋转，背景保持静止（背景是 <img> 层）
  // ==========================================================================
  _toggleRotation() {
    if (!this.stats) return;
    const btn = this.$('rotate');
    if (this._rotating) {
      this._rotating = false;
      cancelAnimationFrame(this._rotationRAF);
      btn.classList.remove('rotating');
      btn.innerHTML = '🔄 自动旋转';
    } else {
      this._rotating = true;
      btn.classList.add('rotating');
      btn.innerHTML = '⏸ 停止旋转';
      this._lastRotationTime = performance.now();
      this._rotationLoop();
    }
    this._syncRecordingControls();
  }

  _stopRotation() {
    if (!this._rotating) return;
    this._rotating = false;
    cancelAnimationFrame(this._rotationRAF);
    const btn = this.$('rotate');
    if (btn) { btn.classList.remove('rotating'); btn.innerHTML = '🔄 自动旋转'; }
    this._syncRecordingControls();
  }

  _rotationLoop() {
    if (!this._rotating) return;
    const now = performance.now();
    const dt = (now - this._lastRotationTime) / 1000; // 秒
    this._lastRotationTime = now;

    // 更新 yaw（环绕 Y 轴旋转）
    this.state.yaw = this._wrapYaw(this.state.yaw + this.state.rotationSpeed * dt);
    this._syncSlider('yaw');
    this.requestRender();

    this._rotationRAF = requestAnimationFrame(() => this._rotationLoop());
  }

  _syncRecordingControls() {
    const rotateBtn = this.$('rotate');
    const fullscreenBtn = this.$('fullscreen');
    const fullscreenActive = this._isStageFullscreen();

    if (rotateBtn) rotateBtn.disabled = !this.stats;
    if (!fullscreenBtn) return;

    const ready = Boolean(this.stats && this._rotating);
    fullscreenBtn.disabled = !fullscreenActive && !ready;
    fullscreenBtn.classList.toggle('recording-ready', ready && !fullscreenActive);
    fullscreenBtn.innerHTML = fullscreenActive ? '↙ 退出全屏' : '⛶ 全屏录制';
    fullscreenBtn.title = fullscreenActive
      ? '退出全屏录制'
      : ready ? '只显示海报画面，按 Esc 退出' : '请先上传轨迹并开启自动旋转';
  }

  _isStageFullscreen() {
    const fullscreenEl = document.fullscreenElement || document.webkitFullscreenElement;
    return fullscreenEl === this.stageEl;
  }

  async _toggleRecordingFullscreen() {
    if (this._isStageFullscreen()) {
      const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
      if (exitFullscreen) await exitFullscreen.call(document);
      return;
    }
    if (!this.stats || !this._rotating) return;

    try {
      if (this.stageEl.requestFullscreen) {
        await this.stageEl.requestFullscreen({ navigationUI: 'hide' });
      } else if (this.stageEl.webkitRequestFullscreen) {
        this.stageEl.webkitRequestFullscreen();
      } else {
        throw new Error('当前浏览器不支持全屏 API');
      }
    } catch (err) {
      console.error('[ThreeDTrackPoster] 无法进入全屏:', err);
      window.alert('无法进入全屏，请使用最新版 Chrome 或 Edge，并允许网页进入全屏。');
      this._syncRecordingControls();
    }
  }

  _handleFullscreenChange() {
    const active = this._isStageFullscreen();
    const stateChanged = active !== this._recordingFullscreen;
    this._recordingFullscreen = active;
    this.stageEl.classList.toggle('t3d-recording', active);
    this._lastRotationTime = performance.now();
    this._syncRecordingControls();

    requestAnimationFrame(() => {
      this._resize();
      requestAnimationFrame(() => this._resize());
    });

    if (stateChanged) {
      this.tracker?.sendEvent(active ? 'recording_fullscreen_enter' : 'recording_fullscreen_exit', {
        track_name: this.trackName,
      });
    }
  }

  _resetView() {
    const def = { pitch: 55, yaw: -25, zoom: 1.0, wallHeight: 0.55, gradientPower: 2.2, trackWidth: 0.012, glow: 0.6, shadowOpacity: 0.20, shadowAngle: -45 };
    Object.entries(def).forEach(([k, v]) => {
      this.state[k] = v;
      const slider = this.$(k);
      const vEl = this.root.querySelector('#' + this.uid + '_' + k + '_v');
      if (slider) slider.value = v;
      if (vEl) vEl.textContent = this._fmt(v, slider.step) + (slider.dataset.unit || '');
    });
    // 复位颜色
    this.state.wallColor = [0.984, 0.573, 0.235];
    this.state.trackColor = [0.984, 0.573, 0.235];
    const wc = this.$('wallColor'); if (wc) wc.value = '#fb923c';
    const tc = this.$('trackColor'); if (tc) tc.value = '#fb923c';
    if (this._rawPts) { this._buildGeometry(this._rawPts); }
    this.requestRender();
  }

  // ==========================================================================
  //  画布手势交互：拖动旋转(Pitch/Yaw) + Ctrl滚轮/双指捏合缩放(Zoom)
  //  桌面与手机统一用 Pointer Events；右侧滑块实时双向同步
  // ==========================================================================
  _bindCanvasInteraction() {
    const stage = this.glCanvas.parentElement;
    this.stage = stage;
    const pointers = new Map();
    let lastDist = 0;
    const SENS = 0.4; // 旋转灵敏度（度/像素）

    stage.addEventListener('pointerdown', (e) => {
      if (this._recordingFullscreen) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}
      stage.classList.add('dragging');
      if (pointers.size === 2) lastDist = this._pointerDist(pointers);
    });

    stage.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const cur = { x: e.clientX, y: e.clientY };
      pointers.set(e.pointerId, cur);

      if (pointers.size === 1) {
        // 单指 / 鼠标拖动 → 旋转
        const dx = cur.x - prev.x, dy = cur.y - prev.y;
        this.state.yaw = this._wrapYaw(this.state.yaw + dx * SENS);
        this.state.pitch = this._clamp(this.state.pitch - dy * SENS, 5, 85);
        this._stopRotation();
        this._syncSlider('yaw'); this._syncSlider('pitch');
        this.requestRender();
        e.preventDefault();
      } else if (pointers.size === 2) {
        // 双指捏合 → 缩放
        const dist = this._pointerDist(pointers);
        if (lastDist > 0) {
          this.state.zoom = this._clamp(this.state.zoom * (dist / lastDist), 0.3, 2.5);
          this._syncSlider('zoom'); this.requestRender();
        }
        lastDist = dist;
        e.preventDefault();
      }
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) lastDist = 0;
      if (pointers.size === 0) stage.classList.remove('dragging');
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);

    // Ctrl + 滚轮 → 缩放（桌面鼠标滚轮 / 触控板捏合同走此路径）
    stage.addEventListener('wheel', (e) => {
      if (this._recordingFullscreen) { e.preventDefault(); return; }
      if (!e.ctrlKey) return; // 不按 Ctrl 时放行，页面正常滚动
      e.preventDefault();
      const factor = 1 - e.deltaY * 0.0015;
      this.state.zoom = this._clamp(this.state.zoom * factor, 0.3, 2.5);
      this._syncSlider('zoom');
      this.requestRender();
    }, { passive: false });
  }

  _pointerDist(map) {
    const pts = [...map.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  _wrapYaw(y) { return ((y + 180) % 360 + 360) % 360 - 180; }

  _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // 拖动/滚轮改 state 后，同步对应滑块的 value 与数值显示（右侧界面保持一致）
  _syncSlider(key) {
    const slider = this.$(key);
    if (!slider) return;
    slider.value = this.state[key];
    const vEl = this.root.querySelector('#' + this.uid + '_' + key + '_v');
    if (vEl) vEl.textContent = this._fmt(this.state[key], slider.step) + (slider.dataset.unit || '');
  }

  // ==========================================================================
  //  文件拖拽区（轨迹文件 + 背景图，按扩展名/类型自动路由）
  // ==========================================================================
  _bindFileZone() {
    const drop = this.$('drop');
    const input = this.$('file');

    input.addEventListener('change', (e) => this._handleFiles(e.target.files));

    ['dragenter', 'dragover'].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files) this._handleFiles(e.dataTransfer.files);
    });
  }

  async _handleFiles(fileList) {
    for (const file of fileList) {
      const name = file.name.toLowerCase();
      if (/\.(gpx|kml|kmz|tcx|fit|geojson|json)$/.test(name)) {
        if (/\.(gpx|kml|kmz)$/.test(name)) {
          await this._loadTrackFile(file);
        } else {
          this._fail('暂不支持 ' + name.split('.').pop().toUpperCase() + ' 格式，请使用 GPX / KML / KMZ 文件');
        }
      } else if (file.type.startsWith('image/')) {
        await this._loadBgImage(file);
      }
    }
  }

  // —— 背景图上传：独立按钮 + 实时叠加到舞台（垫在 3D 轨迹之后透出）——
  _bindImageUpload() {
    this.$('imgbtn').addEventListener('click', () => this.$('imgfile').click());
    this.$('imgfile').addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) this._loadBgImage(e.target.files[0]);
      e.target.value = '';
    });
    this.$('imgclear').addEventListener('click', () => this.clearBg());
  }

  async _loadBgImage(file) {
    if (this._bgUrl) URL.revokeObjectURL(this._bgUrl);
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    this._bgUrl = url;
    this.bgImage = img;
    // 实时叠加：把图显示到舞台背景层（WebGL 画布透明，轨迹在其上方）
    const bgEl = this.$('bg');
    bgEl.src = url;
    bgEl.style.display = 'block';
    // 舞台脱离 flex 等高拉伸，按图片比例自适应大小
    if (this.stageEl) {
      this.stageEl.style.aspectRatio = (img.width / img.height).toFixed(4);
      this.stageEl.style.alignSelf = 'flex-start';
      bgEl.style.objectFit = 'cover'; // 比例已匹配，cover=无裁切无变形
      requestAnimationFrame(() => { this._resize(); this.requestRender(); });
    }
    // 更新按钮 / 文件名提示
    const hint = this.$('imghint');
    hint.style.display = 'flex';
    hint.querySelector('.name').textContent = '🖼️ ' + file.name;
    this.$('imgbtn').textContent = '🔄 更换背景图片';
    this._updateBgDarkenPreview();
  }

  clearBg() {
    if (this._bgUrl) URL.revokeObjectURL(this._bgUrl);
    this._bgUrl = null;
    this.bgImage = null;
    const bgEl = this.$('bg');
    bgEl.removeAttribute('src');
    bgEl.style.display = 'none';
    this.$('imghint').style.display = 'none';
    this.$('imgbtn').textContent = '🖼️ 上传背景图片';
    // 恢复默认布局
    if (this.stageEl) {
      this.stageEl.style.aspectRatio = '';
      this.stageEl.style.alignSelf = '';
      bgEl.style.objectFit = '';
      requestAnimationFrame(() => { this._resize(); this.requestRender(); });
    }
    this._updateBgDarkenPreview();
  }

  // 背景变暗预览：在 stage 上叠加一层半透明遮罩
  _updateBgDarkenPreview() {
    let overlay = this.stageEl.querySelector('.t3d-bg-darken');
    if (!this.bgImage || !this.state.bgDarken) {
      if (overlay) overlay.style.display = 'none';
      return;
    }
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 't3d-bg-darken';
      overlay.style.cssText = 'position:absolute;inset:0;z-index:2;pointer-events:none;background:rgba(8,10,16,0.34);';
      this.stageEl.appendChild(overlay);
    }
    overlay.style.display = 'block';
  }

  async _loadTrackFile(file) {
    try {
      const name = file.name.toLowerCase();
      let xmlText;
      if (name.endsWith('.kmz')) {
        xmlText = await this._unzipKmz(file);
      } else {
        xmlText = await file.text();
      }
      let parsed;
      if (name.endsWith('.gpx')) parsed = this._parseGPX(xmlText);
      else parsed = this._parseKML(xmlText); // kml / kmz 内 kml
      const pts = parsed.points;
      if (!pts || pts.length < 2) { this._fail('未解析到有效轨迹点'); return; }

      this.trackName = parsed.name || file.name.replace(/\.[^.]+$/, '');
      this._rawPts = pts; // 缓存原始点（热力模式切换时重建几何）
      this._buildGeometry(pts);
      this.$('loaded').innerHTML = '✅ ' + file.name + '（' + pts.length + ' 点）';
      this.$('export').disabled = false;
      this._syncRecordingControls();

      // 埋点：轨迹文件上传成功
      const fmt2 = file.name.toLowerCase().endsWith('.gpx') ? 'GPX' : file.name.toLowerCase().endsWith('.kmz') ? 'KMZ' : 'KML';
      this.tracker?.sendEvent('upload_success', { format: fmt2, points_count: pts.length });
      this.emptyHint.style.opacity = '0';
      this.requestRender();
    } catch (err) {
      this._fail('解析失败: ' + err.message);
    }
  }

  async _unzipKmz(file) {
    if (!window.JSZip) throw new Error('缺少 JSZip，无法解压 KMZ');
    const buf = await file.arrayBuffer();
    const zip = await window.JSZip.loadAsync(buf);
    let kmlEntry = null;
    zip.forEach((p, entry) => { if (!kmlEntry && /\.kml$/i.test(p)) kmlEntry = entry; });
    if (!kmlEntry) throw new Error('KMZ 内未找到 .kml');
    return await kmlEntry.async('string');
  }

  // ==========================================================================
  //  解析器
  // ==========================================================================
  _parseGPX(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const nodes = doc.getElementsByTagName('trkpt');
    const pts = [];
    for (const n of nodes) {
      const lat = parseFloat(n.getAttribute('lat'));
      const lon = parseFloat(n.getAttribute('lon'));
      if (isNaN(lat) || isNaN(lon)) continue;
      const eleEl = n.getElementsByTagName('ele')[0];
      const timeEl = n.getElementsByTagName('time')[0];
      pts.push({
        lat, lon,
        ele: eleEl ? parseFloat(eleEl.textContent) : 0,
        time: timeEl ? Date.parse(timeEl.textContent) : null,
      });
    }
    // 兜底：路点 wpt
    if (pts.length === 0) {
      for (const n of doc.getElementsByTagName('rtept')) {
        const lat = parseFloat(n.getAttribute('lat')), lon = parseFloat(n.getAttribute('lon'));
        if (!isNaN(lat) && !isNaN(lon)) pts.push({ lat, lon, ele: 0, time: null });
      }
    }
    let name = '';
    const trk = doc.getElementsByTagName('trk')[0];
    if (trk) { const nm = trk.getElementsByTagName('name')[0]; if (nm) name = nm.textContent.trim(); }
    return { points: pts, name };
  }

  _parseKML(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const pts = [];

    // ① 优先解析 <gx:Track>（两步路等导出格式，含密集轨迹点 + 时间戳）
    const ns = 'http://www.google.com/kml/ext/2.2';
    const tracks = doc.getElementsByTagNameNS ? doc.getElementsByTagNameNS(ns, 'Track')
      : doc.getElementsByTagName('gx:Track');
    if (tracks.length > 0) {
      for (const track of tracks) {
        const whens = track.getElementsByTagName('when');
        // gx:coord 子元素：注意用命名空间或标签名搜索
        const coords = track.getElementsByTagNameNS
          ? track.getElementsByTagNameNS(ns, 'coord')
          : track.getElementsByTagName('gx:coord');
        const n = Math.min(whens.length, coords.length);
        for (let i = 0; i < n; i++) {
          const parts = (coords[i].textContent || '').trim().split(/\s+/);
          if (parts.length < 2) continue;
          const lon = parseFloat(parts[0]), lat = parseFloat(parts[1]);
          if (isNaN(lat) || isNaN(lon)) continue;
          pts.push({
            lat, lon,
            ele: parts[2] ? parseFloat(parts[2]) : 0,
            time: whens[i] ? Date.parse(whens[i].textContent) : null,
          });
        }
      }
      if (pts.length > 0) {
        const nm = doc.getElementsByTagName('name')[0];
        const name = nm ? nm.textContent.trim() : '';
        return { points: pts, name };
      }
    }

    // ② 兜底：解析传统 <LineString> 中的 <coordinates>（跳过路标 Placemark）
    const _isWaypoint = (el) => {
      let p = el.parentElement;
      while (p && p.tagName !== 'Placemark') p = p.parentElement;
      if (!p) return false;
      const id = p.getAttribute('id') || '';
      return id === 'startPoint' || id === 'endPoint' || id === 'realPoint';
    };
    const _extractTime = (el) => {
      let p = el.parentElement;
      while (p && p.tagName !== 'Placemark') p = p.parentElement;
      if (!p) return null;
      const ext = p.getElementsByTagName('ExtendedData')[0];
      if (!ext) return null;
      const dataEls = ext.getElementsByTagName('Data');
      for (const d of dataEls) {
        if (d.getAttribute('name') === 'Time') {
          const v = d.getElementsByTagName('value')[0];
          const ms = v ? parseInt(v.textContent) : NaN;
          return isNaN(ms) ? null : ms;
        }
      }
      return null;
    };
    const coordEls = doc.getElementsByTagName('coordinates');
    for (const c of coordEls) {
      if (_isWaypoint(c)) continue; // 跳过稀疏路标，只要轨迹数据
      const tm = _extractTime(c);
      const raw = c.textContent.trim().split(/\s+/);
      for (const tok of raw) {
        const parts = tok.split(',');
        if (parts.length < 2) continue;
        const lon = parseFloat(parts[0]), lat = parseFloat(parts[1]);
        if (isNaN(lat) || isNaN(lon)) continue;
        pts.push({ lat, lon, ele: parts[2] ? parseFloat(parts[2]) : 0, time: tm });
      }
    }
    const nm = doc.getElementsByTagName('name')[0];
    const name = nm ? nm.textContent.trim() : '';
    return { points: pts, name };
  }

  // ==========================================================================
  //  数学：Mercator 投影 + Catmull-Rom 平滑 + 归一化 + 统计 + 几何构建
  // ==========================================================================
  _mercator(lat, lon) {
    const x = (lon * Math.PI) / 180;
    const latR = (lat * Math.PI) / 180;
    const y = Math.log(Math.tan(Math.PI / 4 + latR / 2));
    return [x, y];
  }

  _catmull(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }

  _buildGeometry(rawPts) {
    // 1) 统计（基于原始经纬度，更精确）
    this.stats = this._computeStats(rawPts);

    // 1.5) 热力指标（速度 / 坡度）+ 最快速度提取
    const ptMetrics = this._computePointMetrics(rawPts);
    this._maxSpeedKmh = ptMetrics.hasSpeed ? ptMetrics.maxSpeedMs * 3.6 : 0;
    this._maxSpeedRawIdx = ptMetrics.maxSpeedIdx;

    const mode = 'solid'; // 始终单色
    let activeMetric = null;

    // 1.8) 轨迹累计长度百分比 [0..1]（用于流光脉冲着色器）
    const R2 = 6371000;
    const rad2 = (d) => (d * Math.PI) / 180;
    let cumDist = 0;
    const rawPercents = [0];
    for (let i = 1; i < rawPts.length; i++) {
      const a = rawPts[i - 1], b = rawPts[i];
      const dLat = rad2(b.lat - a.lat), dLon = rad2(b.lon - a.lon);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad2(a.lat)) * Math.cos(rad2(b.lat)) * Math.sin(dLon / 2) ** 2;
      cumDist += 2 * R2 * Math.asin(Math.min(1, Math.sqrt(h)));
      rawPercents.push(cumDist);
    }
    for (let i = 0; i < rawPercents.length; i++) rawPercents[i] /= (cumDist || 1);

    // 2) Mercator 投影 + 携带海拔 + 热力指标 + 百分比
    const proj = rawPts.map((p, i) => {
      const [x, y] = this._mercator(p.lat, p.lon);
      return { x, y, ele: p.ele, metric: activeMetric ? activeMetric[i] : 0.5, percent: rawPercents[i] };
    });

    // 3) Catmull-Rom 平滑插值。稀疏轨迹按目标点数补密，避免 3D 海报出现明显折线。
    const targetSmoothCount = this._targetSmoothPointCount(proj.length);
    const smooth = this._smoothChainToTarget(proj, targetSmoothCount);

    // 4) 归一化到 XZ 平面 [-1,1]，海拔归一化为高度因子 [0,1]
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let minE = Infinity, maxE = -Infinity;
    for (const s of smooth) {
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
      minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
      minE = Math.min(minE, s.ele); maxE = Math.max(maxE, s.ele);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const half = Math.max(maxX - minX, maxY - minY) / 2 || 1; // 较长轴铺满 [-1,1]
    const eRange = (maxE - minE) || 1;

    const m = smooth.length;
    const Xs = new Float32Array(m), Zs = new Float32Array(m);
    const Hf = new Float32Array(m);
    const wallPos = new Float32Array(m * 2 * 3);
    const wallRatio = new Float32Array(m * 2);

    let peakIdx = 0, peakEle = -Infinity;
    for (let i = 0; i < m; i++) {
      const X = (smooth[i].x - cx) / half;
      const Z = -(smooth[i].y - cy) / half; // 取负，使北方朝屏幕内侧
      const hf = (smooth[i].ele - minE) / eRange; // 0..1 海拔高度因子
      Xs[i] = X; Zs[i] = Z; Hf[i] = hf;
      if (smooth[i].ele > peakEle) { peakEle = smooth[i].ele; peakIdx = i; }
      // 幕墙三角带：底点(ratio0) + 顶点(ratio1)
      const b = i * 6;
      wallPos[b] = X; wallPos[b + 1] = 0; wallPos[b + 2] = Z;
      wallPos[b + 3] = X; wallPos[b + 4] = hf; wallPos[b + 5] = Z;
      wallRatio[i * 2] = 0; wallRatio[i * 2 + 1] = 1;
    }

    // —— 里程碑提取（世界坐标，供 Canvas 2D 高程旗帜投影）——
    // 半程点：沿归一化 XZ 累计弧长达到总长一半处
    let totalLen = 0;
    const cum = new Float32Array(m);
    for (let i = 1; i < m; i++) {
      totalLen += Math.hypot(Xs[i] - Xs[i - 1], Zs[i] - Zs[i - 1]);
      cum[i] = totalLen;
    }
    let halfIdx = Math.floor(m / 2);
    if (totalLen > 0) {
      const target = totalLen / 2;
      for (let i = 1; i < m; i++) { if (cum[i] >= target) { halfIdx = i; break; } }
    }
    const hasEle = (maxE - minE) > 1; // 真实存在海拔起伏（>1m）才显示最高点旗帜
    const speedTargetPercent = rawPercents[Math.min(rawPercents.length - 1, Math.max(0, this._maxSpeedRawIdx))] || 0;
    const speedSmIdx = this._nearestPercentIndex(smooth, speedTargetPercent);
    const hasSpeedFlag = this._maxSpeedKmh > 0;

    // 最陡爬坡点：沿 smoothed 轨迹找坡度（Δelevation / Δdistance）最大的位置
    let steepIdx = Math.floor(m / 2), steepGradient = 0;
    for (let i = 1; i < m; i++) {
      const de = smooth[i].ele - smooth[i - 1].ele;
      if (de <= 0) continue; // 只取上坡
      const dd = Math.hypot(Xs[i] - Xs[i - 1], Zs[i] - Zs[i - 1]) || 0.0001;
      const grad = de / dd; // 每单位长度的高程变化（与真实坡度成比例）
      if (grad > steepGradient) { steepGradient = grad; steepIdx = i; }
    }

    this.milestones = {
      peak: hasEle ? { x: Xs[peakIdx], z: Zs[peakIdx], hf: Hf[peakIdx], ele: this.stats.maxEle } : null,
      half: { x: Xs[halfIdx], z: Zs[halfIdx], hf: Hf[halfIdx], distKm: this.stats.distanceKm / 2 },
      speedPeak: hasSpeedFlag ? { x: Xs[speedSmIdx], z: Zs[speedSmIdx], hf: Hf[speedSmIdx], speedKmh: this._maxSpeedKmh } : null,
      steepest: { x: Xs[steepIdx], z: Zs[steepIdx], hf: Hf[steepIdx], gradient: this.stats.avgGradient },
    };

    // 轨迹带（Ribbon Mesh）：每个中心点沿切线法线挤出左右两顶点，
    // a_dist: -1.0(左顶点) / +1.0(右顶点)，半宽由 GPU uniform u_halfWidth 控制
    const tCenter = new Float32Array(m * 2 * 3);
    const tNormal = new Float32Array(m * 2 * 2);
    const tDist = new Float32Array(m * 2);
    const tMetric = new Float32Array(m * 2);
    const tPercent = new Float32Array(m * 2);
    const hasMetric = smooth[0].metric !== undefined;
    const hasPercent = smooth[0].percent !== undefined;
    const Y0 = 0.004; // 贴地略抬高，避免与幕墙底边重合
    for (let i = 0; i < m; i++) {
      const pi = Math.max(0, i - 1), ni = Math.min(m - 1, i + 1);
      const dx = Xs[ni] - Xs[pi], dz = Zs[ni] - Zs[pi];
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len; // XZ平面法线（向左垂直于切线）
      const metricVal = hasMetric ? smooth[i].metric : 0.5;
      const percentVal = hasPercent ? smooth[i].percent : 0.5;
      for (let s = 0; s < 2; s++) {
        const k = i * 2 + s;
        tCenter[k * 3] = Xs[i]; tCenter[k * 3 + 1] = Y0; tCenter[k * 3 + 2] = Zs[i];
        tNormal[k * 2] = nx; tNormal[k * 2 + 1] = nz;
        tDist[k] = s === 0 ? -1.0 : 1.0;
        tMetric[k] = metricVal;
        tPercent[k] = percentVal;
      }
    }

    const gl = this.gl;
    const upload = (buf, data) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    };
    upload(this.buffers.wallPos, wallPos);
    upload(this.buffers.wallRatio, wallRatio);
    upload(this.buffers.trackCenter, tCenter);
    upload(this.buffers.trackNormal, tNormal);
    upload(this.buffers.trackDist, tDist);
    upload(this.buffers.trackMetric, tMetric);
    upload(this.buffers.trackPercent, tPercent);

    this.wallVertexCount = m * 2;
    this.trackVertexCount = m * 2;

    this._autoFit(); // 自动调焦（缩放）到包围盒
    this._renderStats();
    this._renderMetrics();
  }

  _smoothChain(pts, samples) {
    const n = pts.length;
    if (n < 3 || samples <= 1) return pts.slice();
    const out = [];
    const at = (i) => pts[Math.max(0, Math.min(n - 1, i))];
    const hasMetric = pts[0].metric !== undefined;
    const hasPercent = pts[0].percent !== undefined;
    for (let i = 0; i < n - 1; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      for (let s = 0; s < samples; s++) {
        const t = s / samples;
        const pt = {
          x: this._catmull(p0.x, p1.x, p2.x, p3.x, t),
          y: this._catmull(p0.y, p1.y, p2.y, p3.y, t),
          ele: this._catmull(p0.ele, p1.ele, p2.ele, p3.ele, t),
        };
        if (hasMetric) {
          pt.metric = Math.max(0, Math.min(1,
            this._catmull(p0.metric, p1.metric, p2.metric, p3.metric, t)));
        }
        if (hasPercent) {
          pt.percent = Math.max(0, Math.min(1,
            this._catmull(p0.percent, p1.percent, p2.percent, p3.percent, t)));
        }
        out.push(pt);
      }
    }
    const last = { x: pts[n - 1].x, y: pts[n - 1].y, ele: pts[n - 1].ele };
    if (hasMetric) last.metric = pts[n - 1].metric;
    if (hasPercent) last.percent = pts[n - 1].percent;
    out.push(last);
    return out;
  }

  _targetSmoothPointCount(rawCount) {
    if (rawCount < 3) return rawCount;
    if (rawCount < 30) return 1200;
    if (rawCount < 80) return 1800;
    if (rawCount < 200) return 2400;
    if (rawCount < 6000) return 6000;
    return rawCount;
  }

  _smoothChainToTarget(pts, targetCount) {
    const n = pts.length;
    if (n < 3 || n >= targetCount) return pts.slice();
    const samples = Math.max(2, Math.ceil((targetCount - 1) / Math.max(1, n - 1)));
    return this._smoothChain(pts, samples);
  }

  _nearestPercentIndex(pts, targetPercent) {
    if (!pts.length || pts[0].percent === undefined) return 0;
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const diff = Math.abs(pts[i].percent - targetPercent);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  _computeStats(pts) {
    const R = 6371000; // 地球半径(m)
    const rad = (d) => (d * Math.PI) / 180;
    let dist = 0, gain = 0, maxE = -Infinity;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
      const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
      dist += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
      const de = b.ele - a.ele;
      if (de > 0) gain += de;
      maxE = Math.max(maxE, b.ele);
    }
    maxE = Math.max(maxE, pts[0].ele);
    const t0 = pts[0].time, t1 = pts[pts.length - 1].time;
    const durationSec = (t0 && t1 && t1 > t0) ? Math.round((t1 - t0) / 1000) : null;
    const avgGradient = dist > 0 ? (gain / dist * 100) : 0;
    return {
      distanceKm: dist / 1000,
      gainM: Math.round(gain),
      maxEle: Math.round(maxE),
      durationSec,
      startTime: t0 || null,
      points: pts.length,
      avgGradient: Math.round(avgGradient * 10) / 10, // 平均坡度 %
    };
  }

  // —— Haversine 公式（米）——
  _haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // —— 计算逐点速度 / 坡度指标，归一化到 [0, 1] ——
  _computePointMetrics(rawPts) {
    const n = rawPts.length;
    // 检测是否含时间戳
    const hasTime = rawPts[0].time != null && rawPts[n - 1].time != null;
    const speed = new Float32Array(n);
    const gradient = new Float32Array(n);

    for (let i = 0; i < n - 1; i++) {
      const a = rawPts[i], b = rawPts[i + 1];
      const d = this._haversineMeters(a.lat, a.lon, b.lat, b.lon);
      // 速度 (m/s)
      if (hasTime) {
        const dt = (b.time - a.time) / 1000;
        speed[i] = dt > 0 ? d / dt : 0;
      }
      // 坡度（绝对值 = 高程差 / 水平距离）
      const de = Math.abs(b.ele - a.ele);
      gradient[i] = d > 0 ? de / d : 0;
    }
    speed[n - 1] = speed[n - 2] || 0;
    gradient[n - 1] = gradient[n - 2] || 0;

    // 最快速度（归一化前提取）
    let maxSpeedMs = 0, maxSpeedIdx = 0;
    if (hasTime) {
      for (let i = 0; i < n; i++) {
        if (speed[i] > maxSpeedMs) { maxSpeedMs = speed[i]; maxSpeedIdx = i; }
      }
    }

    // 归一化到 [0, 1]
    const normalize = (arr) => {
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < n; i++) { min = Math.min(min, arr[i]); max = Math.max(max, arr[i]); }
      const range = max - min || 1;
      for (let i = 0; i < n; i++) arr[i] = (arr[i] - min) / range;
    };
    normalize(speed);
    normalize(gradient);

    return { speed, gradient, hasSpeed: hasTime, maxSpeedMs, maxSpeedIdx };
  }

  _autoFit() {
    // 几何已归一化到 [-1,1]，自动焦距即给一个合适的默认 zoom 并同步滑块
    this.state.zoom = 1.0;
    const slider = this.$('zoom');
    if (slider) {
      slider.value = 1.0;
      const vEl = this.root.querySelector('#' + this.uid + '_zoom_v');
      if (vEl) vEl.textContent = '1.00×';
    }
  }

  _renderStats() {
    const s = this.stats;
    if (!s) return;
    const box = this.$('stats');
    const parts = [
      `<span>📏 <b>${s.distanceKm.toFixed(1)}</b> km</span>`,
      `<span>⛰️ <b>${s.gainM.toLocaleString()}</b> m↑</span>`,
      `<span>🔝 <b>${s.maxEle.toLocaleString()}</b> m</span>`,
    ];
    if (s.durationSec) parts.push(`<span>⏱️ <b>${this._fmtDuration(s.durationSec)}</b></span>`);
    box.innerHTML = parts.join('');
    box.style.display = 'flex';
  }

  _fmtDuration(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
                 : `${m}:${String(s).padStart(2, '0')}`;
  }

  // “Xh Ym”格式（顶部数据组 / 海报用）
  _fmtDurationHM(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  // —— 数据文字预览：把统计写入 overlay 的三组数值 + 标签 + 品牌 ——
  _renderMetrics() {
    const s = this.stats;
    if (!s) return;
    const ov = this.$('overlay');
    const setVal = (k, v) => { const el = ov.querySelector('.value[data-k="' + k + '"]'); if (el) el.textContent = v; };
    setVal('distance', s.distanceKm.toFixed(2));
    setVal('gain', s.gainM.toLocaleString());
    setVal('duration', s.durationSec ? this._fmtDurationHM(s.durationSec) : '--');
    this._applyLabels();
    this._maybeFillBrand();
    this._syncCustomMetricsOverlay();
    ov.style.opacity = '1';
  }

  _applyLabels() {
    const ov = this.$('overlay');
    Object.entries(this.state.labels).forEach(([k, txt]) => {
      const el = ov.querySelector('.label[data-k="' + k + '"]');
      if (el) el.textContent = txt;
    });
  }

  // 底部品牌：用户未手动编辑时，默认填入解析到的轨迹名
  _maybeFillBrand() {
    if (this._brandEdited || !this.trackName) return;
    this.state.brandText = this.trackName;
    const inp = this.$('brandInput');
    if (inp) inp.value = this.trackName;
    this.$('brand').textContent = this.trackName;
  }

  // 实时应用文字样式：颜色 + 字号（标签 0.4 倍、品牌 0.5 倍联动缩放）
  _applyTextStyle() {
    const ov = this.$('overlay');
    if (!ov) return;
    ov.style.color = this.state.fontColor;
    const vs = this.state.fontSize;
    ov.querySelectorAll('.value').forEach((e) => { e.style.fontSize = vs + 'px'; });
    ov.querySelectorAll('.label').forEach((e) => { e.style.fontSize = (vs * 0.4) + 'px'; });
    this.$('brand').style.fontSize = (vs * 0.5) + 'px';
  }

  // 文字控件绑定：字体颜色(Coloris) / 标签文本 / 品牌文本（字号滑块复用通用 _bindControls）
  _bindTextControls() {
    const fc = this.$('fontColor');
    if (fc) {
      fc.addEventListener('input', (e) => {
        this.state.fontColor = e.target.value;
        e.target.style.background = e.target.value;
        this._applyTextStyle();
      });
      fc.style.background = this.state.fontColor;
    }
    ['distance', 'gain', 'duration'].forEach((k) => {
      const inp = this.$('label_' + k);
      if (inp) inp.addEventListener('input', (e) => {
        this.state.labels[k] = e.target.value;
        const el = this.$('overlay').querySelector('.label[data-k="' + k + '"]');
        if (el) el.textContent = e.target.value;
      });
    });
    const bi = this.$('brandInput');
    if (bi) bi.addEventListener('input', (e) => {
      this._brandEdited = true;
      this.state.brandText = e.target.value;
      this.$('brand').textContent = e.target.value;
    });
  }

  // ==========================================================================
  //  自定义指标管理
  // ==========================================================================
  _addCustomMetric(label = '', value = '') {
    this.state.customMetrics.push({ label, value });
    this._renderCustomMetricsList();
    this.requestRender();
  }

  _removeCustomMetric(idx) {
    this.state.customMetrics.splice(idx, 1);
    this._renderCustomMetricsList();
    this.requestRender();
  }

  _renderCustomMetricsList() {
    const list = this.$('customMetricsList');
    if (!list) return;
    const metrics = this.state.customMetrics;
    if (!metrics.length) { list.innerHTML = ''; return; }
    // 更新输入表单列表
    list.innerHTML = metrics.map((m, i) =>
      `<div class="t3d-metric-row">
        <input placeholder="标签（如 卡路里）" value="${m.label.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}" data-idx="${i}" data-field="label" oninput="window.__t3d._updateCustomMetric(${i},'label',this.value)">
        <input placeholder="数值（如 3200 kcal）" value="${m.value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}" data-idx="${i}" data-field="value" oninput="window.__t3d._updateCustomMetric(${i},'value',this.value)">
        <button class="t3d-rm-btn" onclick="window.__t3d._removeCustomMetric(${i})" title="移除">✕</button>
      </div>`
    ).join('');

    // 同步更新舞台 overlay 层中的自定义指标
    this._syncCustomMetricsOverlay();
  }

  _updateCustomMetric(idx, field, value) {
    if (idx < 0 || idx >= this.state.customMetrics.length) return;
    this.state.customMetrics[idx][field] = value;
    this._syncCustomMetricsOverlay();
    this.requestRender();
  }

  // 将自定义指标同步到舞台 overlay 层（与距离/爬升/时间同一位置）
  _syncCustomMetricsOverlay() {
    const ov = this.$('overlay');
    if (!ov) return;
    const metricsDiv = ov.querySelector('.t3d-metrics');
    if (!metricsDiv) return;

    // 移除旧的自定义指标（保留前 3 个内置指标）
    metricsDiv.querySelectorAll('.metric.custom').forEach(el => el.remove());

    // 添加自定义指标
    const s = this.stats;
    const fz = this.state.fontSize;
    const fc = this.state.fontColor;
    this.state.customMetrics.forEach(m => {
      const el = document.createElement('div');
      el.className = 'metric custom';
      el.innerHTML = `<div class="label">${m.label}</div><div class="value">${m.value || '--'}</div>`;
      el.querySelector('.label').style.fontSize = (fz * 0.4) + 'px';
      el.querySelector('.label').style.color = fc;
      el.querySelector('.value').style.fontSize = fz + 'px';
      el.querySelector('.value').style.color = fc;
      metricsDiv.appendChild(el);
    });
  }

  // ==========================================================================
  //  手写 mat4（列主序，与 WebGL 一致）
  // ==========================================================================
  static mat4Identity(o) {
    o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0;
    o[4] = 0; o[5] = 1; o[6] = 0; o[7] = 0;
    o[8] = 0; o[9] = 0; o[10] = 1; o[11] = 0;
    o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1;
    return o;
  }

  static mat4Perspective(o, fovy, aspect, near, far) {
    const f = 1.0 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    o[0] = f / aspect; o[1] = 0; o[2] = 0; o[3] = 0;
    o[4] = 0; o[5] = f; o[6] = 0; o[7] = 0;
    o[8] = 0; o[9] = 0; o[10] = (far + near) * nf; o[11] = -1;
    o[12] = 0; o[13] = 0; o[14] = 2 * far * near * nf; o[15] = 0;
    return o;
  }

  static mat4Multiply(o, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    for (let i = 0; i < 4; i++) {
      const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
      o[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      o[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      o[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      o[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    }
    return o;
  }

  static mat4Translate(o, a, x, y, z) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    o[0] = a00; o[1] = a01; o[2] = a02; o[3] = a03;
    o[4] = a10; o[5] = a11; o[6] = a12; o[7] = a13;
    o[8] = a20; o[9] = a21; o[10] = a22; o[11] = a23;
    o[12] = a00 * x + a10 * y + a20 * z + a[12];
    o[13] = a01 * x + a11 * y + a21 * z + a[13];
    o[14] = a02 * x + a12 * y + a22 * z + a[14];
    o[15] = a03 * x + a13 * y + a23 * z + a[15];
    return o;
  }

  static mat4RotateX(o, a, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    if (o !== a) {
      o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = a[3];
      o[12] = a[12]; o[13] = a[13]; o[14] = a[14]; o[15] = a[15];
    }
    o[4] = a10 * c + a20 * s; o[5] = a11 * c + a21 * s; o[6] = a12 * c + a22 * s; o[7] = a13 * c + a23 * s;
    o[8] = a20 * c - a10 * s; o[9] = a21 * c - a11 * s; o[10] = a22 * c - a12 * s; o[11] = a23 * c - a13 * s;
    return o;
  }

  static mat4RotateY(o, a, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    if (o !== a) {
      o[4] = a[4]; o[5] = a[5]; o[6] = a[6]; o[7] = a[7];
      o[12] = a[12]; o[13] = a[13]; o[14] = a[14]; o[15] = a[15];
    }
    o[0] = a00 * c - a20 * s; o[1] = a01 * c - a21 * s; o[2] = a02 * c - a22 * s; o[3] = a03 * c - a23 * s;
    o[8] = a00 * s + a20 * c; o[9] = a01 * s + a21 * c; o[10] = a02 * s + a22 * c; o[11] = a03 * s + a23 * c;
    return o;
  }

  // ==========================================================================
  //  渲染（RAF 单帧调度，滑块拖动期间一次 input → 一帧）
  // ==========================================================================
  requestRender() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => { this._startTime = performance.now();
    this._rafPending = false; this.render(); });
  }

  _computeMVP() {
    const C = ThreeDTrackPoster;
    const aspect = this.glCanvas.width / this.glCanvas.height || 1;
    C.mat4Perspective(this._proj, (45 * Math.PI) / 180, aspect, 0.01, 100);
    C.mat4Identity(this._view);
    const dist = 3.2 / this.state.zoom;
    C.mat4Translate(this._view, this._view, 0, -0.15, -dist);
    C.mat4RotateX(this._view, this._view, (this.state.pitch * Math.PI) / 180);
    C.mat4RotateY(this._view, this._view, (this.state.yaw * Math.PI) / 180);
    C.mat4Multiply(this._mvp, this._proj, this._view); // model = 单位阵
    return this._mvp;
  }

  // —— 3D 世界坐标 → 2D 屏幕坐标（列主序 MVP × 点 → 透视除法 → 视口变换）——
  project3DToScreen(point, mvp, w, h) {
    const M = mvp;
    const { x, y, z } = point;
    const clipX = M[0] * x + M[4] * y + M[8] * z + M[12];
    const clipY = M[1] * x + M[5] * y + M[9] * z + M[13];
    const clipZ = M[2] * x + M[6] * y + M[10] * z + M[14];
    const clipW = M[3] * x + M[7] * y + M[11] * z + M[15];
    if (clipW < 0.01) return null;
    const ndcX = clipX / clipW, ndcY = clipY / clipW, ndcZ = clipZ / clipW;
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1 || ndcZ < -1 || ndcZ > 1) return null;
    return { x: (ndcX * 0.5 + 0.5) * w, y: (1.0 - (ndcY * 0.5 + 0.5)) * h, z: ndcZ };
  }

  _clearAnnot() {
    if (!this.annotCtx || !this.annot) return;
    this.annotCtx.clearRect(0, 0, this.annot.width, this.annot.height);
  }

  render() {
    const gl = this.gl;
    if (!gl) return;
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.wallVertexCount) { this._clearAnnot(); return; }
    const mvp = this._computeMVP();

    // —— 幕墙（渐变三角带）——
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.loc.u_MVPMatrix, false, mvp);
    gl.uniform1f(this.loc.u_wallHeight, this.state.wallHeight);
    gl.uniform1f(this.loc.u_gradientPower, this.state.gradientPower);
    gl.uniform1f(this.loc.u_maxOpacity, this.state.maxOpacity);
    gl.uniform3fv(this.loc.u_color, this.state.wallColor);
    this._bindAttrib(this.buffers.wallPos, this.loc.a_pos, 3);
    this._bindAttrib(this.buffers.wallRatio, this.loc.a_ratio, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.wallVertexCount);

    // —— 轨迹带 2-Pass：阴影投影 → 本体霓虹发光 ——
    gl.useProgram(this.trackProgram);
    gl.uniformMatrix4fv(this.trackLoc.u_MVPMatrix, false, mvp);
    gl.uniform1f(this.trackLoc.u_halfWidth, this.state.trackWidth);
    this._bindAttrib(this.buffers.trackCenter, this.trackLoc.a_center, 3);
    this._bindAttrib(this.buffers.trackNormal, this.trackLoc.a_normal, 2);
    this._bindAttrib(this.buffers.trackDist, this.trackLoc.a_dist, 1);
    this._bindAttrib(this.buffers.trackMetric, this.trackLoc.a_metric, 1);
    this._bindAttrib(this.buffers.trackPercent, this.trackLoc.a_percent, 1);

    // 实时时间（用于流光脉冲动画）
    const elapsedTime = (performance.now() - this._startTime) / 1000.0;

    // 阴影偏移：yaw + 阳光角度 决定投影方向
    const shadowRad = (this.state.yaw + this.state.shadowAngle) * Math.PI / 180;
    const shadowDX = Math.cos(shadowRad) * 0.18;
    const shadowDZ = Math.sin(shadowRad) * 0.18;

    // Pass 1：阴影（拉平至地面，标准半透明混合）
    gl.uniform1i(this.trackLoc.u_isShadow, 1);
    gl.uniform1f(this.trackLoc.u_yBaseline, 0.0);
    gl.uniform2f(this.trackLoc.u_shadowOffset, shadowDX, shadowDZ);
    gl.uniform1f(this.trackLoc.u_shadowOpacity, this.state.shadowOpacity);
    gl.uniform1f(this.trackLoc.u_time, elapsedTime);
    gl.uniform1f(this.trackLoc.u_flowSpeed, 0.0);
    gl.uniform1f(this.trackLoc.u_pulseLength, 0.0);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.trackVertexCount);

    // Pass 2：轨迹本体（加法混合，霓虹发光 + 热力色）
    const glowValue = Math.max(0, Number(this.state.glow) || 0);
    if (glowValue > 0.001) {
      const glowWidth = this.state.trackWidth * (1.9 + glowValue * 3.1);
      gl.uniform1i(this.trackLoc.u_isShadow, 2);
      gl.uniform1f(this.trackLoc.u_halfWidth, glowWidth);
      gl.uniform1f(this.trackLoc.u_glow, glowValue);
      gl.uniform3fv(this.trackLoc.u_color, this.state.trackColor);
      gl.uniform3fv(this.trackLoc.u_coldColor, this.state.coldColor);
      gl.uniform3fv(this.trackLoc.u_hotColor, this.state.hotColor);
      gl.uniform1f(this.trackLoc.u_heatmap, 0.0); // 始终单色
      gl.uniform1f(this.trackLoc.u_time, elapsedTime);
      gl.uniform1f(this.trackLoc.u_flowSpeed, 0.0);
      gl.uniform1f(this.trackLoc.u_pulseLength, 0.0);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.trackVertexCount);
    }

    gl.uniform1i(this.trackLoc.u_isShadow, 0);
    gl.uniform1f(this.trackLoc.u_halfWidth, this.state.trackWidth);
    gl.uniform1f(this.trackLoc.u_glow, this.state.glow);
    gl.uniform3fv(this.trackLoc.u_color, this.state.trackColor);
    gl.uniform3fv(this.trackLoc.u_coldColor, this.state.coldColor);
    gl.uniform3fv(this.trackLoc.u_hotColor, this.state.hotColor);
    gl.uniform1f(this.trackLoc.u_heatmap, 0.0); // 始终单色
    gl.uniform1f(this.trackLoc.u_time, elapsedTime);
    gl.uniform1f(this.trackLoc.u_flowSpeed, 0.0);
    gl.uniform1f(this.trackLoc.u_pulseLength, 0.0);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.trackVertexCount);

    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // —— Canvas 2D 叠层：3D 悬浮高程旗帜 ——
    this._drawAnnotations();
  }

  // ==========================================================================
  //  3D 悬浮高程旗帜（Canvas 2D 叠层渲染）
  // ==========================================================================
  _drawAnnotations() {
    const ctx = this.annotCtx;
    if (!ctx || !this.annot) return;
    this._clearAnnot();
    if (!this.milestones) return;
    const enabled = Object.values(this.state.showMilestones).some(v => v);
    if (!enabled && !this.state.customMetrics.length) return;

    const w = this.annot.width, h = this.annot.height;
    if (!w || !h) return;

    const mvp = this._computeMVP();
    const wallH = this.state.wallHeight;
    const { peak, half, speedPeak, steepest } = this.milestones;
    const cards = [];

    // 最快速度
    if (this.state.showMilestones.speed && speedPeak) {
      const top = this.project3DToScreen({ x: speedPeak.x, y: speedPeak.hf * wallH, z: speedPeak.z }, mvp, w, h);
      const bot = this.project3DToScreen({ x: speedPeak.x, y: 0, z: speedPeak.z }, mvp, w, h);
      if (top) cards.push({ top, bottom: bot, title: '最快速度', value: speedPeak.speedKmh.toFixed(1) + ' km/h', icon: '⚡' });
    }
    // 最高海拔
    if (this.state.showMilestones.peak && peak) {
      const top = this.project3DToScreen({ x: peak.x, y: peak.hf * wallH, z: peak.z }, mvp, w, h);
      const bot = this.project3DToScreen({ x: peak.x, y: 0, z: peak.z }, mvp, w, h);
      if (top) cards.push({ top, bottom: bot, title: '最高海拔', value: peak.ele.toLocaleString() + ' m', icon: '🏔️' });
    }
    // 半程点
    if (this.state.showMilestones.half && half) {
      const top = this.project3DToScreen({ x: half.x, y: half.hf * wallH, z: half.z }, mvp, w, h);
      const bot = this.project3DToScreen({ x: half.x, y: 0, z: half.z }, mvp, w, h);
      if (top) cards.push({ top, bottom: bot, title: '半程点', value: half.distKm.toFixed(1) + ' km', icon: '🏁' });
    }
    // 平均坡度（放在最陡爬坡点位置）
    if (this.state.showMilestones.gradient && steepest && this.stats && this.stats.avgGradient > 0) {
      const top = this.project3DToScreen({ x: steepest.x, y: steepest.hf * wallH, z: steepest.z }, mvp, w, h);
      const bot = this.project3DToScreen({ x: steepest.x, y: 0, z: steepest.z }, mvp, w, h);
      if (top) cards.push({ top, bottom: bot, title: '平均坡度', value: this.stats.avgGradient.toFixed(1) + '%', icon: '📐' });
    }

    for (const c of cards) this._drawMilestoneCard(ctx, c);
  }

  _drawMilestoneCard(ctx, card) {
    const { top, bottom, title, value, icon } = card;
    const lineH = 42;
    const ax = top.x, ay = top.y;

    ctx.save();

    // 虚线引线：地面投影点 → 轨迹点
    if (bottom) {
      ctx.strokeStyle = 'rgba(251,146,60,0.35)';
      ctx.lineWidth = 1.2; ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.moveTo(bottom.x, bottom.y); ctx.lineTo(top.x, top.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    // 轨迹点位置：小实心圆点
    ctx.beginPath();
    ctx.arc(ax, ay, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fb923c';
    ctx.shadowColor = 'rgba(251,146,60,0.7)'; ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowColor = 'transparent';

    // 上方文字（无背景框，仅文字 + 发光阴影确保可读）
    const tx = ax, ty = ay - lineH;
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';

    ctx.font = 'bold 12.5px Nunito, "PingFang SC", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(icon + ' ' + title, tx, ty);

    ctx.font = 'bold 11.5px Nunito, "PingFang SC", sans-serif';
    ctx.fillStyle = '#fb923c';
    ctx.fillText(value, tx, ty - 18);

    ctx.restore();
  }

  _bindAttrib(buffer, loc, size) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.glCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.glCanvas.width !== w || this.glCanvas.height !== h) {
      this.glCanvas.width = w;
      this.glCanvas.height = h;
      if (this.annot) { this.annot.width = w; this.annot.height = h; }
      if (this.gl) this.gl.viewport(0, 0, w, h);
      this.requestRender();
    }
  }

  // ==========================================================================
  //  Coloris 调色盘集成（幕墙色 + 轨迹色 + 冷/暖色 → uniform）
  // ==========================================================================
  _initColoris() {
    // 3D 幕墙颜色
    const wcInput = this.$('wallColor');
    if (wcInput) {
      wcInput.addEventListener('input', (e) => {
        this.state.wallColor = this._hexToRgb(e.target.value);
        e.target.style.background = e.target.value;
        this.requestRender();
      });
      wcInput.style.background = '#fb923c';
    }

    // 2D 轨迹带颜色
    const tcInput = this.$('trackColor');
    if (tcInput) {
      tcInput.addEventListener('input', (e) => {
        this.state.trackColor = this._hexToRgb(e.target.value);
        e.target.style.background = e.target.value;
        this.requestRender();
      });
      tcInput.style.background = '#fb923c';
    }

  }

  _hexToRgb(hex) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [
      parseInt(full.slice(0, 2), 16) / 255,
      parseInt(full.slice(2, 4), 16) / 255,
      parseInt(full.slice(4, 6), 16) / 255,
    ];
  }

  // ==========================================================================
  //  海报导出：与预览画面一致，2x 超采样保证像素不退化
  // ==========================================================================
  async generatePoster() {
    if (!this.stats) return;
    const _t0 = Date.now();

    // 记录当前画布尺寸，临时翻倍渲染以提升导出分辨率
    const origW = this.glCanvas.width, origH = this.glCanvas.height;
    const scale = 2;
    const W = origW * scale, H = origH * scale;

    // 临时扩大 WebGL 画布，重新渲染
    this.glCanvas.width = W;
    this.glCanvas.height = H;
    if (this.gl) this.gl.viewport(0, 0, W, H);
    if (this.annot) { this.annot.width = W; this.annot.height = H; }
    this.render();

    // —— 导出画布 ——
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    // —— ① 舞台背景 ——
    if (this.bgImage) {
      this._drawCover(ctx, this.bgImage, 0, 0, W, H);
      if (this.state.bgDarken) {
        ctx.fillStyle = 'rgba(8,10,16,0.34)';
        ctx.fillRect(0, 0, W, H);
      }
    } else {
      const grad = ctx.createRadialGradient(W * 0.60, 0, 0, W * 0.50, H * 0.50, Math.max(W, H) * 0.75);
      grad.addColorStop(0, 'rgba(40,44,60,0.55)');
      grad.addColorStop(1, 'rgba(10,11,16,0.75)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    // —— ② WebGL 帧（1:1） ——
    ctx.drawImage(this.glCanvas, 0, 0);

    // —— ③ 高程旗帜 ——
    if (this.annot && this.annot.width > 0) {
      ctx.drawImage(this.annot, 0, 0);
    }

    // —— ④ 文字叠层 ——
    this._drawOverlayText(ctx, W, H);

    // —— 恢复原始画布尺寸 ——
    this.glCanvas.width = origW;
    this.glCanvas.height = origH;
    if (this.gl) this.gl.viewport(0, 0, origW, origH);
    if (this.annot) { this.annot.width = origW; this.annot.height = origH; }
    this.render();

    // —— 导出 PNG ——
    const posterName = (this.trackName || 'track') + '-poster.png';

    await new Promise((res) => {
      c.toBlob((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = posterName;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        this.tracker?.sendEvent('export_poster', {
          track_name: this.trackName,
          res: `${W}x${H}`,
          has_bg: !!this.bgImage,
          cost: Date.now() - _t0,
        });
        res();
      }, 'image/png');
    });
  }

  // 将 annotation canvas 上的高程旗帜等比映射到导出海报画布
  _drawAnnotInPoster(ctx, dx, dy, dw, dh) {
    const glW = this.glCanvas.width, glH = this.glCanvas.height;
    if (!glW || !glH) return;
    const scale = dw / glW;
    const mvp = this._computeMVP();
    const wallH = this.state.wallHeight;
    const { peak, half, speedPeak, steepest } = this.milestones;
    const cards = [];

    if (this.state.showMilestones.speed && speedPeak) {
      const top = this.project3DToScreen({ x: speedPeak.x, y: speedPeak.hf * wallH, z: speedPeak.z }, mvp, glW, glH);
      const bot = this.project3DToScreen({ x: speedPeak.x, y: 0, z: speedPeak.z }, mvp, glW, glH);
      if (top) cards.push({ top, bottom: bot, title: '最快速度', value: speedPeak.speedKmh.toFixed(1) + ' km/h', icon: '⚡' });
    }
    if (this.state.showMilestones.peak && peak) {
      const top = this.project3DToScreen({ x: peak.x, y: peak.hf * wallH, z: peak.z }, mvp, glW, glH);
      const bot = this.project3DToScreen({ x: peak.x, y: 0, z: peak.z }, mvp, glW, glH);
      if (top) cards.push({ top, bottom: bot, title: '最高海拔', value: peak.ele.toLocaleString() + ' m', icon: '🏔️' });
    }
    if (this.state.showMilestones.half && half) {
      const top = this.project3DToScreen({ x: half.x, y: half.hf * wallH, z: half.z }, mvp, glW, glH);
      const bot = this.project3DToScreen({ x: half.x, y: 0, z: half.z }, mvp, glW, glH);
      if (top) cards.push({ top, bottom: bot, title: '半程点', value: half.distKm.toFixed(1) + ' km', icon: '🏁' });
    }
    if (this.state.showMilestones.gradient && steepest && this.stats && this.stats.avgGradient > 0) {
      const top = this.project3DToScreen({ x: steepest.x, y: steepest.hf * wallH, z: steepest.z }, mvp, glW, glH);
      const bot = this.project3DToScreen({ x: steepest.x, y: 0, z: steepest.z }, mvp, glW, glH);
      if (top) cards.push({ top, bottom: bot, title: '平均坡度', value: this.stats.avgGradient.toFixed(1) + '%', icon: '📐' });
    }
    if (!cards.length) return;

    ctx.save();
    for (const c of cards) {
      const mx = dx + c.top.x * scale, my = dy + c.top.y * scale;
      const bx = dx + (c.bottom ? c.bottom.x : c.top.x) * scale;
      const by = dy + (c.bottom ? c.bottom.y : c.top.y) * scale;
      const lineH = 42 * scale;

      if (c.bottom) {
        ctx.strokeStyle = 'rgba(251,146,60,0.35)';
        ctx.lineWidth = 1.2 * scale; ctx.setLineDash([3 * scale, 5 * scale]);
        ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(mx, my); ctx.stroke();
        ctx.setLineDash([]);
      }

      // 轨迹点：小圆点
      ctx.beginPath();
      ctx.arc(mx, my, 3.5 * scale, 0, Math.PI * 2);
      ctx.fillStyle = '#fb923c';
      ctx.shadowColor = 'rgba(251,146,60,0.7)'; ctx.shadowBlur = 6 * scale;
      ctx.fill();
      ctx.shadowColor = 'transparent';

      // 上方文字（无背景框）
      const tx = mx, ty = my - lineH;
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 5 * scale; ctx.shadowOffsetY = 1 * scale;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';

      ctx.font = 'bold ' + (12.5 * scale) + 'px Nunito, "PingFang SC", sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(c.icon + ' ' + c.title, tx, ty);
      ctx.font = 'bold ' + (11.5 * scale) + 'px Nunito, "PingFang SC", sans-serif';
      ctx.fillStyle = '#fb923c';
      ctx.fillText(c.value, tx, ty - 18 * scale);
    }
    ctx.restore();
  }

  // 顶层文字排版：严格按 DOM 预览图层(overlay)的实际位置/字号/颜色等比映射到导出画布（所见即所得）
  _drawOverlayText(ctx, W, H) {
    const ov = this.$('overlay');
    const base = this.glCanvas.getBoundingClientRect();
    if (!base.width) return;
    const scale = W / base.width; // 缩放比 = 导出分辨率 / 预览容器宽度
    const els = ov.querySelectorAll('.label, .value, .t3d-brand');
    els.forEach((el) => {
      const txt = (el.textContent || '').trim();
      if (!txt) return;
      const r = el.getBoundingClientRect();
      const cx = (r.left + r.width / 2 - base.left) * scale;
      const cy = (r.top + r.height / 2 - base.top) * scale;
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize) * scale; // 等比缩放字号
      ctx.font = `${cs.fontWeight} ${fs}px Nunito, "PingFang SC", sans-serif`;
      ctx.fillStyle = cs.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // 轻微阴影，保证复杂背景下可读（对应 DOM 的 text-shadow）
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = fs * 0.22;
      ctx.shadowOffsetY = fs * 0.05;
      ctx.fillText(txt, cx, cy);
    });
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }

  _drawCover(ctx, img, x, y, w, h) {
    const ir = img.width / img.height, tr = w / h;
    let dw, dh, dx, dy;
    if (ir > tr) { dh = h; dw = h * ir; dx = x - (dw - w) / 2; dy = y; }
    else { dw = w; dh = w / ir; dx = x; dy = y - (dh - h) / 2; }
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  // ==========================================================================
  //  工具
  // ==========================================================================
  _fail(msg) {
    console.error('[ThreeDTrackPoster]', msg);
    if (this.emptyHint) {
      this.emptyHint.style.opacity = '1';
      this.emptyHint.querySelector('div:last-child').innerHTML = '⚠️ ' + msg;
    }
  }
}
