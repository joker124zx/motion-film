# motion-film

**用代码做动态影像的 Claude Code 技能包。** 产品宣传片、MG / 风格短片、综艺花字、卡点片、单个动效镜头——画面、动画、字幕、音效全部由代码生成，逐帧确定性渲染成 MP4，不用视频生成模型。

<p align="center"><img src="docs/demo.gif" width="640" alt="示范工程渲出的 9.6 秒样片"></p>
<p align="center"><sub>上图：技能包自带的示范工程，一条命令渲出（<a href="docs/demo.mp4">带声音的 MP4</a>）</sub></p>

## 它教 agent 什么

| 部分 | 内容 |
|---|---|
| 导演 | treatment 模板、三候选结构、标杆“学什么/不拿什么”、运镜语法、转场、表演与动画原则 |
| 节奏 | 按观众要读懂的信息点（reads）计时；字幕/文字/字标的最低停留时间公式 |
| 审美准则 | 来自真实返工的判例式规则：单主角开场、光效不群发、整画面冲击 ≤ 3 处、文字最低字高…… |
| 产品宣传片 | 品牌 → 动效参数表、全片骨架、真实页面截图三件套、2.5D 页面相机、约 30 个镜头配方 |
| 风格 | 15 种风格的可执行卡片（含综艺花字层结构与参数）+ 约 60 种风格索引 + 写/改风格的方法 |
| 声音 | 三层声音、片种对应的音效词汇、防机枪感、配乐/配音/混音/母带 |
| 卡点 | BGM 节拍网格拟合、倍数误判纠正、拍号时间线、渲后回测 |
| 评审 | 自检清单 + 可直接用的独立评审提示词与评分表 |

## 工具

| 文件 | 作用 |
|---|---|
| `scripts/render.mjs` | 页面暴露 `renderAt(t)` → 静帧 / 接触印样 / 动作条 / 裁剪 / MP4；多 worker、运动模糊、竖屏、阅读时间检查 |
| `scripts/motion.js` | 页面内的纯函数：种子随机、CSS 等价 cubic-bezier、关键帧、弹簧、过冲 pop、挤压、加速错峰、拍网格、2D 相机 |
| `scripts/sfx.py` | 15 种程序化音效 + 事件混音（可混 BGM、人声下压），零授权问题 |
| `scripts/master.sh` | 混流、两遍 loudnorm 到 −14 LUFS / −1 dBTP、颗粒、规格与黑帧报告 |
| `scripts/beat_grid.py` | 节拍网格拟合 + kick/snare/hihat 分类 + 能量结构 |
| `scripts/capture.mjs` | 产品页面 2x 全页截图、元素切图（透明 / 4x）、空底板、`layout.json` |
| `templates/starter/` | 可直接运行的示范工程，`build.sh` 一条命令出片 |

## 安装

**作为插件（推荐）**

```sh
claude plugin marketplace add lichigo281-spec/motion-film
claude plugin install motion-film@motion-film
```

**或者直接复制技能文件夹**：把 `plugins/motion-film/skills/motion-film/` 复制到 `~/.claude/skills/`（或项目的 `.claude/skills/`）。

然后直接说，例如：

> 用综艺花字风格做一支 10 秒竖屏片子，讲我家猫抢沙发。

> 把我这个项目（localhost:3000）做成 45 秒产品宣传片，配这首 BGM 卡点。

## 运行需要

- Node 18+、ffmpeg、Chrome 或 Chromium（自动查找，或设 `CHROME_PATH`）；项目里 `npm i puppeteer-core`
- Python 3 + numpy、scipy（音效）；卡点分析另需 librosa（装进项目自己的 venv）
- 实测：1080p 30 fps 示范片 288 帧、2 样本运动模糊、3 个 worker 约 70 秒；不同 worker 分配下逐帧字节完全一致

## 原则

- 不带素材库，不自动联网拉代码执行，不自动更新；需要下载素材时先告知来源与授权，并写进 `CREDITS.md`。
- 交付物只有片子、字幕、treatment、授权清单和可复现的源码——不附任何推广或署名请求。
- 若使用 Remotion 渲染，注意它对公司用户可能需要付费授权。

## 致谢

方法论借鉴自四个开源项目，见 [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md)。

## License

[MIT](LICENSE)
