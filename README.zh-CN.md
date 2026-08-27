# Editable Voice Input

录音 → 转写 → 编辑 → 明确提交。

Editable Voice Input 是一个小而清晰、与转写服务无关的 Web 语音输入工具包。它把语音识别视为“生成可编辑草稿”，而不是直接替用户发送内容。

[English](./README.md)

## 交互原则

- 录音默认只存在内存中，宿主产品不主动保存就不会持久化。
- 转写完成后绝不自动提交。
- 用户可以回听、修改文字、重录、取消，最后主动确认提交。
- 浏览器录音、React 界面、服务端校验、转写服务适配彼此解耦。
- 不含遥测、不捆绑模型、不包含账号与存储系统。

## 包结构

| 包 | 能力 |
| --- | --- |
| `@editable-voice-input/core` | 浏览器录音、MIME 协商、状态与错误、对象 URL 生命周期、草稿合并 |
| `@editable-voice-input/react` | `useVoiceInput` 与无障碍、极简、可换肤组件 |
| `@editable-voice-input/server` | 原始请求体字节上限、音频文件签名校验、框架无关处理器 |
| `@editable-voice-input/provider-openai-compatible` | OpenAI 兼容转写接口适配器 |

## 快速接入

```tsx
import { EditableVoiceInput } from "@editable-voice-input/react";
import "@editable-voice-input/react/styles.css";

<EditableVoiceInput
  value={draft}
  onValueChange={setDraft}
  transcribe={async ({ blob, mimeType }) => {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "content-type": mimeType },
      body: blob
    });
    if (!response.ok) throw new Error("转写失败");
    return response.json();
  }}
  onSubmit={({ text }) => sendMessage(text)}
/>
```

转写结束只会更新可编辑草稿，不会触发 `onSubmit`。只有用户点击提交，或宿主明确调用 hook 的 `submit()`，才会发送。

## 移动端与格式

录音层依次尝试 Opus WebM、WebM、MP4、Opus Ogg、Ogg。Safari 通常使用 MP4，Chromium 通常使用 WebM。麦克风只能在 HTTPS（或 localhost）且用户授权后使用。

默认上限为 120 秒、8 MiB，宿主可调低。服务端会同时校验请求声明的 MIME 和音频文件签名，避免只相信请求头。

服务端处理器默认要求传入 `authorize`，没有鉴权就会拒绝创建；只有明确要做公共接口时才能设置 `allowUnauthenticated: true`。`consumeQuota` 用于在解析和调用上游前接入用户/IP 级限流或额度控制。默认要求 `Origin` 且只接受同源浏览器请求；非浏览器服务端客户端必须明确设置 `allowMissingOrigin: true`，并继续执行鉴权。处理器也会读取音频容器的真实时长，不能只靠压缩后字节数绕过 120 秒限制。

`examples/next-app-router` 仅作为本地开发示例；生产构建会返回 503，直到你把 `authorizeExample` 替换为产品真实的会话鉴权。多实例部署时，限流应使用共享且原子的存储。

运行 Next 开发示例前，把其中的 `.env.example` 复制为 `.env.local`，填入仅服务端可见的转写供应商配置，然后执行 `pnpm --filter editable-voice-input-example-next-app-router dev`。

## 隐私边界

本库不会持久化录音或转写文本，也不会收集遥测。公共 API 会把当前录音 `Blob` 返回给宿主，是否存储由宿主产品明确决定。若要保存语音，需自行实现用户告知、加密存储、读取鉴权、保留周期和删除能力。详见 [PRIVACY.md](./PRIVACY.md) 与 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md)。

## 本地开发

```bash
corepack pnpm install --frozen-lockfile
pnpm check
```

项目使用 Changesets 规划版本发布，当前版本为 `0.1.0-alpha.1`，不会自动发布 npm 包。

未来发布 npm 前请运行 `pnpm pack:release`，再发布 `release-packs/` 中的 tarball。不要在子包内直接执行 `npm pack`：必须由 pnpm 打包，才能把内部的 `workspace:*` 改写为实际版本。CI 会把四个 tarball 安装进一个全新的 npm 项目，并分别验证 ESM、CommonJS 及其类型声明和 CSS 导出。

## 开源协议

MIT，见 [LICENSE](./LICENSE)。
