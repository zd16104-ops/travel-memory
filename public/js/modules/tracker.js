/**
 * Tracker — 轻量级前端行为监控与埋点模块
 * 无外部依赖，纯原生 ESM
 *
 * 功能：
 *   1. 会话标识 (Session & UV)
 *   2. 基于 Page Visibility API 的活跃停留时间统计
 *   3. 通用事件发送接口 sendEvent(eventType, eventMeta)
 *   4. 高频操作防抖封装 trackInteraction(actionName, data)
 */

export class Tracker {
  /**
   * @param {Object} options
   * @param {string} options.endpoint  - 后端接收地址，默认 '/api/log'
   * @param {boolean} options.debug    - 开启控制台调试日志
   */
  constructor(options = {}) {
    this.endpoint = options.endpoint || '/api/log';
    this.debug = !!options.debug;

    // ========== 1. 会话标识 ==========
    this.sessionId = this._initSession();

    // ========== 2. 活跃停留时间 ==========
    this._activeTimeMs = 0;
    this._lastVisibleAt = Date.now();
    this._leaveSent = false;
    this._setupVisibilityTracking();

    // ========== 4. 防抖计时器 ==========
    this._debounceTimers = new Map();

    // 初始化时自动上报 pageview
    this.sendEvent('pageview');

    this._log('initialized, sid:', this.sessionId);
  }

  // ---- 会话 ID ----

  _initSession() {
    try {
      let sid = sessionStorage.getItem('_trk_sid');
      if (!sid) {
        sid = 's' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem('_trk_sid', sid);
      }
      return sid;
    } catch (e) {
      // sessionStorage 不可用时降级为内存 ID
      return 's' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }
  }

  // ---- 2. 活跃停留时间（Page Visibility API） ----

  _setupVisibilityTracking() {
    const handleChange = () => {
      if (document.hidden) {
        // 页面隐藏：累加当前段的活跃时间
        this._activeTimeMs += Date.now() - this._lastVisibleAt;
        this._log('hidden, active:', this._activeTimeMs, 'ms');
      } else {
        // 页面重新可见：重置计时起点
        this._lastVisibleAt = Date.now();
        this._log('visible');
      }
    };

    document.addEventListener('visibilitychange', handleChange);

    // 页面离开时发送停留时长
    const handleLeave = () => {
      if (this._leaveSent) return;
      this._leaveSent = true;

      // 如果页面离开时仍可见，把当前段也加上
      if (!document.hidden) {
        this._activeTimeMs += Date.now() - this._lastVisibleAt;
      }

      if (this._activeTimeMs < 3000) return; // 少于 3 秒不报

      const payload = JSON.stringify({
        event_type: 'page_leave',
        active_time_ms: Math.round(this._activeTimeMs),
        session_id: this.sessionId,
      });

      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(this.endpoint, blob);
      this._log('leave beacon sent, active:', Math.round(this._activeTimeMs), 'ms');
    };

    // pagehide 优先于 beforeunload（移动端兼容性更好）
    window.addEventListener('pagehide', handleLeave);
    window.addEventListener('beforeunload', handleLeave);
  }

  // ---- 3. 通用事件发送 ----

  /**
   * 发送埋点事件到后端 /api/log
   *
   * @param {string} eventType   - 事件类型，如 'pageview', 'download', 'upload_success'
   * @param {Object} eventMeta   - 附加元数据（JSON 可序列化对象）
   */
  sendEvent(eventType, eventMeta = {}) {
    const payload = {
      session_id: this.sessionId,
      event_type: String(eventType).slice(0, 50),
      event_meta: typeof eventMeta === 'object' ? eventMeta : {},
    };

    // 当前活跃时间（用于非 leave 事件的上下文）
    const now = Date.now();
    if (!document.hidden) {
      this._activeTimeMs += now - this._lastVisibleAt;
      this._lastVisibleAt = now;
    }
    payload.active_time_ms = Math.round(this._activeTimeMs);

    // 页面正在卸载时用 sendBeacon
    if (document.visibilityState === 'hidden') {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon(this.endpoint, blob);
      return;
    }

    // 正常发送
    fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {
      // 后端无响应不阻断前端
      this._log('sendEvent fetch failed for:', eventType);
    });

    this._log('sendEvent:', eventType, eventMeta);
  }

  // ---- 4. 防抖封装 ----

  /**
   * 高频操作防抖埋点。用于滑块拖动等场景。
   * 延迟 1 秒发送；1 秒内同 actionName 再次调用则重置计时器。
   *
   * @param {string} actionName - 动作名称，同一动作去重
   * @param {Object} data       - 最终发送的元数据
   */
  trackInteraction(actionName, data = {}) {
    if (this._debounceTimers.has(actionName)) {
      clearTimeout(this._debounceTimers.get(actionName));
    }

    this._debounceTimers.set(
      actionName,
      setTimeout(() => {
        this._debounceTimers.delete(actionName);
        this.sendEvent(actionName, data);
      }, 1000)
    );
  }

  // ---- 内部 ----

  _log(...args) {
    if (this.debug) console.log('[Tracker]', ...args);
  }
}

export default Tracker;
