# 来源与许可

Music Marbles Studio 的通用音频分析、琴片与导轨编排、场景、渲染流程及原创示例采用 [GPL-3.0-or-later](LICENSE)。

| 组件 | 用途 | 上游许可 |
| --- | --- | --- |
| [Three.js](https://github.com/mrdoob/three.js) | 三维场景、材质和后处理 | MIT |
| [Playwright Core](https://github.com/microsoft/playwright) | 驱动本机浏览器逐帧渲染 | Apache-2.0 |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) / [FFmpeg](https://ffmpeg.org/legal.html) | 媒体解码、编码与封装 | npm 包为 GPL-3.0-or-later；安装所得二进制的许可见随附文件 |
| [aubio](https://aubio.org/) | 音高与节拍估计 | GPL-3.0-or-later |
| [NumPy](https://numpy.org/doc/stable/license.html) | 频谱分析和示例音频合成 | BSD-3-Clause |
| [Lucide](https://lucide.dev/license) | 界面图标 | ISC，源自 Feather 的图标另含 MIT 许可 |
| [Vite](https://github.com/vitejs/vite) | 开发服务器与前端构建 | MIT |

先确定音乐落点，再反推踏板的编排思路参考 Andrii Borziak 的 [MusicMarbles](https://github.com/AndrewB330/MusicMarbles)，上游采用 MIT 许可。本项目的音频分析、三维场景和导出器独立实现。

《夜航》由 [项目合成脚本](scripts/make-test-song.py) 生成，钢琴式音色、鼓点和铺底音均由波形合成。仓库中的 WAV、动图和有声短片均来自这一原创示例。使用者自行导入的音乐和歌词，其权利归各自权利人。
