# 安全策略

[English](./SECURITY.md)

## 支持版本

首次稳定版发布前，仅维护最新的预发布版本。

## 报告漏洞

请使用 GitHub 私密安全公告，不要公开提交 Issue。请包含受影响包与版本、复现步骤、影响范围，以及可行时的缓解建议。维护者应在五个工作日内确认完整报告。

## 接入方责任

服务端包会校验音频签名、真实时长、字节上限与同源请求；若未配置鉴权或未明确开启匿名访问，处理器会拒绝创建。包提供额度回调，但不包含身份系统或分布式原子限流器。部署方仍需接入真实会话鉴权、共享额度/上游配额、请求超时、HTTPS，以及不记录音频和转写正文的安全日志。

上游适配器会拒绝远程明文 HTTP、URL 内嵌凭证、重定向和超大响应体。这些防护不能替代生产环境的网络出口白名单。

供应商 API Key 只能保存在服务端，禁止打进浏览器包或提交到源码中的示例配置。

直接语音的 transport 只是接口，不是上传服务器。宿主实现必须校验身份、资源归属、文件签名/类型、真实时长和大小，以 `clientMessageId` 做幂等，并按产品风险增加内容安全措施；播放权限需要单独鉴权。建议使用短时效签名播放地址，禁止把客户端传入的消息 metadata 当作授权依据。

`DirectAudioOutbox` 在重试上传前要求进行精确、带 owner 鉴权的查询；查询接口不得泄露同一 ID 是否属于其他用户。lookup-before-upload 不能串行化两个 tab，因此服务端必须原子约束 `(owner, clientTurnId)` 唯一，并在冲突时返回既有消息。IndexedDB store 必须注入 codec 和不透明 owner partition：音频写盘前需加密，把 owner 作为认证数据绑定，使用最小范围的密钥，设置过期时间，partition 不得使用原始账号标识。持久 partition epoch 会对 `clear()` 与延迟写执行 CAS，durable claim 则同时 CAS 来源和目标 partition；持久行 revision 发送租约会在 lookup/upload 周围阻断旧 tab，并让清理只删除匹配版本。自定义 storeName 若与宿主不兼容 keyPath 冲突，必须 fail closed，绝不能删除宿主数据。guest-to-account 恢复时，本地 claim 必须先获得服务端幂等 `claimOrReconcile` 事务的匹配 durable receipt；该事务需同时鉴权两侧 scope、对账或预留 turn，并撤销 source owner 的写权限。禁止用 decode/delete/put 手工模拟换绑。账号切换前需创建新的 store，并清空或显式 claim 旧记录；transport 必须遵守传入的 abort signal，身份 epoch 变化时宿主必须立即 abort。abort 与 `clear()` 在请求已经到达服务端后都只是 best-effort；身份敏感的 lookup、upload 与 claim 必须在自身读写边界原子校验 owner、session 及 identity epoch/revocation。内存 store 不具备持久性，只用于测试和演示。
