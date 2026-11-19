/*
 * 合成大物华 · 跑路了
 * ---------------------------------------------------------------------------
 * 设计要点
 * 1. 物理与渲染彻底分离：
 *    - Matter.js 使用 CONFIG.LEVELS[*].radius 作为方形碰撞体的半边长，
 *      图片只负责“画进边长为 2r 的固定盒子”，按原始整图等比 contain。
 *    - 换任何分辨率的图，碰撞尺寸、落点、质量都不会改变。
 * 2. Canvas 2D 而不是 DOM <img>：
 *    - 场上物体多、每帧有旋转/粒子/震动；Canvas 只需一次 drawImage，DOM 会被
 *      transform/layout 拖慢，且 DPR 控制更麻烦。
 * 3. 固定 60Hz 物理步长 + 表现层可变 dt，兼顾稳定性和高刷屏顺滑。
 * 4. 所有结束流程都严格按“冻结 -> 换 00 -> 标题 -> 重开 -> 成就”的顺序执行。
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  /* =========================================================================
   * 0. 基础守卫 / 工具
   * ========================================================================= */
  var CONFIG = window.CONFIG;
  var doc = document;

  function showFatal(message) {
    var overlay = doc.getElementById('fatalOverlay');
    var text = doc.getElementById('fatalMessage');
    if (text) text.textContent = message;
    if (overlay) {
      overlay.classList.add('is-open');
      overlay.setAttribute('aria-hidden', 'false');
    }
    var boot = doc.getElementById('bootOverlay');
    if (boot) boot.classList.add('is-hidden');
    console.error('[game] ' + message);
  }

  if (!CONFIG) {
    showFatal('js/config.js 没有加载成功。');
    return;
  }
  if (!window.Matter) {
    showFatal('Matter.js 没有加载成功。请检查网络，或确认 vendor/matter.min.js 存在。');
    return;
  }

  var Matter = window.Matter;
  var Engine = Matter.Engine;
  var Composite = Matter.Composite;
  var Bodies = Matter.Bodies;
  var Body = Matter.Body;
  var Events = Matter.Events;

  var STEP_MS = 1000 / 60;
  var STEP_SEC = 1 / 60;
  var TAU = Math.PI * 2;
  var SCORE_FORMAT = new Intl.NumberFormat('zh-CN');

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function randomRange(min, max) {
    return min + Math.random() * (max - min);
  }

  function pad2(level) {
    return String(level).padStart(2, '0');
  }

  function formatScore(value) {
    return SCORE_FORMAT.format(Math.max(0, Math.round(value || 0)));
  }

  function average(values) {
    if (!values.length) return 0;
    var sum = 0;
    for (var i = 0; i < values.length; i++) sum += values[i];
    return sum / values.length;
  }

  function distanceSq(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  function getMeta(key) {
    if (!key) return null;
    if (CONFIG.LEVEL_BY_KEY[key]) return CONFIG.LEVEL_BY_KEY[key];
    if (key === CONFIG.SPECIAL_OUTPUT.key) return CONFIG.SPECIAL_OUTPUT;
    if (key === CONFIG.ENDING.key) {
      return {
        key: CONFIG.ENDING.key,
        img: CONFIG.ENDING.img,
        name: CONFIG.ENDING.title,
        color: '#3A1D2D',
        ink: '#1B0B14',
        radius: 0,
        level: null
      };
    }
    return null;
  }

  function getBaseRadius(key) {
    var meta = getMeta(key);
    return meta ? Number(meta.radius) || 0 : 0;
  }

  function isNumericFruitKey(key) {
    return !!CONFIG.LEVEL_BY_KEY[key];
  }

  var els = {};
  var state = {
    // Matter
    engine: null,
    world: null,
    walls: [],

    // 场上水果 Body 数组
    fruits: [],
    nextFruitId: 1,
    maxFruits: CONFIG.MAX_FRUITS,

    // 分数 / 掉落队列
    score: 0,
    bestScore: 0,
    currentKey: null,
    nextKey: null,
    dropReadyAt: 0,
    simTime: 0,
    accumulator: 0,
    lastFrame: 0,
    running: false,
    ending: false,
    manualPaused: false,
    hidden: false,

    // 瞄准
    pointerId: null,
    pointerActive: false,
    aimX: 0,
    hasDropped: false,

    // 神秘暗号：自由放置模式
    cheatPlaceKey: null,
    cheatPointerId: null,
    cheatPreview: null,

    // 合成队列（每个物理步开始清空）
    mergeQueue: [],
    seenPairs: new Set(),

    // 表现层
    effects: {
      particles: [],
      rings: [],
      texts: []
    },
    flash: 0,
    shake: 0,
    dangerPressure: 0,

    // 布局
    layout: null,
    resizeRaf: 0,

    // 结束 / 特殊流程
    endedAt: 0,
    endAchievementTimer: null,
    warningOpen: false,
    rewindUsed: false,
    dangerGraceUntil: 0,
    rewindBannerTimer: null,

    // 是否在 ?debug=1 下
    debug: false
  };

  /* =========================================================================
   * 1. 存档：localStorage（成就、最高分、声音偏好）
   * ========================================================================= */
  var storageOk = true;
  var persistTimer = null;

  function defaultSave() {
    return {
      version: 1,
      bestScore: 0,
      gamesPlayed: 0,
      soundOn: true,
      cheatUnlocked: false,
      achievements: {}
    };
  }

  function sanitizeSave(raw) {
    var save = defaultSave();
    if (!raw || typeof raw !== 'object') return save;

    if (typeof raw.bestScore === 'number' && isFinite(raw.bestScore)) {
      save.bestScore = Math.max(0, Math.floor(raw.bestScore));
    }
    if (typeof raw.gamesPlayed === 'number' && isFinite(raw.gamesPlayed)) {
      save.gamesPlayed = Math.max(0, Math.floor(raw.gamesPlayed));
    }
    if (typeof raw.soundOn === 'boolean') {
      save.soundOn = raw.soundOn;
    }
    if (raw.cheatUnlocked === true) {
      save.cheatUnlocked = true;
    }
    if (raw.achievements && typeof raw.achievements === 'object') {
      CONFIG.ACHIEVEMENTS.forEach(function (def) {
        var entry = raw.achievements[def.id];
        if (entry && entry.unlocked === true) {
          save.achievements[def.id] = {
            unlocked: true,
            unlockedAt: typeof entry.unlockedAt === 'string' ? entry.unlockedAt : new Date().toISOString()
          };
        }
      });
    }
    return save;
  }

  function loadSave() {
    try {
      var raw = window.localStorage.getItem(CONFIG.STORAGE_KEY);
      if (!raw) return defaultSave();
      return sanitizeSave(JSON.parse(raw));
    } catch (error) {
      storageOk = false;
      console.warn('[save] localStorage 不可用，本次运行只保存在内存中。', error);
      return defaultSave();
    }
  }

  var save = loadSave();
  state.bestScore = save.bestScore;

  function persist() {
    if (!storageOk) return;
    try {
      window.localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(save));
    } catch (error) {
      storageOk = false;
      console.warn('[save] 写入 localStorage 失败。', error);
    }
  }

  function persistSoon() {
    if (persistTimer) return;
    persistTimer = window.setTimeout(function () {
      persistTimer = null;
      persist();
    }, 220);
  }

  function getAchievementList() {
    return CONFIG.ACHIEVEMENTS.map(function (def) {
      var entry = save.achievements[def.id];
      return {
        id: def.id,
        name: def.name,
        desc: def.desc,
        unlocked: !!(entry && entry.unlocked),
        unlockedAt: entry && entry.unlockedAt ? entry.unlockedAt : null
      };
    });
  }

  function isAchievementUnlocked(id) {
    var entry = save.achievements[id];
    return !!(entry && entry.unlocked);
  }

  function unlockAchievement(id) {
    var definition = CONFIG.ACHIEVEMENT_BY_ID[id];
    if (!definition || isAchievementUnlocked(id)) return false;

    var unlockedAt = new Date().toISOString();
    save.achievements[id] = { unlocked: true, unlockedAt: unlockedAt };
    persist();

    UI.renderAchievements();
    UI.pushToast({
      id: id,
      name: definition.name,
      desc: definition.desc
    });
    Sound.achievement();

    return true;
  }

  /* =========================================================================
   * 2. 音效占位（WebAudio 合成，不依赖外部音频文件）
   * ========================================================================= */
  var Sound = {
    ctx: null,
    enabled: true,

    ensure: function () {
      if (!this.enabled) return null;
      var AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      if (!this.ctx) {
        try {
          this.ctx = new AudioCtor();
        } catch (error) {
          return null;
        }
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(function () {});
      }
      return this.ctx;
    },

    unlock: function () {
      this.ensure();
      Music.unlock();
    },

    tone: function (frequency, duration, type, gainValue, delay, endFrequency) {
      var ctx = this.ensure();
      if (!ctx) return;
      var start = ctx.currentTime + (delay || 0);
      var end = start + duration;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(frequency, start);
      if (endFrequency) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), end);
      }
      var level = Math.max(0.0001, gainValue || 0.045);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(level, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(end + 0.03);
    },

    sequence: function (notes, step, type, gain) {
      var self = this;
      notes.forEach(function (note, index) {
        self.tone(note, Math.max(0.1, step * 1.8), type || 'triangle', gain || 0.04, index * step);
      });
    },

    drop: function () {
      this.tone(300, 0.07, 'triangle', 0.025, 0, 190);
    },

    select: function () {
      this.tone(620, 0.07, 'sine', 0.03, 0, 880);
    },

    merge: function (level) {
      var base = 190 + level * 22;
      this.tone(base, 0.12, 'sine', 0.045);
      this.tone(base * 1.5, 0.14, 'sine', 0.028, 0.045);
    },

    twelve: function () {
      this.sequence([392, 523, 659, 784], 0.075, 'triangle', 0.05);
    },

    warning: function () {
      this.tone(440, 0.16, 'square', 0.026);
      this.tone(330, 0.22, 'square', 0.024, 0.18);
    },

    rewind: function () {
      // 倒带感：下行音阶快速掠过，再回到高音
      this.sequence([1046.5, 783.99, 659.25, 523.25, 392, 523.25], 0.055, 'triangle', 0.04);
    },

    special: function () {
      this.sequence([523.25, 659.25, 783.99, 1046.5, 1318.5], 0.07, 'sine', 0.05);
    },

    achievement: function () {
      this.sequence([659.25, 880, 1108.73], 0.085, 'triangle', 0.038);
    },

    gameOver: function () {
      this.sequence([329.63, 261.63, 196, 146.83], 0.13, 'sine', 0.05);
    },

    toggle: function () {
      this.enabled = !this.enabled;
      save.soundOn = this.enabled;
      persist();
      if (this.enabled) {
        this.unlock();
        Music.resumeIfWanted();
      } else {
        Music.pause();
      }
      if (UI.ready) UI.updateSoundButton();
      return this.enabled;
    },

    setEnabled: function (value) {
      this.enabled = !!value;
      save.soundOn = this.enabled;
      if (UI.ready) UI.updateSoundButton();
    }
  };
  Sound.enabled = save.soundOn;

  /* =========================================================================
   * 2.5 春日影 BGM（用户提供的本地音频，不转码）
   * ========================================================================= */
  var Music = {
    audio: null,
    wanted: false,
    unlocked: false,

    ensure: function () {
      if (!this.audio) {
        this.audio = new Audio(CONFIG.MUSIC.chunriying);
        this.audio.preload = 'metadata';
        this.audio.loop = false;
        this.audio.volume = CONFIG.MUSIC.volume;
        this.audio.playsInline = true;
        this.audio.addEventListener('ended', function () {
          Music.wanted = false;
        });
      }
      return this.audio;
    },

    unlock: function () {
      var audio = this.ensure();
      if (!audio || !Sound.enabled) return;
      // 第一次触屏后再开始下载 10MB 音频，避免拖慢首屏。
      if (audio.preload !== 'auto') {
        audio.preload = 'auto';
        try { audio.load(); } catch (error) {}
      }
      if (this.unlocked) {
        this.resumeIfWanted();
        return;
      }
      this.unlocked = true;
      // 静音试播一小段，解锁移动端的后续程序化播放权限。
      var self = this;
      var wasMuted = audio.muted;
      audio.muted = true;
      var promise = audio.play();
      if (promise && typeof promise.then === 'function') {
        promise.then(function () {
          audio.pause();
          audio.currentTime = 0;
          audio.muted = wasMuted;
          if (self.wanted) self.playChunriying(false);
        }).catch(function () {
          audio.muted = wasMuted;
        });
      } else {
        audio.pause();
        audio.currentTime = 0;
        audio.muted = wasMuted;
      }
    },

    playChunriying: function (restart) {
      if (!Sound.enabled) return;
      var audio = this.ensure();
      if (!audio) return;
      this.wanted = true;
      if (restart !== false) {
        try { audio.currentTime = 0; } catch (error) {}
      }
      audio.volume = CONFIG.MUSIC.volume;
      var promise = audio.play();
      if (promise && typeof promise.catch === 'function') {
        promise.catch(function () {
          // 移动端可能拒绝程序化播放；下一次触屏会由 unlock 重试。
        });
      }
    },

    resumeIfWanted: function () {
      if (!this.wanted || !this.audio || !Sound.enabled) return;
      if (this.audio.paused) {
        this.audio.play().catch(function () {});
      }
    },

    pause: function () {
      if (this.audio && !this.audio.paused) this.audio.pause();
    },

    stop: function () {
      this.wanted = false;
      if (!this.audio) return;
      this.audio.pause();
      try { this.audio.currentTime = 0; } catch (error) {}
    }
  };

  /* =========================================================================
   * 3. 图片加载（只读原始文件，绝不改写像素）
   * ========================================================================= */
  var SpriteSet = {
    assets: Object.create(null),

    definitions: function () {
      var list = CONFIG.LEVELS.map(function (level) {
        return {
          key: pad2(level.level),
          src: level.img
        };
      });
      list.push({ key: CONFIG.SPECIAL_OUTPUT.key, src: CONFIG.SPECIAL_OUTPUT.img });
      list.push({ key: CONFIG.ENDING.key, src: CONFIG.ENDING.img });
      return list;
    },

    preload: function (onProgress) {
      var self = this;
      var definitions = this.definitions();
      var total = definitions.length;
      var loadedCount = 0;

      function loadOne(definition) {
        return new Promise(function (resolve) {
          var attempts = 0;
          var maxAttempts = 2;
          var finished = false;

          function finish() {
            if (finished) return;
            finished = true;
            loadedCount += 1;
            if (typeof onProgress === 'function') onProgress(loadedCount, total);
            resolve();
          }

          function markFailed(image) {
            self.assets[definition.key] = {
              key: definition.key,
              src: definition.src,
              image: image,
              loaded: false,
              failed: true,
              naturalWidth: 0,
              naturalHeight: 0
            };
            console.warn('[assets] 图片加载失败（已重试），将使用程序占位图：' + definition.src);
            finish();
          }

          function attempt() {
            attempts += 1;
            var image = new Image();
            var settled = false;
            var timeout = window.setTimeout(function () {
              if (settled) return;
              settled = true;
              retryOrFail(image);
            }, 6000);

            function retryOrFail(failedImage) {
              window.clearTimeout(timeout);
              if (attempts < maxAttempts) {
                window.setTimeout(attempt, 220);
              } else {
                markFailed(failedImage);
              }
            }

            image.decoding = 'async';
            image.onload = function () {
              if (settled) return;
              settled = true;
              window.clearTimeout(timeout);
              self.assets[definition.key] = {
                key: definition.key,
                src: definition.src,
                image: image,
                loaded: true,
                failed: false,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight
              };
              finish();
            };
            image.onerror = function () {
              if (settled) return;
              settled = true;
              retryOrFail(image);
            };

            // 仅 HTTP(S) 加缓存穿透参数；file:// 保持原路径。
            if (attempts === 1 || window.location.protocol === 'file:') {
              image.src = definition.src;
            } else {
              image.src = definition.src + (definition.src.indexOf('?') >= 0 ? '&' : '?') + 'retry=' + Date.now();
            }
          }

          attempt();
        });
      }

      return Promise.all(definitions.map(loadOne));
    },

    get: function (key) {
      return this.assets[key] || null;
    },

    isLoaded: function (key) {
      var asset = this.assets[key];
      return !!(asset && asset.loaded && asset.naturalWidth > 0 && asset.naturalHeight > 0);
    },

    report: function () {
      var layout = state.layout;
      var k = layout ? layout.k : 1;
      return Object.keys(this.assets).map(function (key) {
        var asset = SpriteSet.assets[key];
        var baseRadius = getBaseRadius(key) || CONFIG.LEVEL_BY_NUMBER[12].radius;
        var box = baseRadius * 2 * k * CONFIG.SPRITE_BOX_SCALE;
        var fit = null;
        if (asset.loaded && asset.naturalWidth > 0) {
          var scale = Math.min(box / asset.naturalWidth, box / asset.naturalHeight);
          var drawWidth = asset.naturalWidth * scale;
          var drawHeight = asset.naturalHeight * scale;
          var scaleX = drawWidth / asset.naturalWidth;
          var scaleY = drawHeight / asset.naturalHeight;
          fit = {
            drawWidth: drawWidth,
            drawHeight: drawHeight,
            scaleX: scaleX,
            scaleY: scaleY,
            uniform: Math.abs(scaleX - scaleY) < 1e-9,
            fullSourceUsed: true
          };
        }
        return {
          key: key,
          src: asset.src,
          loaded: asset.loaded,
          naturalWidth: asset.naturalWidth,
          naturalHeight: asset.naturalHeight,
          targetBoxPx: Number(box.toFixed(3)),
          fit: fit
        };
      });
    }
  };

  /* =========================================================================
   * 4. UI：HUD、Toast、成就抽屉、结束层
   * ========================================================================= */
  var TOAST_DURATION = 3300;
  var toastQueue = [];
  var toastActive = false;
  var lastFocusBeforePanel = null;

  var ACHIEVEMENT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 3h10v4.4a5 5 0 0 1-4.15 4.93V15h2.4a1 1 0 0 1 1 1v2H7.75v-2a1 1 0 0 1 1-1H11v-2.67A5 5 0 0 1 7 7.4V3Zm-2 1.5H3.5V7A3.5 3.5 0 0 0 6.65 10.5l.35.03V8.5A1.5 1.5 0 0 1 5.5 7V4.5ZM19 4.5v2.5a1.5 1.5 0 0 1-1.5 1.5v2.03l.35-.03A3.5 3.5 0 0 0 20.5 7V4.5H19Z"/></svg>';
  var LOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 10V8a5 5 0 0 1 10 0v2h1.2A1.8 1.8 0 0 1 20 11.8v7.4a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 19.2v-7.4A1.8 1.8 0 0 1 5.8 10H7Zm2 0h6V8a3 3 0 0 0-6 0v2Zm3 3.2a1.7 1.7 0 0 0-.9 3.14V18h1.8v-1.66a1.7 1.7 0 0 0-.9-3.14Z"/></svg>';

  var UI = {
    ready: false,
    toastTimer: null,
    copyLinkTimer: null,
    subtitleTimer: null,
    subtitleExitTimer: null,
    subtitleQueue: [],
    subtitleActive: false,

    init: function () {
      els.shell = doc.getElementById('gameShell');
      els.canvas = doc.getElementById('gameCanvas');
      els.ctx = els.canvas.getContext('2d', { alpha: true });
      els.hud = doc.getElementById('hud');
      els.scoreValue = doc.getElementById('scoreValue');
      els.bestValue = doc.getElementById('bestValue');
      els.nextCanvas = doc.getElementById('nextCanvas');
      els.nextCtx = els.nextCanvas.getContext('2d');
      els.achievementBtn = doc.getElementById('achievementBtn');
      els.achievementBadge = doc.getElementById('achievementBadge');
      els.soundBtn = doc.getElementById('soundBtn');
      els.gestureHint = doc.getElementById('gestureHint');
      els.safeTopProbe = doc.getElementById('safeTopProbe');
      els.safeBottomProbe = doc.getElementById('safeBottomProbe');
      els.endOverlay = doc.getElementById('endOverlay');
      els.finalScore = doc.getElementById('finalScore');
      els.finalBest = doc.getElementById('finalBest');
      els.restartBtn = doc.getElementById('restartBtn');
      els.endAchievementBtn = doc.getElementById('endAchievementBtn');
      els.panel = doc.getElementById('achievementPanel');
      els.panelSheet = doc.getElementById('achievementSheet');
      els.closeAchievementBtn = doc.getElementById('closeAchievementBtn');
      els.achievementCount = doc.getElementById('achievementCount');
      els.achievementList = doc.getElementById('achievementList');
      els.recipeLine = doc.getElementById('recipeLine');
      els.toastLayer = doc.getElementById('toastLayer');
      els.bootOverlay = doc.getElementById('bootOverlay');
      els.bootStatus = doc.getElementById('bootStatus');
      els.fatalOverlay = doc.getElementById('fatalOverlay');
      els.rewindChip = doc.getElementById('rewindChip');
      els.rewindBanner = doc.getElementById('rewindBanner');
      els.rewindDetail = doc.getElementById('rewindDetail');
      els.ninePickBtn = doc.getElementById('ninePickBtn');
      els.sendPicker = doc.getElementById('sendPicker');
      els.sendPickerSheet = doc.getElementById('sendPickerSheet');
      els.closePickerBtn = doc.getElementById('closePickerBtn');
      els.fruitGrid = doc.getElementById('fruitGrid');
      els.subtitleLayer = doc.getElementById('subtitleLayer');
      els.subtitleText = doc.getElementById('subtitleText');
      els.level12Warning = doc.getElementById('level12Warning');
      els.level12WarningTitle = doc.getElementById('level12WarningTitle');
      els.level12WarningText = doc.getElementById('level12WarningText');
      els.warningContinueBtn = doc.getElementById('warningContinueBtn');
      els.warningQuitBtn = doc.getElementById('warningQuitBtn');
      els.copyLinkBtn = doc.getElementById('copyLinkBtn');
      els.copyLinkStatus = doc.getElementById('copyLinkStatus');
      els.secretRow = doc.getElementById('secretRow');
      els.secretInput = doc.getElementById('secretInput');
      els.secretSubmitBtn = doc.getElementById('secretSubmitBtn');
      els.secretStatus = doc.getElementById('secretStatus');
      els.cheatGrid = doc.getElementById('cheatGrid');
      els.cheatNote = doc.getElementById('cheatNote');
      els.cheatBar = doc.getElementById('cheatBar');
      els.cheatKey = doc.getElementById('cheatKey');
      els.exitCheatBtn = doc.getElementById('exitCheatBtn');

      if (!els.ctx) {
        showFatal('当前浏览器不支持 Canvas 2D。');
        return;
      }

      // 12 级预警文案来自 CONFIG，方便后续改字/换皮。
      if (els.level12WarningTitle) els.level12WarningTitle.textContent = CONFIG.LEVEL12_WARNING.title;
      if (els.level12WarningText) els.level12WarningText.textContent = CONFIG.LEVEL12_WARNING.subtitle;
      if (els.warningContinueBtn) els.warningContinueBtn.textContent = CONFIG.LEVEL12_WARNING.continueLabel;
      if (els.warningQuitBtn) els.warningQuitBtn.textContent = CONFIG.LEVEL12_WARNING.quitLabel;

      this.buildRecipeLine();
      this.buildFruitPicker();
      this.buildCheatGrid();
      this.renderSecretPanel();
      this.updateSoundButton();
      this.setScore(0, false);
      this.setBest(state.bestScore);
      this.renderAchievements();
      this.bindEvents();
      this.refreshRewindChip();
      this.refreshNinePicker();
      this.ready = true;
    },

    buildRecipeLine: function () {
      var recipe = CONFIG.SPECIAL_RECIPES[0];
      if (!recipe) {
        els.recipeLine.textContent = '暂无特殊配方';
        return;
      }
      var parts = Object.keys(recipe.inputs).map(function (key) {
        var count = recipe.inputs[key];
        return (count > 1 ? count + '×' : '') + key;
      });
      var outputMeta = getMeta(recipe.output);
      els.recipeLine.textContent = parts.join(' + ') + ' → ' + recipe.output +
        (outputMeta && outputMeta.name ? ' ' + outputMeta.name : '');
    },

    buildFruitPicker: function () {
      if (!els.fruitGrid) return;
      var self = this;
      while (els.fruitGrid.firstChild) {
        els.fruitGrid.removeChild(els.fruitGrid.firstChild);
      }

      CONFIG.NINE_POWER.choices.forEach(function (level) {
        var key = pad2(level);
        var meta = CONFIG.LEVEL_BY_NUMBER[level];
        if (!meta) return;

        var button = doc.createElement('button');
        button.type = 'button';
        button.className = 'fruit-option';
        button.setAttribute('data-key', key);
        button.setAttribute('aria-label', '选择 ' + key + ' 级' + meta.name);

        var preview = doc.createElement('canvas');
        preview.width = 92;
        preview.height = 92;
        preview.setAttribute('data-key', key);
        preview.setAttribute('aria-hidden', 'true');

        var levelLabel = doc.createElement('span');
        levelLabel.className = 'fruit-option__level';
        levelLabel.textContent = key;

        var nameLabel = doc.createElement('span');
        nameLabel.className = 'fruit-option__name';
        nameLabel.textContent = meta.name;

        button.appendChild(preview);
        button.appendChild(levelLabel);
        button.appendChild(nameLabel);
        button.addEventListener('click', function () {
          self.chooseNextFruit(key);
        });

        els.fruitGrid.appendChild(button);
      });

      this.drawFruitPickerThumbs();
      this.refreshFruitPickerSelection();
    },

    drawFruitPickerThumbs: function () {
      if (!els.fruitGrid) return;
      var canvases = els.fruitGrid.querySelectorAll('canvas[data-key]');
      for (var i = 0; i < canvases.length; i++) {
        drawKeyToCanvas(canvases[i], canvases[i].getAttribute('data-key'), 0.44);
      }
    },

    getCheatKeys: function () {
      var keys = CONFIG.SECRET_CHEAT.levels.map(function (level) { return pad2(level); });
      if (CONFIG.SECRET_CHEAT.specialKey) keys.push(CONFIG.SECRET_CHEAT.specialKey);
      return keys;
    },

    buildCheatGrid: function () {
      if (!els.cheatGrid) return;
      var self = this;
      while (els.cheatGrid.firstChild) {
        els.cheatGrid.removeChild(els.cheatGrid.firstChild);
      }
      this.getCheatKeys().forEach(function (key) {
        var meta = getMeta(key);
        if (!meta) return;
        var button = doc.createElement('button');
        button.type = 'button';
        button.className = 'cheat-option';
        button.setAttribute('data-key', key);
        button.setAttribute('aria-label', '自由放置 ' + key + ' ' + meta.name);

        var preview = doc.createElement('canvas');
        preview.width = 84;
        preview.height = 84;
        preview.setAttribute('data-key', key);
        preview.setAttribute('aria-hidden', 'true');

        var label = doc.createElement('span');
        label.className = 'cheat-option__label';
        label.textContent = key + ' ' + meta.name;
        button.appendChild(preview);
        button.appendChild(label);
        button.addEventListener('click', function () {
          self.startCheatPlacement(key);
        });
        els.cheatGrid.appendChild(button);
      });
      this.drawCheatThumbs();
    },

    drawCheatThumbs: function () {
      if (!els.cheatGrid) return;
      var canvases = els.cheatGrid.querySelectorAll('canvas[data-key]');
      for (var i = 0; i < canvases.length; i++) {
        drawKeyToCanvas(canvases[i], canvases[i].getAttribute('data-key'), 0.43);
      }
    },

    renderSecretPanel: function () {
      if (!els.secretRow) return;
      var unlocked = !!save.cheatUnlocked;
      els.secretRow.hidden = unlocked;
      els.secretStatus.textContent = unlocked ? '暗号正确：自由放置已解锁' : '';
      els.secretStatus.classList.remove('is-error');
      if (els.cheatGrid) els.cheatGrid.hidden = !unlocked;
      if (els.cheatNote) els.cheatNote.hidden = !unlocked;
      if (unlocked) this.drawCheatThumbs();
    },

    submitSecretCode: function () {
      if (!els.secretInput) return;
      var code = String(els.secretInput.value || '').trim();
      // 兼容用户直接粘贴带方括号的写法：[太阳神鸟开外挂]
      code = code.replace(/^[\[【]\s*/, '').replace(/\s*[\]】]$/, '');
      if (code === CONFIG.SECRET_CHEAT.code) {
        save.cheatUnlocked = true;
        persist();
        els.secretInput.value = '';
        this.renderSecretPanel();
        Sound.special();
        return true;
      }
      els.secretStatus.textContent = '暗号不对，再想想。';
      els.secretStatus.classList.add('is-error');
      els.secretInput.focus({ preventScroll: true });
      return false;
    },

    startCheatPlacement: function (key) {
      if (!save.cheatUnlocked) return;
      if (this.getCheatKeys().indexOf(key) === -1) return;
      if (key === pad2(12)) return;
      state.cheatPlaceKey = key;
      state.cheatPointerId = null;
      state.cheatPreview = null;
      cancelAim();
      this.closeAchievements();
      this.showCheatBar(key);
      this.hideHint();
      Sound.select();
    },

    exitCheatPlacement: function () {
      state.cheatPlaceKey = null;
      state.cheatPointerId = null;
      state.cheatPreview = null;
      this.hideCheatBar();
      if (!state.hasDropped && !state.ending) this.showHint();
    },

    showCheatBar: function (key) {
      if (!els.cheatBar) return;
      if (els.cheatKey) els.cheatKey.textContent = key;
      els.cheatBar.hidden = false;
    },

    hideCheatBar: function () {
      if (els.cheatBar) els.cheatBar.hidden = true;
    },

    refreshFruitPickerSelection: function () {
      if (!els.fruitGrid) return;
      var options = els.fruitGrid.querySelectorAll('.fruit-option');
      for (var i = 0; i < options.length; i++) {
        options[i].classList.toggle('is-current', options[i].getAttribute('data-key') === state.currentKey);
      }
    },

    refreshNinePicker: function () {
      if (!els.ninePickBtn) return;
      var hasNine = false;
      if (!state.ending) {
        hasNine = state.fruits.some(function (body) {
          var fruit = body.plugin && body.plugin.fruit;
          return fruit && fruit.level === CONFIG.NINE_POWER.level;
        });
      }
      els.ninePickBtn.hidden = !hasNine;
      if (!hasNine && this.isSendPickerOpen()) {
        this.closeSendPicker();
      }
    },

    isSendPickerOpen: function () {
      return !!(els.sendPicker && els.sendPicker.classList.contains('is-open'));
    },

    openSendPicker: function () {
      if (!els.sendPicker || this.isSendPickerOpen()) return;
      var hasNine = state.fruits.some(function (body) {
        var fruit = body.plugin && body.plugin.fruit;
        return fruit && fruit.level === CONFIG.NINE_POWER.level;
      });
      if (!hasNine || state.ending || state.warningOpen) return;

      this.drawFruitPickerThumbs();
      this.refreshFruitPickerSelection();
      cancelAim();
      if (!state.ending) state.manualPaused = true;
      state.lastFrame = performance.now();
      state.accumulator = 0;
      els.sendPicker.classList.add('is-open');
      els.sendPicker.setAttribute('aria-hidden', 'false');
      window.setTimeout(function () {
        if (state.manualPaused && els.closePickerBtn) {
          els.closePickerBtn.focus({ preventScroll: true });
        }
      }, 90);
    },

    closeSendPicker: function () {
      if (!els.sendPicker || !this.isSendPickerOpen()) return;
      els.sendPicker.classList.remove('is-open');
      els.sendPicker.setAttribute('aria-hidden', 'true');
      if (!state.ending) {
        state.manualPaused = false;
        state.lastFrame = performance.now();
        state.accumulator = 0;
      }
    },

    chooseNextFruit: function (key) {
      var hasNine = state.fruits.some(function (body) {
        var fruit = body.plugin && body.plugin.fruit;
        return fruit && fruit.level === CONFIG.NINE_POWER.level;
      });
      if (!hasNine || !getMeta(key)) return;

      state.currentKey = key;
      clampAim();
      state.lastFrame = performance.now();
      state.accumulator = 0;
      this.closeSendPicker();
      this.refreshFruitPickerSelection();
      Sound.select();
    },

    showSubtitle: function (text, options) {
      if (!text) return;
      options = options || {};
      if (options.replace) {
        window.clearTimeout(this.subtitleTimer);
        window.clearTimeout(this.subtitleExitTimer);
        this.subtitleQueue.length = 0;
        this.subtitleActive = false;
        if (els.subtitleLayer) els.subtitleLayer.classList.remove('is-visible');
      }
      this.subtitleQueue.push({
        text: text,
        duration: Number(options.duration) || CONFIG.SUBTITLE_DURATION
      });
      this.drainSubtitles();
    },

    drainSubtitles: function () {
      var self = this;
      if (this.subtitleActive || this.subtitleQueue.length === 0 || !els.subtitleLayer) return;
      this.subtitleActive = true;
      var item = this.subtitleQueue.shift();
      var text = typeof item === 'string' ? item : item.text;
      var duration = typeof item === 'string' ? CONFIG.SUBTITLE_DURATION : item.duration;
      els.subtitleText.textContent = text;
      els.subtitleLayer.classList.add('is-visible');
      els.subtitleLayer.setAttribute('aria-hidden', 'false');

      window.clearTimeout(this.subtitleTimer);
      this.subtitleTimer = window.setTimeout(function () {
        els.subtitleLayer.classList.remove('is-visible');
        els.subtitleLayer.setAttribute('aria-hidden', 'true');
        window.clearTimeout(self.subtitleExitTimer);
        self.subtitleExitTimer = window.setTimeout(function () {
          self.subtitleActive = false;
          self.drainSubtitles();
        }, 360);
      }, duration);
    },

    hideSubtitle: function () {
      window.clearTimeout(this.subtitleTimer);
      window.clearTimeout(this.subtitleExitTimer);
      this.subtitleQueue.length = 0;
      this.subtitleActive = false;
      if (els.subtitleLayer) {
        els.subtitleLayer.classList.remove('is-visible');
        els.subtitleLayer.setAttribute('aria-hidden', 'true');
      }
      if (els.subtitleText) els.subtitleText.textContent = '';
    },

    bindEvents: function () {
      var self = this;

      els.achievementBtn.addEventListener('click', function () {
        self.openAchievements();
      });
      els.endAchievementBtn.addEventListener('click', function () {
        self.openAchievements();
      });
      els.closeAchievementBtn.addEventListener('click', function () {
        self.closeAchievements();
      });
      els.panel.addEventListener('click', function (event) {
        if (event.target === els.panel) self.closeAchievements();
      });
      els.soundBtn.addEventListener('click', function () {
        Sound.toggle();
      });
      els.restartBtn.addEventListener('click', function () {
        startNewGame();
      });
      if (els.copyLinkBtn) {
        els.copyLinkBtn.addEventListener('click', function () {
          self.copyGameLink();
        });
      }
      els.secretSubmitBtn.addEventListener('click', function () {
        self.submitSecretCode();
      });
      els.secretInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          self.submitSecretCode();
        }
      });
      els.exitCheatBtn.addEventListener('click', function () {
        self.exitCheatPlacement();
      });
      els.warningContinueBtn.addEventListener('click', function () {
        resolveLevel12Warning(true);
      });
      els.warningQuitBtn.addEventListener('click', function () {
        resolveLevel12Warning(false);
      });
      els.ninePickBtn.addEventListener('click', function () {
        self.openSendPicker();
      });
      els.closePickerBtn.addEventListener('click', function () {
        self.closeSendPicker();
      });
      els.sendPicker.addEventListener('click', function (event) {
        if (event.target === els.sendPicker) self.closeSendPicker();
      });

      // 面板内滚动/点选时不要触发页面级手势
      els.sendPickerSheet.addEventListener('pointerdown', function (event) {
        event.stopPropagation();
      });

      // 面板内滚动时不要触发页面级手势
      els.panelSheet.addEventListener('pointerdown', function (event) {
        event.stopPropagation();
      });

      doc.addEventListener('keydown', onKeyDown);
      doc.addEventListener('gesturestart', preventDefault, { passive: false });
      doc.addEventListener('dblclick', preventDefault, { passive: false });
      doc.addEventListener('contextmenu', preventDefault);
      doc.addEventListener('touchmove', function (event) {
        if (event.touches && event.touches.length > 1) event.preventDefault();
      }, { passive: false });
      doc.addEventListener('pointerdown', function () {
        Sound.unlock();
      }, { capture: true, passive: true });

      els.canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
      els.canvas.addEventListener('pointermove', onPointerMove, { passive: false });
      els.canvas.addEventListener('pointerup', onPointerUp, { passive: false });
      els.canvas.addEventListener('pointercancel', onPointerCancel, { passive: false });

      window.addEventListener('resize', scheduleResize, { passive: true });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', scheduleResize, { passive: true });
      }
      window.addEventListener('orientationchange', function () {
        window.setTimeout(scheduleResize, 140);
      });

      doc.addEventListener('visibilitychange', function () {
        if (doc.hidden) {
          state.hidden = true;
          cancelAim();
          Music.pause();
        } else {
          state.hidden = false;
          state.lastFrame = performance.now();
          state.accumulator = 0;
          Music.resumeIfWanted();
        }
      });

      window.addEventListener('beforeunload', persist);
    },

    setScore: function (value, animate) {
      els.scoreValue.textContent = formatScore(value);
      if (animate) {
        els.scoreValue.classList.remove('is-pop');
        // 强制回流，保证连续合成时动画可以重新播放
        void els.scoreValue.offsetWidth;
        els.scoreValue.classList.add('is-pop');
      }
    },

    setBest: function (value) {
      els.bestValue.textContent = formatScore(value);
    },

    setNext: function (key) {
      state.nextKey = key;
      var meta = getMeta(key);
      if (meta) {
        els.nextCanvas.setAttribute('aria-label', '下一个水果：' + meta.name);
      }
      this.drawNextPreview();
    },

    drawNextPreview: function () {
      var canvas = els.nextCanvas;
      var ctx = els.nextCtx;
      if (!canvas || !ctx) return;

      var rect = canvas.getBoundingClientRect();
      var cssSize = Math.max(20, Math.round(rect.width || 40));
      var dpr = Math.min(window.devicePixelRatio || 1, 3);
      var pixelSize = Math.round(cssSize * dpr);

      if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
        canvas.width = pixelSize;
        canvas.height = pixelSize;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssSize, cssSize);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      if (state.nextKey) {
        drawSpriteOn(ctx, state.nextKey, cssSize / 2, cssSize / 2, cssSize * 0.44, 1);
      }
    },

    updateSoundButton: function () {
      els.soundBtn.classList.toggle('is-muted', !Sound.enabled);
      els.soundBtn.setAttribute('aria-pressed', String(Sound.enabled));
      els.soundBtn.setAttribute('aria-label', Sound.enabled ? '关闭音效' : '打开音效');
    },

    setCopyLinkStatus: function (message) {
      if (!els.copyLinkStatus) return;
      els.copyLinkStatus.textContent = message;
      window.clearTimeout(this.copyLinkTimer);
      this.copyLinkTimer = window.setTimeout(function () {
        if (els.copyLinkStatus) els.copyLinkStatus.textContent = '';
      }, 2200);
    },

    copyGameLink: function () {
      var url = window.location.href;
      var self = this;
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(url).then(function () {
          self.setCopyLinkStatus('链接已复制');
        }).catch(function () {
          self.fallbackCopyLink(url);
        });
        return;
      }
      this.fallbackCopyLink(url);
    },

    fallbackCopyLink: function (text) {
      var input = doc.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', 'readonly');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      input.style.left = '-9999px';
      doc.body.appendChild(input);
      input.select();
      var ok = false;
      try {
        ok = doc.execCommand('copy');
      } catch (error) {
        ok = false;
      }
      doc.body.removeChild(input);
      this.setCopyLinkStatus(ok ? '链接已复制' : '请手动复制地址栏链接');
    },

    refreshRewindChip: function () {
      if (!els.rewindChip) return;
      var hasLevel7 = false;
      if (!state.ending && !state.rewindUsed && CONFIG.REWIND.enabled) {
        hasLevel7 = state.fruits.some(function (body) {
          var fruit = body.plugin && body.plugin.fruit;
          return fruit && fruit.level === CONFIG.REWIND.level;
        });
      }
      els.rewindChip.hidden = !hasLevel7;
    },

    showRewindBanner: function (removedCount) {
      if (!els.rewindBanner) return;
      window.clearTimeout(state.rewindBannerTimer);
      els.rewindDetail.textContent = '清除 ' + removedCount + ' 个水果 · 继续游戏';
      els.rewindBanner.classList.add('is-visible');
      els.rewindBanner.setAttribute('aria-hidden', 'false');
      state.rewindBannerTimer = window.setTimeout(function () {
        els.rewindBanner.classList.remove('is-visible');
        els.rewindBanner.setAttribute('aria-hidden', 'true');
      }, 2300);
    },

    hideRewindBanner: function () {
      if (!els.rewindBanner) return;
      window.clearTimeout(state.rewindBannerTimer);
      els.rewindBanner.classList.remove('is-visible');
      els.rewindBanner.setAttribute('aria-hidden', 'true');
    },

    showLevel12Warning: function () {
      if (!els.level12Warning) return;
      els.level12Warning.classList.add('is-open');
      els.level12Warning.setAttribute('aria-hidden', 'false');
      window.setTimeout(function () {
        if (state.warningOpen && els.warningContinueBtn) {
          els.warningContinueBtn.focus({ preventScroll: true });
        }
      }, 120);
    },

    hideLevel12Warning: function () {
      if (!els.level12Warning) return;
      els.level12Warning.classList.remove('is-open');
      els.level12Warning.setAttribute('aria-hidden', 'true');
    },

    renderAchievements: function () {
      var list = getAchievementList();
      var unlocked = list.filter(function (item) { return item.unlocked; });
      els.achievementCount.textContent = unlocked.length + ' / ' + list.length;
      els.achievementBadge.textContent = String(unlocked.length);
      els.achievementBadge.hidden = unlocked.length === 0;
      while (els.achievementList.firstChild) {
        els.achievementList.removeChild(els.achievementList.firstChild);
      }

      list.forEach(function (item) {
        var row = doc.createElement('article');
        row.className = 'achievement-item' + (item.unlocked ? ' is-unlocked' : '');
        row.setAttribute('aria-label', item.name + (item.unlocked ? '，已解锁' : '，未解锁'));

        var icon = doc.createElement('div');
        icon.className = 'achievement-item__icon';
        icon.innerHTML = item.unlocked ? ACHIEVEMENT_ICON : LOCK_ICON;

        var main = doc.createElement('div');
        main.className = 'achievement-item__main';

        var titleRow = doc.createElement('div');
        titleRow.className = 'achievement-item__title-row';

        var title = doc.createElement('h3');
        title.textContent = item.name;

        var badge = doc.createElement('span');
        badge.className = 'achievement-state';
        badge.textContent = item.unlocked ? '已解锁' : '未解锁';

        var desc = doc.createElement('p');
        desc.textContent = item.desc;

        titleRow.appendChild(title);
        titleRow.appendChild(badge);
        main.appendChild(titleRow);
        main.appendChild(desc);

        var date = doc.createElement('span');
        date.className = 'achievement-date';
        date.textContent = item.unlocked ? formatAchievementDate(item.unlockedAt) : '—';

        row.appendChild(icon);
        row.appendChild(main);
        row.appendChild(date);
        els.achievementList.appendChild(row);
      });
    },

    pushToast: function (item) {
      toastQueue.push(item);
      this.drainToasts();
    },

    drainToasts: function () {
      var self = this;
      if (toastActive || toastQueue.length === 0 || !els.toastLayer) return;
      toastActive = true;
      var item = toastQueue.shift();

      var toast = doc.createElement('div');
      toast.className = 'toast';
      toast.setAttribute('role', 'status');

      var icon = doc.createElement('div');
      icon.className = 'toast__icon';
      icon.innerHTML = ACHIEVEMENT_ICON;

      var body = doc.createElement('div');
      var kicker = doc.createElement('span');
      kicker.className = 'toast__kicker';
      kicker.textContent = 'ACHIEVEMENT UNLOCKED';

      var title = doc.createElement('span');
      title.className = 'toast__title';
      title.textContent = item.name;

      var desc = doc.createElement('span');
      desc.className = 'toast__desc';
      desc.textContent = item.desc;

      body.appendChild(kicker);
      body.appendChild(title);
      body.appendChild(desc);
      toast.appendChild(icon);
      toast.appendChild(body);
      els.toastLayer.appendChild(toast);

      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          toast.classList.add('is-in');
        });
      });

      window.clearTimeout(this.toastTimer);
      this.toastTimer = window.setTimeout(function () {
        toast.classList.add('is-out');
        toast.classList.remove('is-in');
        window.setTimeout(function () {
          if (toast.parentNode) toast.parentNode.removeChild(toast);
          toastActive = false;
          self.drainToasts();
        }, 330);
      }, TOAST_DURATION);
    },

    openAchievements: function () {
      if (els.panel.classList.contains('is-open')) return;
      lastFocusBeforePanel = doc.activeElement;
      this.renderAchievements();
      this.renderSecretPanel();
      this.drawCheatThumbs();
      cancelAim();
      if (!state.ending) state.manualPaused = true;
      els.panel.classList.add('is-open');
      els.panel.setAttribute('aria-hidden', 'false');
      state.lastFrame = performance.now();
      state.accumulator = 0;
      window.setTimeout(function () {
        if (els.closeAchievementBtn) els.closeAchievementBtn.focus({ preventScroll: true });
      }, 80);
    },

    closeAchievements: function () {
      if (!els.panel.classList.contains('is-open')) return;
      els.panel.classList.remove('is-open');
      els.panel.setAttribute('aria-hidden', 'true');
      if (!state.ending) {
        state.manualPaused = false;
        state.lastFrame = performance.now();
        state.accumulator = 0;
      }
      if (lastFocusBeforePanel && typeof lastFocusBeforePanel.focus === 'function') {
        lastFocusBeforePanel.focus({ preventScroll: true });
      }
      lastFocusBeforePanel = null;
    },

    isPanelOpen: function () {
      return els.panel.classList.contains('is-open');
    },

    showEndScreen: function (score, best) {
      els.finalScore.textContent = formatScore(score);
      els.finalBest.textContent = formatScore(best);
      els.rewindChip.hidden = true;
      els.ninePickBtn.hidden = true;
      this.closeSendPicker();
      this.hideSubtitle();
      this.hideRewindBanner();
      this.hideLevel12Warning();
      els.endOverlay.classList.add('is-open');
      els.endOverlay.setAttribute('aria-hidden', 'false');
      window.setTimeout(function () {
        if (state.ending && !UI.isPanelOpen()) {
          els.restartBtn.focus({ preventScroll: true });
        }
      }, 980);
    },

    hideEndScreen: function () {
      els.endOverlay.classList.remove('is-open');
      els.endOverlay.setAttribute('aria-hidden', 'true');
    },

    showHint: function () {
      els.gestureHint.classList.remove('is-hidden');
    },

    hideHint: function () {
      els.gestureHint.classList.add('is-hidden');
    },

    setBootStatus: function (text) {
      if (els.bootStatus) els.bootStatus.textContent = text;
    },

    hideBoot: function () {
      if (els.bootOverlay) els.bootOverlay.classList.add('is-hidden');
    }
  };

  function formatAchievementDate(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (isNaN(date.getTime())) return '—';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        year: '2-digit',
        month: '2-digit',
        day: '2-digit'
      }).format(date);
    } catch (error) {
      return date.toLocaleDateString();
    }
  }

  function drawKeyToCanvas(canvas, key, radiusFactor) {
    if (!canvas || !key) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var rect = canvas.getBoundingClientRect();
    var cssSize = Math.max(18, Math.round(rect.width || 46));
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var pixelSize = Math.round(cssSize * dpr);
    if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
      canvas.width = pixelSize;
      canvas.height = pixelSize;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssSize, cssSize);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    drawSpriteOn(ctx, key, cssSize / 2, cssSize / 2, cssSize * (radiusFactor || 0.44), 1);
  }

  function preventDefault(event) {
    event.preventDefault();
  }

  /* =========================================================================
   * 5. 画布尺寸、布局与缩放
   * ========================================================================= */
  function measureSafeArea(element) {
    if (!element) return 0;
    return element.getBoundingClientRect().height || 0;
  }

  function computeLayout() {
    var shellRect = els.shell.getBoundingClientRect();
    var width = Math.max(1, shellRect.width);
    var height = Math.max(1, shellRect.height);
    var canvas = els.canvas;

    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var pixelWidth = Math.round(width * dpr);
    var pixelHeight = Math.round(height * dpr);

    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    var k = width / CONFIG.DESIGN_WIDTH;
    var safeTop = measureSafeArea(els.safeTopProbe);
    var safeBottom = measureSafeArea(els.safeBottomProbe);
    var hudRect = els.hud.getBoundingClientRect();
    var hudBottom = Math.max(hudRect.bottom - shellRect.top, safeTop + 56 * k);

    var side = CONFIG.PLAYFIELD_MARGIN * k;
    var floorY = height - safeBottom - CONFIG.FLOOR_INSET * k;
    var dropY = hudBottom + CONFIG.SPAWN_OFFSET * k;
    var dangerY = hudBottom + CONFIG.DANGER_LINE * k;

    return {
      w: width,
      h: height,
      k: k,
      dpr: dpr,
      safeTop: safeTop,
      safeBottom: safeBottom,
      hudBottom: hudBottom,
      side: side,
      floorY: floorY,
      topY: hudBottom + 4 * k,
      dropY: dropY,
      dangerY: dangerY,
      innerW: Math.max(2, width - side * 2),
      innerH: Math.max(2, floorY - (hudBottom + 4 * k))
    };
  }

  function applyCanvasTransform() {
    var layout = state.layout;
    if (!layout || !els.ctx) return;
    els.ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
    els.ctx.imageSmoothingEnabled = true;
    els.ctx.imageSmoothingQuality = 'high';
  }

  function scheduleResize() {
    if (state.resizeRaf) return;
    state.resizeRaf = requestAnimationFrame(function () {
      state.resizeRaf = 0;
      resizeGame();
    });
  }

  function resizeGame() {
    if (!state.engine) {
      state.layout = computeLayout();
      return;
    }

    var previous = state.layout;
    var next = computeLayout();

    if (previous) {
      var changed = Math.abs(previous.w - next.w) > 0.5 ||
        Math.abs(previous.h - next.h) > 0.5 ||
        Math.abs(previous.k - next.k) > 0.001;
      if (!changed) {
        state.layout = next;
        UI.drawNextPreview();
        UI.drawFruitPickerThumbs();
        UI.drawCheatThumbs();
        return;
      }
      state.layout = next;
      rescaleWorld(previous, next);
    } else {
      state.layout = next;
    }

    applyCanvasTransform();
    rebuildWalls();
    clampAim();
    UI.drawNextPreview();
    UI.drawFruitPickerThumbs();
    UI.drawCheatThumbs();
  }

  function rescaleWorld(previous, next) {
    if (!previous || !previous.innerW || !previous.innerH) return;
    var scaleX = next.innerW / previous.innerW;
    var scaleY = next.innerH / previous.innerH;
    var radiusScale = next.k / previous.k;
    var positionScale = Math.min(scaleX, scaleY);

    state.fruits.forEach(function (body) {
      var fruit = body.plugin && body.plugin.fruit;
      if (!fruit || body._dead) return;

      var nx = (body.position.x - previous.side) / previous.innerW;
      var ny = (body.position.y - previous.topY) / previous.innerH;

      if (Math.abs(radiusScale - 1) > 0.0001) {
        Body.scale(body, radiusScale, radiusScale);
      }
      fruit.radius = fruit.baseRadius * next.k;
      fruit.visualScale = 1;

      var x = next.side + clamp(nx, 0, 1) * next.innerW;
      var y = next.topY + clamp(ny, 0, 1) * next.innerH;
      x = clamp(x, next.side + fruit.radius, next.w - next.side - fruit.radius);
      y = clamp(y, next.topY + fruit.radius, next.floorY - fruit.radius);

      Body.setPosition(body, { x: x, y: y });
      Body.setVelocity(body, {
        x: body.velocity.x * positionScale,
        y: body.velocity.y * positionScale
      });
      fruit.dangerTime = 0;
    });
  }

  function rebuildWalls() {
    var layout = state.layout;
    if (!state.engine || !layout) return;

    state.walls.forEach(function (wall) {
      Composite.remove(state.world, wall);
    });
    state.walls.length = 0;

    var t = CONFIG.WALL_THICKNESS * layout.k;
    var floorT = CONFIG.FLOOR_THICKNESS * layout.k;
    var options = {
      isStatic: true,
      friction: 0.12,
      restitution: 0.02,
      label: 'wall',
      render: { visible: false }
    };

    var ceiling = Bodies.rectangle(layout.w / 2, -t / 2 - 28 * layout.k, layout.w * 2, t, options);
    var left = Bodies.rectangle(layout.side - t / 2, layout.h / 2, t, layout.h * 2, options);
    var right = Bodies.rectangle(layout.w - layout.side + t / 2, layout.h / 2, t, layout.h * 2, options);
    var floor = Bodies.rectangle(layout.w / 2, layout.floorY + floorT / 2, layout.w * 2, floorT, options);

    state.walls.push(ceiling, left, right, floor);
    Composite.add(state.world, state.walls);
  }

  function clampAim() {
    var layout = state.layout;
    if (!layout) return;
    var meta = getMeta(state.currentKey);
    var radius = meta ? meta.radius * layout.k : 22 * layout.k;
    state.aimX = clamp(
      state.aimX || layout.w / 2,
      layout.side + radius + 1,
      layout.w - layout.side - radius - 1
    );
  }

  function isPhysicsRunning() {
    return state.running && !state.ending && !state.manualPaused && !state.hidden && !state.warningOpen;
  }

  /* =========================================================================
   * 6. 水果创建 / 删除 / 随机掉落
   * ========================================================================= */
  function randomDropKey() {
    var total = 0;
    var weights = CONFIG.DROP_WEIGHTS;
    var i;
    for (i = 0; i < weights.length; i++) total += weights[i];
    var roll = Math.random() * total;
    for (i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return CONFIG.DROP_KEYS[i] || CONFIG.DROP_KEYS[0];
    }
    return CONFIG.DROP_KEYS[0];
  }

  function createFruitBody(key, x, y, options) {
    var meta = getMeta(key);
    var layout = state.layout;
    if (!meta || !layout) return null;

    options = options || {};
    var radius = meta.radius * layout.k;
    var side = radius * 2;
    var bodyOptions = {
      label: 'fruit',
      friction: CONFIG.FRUIT_FRICTION,
      frictionStatic: CONFIG.FRUIT_FRICTION_STATIC,
      frictionAir: CONFIG.FRUIT_AIR,
      restitution: CONFIG.FRUIT_RESTITUTION,
      density: CONFIG.FRUIT_DENSITY,
      slop: CONFIG.FRUIT_SLOP,
      render: { visible: false }
    };

    // 方形碰撞体：视觉是正方形卡片，碰撞也按方盒计算。
    if (CONFIG.COLLISION_SHAPE === 'box') {
      var chamferRadius = side * clamp(CONFIG.BOX_CHAMFER_RATIO, 0, 0.45);
      if (chamferRadius > 0.5) {
        bodyOptions.chamfer = { radius: chamferRadius };
      }
    }

    var body = CONFIG.COLLISION_SHAPE === 'box'
      ? Bodies.rectangle(x, y, side, side, bodyOptions)
      : Bodies.circle(x, y, radius, bodyOptions);

    body.plugin.fruit = {
      id: state.nextFruitId++,
      key: key,
      level: meta.level || null,
      isSpecial: key === CONFIG.SPECIAL_OUTPUT.key,
      shape: CONFIG.COLLISION_SHAPE,
      baseRadius: meta.radius,
      radius: radius,
      spriteKey: key,
      renderKey: key,
      visualScale: typeof options.visualScale === 'number' ? options.visualScale : 1,
      bornAt: state.simTime,
      dangerTime: 0,
      isEnding: false
    };

    Body.setAngle(body, typeof options.angle === 'number' ? options.angle : randomRange(-0.14, 0.14));
    Body.setVelocity(body, {
      x: options.velocity && typeof options.velocity.x === 'number' ? options.velocity.x : randomRange(-0.15, 0.15),
      y: options.velocity && typeof options.velocity.y === 'number' ? options.velocity.y : 0
    });
    Body.setAngularVelocity(body, randomRange(-0.035, 0.035));

    Composite.add(state.world, body);
    state.fruits.push(body);
    if (UI.ready) {
      UI.refreshRewindChip();
      UI.refreshNinePicker();
      if (meta.level && CONFIG.SUBTITLES[meta.level]) {
        UI.showSubtitle(CONFIG.SUBTITLES[meta.level]);
      }
    }
    return body;
  }

  function removeFruit(body) {
    if (!body || body._dead) return;
    body._dead = true;
    Composite.remove(state.world, body);
    var index = state.fruits.indexOf(body);
    if (index >= 0) state.fruits.splice(index, 1);
    if (UI.ready) {
      UI.refreshRewindChip();
      UI.refreshNinePicker();
    }
  }

  function canDrop() {
    return isPhysicsRunning() &&
      state.currentKey &&
      state.simTime >= state.dropReadyAt &&
      state.fruits.length < state.maxFruits;
  }

  function tryDrop() {
    if (state.cheatPlaceKey) return false;
    if (!canDrop()) return false;

    var layout = state.layout;
    var meta = getMeta(state.currentKey);
    if (!meta) return false;

    var radius = meta.radius * layout.k;
    var x = clamp(state.aimX, layout.side + radius + 1, layout.w - layout.side - radius - 1);

    var body = createFruitBody(state.currentKey, x, layout.dropY, {
      velocity: { x: 0, y: 0.8 }
    });
    if (!body) return false;

    // 01~05 从顶部落下时播放各自的出场文字（后来的快速覆盖前一条，避免排队积压）
    if (meta.level && CONFIG.ENTRY_SUBTITLES[meta.level]) {
      UI.showSubtitle(CONFIG.ENTRY_SUBTITLES[meta.level], {
        duration: CONFIG.ENTRY_SUBTITLE_DURATION,
        replace: true
      });
    }

    state.hasDropped = true;
    state.pointerActive = false;
    state.currentKey = state.nextKey;
    state.nextKey = randomDropKey();
    state.dropReadyAt = state.simTime + CONFIG.DROP_COOLDOWN / 1000;

    UI.hideHint();
    UI.setNext(state.nextKey);
    Sound.drop();
    return true;
  }

  function clampCheatPoint(point) {
    var layout = state.layout;
    var meta = state.cheatPlaceKey ? getMeta(state.cheatPlaceKey) : null;
    if (!layout || !meta) return null;
    var radius = meta.radius * layout.k;
    return {
      x: clamp(point.x, layout.side + radius + 1, layout.w - layout.side - radius - 1),
      y: clamp(point.y, layout.topY + radius + 1, layout.floorY - radius - 1)
    };
  }

  function placeCheatFruitAt(point) {
    var layout = state.layout;
    var meta = state.cheatPlaceKey ? getMeta(state.cheatPlaceKey) : null;
    if (!layout || !meta || !point) return false;
    var body = createFruitBody(state.cheatPlaceKey, point.x, point.y, {
      velocity: { x: 0, y: 0 },
      angle: randomRange(-0.12, 0.12)
    });
    if (!body) return false;

    if (meta.level && CONFIG.ENTRY_SUBTITLES[meta.level]) {
      UI.showSubtitle(CONFIG.ENTRY_SUBTITLES[meta.level], {
        duration: CONFIG.ENTRY_SUBTITLE_DURATION,
        replace: true
      });
    }

    createBurst(point.x, point.y, meta.color, 12, 150);
    Sound.drop();
    return true;
  }

  /* =========================================================================
   * 7. 合成：普通 1~11、12+12、特殊多合一
   * ========================================================================= */
  function onCollisionStart(event) {
    if (state.ending) return;

    var pairs = event.pairs;
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i];
      var a = pair.bodyA;
      var b = pair.bodyB;
      var fa = a.plugin && a.plugin.fruit;
      var fb = b.plugin && b.plugin.fruit;
      if (!fa || !fb) continue;

      // 两个 004 可以继续合成 05
      if (fa.isSpecial || fb.isSpecial) {
        if (fa.isSpecial && fb.isSpecial &&
            fa.key === CONFIG.SPECIAL_OUTPUT.key && fb.key === CONFIG.SPECIAL_OUTPUT.key) {
          var specialKey = fa.id < fb.id ? fa.id + ':' + fb.id : fb.id + ':' + fa.id;
          if (!state.seenPairs.has(specialKey)) {
            state.seenPairs.add(specialKey);
            state.mergeQueue.push([a, b]);
          }
        }
        continue;
      }

      if (fa.level !== fb.level) continue;

      var key = fa.id < fb.id ? fa.id + ':' + fb.id : fb.id + ':' + fa.id;
      if (state.seenPairs.has(key)) continue;
      state.seenPairs.add(key);
      state.mergeQueue.push([a, b]);
    }
  }

  function processMergeQueue() {
    var queue = state.mergeQueue;
    state.mergeQueue = [];

    for (var i = 0; i < queue.length; i++) {
      var a = queue[i][0];
      var b = queue[i][1];
      if (a._dead || b._dead) continue;
      var fa = a.plugin && a.plugin.fruit;
      var fb = b.plugin && b.plugin.fruit;
      if (!fa || !fb) continue;

      if (fa.isSpecial || fb.isSpecial) {
        if (fa.isSpecial && fb.isSpecial &&
            fa.key === CONFIG.SPECIAL_OUTPUT.key && fb.key === CONFIG.SPECIAL_OUTPUT.key) {
          mergeSpecialToLevel5(a, b);
        }
        continue;
      }

      if (fa.level !== fb.level) continue;

      if (fa.level >= CONFIG.LEVELS.length) {
        mergeTwelve(a, b);
      } else {
        mergeNormal(a, b);
      }
    }

    state.seenPairs.clear();
  }

  function mergeNormal(a, b) {
    var fa = a.plugin.fruit;
    var fb = b.plugin.fruit;
    var nextLevel = fa.level + 1;
    var nextKey = pad2(nextLevel);
    var nextMeta = CONFIG.LEVEL_BY_NUMBER[nextLevel];
    if (!nextMeta) return;

    var x = (a.position.x + b.position.x) / 2;
    var y = (a.position.y + b.position.y) / 2;

    removeFruit(a);
    removeFruit(b);

    createFruitBody(nextKey, x, y, {
      visualScale: 0.56,
      angle: 0,
      velocity: {
        x: randomRange(-0.55, 0.55),
        y: -1.25
      }
    });

    addScore(nextMeta.score);
    createBurst(x, y, nextMeta.color, 14 + nextLevel, 190 + nextLevel * 10);
    createFloatingText(x, y - nextMeta.radius * state.layout.k * 0.4, '+' + nextMeta.score, nextMeta.ink);
    state.shake = Math.max(state.shake, 2.2 + Math.min(4, nextLevel * 0.35));
    Sound.merge(nextLevel);

    if (nextLevel === 7) {
      unlockAchievement('zui_chang_de_he');
    }

    // 合成出 08 时播放《春日影》
    if (nextLevel === 8) {
      Music.playChunriying();
    }

    // 合成出 12 时，暂停物理并灰屏询问玩家是否继续。
    if (nextLevel === 12) {
      showLevel12Warning();
    }
  }

  // 两个 004 相碰：继续合成为 05
  function mergeSpecialToLevel5(a, b) {
    var nextLevel = CONFIG.SPECIAL_OUTPUT.mergeInto;
    var nextMeta = CONFIG.LEVEL_BY_NUMBER[nextLevel];
    if (!nextMeta) return;

    var nextKey = pad2(nextLevel);
    var x = (a.position.x + b.position.x) / 2;
    var y = (a.position.y + b.position.y) / 2;

    removeFruit(a);
    removeFruit(b);

    createFruitBody(nextKey, x, y, {
      visualScale: 0.56,
      angle: 0,
      velocity: {
        x: randomRange(-0.45, 0.45),
        y: -1.1
      }
    });

    addScore(nextMeta.score);
    createBurst(x, y, nextMeta.color, 22, 240);
    createRing(x, y, 100, CONFIG.SPECIAL_OUTPUT.color, 0.55);
    createFloatingText(x, y - nextMeta.radius * state.layout.k * 0.4, '004 → 05', nextMeta.ink);
    state.shake = Math.max(state.shake, 4);
    Sound.merge(nextLevel);
  }

  /**
   * 场上存在类成就：每次物理步结算后检查一次。
   * 这些成就只关心“当前场上是否存在”，不要求首次合成。
   */
  function checkPresenceAchievements() {
    if (!state.fruits.length) return;

    var levels = Object.create(null);
    state.fruits.forEach(function (body) {
      var fruit = body.plugin && body.plugin.fruit;
      if (fruit && fruit.level) levels[fruit.level] = true;
    });

    if (levels[4] && levels[5]) {
      unlockAchievement('zui_jin_ye_zui_yuan');
    }
    if (levels[6]) {
      unlockAchievement('da_dong_bei');
    }
    if (levels[8]) {
      unlockAchievement('yi_bei_zi_duo_duan_dui');
    }
    if (levels[9]) {
      unlockAchievement('yuan_wang_cheng_zhen');
    }
    if (levels[11]) {
      unlockAchievement('wan_sheng_jie');
    }
    if (levels[12]) {
      unlockAchievement('shi_jing_xi');
    }
  }

  function mergeTwelve(a, b) {
    var x = (a.position.x + b.position.x) / 2;
    var y = (a.position.y + b.position.y) / 2;

    removeFruit(a);
    removeFruit(b);

    addScore(CONFIG.TWELVE_SCORE);
    createBurst(x, y, '#BBD8CF', 48, 480);
    createBurst(x, y, '#7FAEA4', 28, 350);
    createRing(x, y, 180, '#BBD8CF', 0.7);
    createFloatingText(x, y - 24, '物华自由 +' + CONFIG.TWELVE_SCORE, '#356B62');
    state.flash = Math.max(state.flash, 0.55);
    state.shake = Math.max(state.shake, 13);
    Sound.twelve();
  }

  /**
   * 在场上寻找配方簇。
   *
   * 规则：
   * - 场上有配方要求的全部水果；
   * - 存在一个“连通簇”，簇内任意相连的水果间距 <= 两者平均半径 * distanceFactor；
   * - 从簇中选出需求数量后，要求所有被选水果到几何中心的距离都 <= 平均半径 * distanceFactor，
   *   防止一条很长的水果链被误判。
   * - 多个候选中取最紧凑的一组。
   */
  function findRecipeCluster(recipe) {
    var required = Object.keys(recipe.inputs).map(function (key) {
      return { key: key, count: recipe.inputs[key] };
    });
    var totalNeeded = required.reduce(function (sum, item) { return sum + item.count; }, 0);

    var candidates = state.fruits.filter(function (body) {
      var fruit = body.plugin && body.plugin.fruit;
      return !body._dead && fruit && !fruit.isSpecial && isNumericFruitKey(fruit.key) && recipe.inputs[fruit.key];
    });
    if (candidates.length < totalNeeded) return null;

    var factor = Number(recipe.distanceFactor) || CONFIG.SPECIAL_DISTANCE_FACTOR;
    var adjacency = candidates.map(function () { return []; });
    var i;
    var j;

    for (i = 0; i < candidates.length; i++) {
      var fi = candidates[i].plugin.fruit;
      for (j = i + 1; j < candidates.length; j++) {
        var fj = candidates[j].plugin.fruit;
        var threshold = ((fi.radius + fj.radius) / 2) * factor;
        if (distanceSq(candidates[i].position, candidates[j].position) <= threshold * threshold) {
          adjacency[i].push(j);
          adjacency[j].push(i);
        }
      }
    }

    var visited = new Array(candidates.length).fill(false);
    var best = null;

    for (i = 0; i < candidates.length; i++) {
      if (visited[i]) continue;

      // BFS 求连通分量
      var component = [];
      var stack = [i];
      visited[i] = true;
      while (stack.length) {
        var current = stack.pop();
        component.push(candidates[current]);
        var neighbours = adjacency[current];
        for (j = 0; j < neighbours.length; j++) {
          if (!visited[neighbours[j]]) {
            visited[neighbours[j]] = true;
            stack.push(neighbours[j]);
          }
        }
      }

      if (component.length < totalNeeded) continue;

      // 每个等级都有足够数量才可能成簇
      var enough = required.every(function (item) {
        return component.filter(function (body) {
          return body.plugin.fruit.key === item.key;
        }).length >= item.count;
      });
      if (!enough) continue;

      var selected = [];
      var center = centroidOf(component);
      var pass;

      // 两轮“按中心取最近”，让挑选结果更靠近真正的几何中心
      for (pass = 0; pass < 2; pass++) {
        if (selected.length) center = centroidOf(selected);
        selected = [];
        required.forEach(function (item) {
          var pool = component.filter(function (body) {
            return body.plugin.fruit.key === item.key;
          });
          pool.sort(function (a, b) {
            return distanceSq(a.position, center) - distanceSq(b.position, center);
          });
          selected = selected.concat(pool.slice(0, item.count));
        });
      }

      if (selected.length !== totalNeeded) continue;
      var selectedCenter = centroidOf(selected);
      var averageRadius = average(selected.map(function (body) {
        return body.plugin.fruit.radius;
      }));
      var maxDistance = Math.max.apply(null, selected.map(function (body) {
        return Math.sqrt(distanceSq(body.position, selectedCenter));
      }));
      var allowed = averageRadius * factor;

      if (maxDistance <= allowed) {
        if (!best || maxDistance < best.maxDistance) {
          best = {
            members: selected,
            center: selectedCenter,
            maxDistance: maxDistance,
            averageRadius: averageRadius
          };
        }
      }
    }

    return best;
  }

  function centroidOf(bodies) {
    var x = 0;
    var y = 0;
    bodies.forEach(function (body) {
      x += body.position.x;
      y += body.position.y;
    });
    return {
      x: x / bodies.length,
      y: y / bodies.length
    };
  }

  function trySpecialRecipes() {
    if (state.ending || !state.fruits.length) return false;

    for (var i = 0; i < CONFIG.SPECIAL_RECIPES.length; i++) {
      var recipe = CONFIG.SPECIAL_RECIPES[i];
      var cluster = findRecipeCluster(recipe);
      if (!cluster) continue;

      activateSpecialRecipe(recipe, cluster);
      return true;
    }
    return false;
  }

  function activateSpecialRecipe(recipe, cluster) {
    var outputMeta = getMeta(recipe.output);
    if (!outputMeta) {
      console.warn('[recipe] 找不到产物 key：' + recipe.output);
      return;
    }

    var center = cluster.center;
    var averageRadius = cluster.averageRadius;

    // 先移除材料，保证不会重复触发
    cluster.members.forEach(function (body) {
      removeFruit(body);
    });

    var outputBody = createFruitBody(recipe.output, center.x, center.y, {
      visualScale: 0.3,
      angle: 0,
      velocity: { x: 0, y: -0.7 }
    });

    var score = Number(recipe.score);
    if (!isFinite(score)) score = Number(outputMeta.score) || 0;
    if (score > 0) addScore(score);

    createBurst(center.x, center.y, outputMeta.color, 36, 310);
    createBurst(center.x, center.y, '#CBE2DA', 20, 230);
    createRing(center.x, center.y, averageRadius * 5.5, outputMeta.color, 0.78);
    createFloatingText(center.x, center.y - averageRadius, recipe.name, '#2F7465');
    if (score > 0) {
      createFloatingText(center.x, center.y + averageRadius * 0.45, '+' + score, '#356B62');
    }
    state.flash = Math.max(state.flash, 0.38);
    state.shake = Math.max(state.shake, 10);
    Sound.special();

    if (recipe.unlockAchievement) {
      unlockAchievement(recipe.unlockAchievement);
    }

    if (outputBody) {
      outputBody.plugin.fruit.visualScale = 0.3;
    }
  }

  /* =========================================================================
   * 8. 分数 / 特效
   * ========================================================================= */
  function addScore(points) {
    var value = Math.max(0, Math.round(Number(points) || 0));
    if (!value) return;
    state.score += value;

    if (state.score > state.bestScore) {
      state.bestScore = state.score;
      save.bestScore = state.bestScore;
      persistSoon();
      UI.setBest(state.bestScore);
    }
    UI.setScore(state.score, true);
  }

  function createBurst(x, y, color, count, power) {
    var layout = state.layout;
    var k = layout ? layout.k : 1;
    var palette = [color, '#F3FAF7', '#BBD8CF', color];
    for (var i = 0; i < count; i++) {
      var angle = randomRange(0, TAU);
      var speed = randomRange(0.25, 1) * power * k;
      state.effects.particles.push({
        x: x,
        y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - randomRange(15, 80) * k,
        gravity: randomRange(260, 520) * k,
        size: randomRange(1.8, 4.6) * k,
        color: palette[i % palette.length],
        life: randomRange(0.38, 0.82),
        maxLife: 0.82,
        shape: i % 5 === 0 ? 'leaf' : 'dot',
        rotation: randomRange(0, TAU),
        spin: randomRange(-7, 7)
      });
    }
    trimEffects();
  }

  function createRing(x, y, maxRadius, color, life) {
    var layout = state.layout;
    var k = layout ? layout.k : 1;
    state.effects.rings.push({
      x: x,
      y: y,
      radius: 6 * k,
      maxRadius: maxRadius * k,
      color: color,
      life: life || 0.5,
      maxLife: life || 0.5
    });
  }

  function createFloatingText(x, y, text, color) {
    var layout = state.layout;
    var k = layout ? layout.k : 1;
    state.effects.texts.push({
      x: x,
      y: y,
      text: text,
      color: color || '#1F3A3B',
      life: 0.95,
      maxLife: 0.95,
      size: 15 * k
    });
  }

  function trimEffects() {
    var effects = state.effects;
    if (effects.particles.length > 320) {
      effects.particles.splice(0, effects.particles.length - 320);
    }
    if (effects.rings.length > 24) {
      effects.rings.splice(0, effects.rings.length - 24);
    }
    if (effects.texts.length > 20) {
      effects.texts.splice(0, effects.texts.length - 20);
    }
  }

  function updateEffects(dt) {
    var effects = state.effects;
    var i;

    for (i = effects.particles.length - 1; i >= 0; i--) {
      var p = effects.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        effects.particles.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.pow(0.28, dt);
      p.rotation += p.spin * dt;
    }

    for (i = effects.rings.length - 1; i >= 0; i--) {
      var ring = effects.rings[i];
      ring.life -= dt;
      if (ring.life <= 0) {
        effects.rings.splice(i, 1);
        continue;
      }
      var progress = 1 - ring.life / ring.maxLife;
      ring.radius = lerp(ring.radius, ring.maxRadius, Math.min(0.6, dt * 12 + progress * 0.12));
    }

    for (i = effects.texts.length - 1; i >= 0; i--) {
      var text = effects.texts[i];
      text.life -= dt;
      if (text.life <= 0) {
        effects.texts.splice(i, 1);
        continue;
      }
      text.y -= 28 * dt;
    }

    state.flash = Math.max(0, state.flash - dt * 2.4);
    state.shake = Math.max(0, state.shake - dt * 35);

    state.fruits.forEach(function (body) {
      var fruit = body.plugin && body.plugin.fruit;
      if (!fruit) return;
      if (fruit.visualScale < 1) {
        fruit.visualScale = Math.min(1, fruit.visualScale + dt * 5.2);
      }
    });
  }

  /* =========================================================================
   * 9. 12 级预警 / 07 回溯 / 危险线与结束流程
   * ========================================================================= */
  function showLevel12Warning() {
    if (state.ending || state.warningOpen) return;
    state.warningOpen = true;
    state.accumulator = 0;
    state.lastFrame = performance.now();
    cancelAim();
    UI.showLevel12Warning();
    Sound.warning();
  }

  function resolveLevel12Warning(shouldContinue) {
    if (!state.warningOpen) return;

    UI.hideLevel12Warning();
    state.warningOpen = false;
    state.lastFrame = performance.now();
    state.accumulator = 0;

    if (!shouldContinue) {
      // 玩家主动选择“跑路了”，这是主动结束，不触发 07 回溯保命。
      triggerGameOver({ allowRewind: false, reason: 'level12-choice' });
      return;
    }

    // 继续游戏：清空危险累计并给一小段免判时间，避免 12 级刚落下就立刻结束。
    state.fruits.forEach(function (body) {
      var fruit = body.plugin && body.plugin.fruit;
      if (fruit) fruit.dangerTime = 0;
    });
    state.dangerPressure = 0;
    state.dangerGraceUntil = Math.max(state.dangerGraceUntil, state.simTime + 1.2);
  }

  function shuffleInPlace(list) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var temp = list[i];
      list[i] = list[j];
      list[j] = temp;
    }
    return list;
  }

  /**
   * 07 回溯：在“即将因为危险线而结束”的瞬间自动发动，单局最多一次。
   * 清除场上全部 07，再额外随机清除 REWIND.clearCount 个其他水果。
   */
  function tryRewind() {
    if (!CONFIG.REWIND.enabled || state.rewindUsed || state.ending) return false;

    var level7Bodies = state.fruits.filter(function (body) {
      var fruit = body.plugin && body.plugin.fruit;
      return fruit && fruit.level === CONFIG.REWIND.level;
    });
    if (!level7Bodies.length) return false;

    // 优先清除 004，剩余名额再随机分给其他水果。
    var specialBodies = state.fruits.filter(function (body) {
      var fruit = body.plugin && body.plugin.fruit;
      return fruit && fruit.key === CONFIG.SPECIAL_OUTPUT.key;
    });
    var others = state.fruits.filter(function (body) {
      return level7Bodies.indexOf(body) === -1 && specialBodies.indexOf(body) === -1;
    });
    shuffleInPlace(others);

    var remainingSlots = Math.max(0, CONFIG.REWIND.clearCount - specialBodies.length);
    var targets = level7Bodies.concat(specialBodies, others.slice(0, remainingSlots));
    var removedCount = targets.length;
    var center = centroidOf(targets);

    state.rewindUsed = true;
    state.mergeQueue.length = 0;
    state.seenPairs.clear();

    targets.forEach(function (body) {
      removeFruit(body);
    });

    // 剩余水果重置危险累计，并进入短暂免判期。
    state.fruits.forEach(function (body) {
      var fruit = body.plugin && body.plugin.fruit;
      if (fruit) fruit.dangerTime = 0;
    });
    state.dangerPressure = 0;
    state.dangerGraceUntil = state.simTime + CONFIG.REWIND.graceTime;

    // 倒带特效
    if (state.layout) {
      var k = state.layout.k;
      createRing(center.x, center.y, 250, '#BBD8CF', 0.85);
      createRing(center.x, center.y, 160, '#D8EBE5', 0.7);
      createBurst(center.x, center.y, '#BBD8CF', 44, 420);
      createBurst(center.x, center.y, '#F2F8F5', 24, 310);
      createFloatingText(center.x, center.y - 18 * k, '回溯', '#356B62');
      state.flash = Math.max(state.flash, 0.48);
      state.shake = Math.max(state.shake, 11);
    }

    UI.refreshRewindChip();
    UI.showRewindBanner(removedCount);
    Sound.rewind();
    return true;
  }

  function updateDanger(dt) {
    if (state.ending || state.warningOpen) return;

    // 回溯或 12 级“继续玩”后的短暂保护期
    if (state.simTime < state.dangerGraceUntil) {
      state.dangerPressure = 0;
      state.fruits.forEach(function (body) {
        var fruit = body.plugin && body.plugin.fruit;
        if (fruit) fruit.dangerTime = 0;
      });
      return;
    }

    var layout = state.layout;
    var grace = CONFIG.DANGER_GRACE_MS / 1000;
    var pressure = 0;

    for (var i = 0; i < state.fruits.length; i++) {
      var body = state.fruits[i];
      var fruit = body.plugin && body.plugin.fruit;
      if (!fruit || body._dead) continue;

      if (state.simTime - fruit.bornAt < grace) {
        fruit.dangerTime = 0;
        continue;
      }

      // 方形碰撞体旋转后要用实际 AABB 顶部；圆退回 center-r。
      var top = body.bounds ? body.bounds.min.y : body.position.y - fruit.radius;
      if (top < layout.dangerY) {
        fruit.dangerTime += dt;
        pressure = Math.max(pressure, Math.min(1, fruit.dangerTime / CONFIG.DANGER_HOLD_TIME));
        if (fruit.dangerTime >= CONFIG.DANGER_HOLD_TIME) {
          state.dangerPressure = 1;
          triggerGameOver();
          return;
        }
      } else {
        // “持续”超过警戒线：一旦回到线下就清零，不做累计。
        fruit.dangerTime = 0;
      }
    }

    state.dangerPressure = pressure;
  }

  function triggerGameOver(options) {
    if (state.ending) return;
    options = options || {};
    var isSecondEnding = isAchievementUnlocked(CONFIG.ENDING.achievement);

    // 危险线导致的结束前，若场上有 07 且本局未用过回溯，则自动保命继续。
    if (options.allowRewind !== false && tryRewind()) {
      return;
    }

    // 1) 冻结物理：帧循环从这一行开始不再更新 Matter。
    state.ending = true;
    state.warningOpen = false;
    state.endedAt = performance.now();
    state.accumulator = 0;
    state.mergeQueue.length = 0;
    state.seenPairs.clear();
    cancelAim();
    UI.hideLevel12Warning();
    UI.hideRewindBanner();
    UI.exitCheatPlacement();

    // 2) 所有场上水果只换图源，不改 radius / position / angle / scale。
    for (var i = 0; i < state.fruits.length; i++) {
      var fruit = state.fruits[i].plugin && state.fruits[i].plugin.fruit;
      if (!fruit) continue;
      fruit.renderKey = CONFIG.ENDING.key;
      fruit.isEnding = true;
    }

    // 3) 更新最高分 / 场次
    if (state.score > state.bestScore) state.bestScore = state.score;
    save.bestScore = state.bestScore;
    save.gamesPlayed += 1;
    persist();
    UI.setBest(state.bestScore);

    // 4) 屏幕中央“跑路了”与重开按钮（CSS 动画按顺序出现）
    UI.hideHint();
    UI.showEndScreen(state.score, state.bestScore);
    Sound.gameOver();
    Music.stop();

    // 6) 首次触发时解锁“龙B之争”；第二次跑路结局再解锁“真正的英雄”。
    window.clearTimeout(state.endAchievementTimer);
    state.endAchievementTimer = window.setTimeout(function () {
      unlockAchievement(CONFIG.ENDING.achievement);
      if (isSecondEnding && CONFIG.ENDING.secondAchievement) {
        unlockAchievement(CONFIG.ENDING.secondAchievement);
      }
    }, 1120);
  }

  /* =========================================================================
   * 10. 物理步进 / 帧循环
   * ========================================================================= */
  function stepSimulation() {
    state.simTime += STEP_SEC;

    // collisionStart 是 Engine.update 同步触发的；先清空队列再更新。
    state.mergeQueue = [];
    state.seenPairs.clear();

    Engine.update(state.engine, STEP_MS);

    // 特殊配方优先于同等级合并，避免“刚凑齐就被同级合掉”。
    trySpecialRecipes();
    processMergeQueue();
    checkPresenceAchievements();
    if (!state.warningOpen && !state.ending) {
      updateDanger(STEP_SEC);
    }
  }

  function frame(now) {
    var rawDt = state.lastFrame ? (now - state.lastFrame) / 1000 : STEP_SEC;
    state.lastFrame = now;
    rawDt = clamp(rawDt, 0, 0.05);

    if (isPhysicsRunning()) {
      state.accumulator = Math.min(state.accumulator + rawDt, STEP_SEC * 5);
      var steps = 0;
      while (state.accumulator >= STEP_SEC && steps < 5) {
        stepSimulation();
        state.accumulator -= STEP_SEC;
        steps += 1;
        if (state.ending || state.warningOpen) {
          state.accumulator = 0;
          break;
        }
      }
    } else {
      state.accumulator = 0;
    }

    updateEffects(rawDt);
    render(now / 1000);
    requestAnimationFrame(frame);
  }

  /* =========================================================================
   * 11. Canvas 渲染
   * ========================================================================= */
  function render(time) {
    var layout = state.layout;
    if (!layout || !els.ctx) return;

    var ctx = els.ctx;
    ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
    ctx.clearRect(0, 0, layout.w, layout.h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    var shake = state.shake;
    if (shake > 0.05) {
      ctx.save();
      var magnitude = Math.min(shake, 14) * layout.k * 0.35;
      ctx.translate(
        Math.sin(time * 93) * magnitude,
        Math.cos(time * 127) * magnitude * 0.72
      );
    } else {
      ctx.save();
    }

    drawRails(ctx, layout);
    drawDangerLine(ctx, layout, time);
    drawFruits(ctx, layout, time);
    drawEffects(ctx, layout, time);

    if (!state.ending) {
      drawAim(ctx, layout, time);
    }

    ctx.restore();

    if (state.flash > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(205, 231, 223, ' + (state.flash * 0.4).toFixed(3) + ')';
      ctx.fillRect(0, 0, layout.w, layout.h);
      ctx.restore();
    }
  }

  function drawRails(ctx, layout) {
    var k = layout.k;
    var side = layout.side;
    var right = layout.w - side;
    var floor = layout.floorY;

    ctx.save();
    ctx.lineCap = 'round';

    // 左右护栏
    ctx.strokeStyle = 'rgba(31, 62, 61, 0.18)';
    ctx.lineWidth = 1.5 * k;
    ctx.beginPath();
    ctx.moveTo(side, layout.hudBottom + 12 * k);
    ctx.lineTo(side, floor - 7 * k);
    ctx.moveTo(right, layout.hudBottom + 12 * k);
    ctx.lineTo(right, floor - 7 * k);
    ctx.stroke();

    // 地板
    ctx.strokeStyle = 'rgba(31, 62, 61, 0.3)';
    ctx.lineWidth = 3 * k;
    ctx.beginPath();
    ctx.moveTo(side, floor);
    ctx.lineTo(right, floor);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(248, 252, 250, 0.62)';
    ctx.lineWidth = 1 * k;
    ctx.beginPath();
    ctx.moveTo(side + 2 * k, floor - 2.2 * k);
    ctx.lineTo(right - 2 * k, floor - 2.2 * k);
    ctx.stroke();

    // 地板两端的软木塞/节点
    ctx.fillStyle = 'rgba(31, 62, 61, 0.28)';
    ctx.beginPath();
    ctx.arc(side, floor, 2.2 * k, 0, TAU);
    ctx.arc(right, floor, 2.2 * k, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  function drawDangerLine(ctx, layout, time) {
    var k = layout.k;
    var side = layout.side;
    var right = layout.w - side;
    var y = layout.dangerY;
    var pressure = state.dangerPressure;

    ctx.save();

    // 警戒线之上的淡红危险区
    var gradient = ctx.createLinearGradient(0, layout.hudBottom, 0, y);
    gradient.addColorStop(0, 'rgba(178, 92, 94, ' + (0.012 + pressure * 0.035).toFixed(3) + ')');
    gradient.addColorStop(1, 'rgba(178, 92, 94, ' + (0.04 + pressure * 0.09).toFixed(3) + ')');
    ctx.fillStyle = gradient;
    ctx.fillRect(side, layout.hudBottom, right - side, Math.max(0, y - layout.hudBottom));

    ctx.setLineDash([7 * k, 7 * k]);
    ctx.lineDashOffset = -time * 13 * k;
    ctx.strokeStyle = 'rgba(171, 86, 86, ' + (0.44 + pressure * 0.42).toFixed(3) + ')';
    ctx.lineWidth = (1.4 + pressure * 0.8) * k;
    ctx.beginPath();
    ctx.moveTo(side, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 右侧的小标签
    var fontSize = Math.max(8, 9.5 * k);
    ctx.font = '800 ' + fontSize.toFixed(1) + 'px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(148, 69, 71, ' + (0.5 + pressure * 0.45).toFixed(3) + ')';
    ctx.fillText('警戒线', right - 2 * k, y - 4 * k);

    ctx.restore();
  }

  function drawFruits(ctx, layout, time) {
    var fruits = state.fruits.slice().sort(function (a, b) {
      return a.position.y - b.position.y;
    });

    for (var i = 0; i < fruits.length; i++) {
      var body = fruits[i];
      var fruit = body.plugin && body.plugin.fruit;
      if (!fruit || body._dead) continue;

      var scale = fruit.visualScale || 1;
      var radius = fruit.radius * scale;
      var key = fruit.renderKey || fruit.spriteKey;

      if (fruit.dangerTime > 0 && !state.ending) {
        var progress = clamp(fruit.dangerTime / CONFIG.DANGER_HOLD_TIME, 0, 1);
        var pulse = 0.55 + Math.sin(time * 14) * 0.18;
        ctx.save();
        ctx.beginPath();
        ctx.arc(body.position.x, body.position.y, fruit.radius + (4 + progress * 6) * layout.k, 0, TAU);
        ctx.fillStyle = 'rgba(178, 92, 94, ' + (0.06 + progress * 0.16 * pulse).toFixed(3) + ')';
        ctx.fill();
        ctx.strokeStyle = 'rgba(171, 86, 86, ' + (0.22 + progress * 0.5).toFixed(3) + ')';
        ctx.lineWidth = (1.2 + progress * 1.2) * layout.k;
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.translate(body.position.x, body.position.y);
      ctx.rotate(body.angle || 0);
      drawSpriteOn(ctx, key, 0, 0, radius, 1);
      ctx.restore();
    }
  }

  function drawSpriteOn(ctx, key, cx, cy, radius, alpha) {
    var meta = getMeta(key);
    if (!meta || radius <= 0) return;

    alpha = typeof alpha === 'number' ? alpha : 1;
    var asset = SpriteSet.get(key);

    ctx.save();
    ctx.globalAlpha *= alpha;

    if (asset && asset.loaded && asset.naturalWidth > 0 && asset.naturalHeight > 0) {
      var box = radius * 2 * CONFIG.SPRITE_BOX_SCALE;
      // 关键：整张图等比缩放进固定盒子。scaleX === scaleY，不裁剪、不拉伸。
      var scale = Math.min(box / asset.naturalWidth, box / asset.naturalHeight);
      var drawWidth = asset.naturalWidth * scale;
      var drawHeight = asset.naturalHeight * scale;
      ctx.drawImage(
        asset.image,
        cx - drawWidth / 2,
        cy - drawHeight / 2,
        drawWidth,
        drawHeight
      );
    } else {
      drawFallbackFruit(ctx, meta, cx, cy, radius);
    }

    ctx.restore();
  }

  function drawFallbackFruit(ctx, meta, cx, cy, radius) {
    var key = meta.key || (meta.level ? pad2(meta.level) : '');
    var gradient = ctx.createRadialGradient(
      cx - radius * 0.38,
      cy - radius * 0.42,
      radius * 0.08,
      cx,
      cy,
      radius * 1.02
    );
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.58)');
    gradient.addColorStop(0.28, meta.color || '#7FAEA4');
    gradient.addColorStop(1, meta.ink || '#8F2A38');

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.lineWidth = Math.max(1, radius * 0.055);
    ctx.strokeStyle = 'rgba(255, 250, 236, 0.68)';
    ctx.stroke();

    // 叶子/高光小装饰
    ctx.beginPath();
    ctx.ellipse(
      cx + radius * 0.26,
      cy - radius * 0.72,
      radius * 0.2,
      radius * 0.1,
      -0.52,
      0,
      TAU
    );
    ctx.fillStyle = 'rgba(66, 127, 74, 0.82)';
    ctx.fill();

    ctx.beginPath();
    ctx.ellipse(
      cx - radius * 0.32,
      cy - radius * 0.35,
      radius * 0.23,
      radius * 0.12,
      -0.72,
      0,
      TAU
    );
    ctx.fillStyle = 'rgba(255, 255, 255, 0.32)';
    ctx.fill();

    if (radius > 11) {
      var label = key === CONFIG.ENDING.key ? '跑' :
        key === CONFIG.SPECIAL_OUTPUT.key ? '皮' :
          String(meta.level || key);
      ctx.fillStyle = 'rgba(248, 252, 250, 0.94)';
      ctx.font = '900 ' + (radius * 0.72).toFixed(1) + 'px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, cy + radius * 0.06);
    }
  }

  function drawAim(ctx, layout, time) {
    // 神秘暗号：自由放置模式下隐藏普通落点，只显示放置预览。
    if (state.cheatPlaceKey) {
      var cheatMeta = getMeta(state.cheatPlaceKey);
      if (!cheatMeta || !state.cheatPreview) return;
      var cheatRadius = cheatMeta.radius * layout.k;
      var point = state.cheatPreview;
      ctx.save();
      ctx.setLineDash([5 * layout.k, 5 * layout.k]);
      ctx.lineWidth = 1.6 * layout.k;
      ctx.strokeStyle = 'rgba(63, 127, 120, 0.62)';
      ctx.strokeRect(
        point.x - cheatRadius,
        point.y - cheatRadius,
        cheatRadius * 2,
        cheatRadius * 2
      );
      ctx.setLineDash([]);
      drawSpriteOn(ctx, state.cheatPlaceKey, point.x, point.y, cheatRadius, 0.56);
      ctx.restore();
      return;
    }

    if (!state.currentKey) return;

    var meta = getMeta(state.currentKey);
    if (!meta) return;

    var k = layout.k;
    var radius = meta.radius * k;
    var x = clamp(
      state.aimX || layout.w / 2,
      layout.side + radius + 1,
      layout.w - layout.side - radius - 1
    );
    var remain = clamp((state.dropReadyAt - state.simTime) / (CONFIG.DROP_COOLDOWN / 1000), 0, 1);
    var ready = remain <= 0;
    var pulse = 0.5 + Math.sin(time * 3.6) * 0.5;

    ctx.save();

    // 垂直瞄准线
    ctx.setLineDash([3 * k, 7 * k]);
    ctx.lineDashOffset = -time * 16 * k;
    ctx.lineWidth = 1.2 * k;
    ctx.strokeStyle = 'rgba(31, 62, 61, ' + (ready ? 0.2 : 0.11) + ')';
    ctx.beginPath();
    ctx.moveTo(x, layout.dropY + radius + 5 * k);
    ctx.lineTo(x, layout.floorY - 5 * k);
    ctx.stroke();
    ctx.setLineDash([]);

    // 顶部落点刻度
    ctx.strokeStyle = 'rgba(31, 62, 61, 0.32)';
    ctx.lineWidth = 1.5 * k;
    ctx.beginPath();
    ctx.moveTo(x - 7 * k, layout.dropY - radius - 6 * k);
    ctx.lineTo(x + 7 * k, layout.dropY - radius - 6 * k);
    ctx.stroke();

    // 水果预览
    var alpha = ready ? 0.62 + pulse * 0.08 : 0.24;
    ctx.save();
    ctx.translate(x, layout.dropY);
    ctx.rotate(Math.sin(time * 2.1) * 0.025);
    drawSpriteOn(ctx, state.currentKey, 0, 0, radius, alpha);
    ctx.restore();

    // 冷却环
    if (!ready) {
      var progress = 1 - remain;
      ctx.beginPath();
      ctx.arc(x, layout.dropY, radius + 6 * k, -Math.PI / 2, -Math.PI / 2 + progress * TAU);
      ctx.strokeStyle = 'rgba(63, 127, 120, 0.78)';
      ctx.lineWidth = 2.4 * k;
      ctx.lineCap = 'round';
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, layout.dropY, radius + 5 * k, 0, TAU);
      ctx.strokeStyle = 'rgba(255, 250, 238, ' + (0.16 + pulse * 0.14).toFixed(3) + ')';
      ctx.lineWidth = 1.2 * k;
      ctx.stroke();
    }

    // 向下的小箭头
    ctx.beginPath();
    ctx.moveTo(x - 4 * k, layout.dropY + radius + 7 * k);
    ctx.lineTo(x + 4 * k, layout.dropY + radius + 7 * k);
    ctx.lineTo(x, layout.dropY + radius + 13 * k);
    ctx.closePath();
    ctx.fillStyle = 'rgba(31, 62, 61, ' + (ready ? 0.32 : 0.16) + ')';
    ctx.fill();

    ctx.restore();
  }

  function drawEffects(ctx, layout, time) {
    var effects = state.effects;
    var i;

    // 扩散环
    for (i = 0; i < effects.rings.length; i++) {
      var ring = effects.rings[i];
      var ringProgress = 1 - ring.life / ring.maxLife;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - ringProgress) * 0.72;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, Math.max(1, ring.radius), 0, TAU);
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = (3 - ringProgress * 2) * layout.k;
      ctx.stroke();
      ctx.restore();
    }

    // 粒子
    for (i = 0; i < effects.particles.length; i++) {
      var p = effects.particles[i];
      var alpha = clamp(p.life / p.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      if (p.shape === 'leaf') {
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size * 1.6, p.size * 0.72, 0, 0, TAU);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    // 浮动分数 / 文字
    for (i = 0; i < effects.texts.length; i++) {
      var text = effects.texts[i];
      var textAlpha = clamp(text.life / text.maxLife, 0, 1);
      var rise = 1 - textAlpha;
      ctx.save();
      ctx.globalAlpha = textAlpha;
      ctx.fillStyle = text.color;
      ctx.font = '900 ' + text.size.toFixed(1) + 'px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(244, 250, 247, 0.72)';
      ctx.shadowBlur = 3 * layout.k;
      ctx.fillText(text.text, text.x, text.y - rise * 8 * layout.k);
      ctx.restore();
    }
  }

  /* =========================================================================
   * 12. 输入
   * ========================================================================= */
  function clientToGamePoint(clientX, clientY) {
    var rect = els.canvas.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  function clientToGameX(clientX) {
    var rect = els.canvas.getBoundingClientRect();
    return clientX - rect.left;
  }

  function updateAimFromEvent(event) {
    var layout = state.layout;
    if (!layout) return;
    var meta = getMeta(state.currentKey);
    var radius = meta ? meta.radius * layout.k : 20 * layout.k;
    state.aimX = clamp(
      clientToGameX(event.clientX),
      layout.side + radius + 1,
      layout.w - layout.side - radius - 1
    );
  }

  function onPointerDown(event) {
    if (!isPhysicsRunning()) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    if (state.cheatPlaceKey) {
      if (state.cheatPointerId !== null) return;
      event.preventDefault();
      state.cheatPointerId = event.pointerId;
      state.cheatPreview = clampCheatPoint(clientToGamePoint(event.clientX, event.clientY));
      try {
        els.canvas.setPointerCapture(event.pointerId);
      } catch (error) {
        // ignore
      }
      return;
    }

    if (state.pointerId !== null) return;

    event.preventDefault();
    state.pointerId = event.pointerId;
    state.pointerActive = true;
    updateAimFromEvent(event);

    try {
      els.canvas.setPointerCapture(event.pointerId);
    } catch (error) {
      // 某些浏览器/文件协议下不支持 capture，不影响玩法
    }
  }

  function onPointerMove(event) {
    if (state.cheatPlaceKey && event.pointerId === state.cheatPointerId) {
      event.preventDefault();
      state.cheatPreview = clampCheatPoint(clientToGamePoint(event.clientX, event.clientY));
      return;
    }
    if (event.pointerId !== state.pointerId) return;
    event.preventDefault();
    updateAimFromEvent(event);
  }

  function onPointerUp(event) {
    if (state.cheatPlaceKey && event.pointerId === state.cheatPointerId) {
      event.preventDefault();
      var point = clampCheatPoint(clientToGamePoint(event.clientX, event.clientY));
      state.cheatPointerId = null;
      state.cheatPreview = null;
      try {
        els.canvas.releasePointerCapture(event.pointerId);
      } catch (error) {
        // ignore
      }
      placeCheatFruitAt(point);
      return;
    }

    if (event.pointerId !== state.pointerId) return;
    event.preventDefault();
    updateAimFromEvent(event);
    state.pointerId = null;
    state.pointerActive = false;
    try {
      els.canvas.releasePointerCapture(event.pointerId);
    } catch (error) {
      // ignore
    }
    tryDrop();
  }

  function onPointerCancel(event) {
    if (event.pointerId === state.cheatPointerId) {
      state.cheatPointerId = null;
      state.cheatPreview = null;
      return;
    }
    if (event.pointerId !== state.pointerId) return;
    state.pointerId = null;
    state.pointerActive = false;
    try {
      els.canvas.releasePointerCapture(event.pointerId);
    } catch (error) {
      // ignore
    }
  }

  function cancelAim() {
    state.pointerId = null;
    state.pointerActive = false;
    state.cheatPointerId = null;
    state.cheatPreview = null;
  }

  function onKeyDown(event) {
    if (state.warningOpen) {
      // 预警层只能通过“继续玩 / 跑路了”决定；Esc 等同继续，避免误结束。
      if (event.key === 'Escape') {
        resolveLevel12Warning(true);
        event.preventDefault();
      }
      return;
    }

    if (UI.isSendPickerOpen()) {
      if (event.key === 'Escape') {
        UI.closeSendPicker();
        event.preventDefault();
      }
      return;
    }

    if (event.key === 'Escape') {
      if (UI.isPanelOpen()) {
        UI.closeAchievements();
        event.preventDefault();
      }
      return;
    }

    if (UI.isPanelOpen()) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    if (state.cheatPlaceKey && event.key === 'Escape') {
      UI.exitCheatPlacement();
      event.preventDefault();
      return;
    }

    var key = event.key;
    if (key === 'm' || key === 'M') {
      Sound.toggle();
      event.preventDefault();
      return;
    }
    if (state.ending) {
      if (key === 'r' || key === 'R') {
        startNewGame();
        event.preventDefault();
      }
      return;
    }
    if (key === 'a' || key === 'A') {
      UI.openAchievements();
      event.preventDefault();
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      var layout = state.layout;
      var meta = getMeta(state.currentKey);
      if (!layout || !meta) return;
      var stepDistance = 14 * layout.k;
      var radius = meta.radius * layout.k;
      state.aimX = clamp(
        state.aimX + (key === 'ArrowLeft' ? -stepDistance : stepDistance),
        layout.side + radius + 1,
        layout.w - layout.side - radius - 1
      );
      event.preventDefault();
      return;
    }
    if (key === ' ' || event.code === 'Space') {
      event.preventDefault();
      tryDrop();
    }
  }

  /* =========================================================================
   * 13. 引擎 / 回合 / 启动
   * ========================================================================= */
  function initEngine() {
    state.engine = Engine.create({
      enableSleeping: false
    });
    state.world = state.engine.world;
    state.engine.gravity.y = CONFIG.GRAVITY;
    state.engine.positionIterations = 8;
    state.engine.velocityIterations = 6;
    state.engine.constraintIterations = 2;

    Events.on(state.engine, 'collisionStart', onCollisionStart);
  }

  function resetRound() {
    // 清空水果
    state.fruits.slice().forEach(function (body) {
      removeFruit(body);
    });
    state.fruits.length = 0;
    state.mergeQueue.length = 0;
    state.seenPairs.clear();
    Music.stop();

    // 清空状态
    state.score = 0;
    state.simTime = 0;
    state.accumulator = 0;
    state.lastFrame = performance.now();
    state.ending = false;
    state.manualPaused = false;
    state.warningOpen = false;
    state.rewindUsed = false;
    state.dangerGraceUntil = 0;
    state.pointerId = null;
    state.pointerActive = false;
    state.hasDropped = false;
    state.flash = 0;
    state.shake = 0;
    state.dangerPressure = 0;
    state.endedAt = 0;
    state.effects.particles.length = 0;
    state.effects.rings.length = 0;
    state.effects.texts.length = 0;
    state.cheatPlaceKey = null;
    state.cheatPointerId = null;
    state.cheatPreview = null;

    state.currentKey = randomDropKey();
    state.nextKey = randomDropKey();
    state.dropReadyAt = 0;

    var layout = state.layout;
    state.aimX = layout ? layout.w / 2 : 0;
    clampAim();

    UI.hideEndScreen();
    UI.hideLevel12Warning();
    UI.hideRewindBanner();
    UI.hideSubtitle();
    UI.hideCheatBar();
    UI.closeSendPicker();
    UI.refreshRewindChip();
    UI.refreshNinePicker();
    UI.refreshFruitPickerSelection();
    UI.setScore(0, false);
    UI.setBest(state.bestScore);
    UI.setNext(state.nextKey);
    UI.showHint();
    UI.drawNextPreview();
  }

  function startNewGame() {
    if (!state.engine) return;
    resetRound();
    state.running = true;
    state.lastFrame = performance.now();
  }

  function boot() {
    try {
      UI.init();
      if (!UI.ready) return;

      initEngine();
      state.layout = computeLayout();
      applyCanvasTransform();
      rebuildWalls();
      resizeGame();

      state.debug = new URLSearchParams(window.location.search).has('debug');
      UI.setBootStatus('正在准备水果…');

      SpriteSet.preload(function (loaded, total) {
        UI.setBootStatus('正在准备水果… ' + loaded + ' / ' + total);
      }).then(function () {
        var missing = SpriteSet.report().filter(function (item) { return !item.loaded; }).length;
        if (missing > 0) {
          UI.setBootStatus('有 ' + missing + ' 张素材未找到，已使用占位绘制');
        } else {
          UI.setBootStatus('水果就位');
        }

        resetRound();
        state.running = true;
        state.lastFrame = performance.now();
        resizeGame();
        UI.drawFruitPickerThumbs();
        UI.drawCheatThumbs();
        requestAnimationFrame(frame);

        window.setTimeout(function () {
          UI.hideBoot();
        }, missing > 0 ? 520 : 220);

        if (state.debug) {
          console.info('[debug] window.WatermelonGame 已启用');
          console.table(SpriteSet.report());
        }
      }).catch(function (error) {
        console.error(error);
        showFatal('素材加载过程出现异常：' + (error && error.message ? error.message : error));
      });
    } catch (error) {
      console.error(error);
      showFatal('初始化失败：' + (error && error.message ? error.message : error));
    }
  }

  /* =========================================================================
   * 14. QA / 调试接口
   *     正常游玩不会被影响；带 ?debug=1 打开时可用。
   * ========================================================================= */
  var publicApi = {
    version: CONFIG.VERSION,
    inspectAssets: function () {
      return SpriteSet.report();
    },
    getState: function () {
      var hasLevel7 = state.fruits.some(function (body) {
        var fruit = body.plugin && body.plugin.fruit;
        return fruit && fruit.level === CONFIG.REWIND.level;
      });
      var hasLevel9 = state.fruits.some(function (body) {
        var fruit = body.plugin && body.plugin.fruit;
        return fruit && fruit.level === CONFIG.NINE_POWER.level;
      });
      return {
        score: state.score,
        bestScore: state.bestScore,
        ending: state.ending,
        running: state.running,
        warningOpen: state.warningOpen,
        rewindUsed: state.rewindUsed,
        rewindReady: !state.rewindUsed && hasLevel7,
        cheatUnlocked: !!save.cheatUnlocked,
        cheatPlaceKey: state.cheatPlaceKey,
        nineReady: hasLevel9,
        pickerOpen: UI.isSendPickerOpen(),
        currentKey: state.currentKey,
        nextKey: state.nextKey,
        simTime: Number(state.simTime.toFixed(3)),
        dangerY: state.layout ? Number(state.layout.dangerY.toFixed(2)) : null,
        dangerGraceUntil: Number(state.dangerGraceUntil.toFixed(3)),
        fruits: state.fruits.map(function (body) {
          var fruit = body.plugin.fruit;
          return {
            key: fruit.key,
            level: fruit.level,
            shape: fruit.shape,
            radius: fruit.radius,
            collisionWidth: body.bounds ? Number(body.bounds.max.x - body.bounds.min.x) : null,
            collisionHeight: body.bounds ? Number(body.bounds.max.y - body.bounds.min.y) : null,
            angle: Number((body.angle || 0).toFixed(3)),
            x: body.position.x,
            y: body.position.y,
            renderKey: fruit.renderKey,
            dangerTime: Number((fruit.dangerTime || 0).toFixed(3)),
            bornAt: Number((fruit.bornAt || 0).toFixed(3))
          };
        })
      };
    }
  };

  function debugSpawn(key, x, y) {
    if (!state.layout) return null;
    var layout = state.layout;
    var px = typeof x === 'number' ? x * layout.w : layout.w / 2;
    var py = typeof y === 'number' ? y * layout.h : layout.floorY - 120 * layout.k;
    return createFruitBody(key, px, py, {});
  }

  function debugSpawnRecipeCluster() {
    var recipe = CONFIG.SPECIAL_RECIPES[0];
    if (!recipe || !state.layout) return false;
    var layout = state.layout;
    var keys = [];
    Object.keys(recipe.inputs).forEach(function (key) {
      for (var i = 0; i < recipe.inputs[key]; i++) keys.push(key);
    });

    var centerX = layout.w / 2;
    var centerY = layout.floorY - 145 * layout.k;
    var spacingX = 52 * layout.k;
    var spacingY = 54 * layout.k;
    var columns = 3;

    keys.forEach(function (key, index) {
      var col = index % columns;
      var row = Math.floor(index / columns);
      var x = centerX + (col - (columns - 1) / 2) * spacingX;
      var y = centerY + (row - 0.5) * spacingY;
      createFruitBody(key, x, y, { velocity: { x: 0, y: 0 } });
    });
    return true;
  }

  function debugMergePair(level) {
    if (!state.layout) return false;
    var key = pad2(level);
    var meta = getMeta(key);
    if (!meta) return false;
    var layout = state.layout;
    var r = meta.radius * layout.k;
    createFruitBody(key, layout.w / 2 - r * 0.25, layout.floorY - r - 40 * layout.k, { velocity: { x: 0, y: 0 } });
    createFruitBody(key, layout.w / 2 + r * 0.25, layout.floorY - r - 40 * layout.k, { velocity: { x: 0, y: 0 } });
    return true;
  }

  function debugDangerTest() {
    if (!state.layout) return false;
    var layout = state.layout;
    var body = createFruitBody('12', layout.w / 2, layout.dangerY - 12 * layout.k, { velocity: { x: 0, y: 0 } });
    if (!body) return false;
    // 固定在高处，模拟“水果顶部持续越过警戒线”，用于验收结束判定。
    Body.setStatic(body, true);
    return true;
  }

  function debugRewindSetup() {
    if (!state.layout) return false;
    var layout = state.layout;
    var keys = ['07', '01', '02', '03', '04', '05', '01', '02', '03', '04', '05', '01', '02', '03', '04'];
    keys.forEach(function (key, index) {
      var meta = getMeta(key);
      if (!meta) return;
      var radius = meta.radius * layout.k;
      var x = layout.side + radius + 12 * layout.k +
        (index % 5) * ((layout.innerW - radius * 2 - 24 * layout.k) / 4);
      var y = layout.floorY - radius - Math.floor(index / 5) * 64 * layout.k;
      createFruitBody(key, x, y, { velocity: { x: 0, y: 0 } });
    });
    return true;
  }

  if (new URLSearchParams(window.location.search).has('debug')) {
    state.debug = true;
    publicApi.debug = {
      spawn: debugSpawn,
      spawnRecipeCluster: debugSpawnRecipeCluster,
      mergePair: debugMergePair,
      dangerTest: debugDangerTest,
      rewindSetup: debugRewindSetup,
      gameOver: function () {
        triggerGameOver({ allowRewind: false, reason: 'debug' });
      },
      unlock: unlockAchievement,
      restart: startNewGame,
      openPicker: function () {
        UI.openSendPicker();
      },
      chooseNext: function (key) {
        UI.chooseNextFruit(key);
        return state.currentKey;
      },
      setCurrent: function (key) {
        if (!getMeta(key)) return false;
        state.currentKey = key;
        clampAim();
        return true;
      },
      musicInfo: function () {
        var audio = Music.audio;
        return {
          src: CONFIG.MUSIC.chunriying,
          exists: !!audio,
          paused: audio ? audio.paused : true,
          currentTime: audio ? Number(audio.currentTime.toFixed(2)) : 0,
          readyState: audio ? audio.readyState : 0,
          networkState: audio ? audio.networkState : 0,
          error: audio && audio.error ? audio.error.code : null,
          wanted: Music.wanted
        };
      },
      continueWarning: function () {
        resolveLevel12Warning(true);
      },
      quitWarning: function () {
        resolveLevel12Warning(false);
      },
      dropAt: function (xRatio) {
        if (typeof xRatio === 'number') state.aimX = state.layout.w * xRatio;
        return tryDrop();
      }
    };
  }

  window.WatermelonGame = publicApi;

  /* =========================================================================
   * 15. 启动
   * ========================================================================= */
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
