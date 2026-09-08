# Editable Voice Input

## 极简按住说话

新增不依赖框架的 `PressToTalkController`：默认按住录音、松开发送，上滑取消；可把当前录音转文字编辑，也可用文字模式旁的小 mic 点击/键盘听写。唯一宿主回调为 `onCommit({ audio, intent: "send" | "dictate", sessionKey, recordingId, signal, source })`。

`send` 可由宿主识别后，把可回放音频和文字副本交给同一发送流程；`dictate` 返回 `{ text }`，仅安全回填草稿或保留建议，不自动发送。转写晚回不会覆盖用户编辑或落入另一会话。权限待决时松手、取消、页面隐藏和非用户停止均不能误发。无 Web Speech 依赖，无新增服务端录音存储；IndexedDB 存储是否开启及其身份隔离由宿主决定。

- 极简 React：`PressToTalkInput`，一个模式切换、一个录音区，无模式 tabs。
- Vanilla JS：`bindPressToTalk(button, controller)`，处理 Pointer Capture、取消、键盘激活与兼容 click 去重。
- `pnpm build:vendor`：输出 `window.EditableVoiceInputCore` IIFE、browser ESM 和自包含 `server.bundle.cjs`。
- [固定 API、接入示例与安全边界](./docs/press-to-talk.zh-CN.md) · [English contract](./docs/press-to-talk.md)

旧版 hooks 和组件 API 保持兼容。Vite 默认示例已替换为极简输入；旧双模式示例保留在 `examples/vite-react/src/LegacyApp.tsx` / `legacy.css`。Vite 两条语音路径均需 localhost:3001 的 `/api/transcribe` 服务。Vanilla 示例见 `examples/vanilla`，只提供静态 UI，识别路由须由宿主提供。浏览器自动化使用合成麦克风音频和模拟识别结果，不等同于真实手机或服务商验收。

说话 → 编辑文字，或直接发送录音。

Editable Voice Input 是一个小而清晰、与转写服务无关的 Web 语音输入工具包。它明确区分两类产品能力：可编辑的实时听写，以及作为一等消息存在的原始录音。

[English](./README.md)

## 交互原则

- 录音默认只存在内存中，只有宿主显式写入 outbox 才会持久化。
- 转写完成后绝不自动提交。
- 用户可以回听、修改文字、重录、取消，最后主动确认提交。
- 浏览器录音、React 界面、服务端校验、转写服务适配彼此解耦。
- 实时临时结果不会写进可编辑正文，因此不会反复覆盖用户输入。
- 停止后的权威批量转写，只有在用户未修改时才自动替换；否则仅作为建议。
- 直接语音的上传由宿主注入 transport，本库不替宿主决定存储与保留期。
- 不含遥测、不捆绑模型、不包含账号系统，也不会默认开启存储。

## 包结构

| 包 | 能力 |
| --- | --- |
| `@editable-voice-input/core` | 录音、听写状态机、可选 Web Speech provider、批量校正、直接语音消息契约 |
| `@editable-voice-input/react` | 兼容旧版 `useVoiceInput`，并新增 `useEditableDictation`、`useDirectAudioMessage` |
| `@editable-voice-input/server` | 原始请求体字节上限、音频文件签名校验、框架无关处理器 |
| `@editable-voice-input/provider-openai-compatible` | OpenAI 兼容转写接口适配器 |
| `@editable-voice-input/adapter-guichu` | 与 core 隔离的归处 Here 会话、身份与 owner 适配层 |

`@editable-voice-input/adapter-guichu` 只是宿主接入契约与参考适配器，不是归处/V0954 服务端实现。它不包含服务端路由、receipt 持久化、数据库迁移，也不能证明任何生产产品已经接入；宿主必须自行实现并用事务级测试验证这些边界，才能声称端到端完成。

V0954 当前使用产品自身的语音实现，尚未 import 这套 SDK。

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

`useEditableDictation` 可注入任意 `DictationProvider`。浏览器 Web Speech 默认关闭，因为浏览器供应商可能处理语音；产品先完成说明与同意，再显式传入 `enableBrowserWebSpeech: true`。变化中的识别假设放在 `interimText`，只有 final 片段进入可编辑正文。传入 `authoritativeTranscribe` 后，hook 会并行保留临时录音，并在停止时调用批量转写。

```tsx
const dictation = useEditableDictation({
  value: draft,
  onValueChange: setDraft,
  language: "zh-CN",
  enableBrowserWebSpeech: true, // 仅在产品完成隐私说明与同意之后
  authoritativeTranscribe: transcribeThroughYourServer
});
```

如果用户在过程中修改了文字，批量结果只会出现在 `authoritativeSuggestion`，绝不会覆盖 `value`；宿主可自行展示对比与采纳界面。若正文未被用户修改，权威结果会自动应用。

内置 Web Speech provider 是可选能力，其可用性取决于浏览器。浏览器因静音自然结束识别时，只要用户仍处于听写意图就会自动续听；若 Web Speech 不支持或报错，并且配置了 `authoritativeTranscribe`，录音仍会继续，状态退化为 `batch-only`，非致命错误通过 `liveError` 暴露。原生 SDK、WebSocket、端侧模型或其他供应商都可以实现同一 `DictationProvider` 契约。

## Headless 双模式

`useDualModeVoiceInput` 统一协调“转成文字后编辑”和“直接发送录音”，切换模式时会关闭另一条录音链路。`DualModeVoiceInput` 是可选的极简 UI，支持键盘 Tab 语义与至少 44px 的触控目标；产品也可只使用 headless hook 自行呈现。

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

### 可恢复的 durable outbox

`DirectAudioOutbox` 会先用稳定的 `clientTurnId` 暂存录音，上传前按该 ID 做一次精确、带 owner 鉴权的服务端查询；只有确认服务端已存在有效消息后才删除本地 pending。即使上传成功后的 HTTP 响应丢失，刷新后也能恢复。服务端一旦返回经过校验的消息，就视为 durable receipt：即使 IndexedDB 条件删除被中断，`send()` 仍以 `cleanupPending: true` 返回成功，保留 pending，并在后续恢复时继续精确对账。跨 tab、跨设备的 exactly-once 还必须由服务端对 `(owner, clientTurnId)` 建立原子唯一约束；并发冲突需要返回已经存在的消息。

持久化由 `DirectAudioOutboxStore` 注入。浏览器可使用 `createIndexedDbDirectAudioOutboxStore`，但必须同时传入 codec 和当前 owner 的不透明 `partition`。记录使用 `(partition, clientTurnId)` 复合键；持久 partition epoch 让 `clear()` 与删行保持原子，并阻止另一个 tab 的延迟编码把旧记录写回来。每次发送还会持久化 partition epoch + 行 revision 租约，在 lookup 前后及 upload 前复核，并只做租约匹配的条件删除。`claimTo()` 会同时 CAS 来源与目标 epoch，再原子换绑、重新加密并移动记录，因此旧 tab 在 clear 或 claim 后不能继续发送。多个自定义 `storeName` 通过 IndexedDB 版本升级协议协调；每个 tab/realm 在 `versionchange` 时关闭旧连接，随后重开并重试被打断的 schema 与行事务。若自定义名称与宿主已有且 keyPath 不兼容的 store 冲突，会 fail closed，绝不会删除或改写宿主数据。身份变化后必须创建新的 store 实例，partition 不得使用原始账号标识。宿主需在 codec 中加密、绑定当前身份、设置过期并拒绝跨账号恢复。内存 store 只用于测试和非持久化演示。

归处专属的 `conversationId`、`sessionId`、`ownerKey` 只存在于 `@editable-voice-input/adapter-guichu`；旧 pending 如果缺少这组密封 scope 会直接 fail closed。适配器要求宿主提供每次登录、退出或 claim 都会变化的 `identityEpoch`，并在变化时立即 abort 对应的 `identitySignal`；lookup/upload 前后都会复核，也可接入服务端身份预检。账号变化时必须先调用 `outbox.clear()`，或使用 guest-to-account 认证 claim helper。该 helper 会把 source identity、target identity 与调用方取消信号一直联结到服务端等待及本地 IndexedDB move 完成；它必须先拿到服务端幂等 `claimOrReconcile` receipt：服务端在同一事务中对账已有 guest 消息或为 account 预留该 turn，并撤销 source 对该 turn 的继续写入。receipt 必须完整回显两侧的 conversation、session、owner、identity epoch 以及 client turn，本地才会换绑；服务端响应丢失后的重试必须返回同一个 durable receipt。

该 helper 每次只迁移一个 `clientTurnId`。如果存在多条 pending，宿主必须在身份切换前先枚举全部记录，再使用一个持久的服务端 batch grant，或在逐条 claim 期间保持 source 的逐 turn 授权有效。不能迁完第一条就销毁或全局撤销 source identity；应在所有选中记录完成后再结束批次。本包不会假装已经替宿主编排了这个事务。`clear()` 只是 best-effort 的客户端围栏：它会作废本地 pending continuation 并请求中止 transport，但无法撤回已经送达服务端的网络请求。强撤销必须由服务端 identity epoch/revocation 在 `findExact`、`upload` 与 claim 对账的同一事务边界执行。

## 移动端与格式

录音层依次尝试 Opus WebM、WebM、MP4、Opus Ogg、Ogg。Safari 通常使用 MP4，Chromium 通常使用 WebM。麦克风只能在 HTTPS（或 localhost）且用户授权后使用。

默认上限为 120 秒、8 MiB，宿主可调低。服务端会同时校验请求声明的 MIME 和音频文件签名，避免只相信请求头。

Web Speech 与 MediaRecorder 是两种独立能力。Chromium 通常支持前者；iOS Safari 会随系统版本变化，也可能在静音或页面进入后台时自动结束。接入时必须做能力检测、保留已输入文字，并提供纯批量转写作为降级路径。

MediaStream track 结束、页面隐藏或离开时，录音会安全停止并释放麦克风，避免后台继续采集。音频会带上 `terminationReason`；这类生命周期停止不会被当成用户主动“停止即发送”。

服务端处理器默认要求传入 `authorize`，没有鉴权就会拒绝创建；只有明确要做公共接口时才能设置 `allowUnauthenticated: true`。`consumeQuota` 用于在解析和调用上游前接入用户/IP 级限流或额度控制。默认要求 `Origin` 且只接受同源浏览器请求；非浏览器服务端客户端必须明确设置 `allowMissingOrigin: true`，并继续执行鉴权。处理器也会读取音频容器的真实时长，不能只靠压缩后字节数绕过 120 秒限制。

`examples/next-app-router` 仅作为本地开发示例；生产构建会返回 503，直到你把 `authorizeExample` 替换为产品真实的会话鉴权。多实例部署时，限流应使用共享且原子的存储。

`examples/vite-react` 会把 `/api/transcribe` 代理到 `http://localhost:3001`。当前极简示例的语音消息与听写均使用该接口，请先在该端口启动兼容的原始音频转写服务。示例回放仅使用当前页面内存，不包含录音存储接口；旧双模式示例仅作为 `LegacyApp.tsx` / `legacy.css` 源码保留。

运行 Next 开发示例前，把其中的 `.env.example` 复制为 `.env.local`，填入仅服务端可见的转写供应商配置，然后执行 `pnpm --filter editable-voice-input-example-next-app-router dev`。

## 隐私边界

本库不会持久化录音或转写文本，除非宿主显式创建并使用 outbox store；本库也不会收集遥测。浏览器 Web Speech 默认关闭，其具体实现可能把语音发送给浏览器供应商，产品必须按实际 provider 说明并获得同意后再启用。公共 API 会把当前录音 `Blob` 返回给宿主，是否存储由宿主明确决定。若要保存语音，需实现用户告知、加密存储、读取鉴权、保留周期、删除与导出能力。详见 [PRIVACY.md](./PRIVACY.md) 与 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md)。

## 本地开发

```bash
corepack pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
```

当前分支保持在 Changesets 的 `beta` 预发布模式，版本为 `0.2.0-beta.1`，不会自动发布 npm 包；真实手机浏览器 QA 完成前不要执行稳定版 version/publish。

未来发布 npm 前请运行 `pnpm pack:release`，再发布 `release-packs/` 中的 tarball。不要在子包内直接执行 `npm pack`：必须由 pnpm 打包，才能把内部的 `workspace:*` 改写为实际版本。CI 会把五个 tarball 安装进一个全新的 npm 项目，并分别验证 ESM、CommonJS 及其类型声明和 CSS 导出。

## 开源协议

MIT，见 [LICENSE](./LICENSE)。
