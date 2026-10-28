# 第一次使用 H3Mise

## 启动

1. 把项目完整下载并解压到一个可以写入的文件夹。不要直接在压缩包里运行。
2. 安装 [Node.js](https://nodejs.org/) **22.13 或更新版本**，保留安装程序默认的 npm 和 PATH 选项。安装后重新打开启动文件；不需要安装 Git、Python、全局 pnpm 或以管理员身份启动。
3. 按系统选择入口：

| 系统 | 打开方式 |
| --- | --- |
| Windows | 双击根目录的 **`start.bat`** |
| macOS | 打开 **`start.command`**；如果解压后丢失执行权限，在该文件夹的终端运行 `chmod +x start.command` 后再双击，也可以直接运行 `sh start.sh` |
| Linux | 在该文件夹的终端运行 **`sh start.sh`**；支持运行脚本的文件管理器也可在赋予执行权限后打开 |

首次会联网下载项目指定版本的 pnpm 和依赖、准备网页。后续无更新时直接启动；更新代码后会自动重新准备所需部分。无需手动执行 install 或 build，也不用复制 `.env`。

成功后浏览器自动打开。**使用期间保持启动窗口打开**，按 **Ctrl+C** 停止服务；仅关闭网页不会停止服务。再次启动会打开已运行的 H3Mise，不会重复启动。

项目默认保存在当前用户目录的 `.h3mise`，重启不会丢失。已有 `H3MISE_HOME`、端口、Key 和项目 Provider 配置会继续使用。

## 没有 Key 也能先试

未配置 RunningHub Key 或本地 ComfyUI 时，启动后会显示新手入门页：

- **免费体验**：打开「项目与示例」，安装内置示例。示例默认使用 Mock，演示生成无需 Key；浏览故事、素材和手工设计镜头也不需要 AI Key。
- **真实视频生成**：需要自己账号的 RunningHub Key 和视频 AI App ID。先在 **设置 → RunningHub** 选择中国大陆或 Global 站点，再填写同一站点的 Key 与 App ID，保存并检测节点。Key 只在本机设置页输入，不要发到聊天、截图或提交到仓库。
- **本地 ComfyUI**：可按 [ComfyUI 接入指南](ComfyUI.md) 接入自己的本地工作流。
- **AI 辅助创作（可选）**：与渲染 Key 是两套配置。设置页提供兼容模型和外部 AI 助手的接入说明；不配置也能手工创作。

设置页随时可以重新打开「新手入门」。保存 Key、检测节点和启动程序均不会自动发起新的付费渲染；真实生成仍需 Preflight 和费用确认。重启时会照常恢复已有任务。

## 视频工具 FFmpeg

浏览、规划故事不依赖 FFmpeg；**Mock 生成视频、提取画面、视频导入处理和导出**需要 `ffmpeg` 与 `ffprobe` 两个程序。

- Windows：可使用 `winget install --id Gyan.FFmpeg --exact`，或从 [FFmpeg 下载页](https://ffmpeg.org/download.html) 选择 Windows 版本，将其中的 `bin` 文件夹加入 PATH。
- macOS：已安装 Homebrew 时可运行 `brew install ffmpeg`，或使用 FFmpeg 下载页的 macOS 版本。
- Linux：使用系统的软件管理器安装 FFmpeg（例如 Debian / Ubuntu：`sudo apt install ffmpeg`）。

安装后关闭并重新打开启动窗口，新手页会重新检查。也可以在 **设置 → 环境检查** 查看状态。

## 启动遇到问题

| 提示或现象 | 处理方法 |
| --- | --- |
| 找不到 Node / Node 版本太旧 | 安装上面要求的 Node.js，安装完成后重新打开启动文件 |
| 下载依赖失败 | 检查网络；保留错误提示，修复后再次启动即可。首次需要访问 npm 仓库 |
| 文件夹无法写入 | 将完整项目放入自己的普通文件夹，再启动 |
| 正在由另一个窗口准备 | 等待原窗口完成；避免连续双击。原窗口已关闭时可重新启动 |
| 端口被其他程序占用 | 关闭占用程序后再启动；有经验的用户也可在 `.env.local` 中设置 `PORT=4791` |
| 已有 H3Mise 仅提供 API | 在原启动窗口按 Ctrl+C，再使用一键启动 |
| 浏览器没有自动打开 | 复制启动窗口显示的 `http://127.0.0.1:端口` 地址到浏览器 |

服务器只监听本机。开发者仍可继续使用 README 中的 `pnpm dev` / `pnpm start`；一键启动不会修改原有启动命令。

## English / 日本語

- **English:** Install Node.js **22.13+** with npm. Extract the complete project. Windows: double-click `start.bat`; macOS: open `start.command` (run `chmod +x start.command` if needed); Linux: `sh start.sh`. First launch downloads dependencies and builds the UI. Keep the launcher window open; Ctrl+C stops it. No key is required to explore bundled Mock demos. Missing keys open a guide; enter RunningHub credentials only in local Settings after choosing the matching region. FFmpeg and FFprobe are needed for video processing. See the [English README](README.en.md).
- **日本語:** npm を含む Node.js **22.13 以降**をインストールし、全ファイルを展開してください。Windows は `start.bat` をダブルクリック、macOS は `start.command`（必要なら `chmod +x start.command`）、Linux は `sh start.sh`。初回は依存関係と UI を準備します。起動ウィンドウを開いたまま使用し、Ctrl+C で停止します。Mock サンプルは Key 不要です。Key 未設定時は入門画面が開きます。RunningHub の地域を選んでから同じサイトの Key をローカル設定画面に入力してください。動画処理には FFmpeg と FFprobe が必要です。[日本語 README](README.ja.md) も参照してください。
