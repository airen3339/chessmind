# ChessMind

<sub>[简体中文](README.md) · [English](README.en.md)</sub>

和大语言模型下国际象棋。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078d4.svg)](#下载)
[![Tauri](https://img.shields.io/badge/Tauri-2-24c8db.svg)](https://tauri.app)

---

## 功能

- **兼容接口**：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini 原生 API。
- **四种对局模式**：我执白、我执黑、AI 对 AI、双人本地。
- **教练模式**：开局时可选思维链、着法解释、逐手点评、局势解读、随时申请指导、终局简评，教练模型可以单独指定。
- **实时思维链**：模型支持时显示推理过程，展示每一步的耗时、HTTP 状态和 token 用量。
- **摆棋编辑器**：开局前或对局中途都能摆，支持载入与复制 FEN。
- **多套配置**：保存多套API接口配置，AI 对 AI 时两边可以用不同模型互下。
- **完整对局管理**：悔棋、暂停、翻转棋盘。

## 下载

到 [Releases](../../releases) 下载，两个版本功能相同：

| 文件 | 场景 |
| --- | --- |
| `ChessMind-1.1.1-win-x64-setup.exe` | 一键安装包 |
| `ChessMind-1.1.1-win-x64.zip` | 免安装压缩包，解压即用 |

各版本的改动记录见 [CHANGELOG.md](CHANGELOG.md)。

每个文件都配了 `.sha256`，下载后可校验：

```powershell
Get-FileHash .\ChessMind-1.1.1-win-x64.zip -Algorithm SHA256
```

**系统要求**：Windows 10 1803+ 或 Windows 11，需要 WebView2 运行时（通常系统自带）。

**首次运行**：可能会遇到 SmartScreen 拦截，点「更多信息 → 仍要运行」即可。

配置文件在 `%APPDATA%\com.chessmind.app\settings.json`，用 Windows DPAPI 加密，只有当前用户能解密。

## 支持的接口

| 格式 | 端点 | 思维链来源 |
| --- | --- | --- |
| OpenAI Chat Completions | `{base}/chat/completions` | 依模型而定 |
| OpenAI Responses | `{base}/responses` | reasoning summary |
| Anthropic Messages | `{base}/messages` | thinking |
| Gemini | `{base}/models/{model}:streamGenerateContent` | thought |

### 常见填法

| 服务 | 格式 | Base URL | 模型 |
| --- | --- | --- | --- |
| OpenAI | Responses | `https://api.openai.com/v1` | `gpt-5` |
| Anthropic | Anthropic Messages | `https://api.anthropic.com/v1` | `claude-sonnet-4-6` |
| DeepSeek | Chat Completions | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenRouter | Chat Completions | `https://openrouter.ai/api/v1` | 任意 `vendor/model` |
| Ollama | Chat Completions | `http://127.0.0.1:11434/v1` | `qwen3:32b` |

自签名网关可以开「忽略证书错误」，需要额外鉴权头的网关可以填自定义请求头。

请填写最终接口地址，应用不会自动跟随重定向，以免转发密钥。当前对局固定开始时的配置；修改用于下一局，AI 出错后点击「再试一次」会读取本局原配置的新密钥和参数。

## 快捷键

| 键 | 作用 |
| --- | --- |
| `F` | 翻转棋盘 |
| `U` | 悔棋 |
| `H` | 请求指导（教练模式） |
| `Space` | 暂停 / 继续 |
| `1`–`6` | 摆棋时选择棋子类型 |
| `W` / `B` | 摆棋时切换白 / 黑 |
| `Esc` | 摆棋时退出橡皮擦 |
| 右键 | 摆棋时删除棋子 |

## 从源码运行

技术栈是 React 19 + TypeScript + Vite，外壳用 Tauri 2，规则引擎是 chess.js。

需要 Node.js 20.19+ 和 Rust 1.90+。

```powershell
npm install
npm run tauri dev    # 开发模式
npm run dist         # 产出安装包与免安装压缩包，放在 release/
```

其他脚本：

```powershell
npm run typecheck        # tsc --noEmit
npm run test             # vitest
npm run build            # 类型检查 + 前端构建
npm run tauri build      # 只出 NSIS 安装包
```

开发服务器运行时访问 `http://127.0.0.1:1420/smoke.html` 可以跑一遍全链路自检；`capture.html?state=settings` 能把界面切到指定状态方便截图。

## 让模型会下棋

- **合法着法白名单**：每步把当前所有合法着法按棋子分组，用 SAN 和 UCI 两种写法列全交给模型。
- **完整局面包**：带坐标的 ASCII 棋盘、FEN、行棋方、易位权、吃过路兵格、半回合钟、将军状态。
- **严格契约加三级解析**：模型输出 JSON，解析时依次尝试字段、UCI 坐标、SAN 词元；全不合法就把错因连同合法着法再发一次。
- **竞态保护**：悔棋、暂停、结束、摆棋会立即作废在途请求，旧着法不会落到新局面。
- **上下文可选**：连续上下文让模型延续自己的计划并命中前缀缓存，每步独立则每次从当前局面重新推理。
- **教练与对局分离**：教练是独立请求，落子之后才发，既不写进对局上下文，也影响不了 AI 那一手的选择。

## 致谢

- **[LINUX DO](https://linux.do)** — 社区支持

## 许可证

[MIT](LICENSE)。第三方组件许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，其中 Cburnett 棋组依 BSD-3-Clause 使用。
