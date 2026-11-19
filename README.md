# 合成大物华 · 跑路了

移动端优先的「合成大物华」类小游戏。纯静态页面，**双击 `index.html` 就能玩**，不需要 npm、不需要构建工具。

当前素材来自你提供的 14 张角色图 + 1 张 `bj.jpg` 背景图，均已按字节原样复制到 `img/`。玩法包含：

- 方形（带小圆角）碰撞体，视觉上更像正方体卡片；
- `01 + 02 + 03` 各 1 个 → `004` 的特殊配方，`004 + 004 → 05`；
- 场上存在 07 时的一次「回溯」保命，优先清除 004；
- 合成出 12 级时的灰屏「跑路预警」，由玩家选择继续或结束；
- 09 在场时，可从 01~08 指定下一颗要发送的水果；
- 06 / 08 生成时的电影字幕，01~05 放置入场时的出场文字；
- 08 合成时播放《春日影》；
- 成就页输入神秘暗号「太阳神鸟开外挂」后，可自由放置 01~11 与 004（不含 12）；
- 10 个成就，包括 04+05、06、08、09、11、12 的场上判定与第二次跑路结局；
- `bj.jpg` 全屏背景与冷灰/青绿色 UI；
- 手机同 Wi-Fi 链接、临时公网链接、复制链接按钮。

---

## 1. 快速开始

1. 双击 `index.html`。
2. Matter.js 已固定为本地 `vendor/matter.min.js`（与 CDN 同版本 0.20.0），**不再需要等网络**，断网也能立即启动。
3. 手机同 Wi-Fi 游玩：双击 `start-mobile.cmd`，或运行：

```powershell
powershell -ExecutionPolicy Bypass -File tools/start-mobile.ps1
```

脚本会打印：

```text
电脑：http://localhost:8081/
手机：http://<电脑局域网IP>:8081/
```

手机与电脑连接同一个 Wi-Fi，用手机浏览器打开「手机」那一行即可。Windows 防火墙弹窗时请允许 Python 访问。

> 也可以把整个目录部署到任意静态网站；游戏内成就面板底部有「复制游戏链接」按钮。
>
> 公网链接：本轮通过 Cloudflare Quick Tunnel 提供临时公网地址（见交付消息）。该地址依赖本机后台进程，电脑重启或会话结束后会失效；需要长期公网地址时请部署到静态托管，或使用带账号的命名隧道。
>
> 浏览器限制 `file://` 的 localStorage 时，游戏仍能玩，只是最高分/成就会退化为本次打开内有效；用静态服务器打开即可正常持久化。

---

## 2. 文件结构

```text
watermelon-game/
├─ index.html                 # 页面结构（本地 Matter.js + config + game 静态加载）
├─ start-mobile.cmd           # 双击启动手机同 Wi-Fi 访问
├─ css/
│  └─ style.css               # bj 背景、冷灰/青绿 UI、HUD、安全区、各层
├─ js/
│  ├─ config.js               # LEVELS / 特殊配方 / 回溯 / 09 / 字幕 / 暗号 / 成就
│  └─ game.js                 # 方形物理、Canvas、合成、自选、回溯、结束、10 个成就
├─ vendor/
│  └─ matter.min.js           # Matter.js 0.20.0，本地加载
├─ audio/
│  ├─ chunriying.mp3          # 春日影（用户原文件，字节复制）
│  └─ README.txt
├─ img/
│  ├─ bj.jpg                  # 全屏背景
│  ├─ 00.jpg                  # 结束“跑路”图（实际使用你的原图）
│  ├─ 01.jpg ~ 12.jpg         # 12 级水果
│  ├─ 004.jpg                 # 特殊产物
│  └─ README.txt              # 图片替换说明
├─ tools/
│  ├─ image-hash.ps1          # 15 张图片的哈希快照/校验，只读
│  └─ start-mobile.ps1        # 局域网 HTTP 服务
├─ .gitignore
└─ README.md
```

拆成 `config.js / game.js / style.css` 而不是单文件：

- 数值、图片路径、配方都集中在 `config.js`；
- 物理/状态/渲染集中在 `game.js`；
- 视觉样式集中在 `style.css`；
- 无打包、无模块加载器，双击即运行，也方便后续换图。

---

## 3. 为什么选 Canvas 2D

- 场上同时有几十个水果，每帧有位置、旋转、合成粒子、震屏。Canvas 一次 `drawImage` 比 DOM 节点变换更轻。
- 高 DPI 只需把 canvas backing store 放大 `devicePixelRatio` 倍，再 `ctx.scale(dpr, dpr)`，所有坐标仍用 CSS 像素。
- 水果图片和物理尺寸严格解耦：物理使用 `CONFIG.LEVELS[*].radius` 作为方形碰撞体半边长，渲染把整张图等比放进 `2r` 方形盒子。
- 方形碰撞体带小圆角，卡片旋转/堆叠时更像正方体；半径仍完全由 CONFIG 决定。
- 结束“全场统一换 00 图”只需把 `renderKey` 改成 `00`，位置/角度/尺寸/缩放完全不动。

关键绘制代码在 [game.js:2827](watermelon-game/js/game.js#L2827)：整张原图等比 contain 到固定盒子，`scaleX === scaleY`，不裁剪、不拉伸。方形碰撞体创建在 [game.js:1743](watermelon-game/js/game.js#L1743)。

---

## 4. 当前数值与玩法

### 4.1 基础配置

完整配置见 [config.js](watermelon-game/js/config.js#L16)。

| 配置 | 当前值 |
|---|---|
| `DESIGN_WIDTH` | `390`，屏幕实际宽度 / 390 = k |
| `GRAVITY` | `2.0` |
| `DROP_COOLDOWN` | `480ms` |
| `COLLISION_SHAPE` | `box`，方形碰撞体 |
| `BOX_CHAMFER_RATIO` | `0.12`，方盒小圆角 |
| `DANGER_LINE` | `116` 设计稿单位（HUD 下沿以下） |
| `DANGER_HOLD_TIME` | `1.5s` |
| `DANGER_GRACE_MS` | `850ms` |
| `DROP_LEVELS` | `[1,2,3,4,5]` |
| `TWELVE_SCORE` | `10000` |
| `NINE_POWER` | 09 在场时可选 01~08 作为当前待发送水果 |
| `SUBTITLE_DURATION` | `3400ms` |
| `SUBTITLES` | 06 / 08 生成字幕 |

### 4.2 特殊配方

```js
SPECIAL_RECIPES: [
  {
    id: 'skin',
    name: '我皮肤呢',
    inputs: { '01': 1, '02': 1, '03': 1 },
    output: '004',
    score: 1500,
    unlockAchievement: 'wo_pifu_ne',
    distanceFactor: 3.0
  }
]
```

规则：场上同时存在 01、02、03 各 1 个，并且聚成一簇（所有被消耗水果到几何中心的距离不超过 `平均半径 × distanceFactor`），就消耗它们，在几何中心生成 `004`，播放特效并解锁「我皮肤呢」。

`004` 不是终点：两个 `004` 相碰会继续合成为 **05**，并加 05 的分数。

### 4.3 07 回溯

配置在 [config.js](watermelon-game/js/config.js#L89)：

```js
REWIND: {
  enabled: true,
  level: 7,
  clearCount: 12,
  graceTime: 2.2
}
```

规则：

- 场上只要有 07，左上角显示「07 回溯就绪」；
- 当危险线判定即将让本局结束时，如果 07 还在场且本局未用过回溯，会自动发动；
- 发动后清除场上**全部 07**，**优先清除全部 004**，剩余名额再随机清除其他水果，最多补足 12 个；
- 给剩余水果 2.2 秒免判时间，游戏继续；
- 单局最多触发一次；重开新局后恢复；
- 如果玩家是在 12 级预警里主动选择「跑路了」，属于主动结束，不触发回溯。

实现位置：[game.js:2461](watermelon-game/js/game.js#L2461)。

### 4.4 12 级灰屏预警

当两个 11 级合成为 12 级时：

- 物理立即暂停；
- 屏幕变灰，弹出「跑路预警」四个大字；
- 玩家选择「继续玩」：解除暂停，继续本局；
- 玩家选择「跑路了」：进入结束流程，全场换 `00.jpg`，弹出「跑路了」与重开按钮。

每次新合成 12 级都会触发预警，不是只触发一次。

实现位置：[game.js:2414](watermelon-game/js/game.js#L2414)。

### 4.5 09 指定下一颗

只要场上存在 09，HUD 下方右侧会出现「09 · 自选下一颗」入口。

- 打开后可从 **01~08** 中任选一项；
- 选择结果替换**当前待发送**的水果，幽灵落点会立刻切换；
- 不消耗 09；09 离场后入口自动消失；
- 选择面板打开期间物理暂停，关闭/选中后继续。

配置在 `CONFIG.NINE_POWER`，实现见 [game.js:976](watermelon-game/js/game.js#L976) 与 [game.js:1010](watermelon-game/js/game.js#L1010)。

### 4.6 06 / 08 字幕

- 06 生成：`大东北是我的家乡——我就在这嘎达土生土长`
- 08 生成：`少一天，少一个时辰，少一秒，就不是一辈子的多段队`

字幕在屏幕下方淡入淡出，多条时按队列依次播放，不阻塞操作。配置在 `CONFIG.SUBTITLES` 与 `CONFIG.SUBTITLE_DURATION`。

### 4.7 bj 背景、冷灰/青绿 UI 与手机链接

- 背景直接引用 `img/bj.jpg`，通过 `object-fit: cover` 等比铺满；不拉伸，只会在比例不一致时居中裁切少量边缘。
- UI 主色从原来的暖橙/珊瑚改为取色自 bj 的冷灰、银白、青绿：白玻璃 HUD、墨绿标题、青绿主按钮、灰银预警卡片。
- 成就面板底部可「复制游戏链接」；手机同 Wi-Fi 用 `start-mobile.cmd` 启动后打开脚本打印的地址。
- 游戏名已改为 **合成大物华**。

### 4.8 神秘暗号与自由放置

在成就页输入暗号：

```text
太阳神鸟开外挂
```

解锁后会显示 **01~11 + 004** 的自由放置网格（明确不含 12）。点选任一水果后：

1. 成就页关闭，底部出现「自由放置 08 · 点击场上任意位置」状态条；
2. 点击/拖动后松手，水果会出现在点击位置；
3. 模式保持开启，可以连续放置；点「退出」恢复普通玩法；
4. 解锁状态写入 localStorage，刷新后仍保留。

实现见 [config.js:124](watermelon-game/js/config.js#L124) 的 `SECRET_CHEAT` 与 [game.js](watermelon-game/js/game.js) 中的暗号/放置逻辑。

### 4.9 01~05 出场文字

从顶部放置（或自由放置）01~05 时，会显示：

| 等级 | 出场文字 |
|---|---|
| 01 | 我有驾照了，哀家考完驾照了 |
| 02 | 白石散乐就是个外行 |
| 03 | 仙鹤可是会飞的 |
| 04 | 全球气温骤降20度，我在林间建了个小屋 |
| 05 | 台北也要零下50度吗 |

这些短字幕会快速覆盖前一条，避免连续掉落时排队堆积；06/08 的电影字幕仍按队列播放。

### 4.10 春日影

合成出 08 时，播放用户提供的：

```text
audio/chunriying.mp3
```

文件从 `新建文件夹 (2)\CRYCHIC - 春日影.mp3` 按字节复制，未转码。首次触屏后会开始预加载，08 合成时从头播放；游戏结束/重开会停止。音效开关会同时控制 SFX 与 BGM。配置在 [config.js:150](watermelon-game/js/config.js#L150)。

首次自动播放若被移动端浏览器拦截，下一次触屏会自动重试。

---

## 5. 结束流程

普通危险线结束（没有可发动回溯）时：

1. 任一水果顶部越过警戒线持续 `1.5s`；
2. 冻结物理；
3. 场上所有水果的 `renderKey` 切换为 `00`，不改变半径/位置/角度；
4. 屏幕中央弹出「跑路了」；
5. 显示「再来一局」；
6. 首次结束时解锁「龙B之争」。

如果场上有 07 且回溯未使用，第 1 步之后会先进入回溯分支，而不是结束。

如果玩家在 12 级预警选择「跑路了」，直接进入第 2~6 步，不触发回溯。

---

## 6. 成就

| id | 名称 | 条件 |
|---|---|---|
| `wo_pifu_ne` | 我皮肤呢 | 触发 skin 特殊配方（01 + 02 + 03 各 1 个） |
| `long_b_zhi_zheng` | 龙B之争 | 第一次触发游戏结束 |
| `zui_chang_de_he` | 最长的河 | 首次合成出 07 级水果 |
| `zui_jin_ye_zui_yuan` | 最近也是最远的距离 | 场上同时存在 04 和 05 |
| `yuan_wang_cheng_zhen` | 愿望成真 | 场上出现 09 |
| `da_dong_bei` | 大东北是我的家乡 | 场上出现 06 |
| `yi_bei_zi_duo_duan_dui` | 我们要组一辈子的多段队 | 场上出现 08 |
| `wan_sheng_jie` | 万圣节？是惊喜吗 | 场上出现 11 |
| `shi_jing_xi` | 是惊吓 | 场上出现 12 |
| `er_ni_wo_de_wan_jia` | 而你我的玩家，你是真正的英雄 | 第一次跑路结局解锁后再完成一次跑路结局 |

“场上存在”类成就由每个物理步结束后的场上等级扫描触发；成就只解锁一次，Toast 会按队列依次播放。

成就注释（面板/Toast 中显示）：

- 我皮肤呢：其实玩家也想问这个问题
- 龙B之争：怎么跑路了，哪边是好人
- 最长的河：回溯是好回溯，怎么把我所有东西清空了
- 最近也是最远的距离：台北用不上天津的秋裤的，没那么冷
- 愿望成真：愿望杯希望你许下一个轻松的心愿
- 大东北是我的家乡：龙王二人转
- 我们要组一辈子的多段队：为什么要演奏春日影
- 万圣节？是惊喜吗：这个游戏是要跑路了吗？喵。
- 是惊吓：什么叫做你们俩没讨论好。
- 而你我的玩家，你是真正的英雄：我要玩一辈子物华弥新

存档 key：`merge-watermelon-run-v1`，结构：

```json
{
  "version": 1,
  "bestScore": 1500,
  "gamesPlayed": 3,
  "soundOn": true,
  "achievements": {
    "wo_pifu_ne": { "unlocked": true, "unlockedAt": "2026-11-18T10:15:04.778Z" }
  }
}
```

重开一局只清当前棋盘，不清成就；成就每个只解锁一次。最高分、场次、声音偏好和成就都会持久化。当前未完成棋盘不持久化。

---

## 7. 图片：当前已接入的实际素材

你放在 `C:\Users\Administrator\Desktop\新建文件夹 (2)` 的 14 张角色 JPG，加上背景 `bj.jpg`，共 15 张，已按**字节原样**复制到 `img/`：

| 原文件 | 游戏内路径 |
|---|---|
| `bj.jpg` | `img/bj.jpg` |
| `00.jpg` | `img/00.jpg` |
| `01 (2).jpg` | `img/01.jpg` |
| `02 (2).jpg` | `img/02.jpg` |
| `03 (2).jpg` | `img/03.jpg` |
| `04.jpg` ~ `12.jpg` | `img/04.jpg` ~ `img/12.jpg` |
| `004.jpg` | `img/004.jpg` |

没有转成 PNG，也没有压缩、裁剪、重采样或转码，因此不会改变原图像素。  
背景图通过 `object-fit: cover` 等比铺满屏幕；比例不一致时会居中裁切边缘，但绝不会横向/纵向拉伸。

> 原始角色图约 200~233 像素见方。高 DPR 手机上，12 级水果最大会绘制到约 210 CSS 像素 × 3 DPR，源图分辨率相对有限，浏览器放大时会有一定柔化；这是源图分辨率决定的上限，代码没有做任何图像处理。换更高分辨率同名 JPG 即可改善，无需改代码。

如果要再次替换图片：

- 直接覆盖 `img/` 下的同名 `.jpg`；
- 如果换成 `.png`，需要同步修改 [config.js](watermelon-game/js/config.js#L16) 和 [image-hash.ps1](watermelon-game/tools/image-hash.ps1) 中的扩展名；
- 建议使用正方形、透明背景、内容贴边的图；
- 非正方形也能正常显示，只是会等比 contain 留白。

音频文件：

```text
audio/chunriying.mp3
来源：新建文件夹 (2)\CRYCHIC - 春日影.mp3
SHA256：22E111726BDC9C8C088DDE5147F08295A09B07084EDBE5632276212CDBCFD38E
```

按字节原样复制，未转码；替换时直接覆盖同名文件即可。

---

## 8. 验证「像素未被改变」与「不变形」

### 8.1 文件级校验

```powershell
# 1) 生成基线
powershell -ExecutionPolicy Bypass -File tools/image-hash.ps1 -Save

# 2) 打开游戏、玩几局、触发结束、刷新

# 3) 校验
powershell -ExecutionPolicy Bypass -File tools/image-hash.ps1 -Verify
```

脚本只读图片，比较 15 张图的 SHA256 与字节数；全部一致输出 `PASS`。  
工具在 [image-hash.ps1](watermelon-game/tools/image-hash.ps1)。

### 8.2 渲染级校验

打开：

```text
index.html?debug=1
```

Console 执行：

```js
WatermelonGame.inspectAssets()
WatermelonGame.getState()
```

检查：

- 所有水果 `fit.uniform === true`；
- `fit.drawWidth / naturalWidth === fit.drawHeight / naturalHeight`；
- 换不同分辨率图后，`targetBoxPx` 不变；
- `WatermelonGame.getState().fruits[i].shape === 'box'`，`collisionWidth` 与 `collisionHeight` 接近 2 × radius；
- `WatermelonGame.getState().fruits[i].radius` 始终等于 `CONFIG 半径 × (innerWidth / 390)`；
- 背景：`document.querySelector('.backdrop__image')` 的 `naturalWidth/naturalHeight` 为原始尺寸，CSS `object-fit` 为 `cover`。

### 8.3 结束贴图校验

```js
WatermelonGame.debug.spawn('05', 0.4, 0.7);
WatermelonGame.debug.spawn('07', 0.6, 0.7);
WatermelonGame.debug.gameOver();

WatermelonGame.getState().fruits.every(f => f.renderKey === '00') // true
```

---

## 9. 调试接口（仅 `?debug=1`）

| 方法 | 作用 |
|---|---|
| `WatermelonGame.inspectAssets()` | 原图尺寸、绘制盒、缩放比例、是否等比 |
| `WatermelonGame.getState()` | 分数、水果、警告/回溯状态 |
| `WatermelonGame.debug.spawn(key, xRatio, yRatio)` | 在屏幕比例坐标生成水果 |
| `WatermelonGame.debug.spawnRecipeCluster()` | 生成一簇 01 + 02 + 03，测试特殊合成 |
| `WatermelonGame.debug.mergePair(level)` | 生成两个同级水果触发合成；`11` 可测 12 级预警 |
| `WatermelonGame.debug.rewindSetup()` | 生成 07 + 一批水果，测试回溯 |
| `WatermelonGame.debug.dangerTest()` | 固定一个 12 级水果在警戒线上方，测试自然结束 |
| `WatermelonGame.debug.openPicker()` | 打开 09 的 01~08 自选面板 |
| `WatermelonGame.debug.chooseNext(key)` | 直接指定当前待发送水果，如 `'08'` |
| `WatermelonGame.debug.setCurrent(key)` | 强制设置当前水果，便于测试 01~05 出场文字 |
| `WatermelonGame.debug.musicInfo()` | 查看春日影音频的播放/加载状态 |
| `WatermelonGame.debug.continueWarning()` | 12 级预警选「继续玩」 |
| `WatermelonGame.debug.quitWarning()` | 12 级预警选「跑路了」 |
| `WatermelonGame.debug.gameOver()` | 直接触发结束（跳过回溯） |
| `WatermelonGame.debug.dropAt(xRatio)` | 指定横向比例掉落 |
| `WatermelonGame.debug.restart()` | 重开一局 |

正常入口 `index.html` 不暴露 `debug` 对象。

---

## 10. 音效说明

目前是 WebAudio 合成音：掉落、自选、升级、特殊合成、12 级预警、回溯、成就、结束各有独立音色。  
合成出 08 时会播放用户提供的 `audio/chunriying.mp3`，音效开关同时控制 SFX 与 BGM。`game.js` 里的 `Sound` 对象是音效占位层，可以整体替换为真实音频文件播放。

---

## 11. 验收清单

- [ ] 双击 `index.html` 立即启动，不依赖 CDN；断网也正常。
- [ ] 页面标题、启动页名称均为「合成大物华」。
- [ ] 背景显示 `img/bj.jpg`，UI 为冷灰/银白/青绿配色，没有旧暖橙色块。
- [ ] 所有水果碰撞体为方形（带小圆角），卡片旋转/堆叠明显更像正方体。
- [ ] 页面显示 `img/` 里的实际 JPG 头像，而不是占位图。
- [ ] 390×844、320×568 竖屏下 HUD 不溢出；安全区正常；不能滚动/缩放。
- [ ] 按住拖动落点、松手掉落；冷却生效；点击也能落。
- [ ] 只随机出现 01~05。
- [ ] 同级碰撞升级；07 首次合成解锁「最长的河」。
- [ ] 12 + 12 消失并 +10000，不生成 13 级。
- [ ] 01 + 02 + 03 各 1 个聚成一团 → 生成 004 + 特效 + 成就。
- [ ] 两个 004 相碰 → 合成为 05，004 消失。
- [ ] 合成 11+11=12 时灰屏、出现「跑路预警」，物理暂停。
- [ ] 预警选择「继续玩」恢复游戏；选择「跑路了」进入结束。
- [ ] 场上有 07 时显示「07 回溯就绪」。
- [ ] 危险线即将结束时，07 回溯自动清除 07 + 优先全部 004 + 最多补足 12 个其他随机水果，游戏继续。
- [ ] 回溯单局只触发一次；新开一局后可再次拥有。
- [ ] 场上有 09 时出现「09 自选下一颗」，可指定 01~08，选择后幽灵立即切换。
- [ ] 06 生成时出现字幕「大东北是我的家乡——我就在这嘎达土生土长」。
- [ ] 08 生成时出现字幕「少一天，少一个时辰，少一秒，就不是一辈子的多段队」，并播放 `audio/chunriying.mp3`。
- [ ] 01~05 从顶部放置时分别显示各自的出场文字。
- [ ] 成就页输入「太阳神鸟开外挂」后，出现 01~11 + 004 的自由放置网格，不含 12。
- [ ] 点选水果后可点击场上任意位置连续放置；退出按钮恢复普通模式；刷新后解锁仍在。
- [ ] 十个成就都能触发：04+05、06、08、09、11、12 的在场成就 + 原有三个 + 第二次跑路结局；注释文案与第 6 节一致。
- [ ] 第一次跑路结局解锁「龙B之争」，第二次跑路结局解锁「而你我的玩家，你是真正的英雄」。
- [ ] 成就面板显示 `x / 10`，可滚动查看，并显示本次更新的成就注释。
- [ ] 成就面板底部「复制游戏链接」有成功提示。
- [ ] 双击 `start-mobile.cmd` 后，手机与电脑同 Wi-Fi 可以打开脚本打印的链接。
- [ ] 当前会话提供的临时公网链接可从非局域网网络打开。
- [ ] 普通结束/主动结束：全场切换 00.jpg，弹出「跑路了」，重开按钮出现。
- [ ] 成就、最高分、声音偏好在刷新/重开后保留。
- [ ] 替换不同分辨率图片后 `inspectAssets()` 全部 `uniform: true`，物理半径不变。
- [ ] `image-hash.ps1` 对 15 张图 Save → 游戏 → Verify 全部 PASS。
- [ ] `audio/chunriying.mp3` SHA256 与用户原文件一致。
- [ ] iOS Safari / Android Chrome 无双击缩放、无页面滚动，拖动跟手。
