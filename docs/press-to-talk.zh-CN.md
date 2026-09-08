# PressToTalk 接入契约

本契约用于 vanilla JS、React 或其他宿主。默认按住说话、松开发送，上滑取消；不依赖 Web Speech，不内置网络请求、音频持久化或服务器存储。全部示例标识和文字为匿名合成数据。

## 可直接接入的 API

```js
const voice = new EditableVoiceInputCore.PressToTalkController({
  sessionKey: "demo-session-a",
  defaultText: "",
  defaultMode: "send", // send | dictate
  cancelDistancePx: 64,
  async onCommit({ audio, intent, sessionKey, recordingId, signal, source }) {
    // audio: { blob, mimeType, durationMs, size, terminationReason? }
    // source: pointer | activation
    // intent: send | dictate
    const result = await transcribeThroughHost(audio, { signal });
    if (signal.aborted) return;
    if (intent === "dictate") return { text: result.text };

    // 固定使用回调中的 sessionKey，不在异步返回后读取“当前会话”。
    // 如需本机回放，由宿主按身份隔离地写入 IndexedDB。
    // 把 audio 和文字副本交给原有同一发送流程，具体存储/授权由宿主负责。
    await hostSend({ audio, text: result.text, sessionKey, recordingId, signal });
  }
});

voice.pointerDown({ pointerId: 1, clientY: 300 });
voice.pointerMove({ pointerId: 1, clientY: 210 });
voice.pointerUp({ pointerId: 1, clientY: 210 }); // 取消，不调用 onCommit
voice.pointerCancel(1);

await voice.start({ intent: "dictate" }); // 小 mic 的点击/键盘开始路径
voice.stop(); // 按本次 intent 停止
voice.stopToDictate(); // 当前 send 录音转文字，撤销发送意图
voice.setMode("dictate"); // 切模式取消在途操作，保留草稿
voice.setText("用户编辑的草稿");
voice.setSession("demo-session-b", "另一会话草稿");
const unsubscribe = voice.subscribe(() => render(voice.getSnapshot()));
voice.cancel(); // 保留草稿，取消 capture 和异步结果
unsubscribe();
voice.dispose();
```

`onCommit` 返回 `void | string | { text: string }` 或对应 Promise。仅 `dictate` 分支使用返回的文本；`send` 返回值不写入草稿。回调每段录音最多调用一次，不自动重试。回调成功只代表宿主处理完成，不等同于服务器消息落库。

`getSnapshot()` 返回只读稳定快照：`phase`（idle / requesting-permission / recording / stopping / transcribing / committing / error）、`mode`（send / dictate）、`text`、`transcriptSuggestion`、`cancelPending`、`sessionKey`、`recordingId`、`elapsedMs`、`error`。`subscribe` 只通知变化，不立刻回调；首次渲染主动读取快照。

`pointerDown` 返回是否接受本次主指针；必须配合 Pointer Capture，`pointerup` 也传最终 `clientY`。只处理同一指针。上滑达到阈值为取消，滑回阈值内恢复。`start` 不提交；原生 `<button>` 的 click（含 Enter/Space、辅助技术激活）调用 start/stop，无需持续按键。Escape 调用 cancel。不要同时把一次指针松手产生的 click 当作新的开始。

## 发送和会话边界

- 权限待决时松手即取消；权限之后成功也只释放麦克风，不补发。
- pointercancel、丢失 Pointer Capture、页面隐藏/pagehide、取消、切模式/会话、dispose 均不得自动提交。
- 非用户停止（时长上限、音轨中断等）丢弃，不调用 onCommit。
- `stopToDictate()` 只接受正在录制的音频；权限待决时只取消并进入编辑模式。
- 转写返回时，原会话和录音已失效就丢弃。原草稿曾被编辑（即使改回原文）就仅设置 `transcriptSuggestion`，不覆盖；未编辑则追加到开始录音时的草稿。
- `setSession` 每次都创建新隔离边界，即使 key 相同；身份切换/新建消息草稿也应调用它。key 是宿主不透明作用域，不是身份认证凭证。
- AbortSignal 是本地尽力取消，不能撤回已送达服务端的请求。宿主必须在转写、IndexedDB 写入、发送之间复查取消和身份；服务器仍需认证/授权/幂等检查。推荐用 `recordingId` 作为同一次发送的幂等键。
- core 不会把转写当作发送。只有明确松手或标明停止发送的点击/键盘动作才会产生 `intent: "send"`；`dictate` 永远只编辑草稿，文本发送按钮由宿主实现。

## Vendoring

```sh
pnpm install --frozen-lockfile
pnpm build:vendor
pnpm vendor:check
```

- `dist/vendor/press-to-talk.iife.js`：普通 script，全局 `window.EditableVoiceInputCore`。
- `dist/vendor/press-to-talk.js`：自包含 browser ESM，导出 `PressToTalkController`、`bindPressToTalk`、`BrowserVoiceCapture` 等录音相关接口，不包含 React/outbox/Web Speech。
- `dist/vendor/server.bundle.cjs`：Node 服务端自包含 CJS，导出 `createTranscriptionHandler`、`createOpenAICompatibleProvider` 等服务端接口，含音频时长检测依赖；不包含密钥。
- `dist/vendor/LICENSE`、`THIRD_PARTY_NOTICES.md`、`manifest.json`：随 vendoring 产物一起保留；manifest 包含版本、字节数和 SHA-256。

源码构建不发布 npm。将 browser 产物放入宿主静态资源目录；server bundle 仅供服务端 require，不能发送到浏览器。服务端使用标准 Request/Response API，原生 Node HTTP 应用需自行适配并保留认证、Origin、限流和请求大小校验。

**默认 inspector 不保证接受任意浏览器 Blob。** live WebM 即使可回放，也可能因缺少时长元数据而被 `inspectAudioDurationMs` 以 415 拒绝，且不会调用 ASR；当前 Matroska parser 的 `duration: true` 不能补出该时长。需要时通过 `inspectDurationMs` 注入宿主验证过的 `AudioDurationInspector`，详见[真实接口、注入示例及安全要求](../README.zh-CN.md#服务端时长检查与-live-webm)。bundle 不包含兜底 decoder，模拟转写的浏览器测试不能证明真实服务端容器兼容性。
