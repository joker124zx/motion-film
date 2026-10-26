# 技术：怎么把片子渲出来

```
时间线（唯一事实源：镜头、拍、命中点、字幕、音效事件）
  ├─ 画面：网页 renderAt(t) ──► 无头 Chrome 逐帧截图 ──► 帧序列/MP4
  ├─ 配音：TTS 每句 ──► 语音识别回读校验 ──► 词级时间
  ├─ 配乐：同一时间线写谱（采样 + 合成）──► 分轨
  ├─ 拟音：在事件时间程序化合成或放置采样
  └─ 字幕：.srt + 画面内烧录的样式化字幕
混音（ducking、压缩、平衡）──► ffmpeg 混流 + 两遍 loudnorm −14 LUFS ──► 成片
```

## 1. 页面契约（`scripts/render.mjs` 读这些）

```js
window.FILM = { width: 1920, height: 1080, fps: 30, duration: 12.0 };  // 可被命令行覆盖
window.renderAt = async (t) => { /* 画出时刻 t 的完整一帧，确定性 */ };
window.READY = true;            // 字体、图片、着色器都就绪后再置 true
window.EVENTS = [{ t, kind, gain, pan, ... }];   // 可选：音效事件，导出给 sfx.py
window.TEXTS = (t) => [{ id, text, x0, y0, x1, y1 }];  // 可选：当前可见文字，供 --readcheck
window.CUES = [{ t0, t1, text }];  // 可选：字幕，导出成 .srt
```

页面里的 CSS 动画 / Web Animations 也会被渲染器暂停并 seek 到 t，但推荐全部由 `renderAt` 驱动。

## 2. 确定性铁律

- 禁 `Date.now()`、无参 `new Date()`、`performance.now()`、无种子 `Math.random()`、`requestAnimationFrame` 驱动的状态。
- 不跨帧累积状态：物理、粒子用闭式解或预计算。任何帧可单独、乱序、并行渲染（多 worker 就是这么干的）。
- 随机：`motion.js` 的 `mulberry32(seed)` 和 `hash(i)`，种子从元素 index/id 派生。
- 不用状态触发的 CSS transition（hover、class 切换引发的过渡）。
- 用 GSAP 等时间线库可以：建好时间线后 `tl.pause(); renderAt = t => tl.seek(t)`。

## 3. 选择渲染路线

| 路线 | 适合 | 备注 |
|---|---|---|
| DOM + SVG + CSS | 排版、花字、UI、扁平矢量、产品页面相机 | 最快出效果；`backdrop-filter`、`zoom`、3D transform 都能用 |
| Canvas 2D | 手绘笔刷、粒子、像素风、大量元素 | 自写笔刷或 p5.js；像素风内部低分辨率再最近邻放大 |
| WebGL2 / 着色器 | 液态、极光、VHS/CRT 后期、metaball、SDF | 后期效果放这一层 |
| Three.js | 等轴、3D 产品、立体书、积木 | 2x 渲染后缩小；HDRI 低强度 + 面光源比强环境光更“真”；后期景深按相机类型选深度函数 |
| Blender（bpy 脚本） | 真实材质、焦散、软体、布料 | 渲 PNG 序列，文字和颗粒再用网页叠一层 |
| Remotion（React） | 已有 React 产品、团队习惯 Remotion | 原则全部通用；`npx remotion still` 做静帧自检；公司使用可能需要付费授权；AAC 输出偏移要实测 |

## 4. 画面质量

- **运动模糊**：`render.mjs --mb 4 --shutter 0.5` 在每帧内取 4 个子时刻平均（快门 180°）。快动作、甩镜、飞入时开；像素风、一拍二手绘、包豪斯这类“硬”风格不开。
- **一拍二**：风格需要时（定格、像素、手绘）把**元素**的 t 量化到 12 fps 网格，相机和光保持每帧平滑——阶梯式相机读作卡顿。
- **颗粒在 ffmpeg 里加**（`master.sh --grain N`），不在页面里画：页面颗粒让每帧不可压缩，渲染也慢。
- **渐变色带**：加 3–5% 噪点或抖动。
- **细线闪烁**：线宽 ≥ 1.5 px，或 2x 渲染后缩小（`--scale 2` 再编码时缩回）。
- **文字放大发糊**：见 aesthetic-rules Q2（CSS `zoom` + 高倍纹理）。
- **截图用 JPEG 中间帧**（质量 95）比 PNG 快很多；最终交付前最后一遍可以用 PNG。
- 竖屏：`--w 1080 --h 1920`；页面布局从 `innerWidth/innerHeight` 算，不写死 1920。

## 5. 字体

- 只用可商用的开源字体（OFL 等），下载到项目 `fonts/`，`@font-face` 本地加载，渲染时不连外网。
- 中文字体按实际用字子集化：Google Fonts CSS API 带 `&text=<URL 编码的字>` 只返回这些字形；或用 `pyftsubset`。改了文案要重新子集化，否则出豆腐块。
- 渲染前 `await document.fonts.ready`，再置 `READY = true`。

## 6. 性能

- 每帧 ≤ 1.5 s 为宜；渲染日志打印 ms/frame。大量 `fill`/笔触、全屏 blur、超大 backdrop-filter 最贵。
- `--workers N` 并行（每个 worker 一个浏览器页）；帧序列模式可断点续渲。
- 无 GPU 时 WebGL 走软件渲染（`--soft-gl`），慢但能跑；水彩类 GPU 填充在集成显卡上很慢，可让风格换一种填充。
- Linux 无头环境 Chrome 通常需要 `--no-sandbox`（渲染器默认加，仅在本地渲染自己的页面时使用）。

## 7. 项目结构（建议）

```
<name>/
  index.html          # renderAt(t)
  timeline.js         # 唯一事实源：SHOTS、BPM、命中点、字幕、音效事件
  scenes/*.js         # 每个镜头一个 fn(t, lt, dur)
  assets/  fonts/
  mix.py              # 读 events.json → mix.wav
  build.sh            # 一条命令出片
  TREATMENT.md  CREDITS.md
  out/                # 渲染产物（qa/ 存每版自检图）
```

`build.sh`：直接用 `templates/starter/build.sh`（检查阅读时间 → 导出事件与字幕 → 多 worker 渲染 → 合成音效/混音乐 → 母带与规格报告 → 海报帧）。`MF` 指向本 skill 目录。

常用命令：

```sh
node $MF/scripts/render.mjs <项目> --stills 1.5,3.2          # 关键时刻静帧
node $MF/scripts/render.mjs <项目> --sheet 0:12:0.5           # 接触印样
node $MF/scripts/render.mjs <项目> --strip 2.1:2.6            # 一个动作的每一帧
node $MF/scripts/render.mjs <项目> --sheet 2.3,2.4 --crop 760,420,500,400 --cellw 500   # 裁剪放大
node $MF/scripts/render.mjs <项目> --w 1080 --h 1920 ...      # 竖屏
node $MF/scripts/render.mjs <项目> --from 4 --to 6 --out out/part.mp4   # 只渲一段
```

实测：本 skill 的示范工程 288 帧 1080p、2 样本运动模糊、3 个 worker 约 70 s；不同 worker 分配下逐帧字节完全一致（确定性）。

## 8. 角色 rig 小贴士

- 2.5D rig（躯干、头、四肢逐帧解算）足够做哑剧。
- 肩部旋转顺序：先外展后屈曲；反过来抬起的手臂会交叉成 X。
- 手臂抬起时肩带随之上提前移；不要给与躯干重叠的那段手臂描边——那条线让关节像木偶接缝。
- 转身用画好的关键视图（正 → 3/4 → 侧 → 背 3/4 → 背）切换，不要对平面角色做 3D 投影。
