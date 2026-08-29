# Editable Voice Input

说话 → 编辑文字，或直接发送录音。

Editable Voice Input 是一个小而清晰、与转写服务无关的 Web 语音输入工具包。它明确区分两类产品能力：可编辑的实时听写，以及作为一等消息存在的原始录音。

[English](./README.md)

## 交互原则

- 录音默认只存在内存中，宿主产品不主动保存就不会持久化。
- 转写完成后绝不自动提交。
- 用户可以回听、修改文字、重录、取消，最后主动确认提交。
- 浏览器录音、React 界面、服务端校验、转写服务适配彼此解耦。
- 实时临时结果不会写进可编辑正文，因此不会反复覆盖用户输入。
- 停止后的权威批量转写，只有在用户未修改时才自动替换；否则仅作为建议。
- 直接语音的上传由宿主注入 transport，本库不替宿主决定存储与保留期。
- 不含遥测、不捆绑模型、不包含账号与存储系统。

## 包结构

| 包 | 能力 |
| --- | --- |
| `@editable-voice-input/core` | 录音、听写状态机、可选 Web Speech provider、批量校正、直接语音消息契约 |
| `@editable-voice-input/react` | 兼容旧版 `useVoiceInput`，并新增 `useEditableDictation`、`useDirectAudioMessage` |
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

## 可编辑实时听写

`useEditableDictation` 默认使用浏览器 Web Speech API，也可以注入任意 `DictationProvider`。变化中的识别假设放在 `interimText`，只有 final 片段进入可编辑正文。传入 `authoritativeTranscribe` 后，hook 会并行保留临时录音，并在停止时调用批量转写。

```tsx
const dictation = useEditableDictation({
  value: draft,
  onValueChange: setDraft,
  language: "zh-CN",
  authoritativeTranscribe: transcribeThroughYourServer
});
```

如果用户在过程中修改了文字，批量结果只会出现在 `authoritativeSuggestion`，绝不会覆盖 `value`；宿主可自行展示对比与采纳界面。若正文未被用户修改，权威结果会自动应用。

内置 Web Speech provider 是可选能力，其可用性取决于浏览器。原生 SDK、WebSocket、端侧模型或其他供应商都可以实现同一 `DictationProvider` 契约。

## 直接语音消息

`useDirectAudioMessage` 负责录音、稳定的客户端消息 ID、单次上传锁，以及服务器返回的可播放元数据。默认需要显式调用 `send()`；只有 UI 明确告知“停止即发送”时，才建议开启 `uploadOnStop: true`。

```tsx
const audioMessage = useDirectAudioMessage({
  transport: {
    async upload({ audio, clientMessageId, signal }) {
      const response = await fetch(`/api/audio-messages/${clientMessageId}`, {
        method: "PUT",
        headers: { "content-type": audio.mimeType },
        body: audio.blob,
        signal
      });
      if (!response.ok) throw new Error("语音上传失败");
      return response.json();
    }
  }
});
```

服务端应把 `clientMessageId` 当作幂等键，并分别校验上传与播放权限。core 会验证服务端回传同一个 ID，避免迟到响应误挂到另一条本地录音。

## 移动端与格式

录音层依次尝试 Opus WebM、WebM、MP4、Opus Ogg、Ogg。Safari 通常使用 MP4，Chromium 通常使用 WebM。麦克风只能在 HTTPS（或 localhost）且用户授权后使用。

默认上限为 120 秒、8 MiB，宿主可调低。服务端会同时校验请求声明的 MIME 和音频文件签名，避免只相信请求头。

Web Speech 与 MediaRecorder 是两种独立能力。Chromium 通常支持前者；iOS Safari 会随系统版本变化，也可能在静音或页面进入后台时自动结束。接入时必须做能力检测、保留已输入文字，并提供纯批量转写作为降级路径。

服务端处理器默认要求传入 `authorize`，没有鉴权就会拒绝创建；只有明确要做公共接口时才能设置 `allowUnauthenticated: true`。`consumeQuota` 用于在解析和调用上游前接入用户/IP 级限流或额度控制。默认要求 `Origin` 且只接受同源浏览器请求；非浏览器服务端客户端必须明确设置 `allowMissingOrigin: true`，并继续执行鉴权。处理器也会读取音频容器的真实时长，不能只靠压缩后字节数绕过 120 秒限制。

`examples/next-app-router` 仅作为本地开发示例；生产构建会返回 503，直到你把 `authorizeExample` 替换为产品真实的会话鉴权。多实例部署时，限流应使用共享且原子的存储。

`examples/vite-react` 的可编辑听写会把 `/api/transcribe` 代理到 `http://localhost:3001`。测试停止后的 batch fallback 前，必须先在该端口启动兼容的原始音频转写接口；直接语音 tab 只使用当前页面内存，不依赖此代理。

运行 Next 开发示例前，把其中的 `.env.example` 复制为 `.env.local`，填入仅服务端可见的转写供应商配置，然后执行 `pnpm --filter editable-voice-input-example-next-app-router dev`。

## 隐私边界

本库不会持久化录音或转写文本，也不会收集遥测。浏览器 Web Speech 的具体实现可能把语音发送给浏览器供应商，产品必须按实际 provider 说明并获得同意。公共 API 会把当前录音 `Blob` 返回给宿主，是否存储由宿主明确决定。若要保存语音，需实现用户告知、加密存储、读取鉴权、保留周期、删除与导出能力。详见 [PRIVACY.md](./PRIVACY.md) 与 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md)。

## 本地开发

```bash
corepack pnpm install --frozen-lockfile
pnpm check
```

项目使用 Changesets 规划版本发布，当前版本为 `0.1.0-alpha.1`，不会自动发布 npm 包。

未来发布 npm 前请运行 `pnpm pack:release`，再发布 `release-packs/` 中的 tarball。不要在子包内直接执行 `npm pack`：必须由 pnpm 打包，才能把内部的 `workspace:*` 改写为实际版本。CI 会把四个 tarball 安装进一个全新的 npm 项目，并分别验证 ESM、CommonJS 及其类型声明和 CSS 导出。

## 开源协议

MIT，见 [LICENSE](./LICENSE)。
