/*
 * 合成大物华 · 跑路了
 * ------------------------------------------------------------------
 * 这是唯一的数值/资源入口。
 *
 * 重要约定：
 * 1. radius 是方形碰撞体半边长（设计稿单位，390 宽为基准），和图片像素尺寸完全无关。
 * 2. 换图只改 img 字段；渲染层会用“原始整图 + 等比 contain”的方式画进固定大小的
 *    边长为 2 * radius 的方形盒子，绝不会拉伸、裁剪或改写图片。
 * 3. 所有数值留在这里，游戏逻辑不要写死手感参数。
 * ------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  const LEVELS = [
    { level: 1,  img: 'img/01.jpg', radius: 17,  score: 2,    name: '樱桃',   color: '#F25F6B', ink: '#A92F3E' },
    { level: 2,  img: 'img/02.jpg', radius: 22,  score: 4,    name: '杏子',   color: '#F58B57', ink: '#A84A28' },
    { level: 3,  img: 'img/03.jpg', radius: 28,  score: 8,    name: '柠檬',   color: '#F4C64E', ink: '#9A7215' },
    { level: 4,  img: 'img/04.jpg', radius: 35,  score: 16,   name: '奇异果', color: '#AFCF66', ink: '#5E7A22' },
    { level: 5,  img: 'img/05.jpg', radius: 42,  score: 32,   name: '青提',   color: '#73C98A', ink: '#2F7547' },
    { level: 6,  img: 'img/06.jpg', radius: 50,  score: 64,   name: '蜜瓜',   color: '#55C2A4', ink: '#25705E' },
    { level: 7,  img: 'img/07.jpg', radius: 58,  score: 128,  name: '水蜜桃', color: '#61B4D9', ink: '#2C6B88' },
    { level: 8,  img: 'img/08.jpg', radius: 67,  score: 256,  name: '蓝莓',   color: '#7C8FE3', ink: '#3C4B96' },
    { level: 9,  img: 'img/09.jpg', radius: 76,  score: 512,  name: '葡萄',   color: '#A579DC', ink: '#5E3A8E' },
    { level: 10, img: 'img/10.jpg', radius: 85,  score: 1024, name: '火龙果', color: '#D16DBC', ink: '#843567' },
    { level: 11, img: 'img/11.jpg', radius: 94,  score: 2048, name: '石榴',   color: '#E65E8D', ink: '#982A4D' },
    { level: 12, img: 'img/12.jpg', radius: 105, score: 4096, name: '大物华', color: '#3F9E63', ink: '#1D5733' }
  ];

  const CONFIG = {
    VERSION: '1.4.0',

    // ---------- 画布/响应式 ----------
    DESIGN_WIDTH: 390,        // 所有设计稿单位以 390 宽为基准；k = 实际宽度 / 390
    PLAYFIELD_MARGIN: 12,     // 左右护栏距离屏幕边缘（设计稿单位）
    FLOOR_INSET: 13,          // 地板距离屏幕底部（设计稿单位，另加安全区）
    WALL_THICKNESS: 100,      // 不可见物理墙厚度（设计稿单位）
    FLOOR_THICKNESS: 100,
    SPAWN_OFFSET: 38,         // 落点中心位于 HUD 下沿多少（设计稿单位）

    // ---------- 物理手感 ----------
    GRAVITY: 2.0,             // Matter.Engine.gravity.y
    DROP_COOLDOWN: 480,       // 两次掉落之间的冷却（毫秒）
    COLLISION_SHAPE: 'box',   // 方形碰撞体，视觉与手感都更像正方体卡片
    BOX_CHAMFER_RATIO: 0.12,  // 方盒圆角比例（0~0.5），防止尖角卡墙
    FRUIT_FRICTION: 0.22,
    FRUIT_FRICTION_STATIC: 0.5,
    FRUIT_AIR: 0.004,
    FRUIT_RESTITUTION: 0.1,
    FRUIT_DENSITY: 0.001,
    FRUIT_SLOP: 0.02,

    // ---------- 只随机掉落的等级 ----------
    DROP_LEVELS: [1, 2, 3, 4, 5],
    DROP_WEIGHTS: [30, 25, 20, 15, 10], // 与 DROP_LEVELS 一一对应

    // ---------- 结束判定 ----------
    // 警戒线位于 HUD 下沿再往下 DANGER_LINE 个设计稿单位。
    DANGER_LINE: 116,
    DANGER_HOLD_TIME: 1.5,    // 水果顶部越过警戒线持续多少秒后结束（秒）
    DANGER_GRACE_MS: 850,     // 新生成水果的免判时间，避免“刚掉下时经过警戒线”误判

    // ---------- 12 级对撞 ----------
    TWELVE_SCORE: 10000,      // 12 + 12 一起消失时加分

    // ---------- 特殊多合一配方 ----------
    // 触发逻辑：场上同时存在 inputs 要求的全部水果，并且它们聚成一簇
    // （任意两只的间距 <= avg(radius_a, radius_b) * SPECIAL_DISTANCE_FACTOR），
    // 就消耗这些水果，在几何中心生成 output。
    SPECIAL_DISTANCE_FACTOR: 3.0,
    SPECIAL_RECIPES: [
      {
        id: 'skin',
        name: '我皮肤呢',
        // 当前配方：01 / 02 / 03 各 1 个即可。
        inputs: { '01': 1, '02': 1, '03': 1 },
        output: '004',
        score: 1500,
        unlockAchievement: 'wo_pifu_ne',
        // 单条配方可覆盖全局距离系数（可选）
        distanceFactor: 3.0
      }
    ],

    // ---------- 07 回溯 ----------
    // 场上存在 07 时，在即将因警戒线越线而结束时自动发动一次：
    // 清除 07 + 最多 12 个其他随机水果，回到可继续游戏的状态。
    REWIND: {
      enabled: true,
      level: 7,
      clearCount: 12,
      graceTime: 2.2           // 发动后给剩余水果的免判时间（秒）
    },

    // ---------- 12 级预警 ----------
    LEVEL12_WARNING: {
      title: '跑路预警',
      subtitle: '12 级大物华出现了，还要继续跑吗？',
      continueLabel: '继续玩',
      quitLabel: '跑路了'
    },

    // ---------- 特殊产物 ----------
    SPECIAL_OUTPUT: {
      key: '004',
      id: '004',
      img: 'img/004.jpg',
      radius: 54,
      score: 1500,
      name: '我皮肤呢',
      color: '#6FC6AE',
      ink: '#2F7465',
      mergeInto: 5             // 两个 004 相碰时合成为 05
    },

    // ---------- 09 指定下一颗 ----------
    NINE_POWER: {
      level: 9,
      choices: [1, 2, 3, 4, 5, 6, 7, 8]
    },

    // ---------- 隐藏暗号 / 自由放置 ----------
    SECRET_CHEAT: {
      enabled: true,
      code: '太阳神鸟开外挂',
      // 允许自定义放置的水果：01~11 + 004（明确排除 12）
      levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      specialKey: '004'
    },

    // ---------- 01~05 出场文字 ----------
    ENTRY_SUBTITLE_DURATION: 2400,
    ENTRY_SUBTITLES: {
      1: '我有驾照了，哀家考完驾照了',
      2: '白石散乐就是个外行',
      3: '仙鹤可是会飞的',
      4: '全球气温骤降20度，我在林间建了个小屋',
      5: '台北也要零下50度吗'
    },

    // ---------- 06 / 08 生成字幕 ----------
    SUBTITLE_DURATION: 3400,
    SUBTITLES: {
      6: '大东北是我的家乡——我就在这嘎达土生土长',
      8: '少一天，少一个时辰，少一秒，就不是一辈子的多段队'
    },

    // ---------- 春日影 BGM ----------
    MUSIC: {
      chunriying: 'audio/chunriying.mp3',
      volume: 0.55
    },

    // ---------- 结束画面 ----------
    ENDING: {
      key: '00',
      img: 'img/00.jpg',
      title: '跑路了',
      achievement: 'long_b_zhi_zheng',
      secondAchievement: 'er_ni_wo_de_wan_jia'
    },

    // ---------- 成就定义（持久化数据会补上 unlocked/unlockedAt）----------
    ACHIEVEMENTS: [
      {
        id: 'wo_pifu_ne',
        name: '我皮肤呢',
        desc: '其实玩家也想问这个问题'
      },
      {
        id: 'long_b_zhi_zheng',
        name: '龙B之争',
        desc: '怎么跑路了，哪边是好人'
      },
      {
        id: 'zui_chang_de_he',
        name: '最长的河',
        desc: '回溯是好回溯，怎么把我所有东西清空了'
      },
      {
        id: 'zui_jin_ye_zui_yuan',
        name: '最近也是最远的距离',
        desc: '台北用不上天津的秋裤的，没那么冷'
      },
      {
        id: 'yuan_wang_cheng_zhen',
        name: '愿望成真',
        desc: '愿望杯希望你许下一个轻松的心愿'
      },
      {
        id: 'da_dong_bei',
        name: '大东北是我的家乡',
        desc: '龙王二人转'
      },
      {
        id: 'yi_bei_zi_duo_duan_dui',
        name: '我们要组一辈子的多段队',
        desc: '为什么要演奏春日影'
      },
      {
        id: 'wan_sheng_jie',
        name: '万圣节？是惊喜吗',
        desc: '这个游戏是要跑路了吗？喵。'
      },
      {
        id: 'shi_jing_xi',
        name: '是惊吓',
        desc: '什么叫做你们俩没讨论好。'
      },
      {
        id: 'er_ni_wo_de_wan_jia',
        name: '而你我的玩家，你是真正的英雄',
        desc: '我要玩一辈子物华弥新'
      }
    ],

    // ---------- 存储 ----------
    STORAGE_KEY: 'merge-watermelon-run-v1',

    // ---------- 其它 ----------
    SPRITE_BOX_SCALE: 1.0,    // 只影响绘制盒大小，不影响物理 radius；默认严格贴合 2r
    MAX_FRUITS: 64,           // 极端情况下防止场上物体无限增长
    HINT_TEXT: '拖动瞄准 · 松手落下'
  };

  // 生成 01~12 的等级索引，逻辑层统一用两位字符串 key 查表。
  CONFIG.LEVELS = LEVELS;
  CONFIG.LEVEL_BY_KEY = LEVELS.reduce(function (map, item) {
    map[String(item.level).padStart(2, '0')] = item;
    return map;
  }, {});
  CONFIG.LEVEL_BY_NUMBER = LEVELS.reduce(function (map, item) {
    map[item.level] = item;
    return map;
  }, {});
  CONFIG.SPECIAL_BY_KEY = { '004': CONFIG.SPECIAL_OUTPUT };
  CONFIG.ALL_DROP_KEYS = LEVELS.map(function (item) {
    return String(item.level).padStart(2, '0');
  });
  CONFIG.DROP_KEYS = CONFIG.DROP_LEVELS.map(function (level) {
    return String(level).padStart(2, '0');
  });
  CONFIG.ACHIEVEMENT_BY_ID = CONFIG.ACHIEVEMENTS.reduce(function (map, item) {
    map[item.id] = item;
    return map;
  }, {});

  global.CONFIG = CONFIG;
})(window);
