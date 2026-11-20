# vendor/ffmpeg

ParallelRoom 用到的两个命令行工具，**打包时整包带走**（`electron-builder` 的 `extraResources`），
运行时从 `process.resourcesPath\ffmpeg\` 里找（见 `src/main/recorder.js` 的 `findFfmpeg()`）。

| 文件 | 用途 |
| --- | --- |
| `ffmpeg.exe` | 直录流 `-c copy` 转封装、分段合并、加水印、多窗口拼接、图片片头/文字、合并导出（全部转码都靠它） |
| `ffprobe.exe` | 量时长 / 分辨率 / 帧率 / 有没有音轨（精彩片段、图片水印按画面宽度缩放、合并导出选尺寸都要用） |

来源：**ffmpeg 8.1.1 essentials build**（<https://www.gyan.dev/ffmpeg/builds/>，`ffmpeg-8.1.1-essentials_build`）。

许可证：ffmpeg 本体 LGPL-2.1+；这个 essentials build 里包含 x264 等 GPL 组件，整体按 **GPL** 分发。
如果你要把安装包公开发布，请同时提供 ffmpeg 源码链接（<https://ffmpeg.org/download.html>、<https://www.gyan.dev/ffmpeg/builds/>）
并遵守 GPL 的相应义务；只自己/同事内部用则不必额外处理。

替换成别的版本：把新的 `ffmpeg.exe` / `ffprobe.exe` 覆盖到本目录，然后重新跑 `npm run dist` 即可。
也可以不改包、临时用环境变量指定：`set PR_FFMPEG=D:\tools\ffmpeg\bin\ffmpeg.exe`、`set PR_FFPROBE=...`。
