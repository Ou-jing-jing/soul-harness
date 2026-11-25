# SH-009 — Local API / WebSocket / Health 正式实施计划

- **文档状态**：R2.1 修订，等待独立审查。**不是实施授权**，不表示 SH-009 已开始或已完成。
- **基线**：`main` / `origin/main` = `27e4ec4cebab070199a2d888cd7f1ab2cb2d087e`（2026-11）。
- **依据**：SH-009 E0 只读调查报告、独立复核报告、维护者对争议项的最终裁决，以及当前仓库真实源码。
- **本文件性质**：只定义实施边界、接口、顺序和验收；不修改任何源码、测试、依赖、lockfile、配置或现有架构文档。

---

## 1. 基线、范围与原则

### 1.1 基线事实

| 项 | 值 |
|---|---|
| 分支 | `main` |
| 本地 HEAD | `27e4ec4cebab070199a2d888cd7f1ab2cb2d087e` |
| `origin/main` | 同 SHA |
| 工作区（创建本计划文件前） | 干净；交付时仅 `?? docs/SH-009-PLAN.md` 一个未跟踪的本次计划文件 |
| 现有 Daemon 测试 | 12 个文件、118 项通过 |
| 现有根级检查 | `pnpm run check` 的格式、lint、typecheck、测试、build、consumer-check 均通过 |

### 1.2 本批范围

SH-009 只增加 Daemon 的本地管理 API、WebSocket 状态通道和健康检查传输，并完成相应的**窄化** Daemon 组合。

### 1.3 本批不做

- `POST /v1/stimuli` 或任何 HTTP 刺激入口。
- Task 写接口、任务派发、认知 Handler。
- Archive、Action Gateway、Dream、记忆/思维接口。
- Supervisor、后台 health loop、自动重启。
- 队列深度、最近提交时间、最近错误等当前不存在的数据指标。
- 修改 Persistence、Migration、Contracts、Runtime 的业务语义。
- 任何破坏 SH-008E E4 关闭规则的改动。

### 1.4 标注约定

- **【事实】**：当前源码/文档可直接核对。
- **【冻结决议】**：维护者已决定，不在本计划重新讨论。
- **【实施验证项】**：实现时必须用真实依赖/测试验证，不是已知事实。
- **【停止条件】**：发现即停止，不自行扩大范围。

---

## 2. 当前源码事实

### 2.1 Daemon

| 事实 | 证据 |
|---|---|
| `SoulDaemon` 已持有 Lock、Store、PersonaLifecycle、Ingress、Scheduler | `apps/soul-daemon/src/daemon.ts:158-183` |
| `DaemonStatus` 已有 `recovery`，以及 A1 加入的 `scheduler: SchedulerStats \| null` | `daemon.ts:101-114` |
| `status` 每次读取时调用 `this.#scheduler?.stats() ?? null` | `daemon.ts:198-211` |
| 启动顺序为 config/log/dataDir → lock → Store → migrate/verify → RECOVERING → READY → RUNNING | `daemon.ts:248-352` |
| READY 创建 Ingress，随后创建并启动空 Handler Scheduler | `daemon.ts:536-573` |
| 当前没有 HTTP/WS/Health source 或依赖 | 无 `apps/soul-daemon/src/api/`；package 只有 persistence/runtime |
| 关闭顺序为 Ingress → Scheduler.stop → Store → Lock | `daemon.ts:379-432` |
| Scheduler stop 失败不关 Store、不放 Lock | `daemon.ts:406-413` |
| Store.close 失败保留 Lock | `daemon.ts:484-520` |
| `http_api` / `health_check` 仍为 `not_implemented` | `src/phases.ts:107-120` |
| API/健康能力字段目前是字面量 `not_implemented` | `src/phases.ts:177-202` |
| 现有错误码没有 API/Token 专用项 | `src/errors.ts:10-34` |
| 现有 Daemon 测试没有 HTTP/WS/Health 覆盖 | `apps/soul-daemon/test/` |

### 2.2 Runtime / Persistence / Contracts

| 能力 | 公开接口 | 当前限制 |
|---|---|---|
| Persona | `PersonaLifecycle` 的 create/get/list/query/start/suspend/resume/stop | Daemon 私有持有 lifecycle；API 必须经窄接口 |
| Ingress | `StimulusIngress.acceptStimulus/readBuffered/listQueued/evictExpired/close/metrics` | 无 transport、无 adapter registry、无事件观察者、无全局队列深度 |
| Scheduler | `TaskScheduler.start/stop/stats` | 空 Handler Map；`stats` 只有 state/activeHandlers/activeUnits |
| Recovery | `recoverRuntime` 返回 `RecoveryReport` | Daemon 保存启动摘要，没有运行期查询接口 |
| Persistence | `createRepositories(store)` 的 personas/events/sessions/tasks 等只读查询 | Daemon 可用，但 API 不得直接接触 Repository/Store |
| Contracts | `StimulusInputV1`、`AckResponse`、`ErrorResponse`、Archive IPC | 没有 API/Health/WS 管理契约，也没有普通 404/409/413/503 错误码 |

### 2.3 工程事实

- 当前没有 `fastify`、`@fastify/websocket`、`ws` 依赖。
- `.nvmrc` 为 `24.21.0`；package engine 为 `>=24.15.0 <25`。
- CI 使用 frozen lockfile，执行 format/lint/typecheck/test/build/consumer-check。
- `pnpm-workspace.yaml` 只把 `esbuild` 列入 `allowBuilds`。
- `apps/soul-daemon/package.json` 依赖只有 `@soul-harness/persistence`、`@soul-harness/runtime`。

### 2.4 已知文档滞后（本计划不修改）

| 文档 | 滞后内容 |
|---|---|
| `docs/PLAN.md` §7/§13 | 仍写 SH-008E 未开始、Daemon 未装配 |
| `docs/architecture/OVERVIEW.md` §9 | 同上 |
| `docs/architecture/MODULES.md` §4 | 同上 |
| `docs/architecture/RUNTIME-LIFECYCLE.md` §2 注 | 仍把 API/Health 写成未开始的 SH-009；SH-009 完成后需同步 |
| `docs/architecture/RUNTIME-LIFECYCLE.md` §3 | “超时取消运行任务”与 SH-008E D-R1 冲突；SH-009 不得实现该超时 |
| `apps/soul-daemon/README.md` | 尚无 API/WS/Health 运行说明 |

这些只作为 E5 文档同步清单；本计划阶段不修改。

---

## 3. 冻结设计决议（逐项映射）

### 3.1 Token

**【冻结决议】**

- 首次启动在取得单实例锁后生成 32 字节随机 Token。
- base64url，存 `<SOUL_DATA_DIR>/api.token`。
- POSIX 文件权限 0600。
- 已存在文件必须验证：普通文件、非符号链接、格式合法；非法则启动失败，不自动重生成。
- 不提供环境变量 Token 覆盖，不提供 HTTP Token 获取接口，不做热轮换。
- Token 不进入日志、异常或响应。
- Windows 不宣称 Node mode 等于 ACL；依赖数据目录 ACL 与同用户信任模型，并记录限制。
- 比较使用恒定时间比较。
- **首版 Studio 获取方式**：用户手动从 `<SOUL_DATA_DIR>/api.token` 复制 Token，在 Studio 中粘贴；Studio 仅保存在内存，不写 localStorage/sessionStorage/IndexedDB/Cookie。刷新页面后需重新粘贴。没有匿名 bootstrap、Token 获取端点、环境变量覆盖或热轮换。

### 3.2 管理 API 错误

**【冻结决议】** 使用 Daemon 本地错误信封，不修改 `packages/contracts`，不扩展 `soul.error.v1`。

固定错误码与 HTTP 状态：

| code | HTTP | 固定 message |
|---|---:|---|
| `invalid_request` | 400 | `invalid request` |
| `unauthorized` | 401 | `authentication required` |
| `forbidden` | 403 | `request forbidden` |
| `not_found` | 404 | `resource not found` |
| `conflict` | 409 | `state conflict` |
| `too_large` | 413 | `request body too large` |
| `rate_limited` | 429 | `too many requests` |
| `unavailable` | 503 | `service unavailable` |
| `internal_error` | 500 | `internal error` |

响应形状固定为：

```json
{ "error": { "code": "not_found", "message": "resource not found" } }
```

不得包含异常文本、堆栈、路径、请求正文、Token 或动态细节。

### 3.3 Stimulus

**【冻结决议】** SH-009 不实现 `POST /v1/stimuli`；不把管理 API Token 自动当 Adapter 身份；不绕过 Adapter Registry。可信 Adapter 身份模型落地后另行规划。

Ingress 继续是进程内组件；SH-009 不改变 `acceptsInput=false` / `eventIngress=unavailable_no_transport`。

### 3.4 端口与版本

**【冻结决议】**

- HTTP / WS：`127.0.0.1:18700`。
- Studio Dev：`127.0.0.1:18701`。
- 只监听 IPv4 loopback。
- 不自动换端口；占用时启动失败，退出码 5。
- HTTP 使用 `/v1/` 路径版本。
- WS 使用 `soul.ws.v1` 子协议。

### 3.5 HTTP 安全

**【冻结决议】**

- 所有管理 API 使用 Bearer Token。
- Health live / ready 匿名，但只返回最小信息和固定原因枚举。
- `/v1/status` 及其他管理端点必须鉴权。
- 严格 Host 校验。
- 浏览器 Origin 精确 allowlist：
  - `http://127.0.0.1:18701`
  - 未来 Daemon 托管 Studio 的同源地址（届时为 `http://127.0.0.1:18700`）
- 非浏览器客户端允许没有 Origin，但仍须 Token。
- 不允许通配 CORS，不使用 Cookie。
- 不提供匿名 Token bootstrap。
- 请求体大小有限制。
- Fastify 默认请求日志关闭或由 Daemon logger 安全接管；不得记录 Token、请求正文或敏感头。

### 3.6 WebSocket

**【冻结决议】**

- 不允许 URL query 携带 Token。
- 使用首条消息鉴权。
- 鉴权等待时间、未鉴权连接数量、首帧大小均有上限。
- 首版只做 `hello`、权威 snapshot、客户端 pull、`shutting_down`。
- 不做周期性伪推送，不做事件续传。
- 每连接发送队列有界。
- 慢客户端关闭，不得阻塞 Daemon。
- Host / Origin 校验与 HTTP 一致。

### 3.7 内部组件访问

**【冻结决议】**

- 不公开 Store、数据库连接、Repository 集合或 Runtime 组件句柄。
- API Server 只接收窄化的 `DaemonApi` 依赖接口。
- 只暴露已批准的 Persona 操作、只读查询和状态读取。
- API 路由不得执行 SQL。
- 由 Daemon 组合现有组件实现窄接口。

### 3.8 Health

**【冻结决议】** ready 至少要求：

- phase 为 RUNNING；
- Store 已打开；
- Instance Lock 仍由当前进程持有；
- Recovery 已完成；
- 未进入 draining；
- API 正在监听。

Scheduler running 不代表 task dispatch available；必须保留 `handlerKinds=0` 和 `taskDispatch=unavailable_no_handlers` 的真实语义。不增加不存在的数据指标，不增加后台 health loop 或 supervisor。

### 3.9 生命周期

**【冻结决议】**

启动：

```text
Persona Recovery → Runtime Recovery → Ingress → Scheduler.start() → API listen → RUNNING
```

关闭：

```text
API beginDrain → ingress.close() → await scheduler.stop()
→ 关闭 WS / API server → Store.close() → Lock.release()
```

严格遵守 SH-008E E4：

- Scheduler stop 未完成，不关闭 Store、不释放 Lock。
- API close 失败，不关闭 Store、不释放 Lock。
- Store close 失败，不释放 Lock。
- 不新增强制关闭超时。
- 不改变既有 shutdown 失败语义。

### 3.10 API / Health Surface 状态

**【冻结决议】** `DaemonComponentSurface` 与 `RuntimeCapabilitySurface` 的四个字段必须扩展为下列精确联合类型；不得继续使用只含 `not_implemented` 的字面量类型，也不得用 `unknown`/`string` 绕过。

```ts
type HttpApiComponentState =
  | 'not_implemented'
  | 'assembled'
  | 'running'
  | 'draining'
  | 'stopped'
  | 'failed';

type HealthEndpointComponentState =
  | 'not_implemented'
  | 'assembled'
  | 'running'
  | 'draining'
  | 'stopped'
  | 'failed';

type HttpApiCapability =
  | 'not_implemented'
  | 'unavailable'
  | 'draining'
  | 'available';

type HealthEndpointCapability =
  | 'not_implemented'
  | 'unavailable'
  | 'draining'
  | 'available';
```

**Component 与 Capability 的语义区别**：

- `components.*` 描述**对象/端点的生命周期状态**：是否实现、对象是否存在、是否监听、是否正在 draining、是否已停止或失败。
- `capabilities.*` 描述**当前是否可被管理客户端使用**：是否能接收新请求/提供端点。对象存在但未监听时是 `unavailable`；监听成功才是 `available`。

**精确状态映射**：

| 时刻 | `components.httpApi` | `components.healthEndpoint` | `capabilities.httpApi` | `capabilities.healthEndpoint` |
|---|---|---|---|---|
| SH-009 代码尚未引入 API | `not_implemented` | `not_implemented` | `not_implemented` | `not_implemented` |
| API server 已创建、尚未 listen | `assembled` | `assembled` | `unavailable` | `unavailable` |
| listen 成功、RUNNING | `running` | `running` | `available` | `available` |
| DRAINING（beginDrain 后、API close 前） | `draining` | `draining` | `draining` | `draining` |
| API close 成功 | `stopped` | `stopped` | `unavailable` | `unavailable` |
| API close 失败 / listen 失败 | `failed` | `failed` | `unavailable` | `unavailable` |

- `DRAINING` 时 listener 可能仍绑定，但只接受 drain/liveness；管理能力必须报告 `draining`，不能继续报告 `available`。
- `API close` 失败时表面必须是 `failed/unavailable`；Store/Lock 按 §9 保留，不得伪造成 `stopped` 或 clean。
- `healthEndpoint` 与 API server 同生命周期；它不能独立于 API server 报告 `running`。
- 状态更新由 Daemon 在真实生命周期点写入 surface：创建后 `assembled`，listen 成功后 `running`，beginDrain 后 `draining`，close 成功/失败后 `stopped`/`failed`。不得用定时器或事后猜测补状态。

---

## 4. HTTP API 设计

### 4.1 端点总表

所有路径均以 `/v1/` 开始。管理 API 除 health 外均要求 `Authorization: Bearer <token>`。

| 批次 | 方法与路径 | 用途 | 鉴权 | 请求 | 成功响应 | 主要错误 |
|---|---|---|---|---|---|---|
| E2 | `GET /v1/health/live` | liveness | 匿名 | 无 | 200 `{"status":"ok"}` | 403/429 |
| E2 | `GET /v1/health/ready` | readiness | 匿名 | 无 | 200 `{"status":"ready"}` | 403/429/503 `{"status":"not_ready","reason":...}` |
| E2 | `GET /v1/status` | 详细状态 | Bearer | 无 | `StatusResponse` | 400/401/403/503/500 |
| E2 | `GET /v1/personas` | Persona 列表 | Bearer | `state?`,`limit?` | `{personas:[PersonaView]}` | 400/401/403/500 |
| E2 | `GET /v1/personas/:personaId` | 单个 Persona | Bearer | 无 | `{persona:PersonaView}` | 400/401/403/404/500 |
| E2 | `GET /v1/personas/:personaId/events` | 事件元数据列表 | Bearer | `status?`,`limit?` | `{events:[EventView]}` | 400/401/403/500 |
| E2 | `GET /v1/personas/:personaId/events/:eventId` | 单个事件元数据 | Bearer | 无 | `{event:EventView}` | 400/401/403/404/500 |
| E2 | `GET /v1/personas/:personaId/tasks` | 任务只读元数据 | Bearer | `state?`,`limit?` | `{tasks:[TaskView]}` | 400/401/403/500 |
| E2 | `GET /v1/personas/:personaId/sessions` | 会话只读元数据 | Bearer | `limit?` | `{sessions:[SessionView]}` | 400/401/403/500 |
| E3 | `POST /v1/personas` | 创建 Persona | Bearer | `{displayName}` | 201 `{persona}` | 400/401/403/500 |
| E3 | `POST /v1/personas/:personaId/start` | 启动 Persona | Bearer | 无 | `{persona}` | 400/401/403/404/409/500 |
| E3 | `POST /v1/personas/:personaId/suspend` | 暂停 Persona | Bearer | 无 | `{persona}` | 同上 |
| E3 | `POST /v1/personas/:personaId/resume` | 恢复 Persona | Bearer | 无 | `{persona}` | 同上 |
| E3 | `POST /v1/personas/:personaId/stop` | 停止 Persona | Bearer | 无 | `{persona}` | 同上 |
| E4 | `GET /v1/ws` | WebSocket 升级 | 首帧鉴权 | 无 HTTP body | WebSocket | 401/403/426 |

明确不存在：

- `POST /v1/stimuli`；
- 任何 task 写接口；
- Archive/Action/认知/记忆接口；
- 配置修改或远程停机接口。

### 4.2 DTO 字段（管理 API 本地 wire types）

这些 DTO 定义在 `apps/soul-daemon/src/api/wire.ts`，**不新增 Contracts 文件**。

**PersonaView**

```ts
{
  id: string;
  displayName: string;
  state: 'CREATED' | 'STARTING' | 'RUNNING' | 'SUSPENDED' | 'STOPPING' | 'STOPPED' | 'FAILED';
  version: number;
  createdAt: number;
  updatedAt: number;
}
```

默认不返回 `bootId`、`epoch`、`runtimeState`。若后续需要管理员诊断，另行批准。

**EventView**

```ts
{
  id: string;
  status: string;
  statusReason: string | null;
  receivedAt: number;
  occurredAt: number | null;
  archiveState: string;
}
```

不返回 `summary`、`archiveRef`、正文、`adapterEventRef`、`sessionId`。

**TaskView**

```ts
{
  id: string;
  state: string;
  kind: string;
  channel: string;
  priority: number;
  attempt: number;
  scheduledAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}
```

不返回 `payloadJson`、`runId`。

**SessionView**

```ts
{
  id: string;
  adapterId: string;
  openedAt: number;
  closedAt: number | null;
}
```

不返回 `externalId`、`metaJson`。

**StatusResponse**

只映射当前 `DaemonStatus` 已有的字段，**不新增无来源字段**：

| 字段 | 权威来源 | 类别 | 说明 |
|---|---|---|---|
| `phase` | `SoulDaemon.#phase` | DaemonStatus 已有 | 当前生命周期值 |
| `pid` | `process.pid` | DaemonStatus 已有 | 进程 PID |
| `startedAt` | `#startedAt` | DaemonStatus 已有 | 仅在 RUNNING 赋值；之前为 null |
| `bootId` | `#lock?.holder.bootToken ?? null` | DaemonStatus 已有 | 当前锁的 boot token；没有锁时为 null |
| `storeOpen` | `#store !== null` | DaemonStatus 已有 | **引用存在性**，不是实时 DB 探针 |
| `lockHeld` | `#lock !== null` | DaemonStatus 已有 | **引用存在性**，不是重新查询 OS 锁 |
| `personaLifecycleAssembled` | `#lifecycle !== null` | DaemonStatus 已有 | 只表示对象已装配 |
| `recovery` | `#recovery` | DaemonStatus 已有 | 启动时的 Recovery 摘要；不是运行期实时恢复 |
| `scheduler` | `#scheduler?.stats() ?? null` | DaemonStatus 已有（A1） | 每次读取调用；无 scheduler 引用时为 null；当前 stop 开始时清引用，因此 DRAINING 可能为 null，不补造 |
| `components` | `#surface.components` | DaemonStatus 已有 | 当前 surface；http/health 按 §3.10 的 component 枚举更新 |
| `capabilities` | `#surface.capabilities` | DaemonStatus 已有 | 当前 surface；http/health 按 §3.10 的 capability 枚举更新；不得只凭 scheduler running 推断 dispatch |

**SH-009 本地派生但不在 StatusResponse 中新增的字段**：

- `httpApi` / `healthEndpoint` 的 running 状态来自 `#surface` + API server listening 标志；
- readiness 的 `ready/reason` 由 `DaemonApi.getReadiness()` 即时派生；
- 这些不添加 `queueDepth`、`lastCommit`、`lastError`、`apiListening` 等无当前可靠来源的字段。

`StatusResponse` 不包含 `dataDir`、`databaseFile`、Token、环境变量或路径。Contracts 不变。

### 4.3 本地错误映射

Fastify 层统一转换为 §3.2 的固定错误信封。

| 来源 | 映射 |
|---|---|
| 缺失/错误 Bearer | `unauthorized` 401 |
| Host/Origin 不允许 | `forbidden` 403 |
| JSON 解析失败、路径/查询格式错误、Runtime `invalid_argument`/`schema_invalid` | `invalid_request` 400 |
| Persona/Event/Task/Session 不存在、Runtime `not_found` | `not_found` 404 |
| Runtime `illegal_transition`/`version_conflict` | `conflict` 409 |
| Fastify body limit | `too_large` 413 |
| 本地限流 | `rate_limited` 429 |
| draining、Runtime `closed`、服务未就绪的写请求 | `unavailable` 503 |
| 其他未分类/内部异常 | `internal_error` 500 |

Fastify 的 404/405 统一收敛为 `not_found` 404；不返回框架默认错误对象。

### 4.4 Health 响应（匿名最小信息）

`GET /v1/health/live`：

```json
{ "status": "ok" }
```

`GET /v1/health/ready` 成功：

```json
{ "status": "ready" }
```

失败（503）：

```json
{ "status": "not_ready", "reason": "store_unavailable" }
```

固定原因枚举：

- `phase_not_running`
- `store_unavailable`
- `lock_not_held`
- `recovery_incomplete`
- `draining`
- `api_not_listening`

不返回 pid、bootId、phase、Store 路径、Scheduler 统计、Persona 名称或错误文本。

### 4.5 Host / Origin / CORS

- 监听：`server.listen({ host: '127.0.0.1', port: 18700 })`；不得用 `0.0.0.0` 或 `::`。
- Host 允许精确值：`127.0.0.1:18700`；拒绝 `localhost`、其他主机名、缺失 Host、带错误端口。
- Origin：
  - 有 Origin 时必须精确等于 `http://127.0.0.1:18701`；
  - 未来 Daemon 托管 Studio 时增加 `http://127.0.0.1:18700`（同源）；
  - 其他 Origin 一律 403；
  - 无 Origin 的非浏览器客户端允许，但仍须 Token。
- CORS：
  - 只对 allowlist Origin 返回 `Access-Control-Allow-Origin` 精确值；
  - 允许方法 `GET, POST, OPTIONS`；
  - 允许头 `Authorization, Content-Type`；
  - 不允许 credentials / `*`；
  - `Vary: Origin`；
  - `OPTIONS` 仍需 Host/Origin 校验，不经过 Bearer。
- DNS rebinding：loopback bind + Host 精确校验 + Origin allowlist + Token；不得把 Host/Origin 校验当唯一认证。

### 4.6 HTTP 资源限制

以下为实现常量，E2 以测试固定，不新增环境变量：

| 限制 | 值 |
|---|---|
| JSON body limit | 64 KiB |
| Content-Type | `application/json`（无 body 的动作除外） |
| 全局限流 | Token Bucket：容量 20，补充 2 tokens/s，每请求消耗 1 |
| 连接超时 | 30 秒 |
| keep-alive | 5 秒 |
| 每 socket 最大请求 | 1000 |
| 列表默认 limit | 50（Persona / Event / Task / Session） |
| 列表最大 limit | 200（四类一致） |
| 响应头/正文 | 只返回固定 DTO；不回显请求 |

列表 `limit` 规则（四类一致）：

- 缺省/空值：50；
- 必须是十进制整数 1–200；
- `limit=0`、负数、小数、非数字、超过 200：`invalid_request` 400；
- 超过最大值不截断、不夹值；
- 首版没有游标分页；请求 `limit` 是返回上限，服务端可以在达到该上限时返回较少记录，**不声称完整列表**。

限流使用**Daemon 全局 Token Bucket**：

- `remoteAddress` 在只监听 `127.0.0.1` 时无法区分客户端，因此不做 per-IP 分桶；
- 全局共享一个 bucket，容量 20 tokens；
- 每秒补充 2 tokens，使用**单调时钟**（`performance.now()` 或注入的单调 clock，禁止 `Date.now()`）；
- 每个 HTTP 请求消耗 1 token，包括匿名 Health 路由；
- 请求到达时先按 `elapsed * 2` 补充（上限 20），不足 1 token 返回 `rate_limited` 429；
- 不引入数据库持久化、外部限流服务或后台轮询。

E2 测试必须注入 Fake Clock，不依赖真实等待。

---

## 5. Token 文件

### 5.1 路径、生成与读取

- 默认 `<SOUL_DATA_DIR>/api.token`；不提供环境变量覆盖。
- 在单实例锁成功之后、Store 打开之前生成/读取；失败即启动失败。
- 32 字节 `crypto.randomBytes`，base64url 编码（43 字符）。
- 启动时读入内存；运行期不重读。轮换需要停机、原子替换文件、重启。
- 客户端获取：CLI/Studio 用户手动从 `<SOUL_DATA_DIR>/api.token` 复制；Studio 只保存在内存，刷新后重新粘贴。不提供 bootstrap/HTTP 获取/环境变量覆盖/热轮换。

**首次创建**（路径不存在）：

1. 已确认 dataDir 是目录；POSIX 上还要通过 §5.2 的现有目录权限检查。
2. POSIX 用 `openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)` 创建；Windows 用 `openSync(path, 'wx', 0o600)`。`O_EXCL` 保证不覆盖已有路径；POSIX 若没有 `O_NOFOLLOW`，fail closed。
3. 同一 fd 上 `fstatSync`：必须是普通文件；POSIX 上 mode 必须精确为 `0600`（拒绝 setuid/setgid/sticky 及 group/other 位）；Windows 只验证普通文件。
4. 生成随机 token，`writeSync(fd, ...)`，`fsyncSync(fd)`，关闭。
5. 创建失败（EEXIST、ELOOP、权限、fstat 不符）不自动重生成；按现有文件路径重新走读取流程或启动失败。

**读取现有文件**：

1. **不得**先 `lstat` 再按路径 `readFile`；必须在同一 fd 上完成打开、`fstat`、权限检查和读取，避免检查/使用竞态。
2. POSIX：`openSync(path, O_RDONLY | O_NOFOLLOW)`；若运行时没有 `O_NOFOLLOW`，**fail closed**，不退回“先 lstat 再读路径”。
3. Windows：Node 没有可依赖的 `O_NOFOLLOW` 语义，使用 `openSync(path, 'r')`，立即 `fstatSync(fd)` 确认普通文件；打开前允许一次 `lstat` 只用于快速拒绝符号链接，但**不把它当作竞态证明**。Windows 的残余替换竞态由数据目录 ACL/同用户信任模型承担，并在文档中记录。
4. `fstatSync`：必须是普通文件；不得是目录、socket、设备。
5. POSIX：同一 `fstat` 的 `uid` 必须是当前进程 uid；mode 必须精确为 `0600`；否则启动失败。
6. 从同一 fd 读取有限字节（最多 128 字节）；内容必须是 43 字符 base64url，允许单个结尾换行；多余字节、空文件、非 UTF-8 或格式不符均失败。
7. 所有路径在 `finally` 中关闭 fd；异常不包含 token 内容。

已存在但非法：启动失败，不自动重生成、不覆盖。打开 fd 后即使路径被替换，本次启动也只读取已经打开的 inode，不会把“旧 fstat + 新路径内容”混用。

### 5.2 权限与信任边界

**POSIX 现有 dataDir 检查**（每次启动，不只是首次创建）：

- `statSync(dataDir)` 必须是目录；
- `(mode & 0o077) === 0`，即 group/other 没有任何权限；
- `stat.uid === process.getuid()`（运行平台支持时）；
- 不合格时启动失败（`api_token_insecure`），不自动 chmod、不自动迁移目录。
- 首次创建后再次 stat，确认目录仍符合上述条件。
- 目录 stat 是启动 guard；Node 没有可移植的 `openat`/`O_DIRECTORY` 文件描述符语义，因此不声称对同用户目录替换竞态完全免疫。Token 文件本身仍使用同一 fd 的 fstat/读取，不把目录检查当成文件读取的竞态证明。

**POSIX 现有 token 文件**：

- 必须是普通文件；
- `fstat.uid` 为当前进程 uid；
- mode 必须精确为 `0600`；
- 不接受 group/other 可读写、setuid/setgid/sticky 位。

**Windows**：

- `mode` 不等同 ACL；依赖 dataDir ACL 和同用户信任模型。
- 不新增 `icacls`/DPAPI 或原生模块；不声称 token 文件具有 0600 ACL。
- 测试只验证普通文件、格式、读取、符号链接快速拒绝和 fstat 行为；ACL 作为部署限制写入 README。
- Windows 上路径替换的残余竞态由同用户信任边界承担；不得把它描述成与 POSIX `O_NOFOLLOW` 等价。

**符号链接与替换**：

- POSIX 用 `O_NOFOLLOW`；符号链接打开失败，启动失败。
- POSIX 运行时缺少 `O_NOFOLLOW`：fail closed。
- Windows 的快速 `lstat` 不是安全证明；只用于拒绝明显的符号链接，最终仍以 fd 的 `fstat` 和 dataDir ACL 为边界。
- 测试覆盖：现有文件 0644/0400/符号链接、目录 0755、文件在打开后被路径替换（fd 读取不跟随新路径）。

### 5.3 鉴权

- HTTP：`Authorization: Bearer <token>`，严格 scheme/长度；`crypto.timingSafeEqual`。
- 不接受 query、Cookie 或自定义 header 中的 token。
- WS：首条 JSON 消息：

```json
{ "type": "auth", "token": "<token>" }
```

- 首条消息必须在 5 秒内到达，否则关闭；未鉴权连接最多 16 个；**所有入站消息**（包括首帧和认证后的消息）最多 4 KiB。
- 鉴权成功前不发送任何状态、不回显 token，也不发送 JSON 错误消息。
- 鉴权失败采用**纯关闭**，close code `1008`、reason `unauthorized`；日志只记录 `auth_failed` 事件，不记录 token。
- 首帧格式错误、非 `auth`、额外字段：close `1008` `invalid_auth`；首帧超时：close `1008` `auth_timeout`。

### 5.4 日志与错误

- Token 不进入 `logger`、异常 message、Fastify default error、响应。
- 测试用 logger sink 断言 token 字符串不出现。
- 认证失败不区分“缺失/错误/格式不对”，统一 `unauthorized`。

---

## 6. WebSocket 协议

### 6.1 连接

- 路径 `/v1/ws`，同端口，IPv4 loopback。
- HTTP Upgrade 阶段不读取 Token；升级后建立 socket，进入未鉴权状态。
- 必须请求/协商子协议 `soul.ws.v1`；缺失或不匹配 → 拒绝升级（HTTP 426 或升级失败）。
- Host/Origin 校验与 HTTP 完全一致。
- 不允许 URL query 携带 token。

### 6.2 鉴权与首帧

- 连接后 5 秒内必须发送 `auth` 首帧。
- **所有入站 WebSocket 消息统一最大 4 KiB**，包括认证消息和认证后的 `pull`/未知消息。
- **传输层必须设置硬上限**：`@fastify/websocket` 注册时设置 `options.maxPayload: 4096`（或经实际依赖验证的等效 transport 上限），不得只在应用层 `message` 回调收到完整帧后才检查长度。应用层仍保留 4 KiB 的统一协议检查作为第二道防线。
- 任意阶段收到超限消息：传输层以 `1009` 结束连接；服务端原因标识固定为 `frame_too_large`，不得先解析或缓存整个超大帧。若依赖库自行生成 close 文本，E4 必须验证 1009 行为和 Daemon 的归一化原因映射，不能声称精确 wire text 已实现。
- 服务端只接受 `soul.ws.v1` 协议。
- 鉴权成功后发送 `hello`，随后发送一次权威 snapshot；客户端可以发送 `pull` 请求新 snapshot。
- **连接名额**：
  - Upgrade 开始前原子预留一个未鉴权名额；未鉴权名额已满（16）时直接 HTTP 503 `unavailable`，不建立 socket。
  - **预留成功后，若 HTTP Upgrade 失败、握手被拒、握手期间客户端断开或 socket 在鉴权前报错/关闭，必须释放该预留名额且只释放一次**；由 upgrade 错误路径与连接关闭路径共用幂等的 slot release，不得把失败握手计入活动连接。
  - 鉴权成功时原子转换为已鉴权名额；若已鉴权名额已满（32），close `1013` `server_busy` 并释放原未鉴权名额。
  - 鉴权失败、超时、非法首帧、断开、服务关闭均释放当前名额一次；不得重复释放或泄漏。
  - 所有计数和转换在单线程事件循环内完成；先预留再升级，因此不存在“检查通过后、建立连接前”的超额窗口；失败/关闭路径必须回收预留，不能永久占用名额。
- `pull` 采用**合并重复待处理**策略：每连接最多一个 pending pull 或一个正在生成的 snapshot；已有 pending/正在生成时再次 `pull` 只标记一次“dirty”，不排队、不创建新任务。一次 snapshot 发送完成后最多再处理一次 dirty pull，然后清空。
- 每连接出站队列最多 64 条或 1 MiB（先到者）；慢客户端关闭，不阻塞 Daemon。

### 6.3 消息

**server → client**

```json
{ "type": "hello", "protocol": "soul.ws.v1", "serverTime": 1800000000000 }
```

```json
{ "type": "snapshot", "status": { /* StatusResponse 的只读投影 */ } }
```

```json
{ "type": "shutting_down", "reason": "daemon_stop" }
```

**client → server**

```json
{ "type": "pull" }
```

约束：

- 首版只有 `hello`、`snapshot`、`pull`、`shutting_down` 和 `auth`。
- 不做周期性推送；不做事件续传；不做事件流。
- `snapshot` 是权威状态在该时刻的快照；断线重连必须重新鉴权并重新 pull，不能依赖缓存。
- WS 不提供任何写命令；所有管理写操作只能走 HTTP。
- **所有协议/鉴权错误都采用纯关闭，不发送 JSON 错误消息**；原因是首版消息集合固定，且错误消息可能被误当成状态。

#### 6.3.1 固定 close code 表

未鉴权名额满时在 Upgrade 前拒绝 HTTP 503，不建立 socket；已鉴权名额满时发生在鉴权转换阶段，使用下表 `server_busy`。

| 场景 | close code | reason |
|---|---:|---|
| 未在 5 秒内鉴权 | 1008 | `auth_timeout` |
| 鉴权 token 错误/缺失 | 1008 | `unauthorized` |
| 首帧不是合法的 `auth` 对象、字段多余 | 1008 | `invalid_auth` |
| 任意入站消息超过 4 KiB | 1009 | `frame_too_large` |
| 首帧/后续帧非法 JSON | 1003 | `invalid_json` |
| 未知消息类型 | 1003 | `unknown_message` |
| 鉴权前发送 `pull` 或其他消息 | 1008 | `unauthorized` |
| 鉴权成功时已鉴权名额已满 | 1013 | `server_busy` |
| 出站队列/慢客户端超限 | 1013 | `slow_client` |
| 服务关闭 | 1001 | `daemon_stop` |

- 子协议缺失/不匹配在 HTTP Upgrade 阶段拒绝（HTTP 426），不建立 WebSocket、不适用 close code。
- 鉴权失败不返回 HTTP 401 JSON（已经升级为 WS）；只在日志记录 `auth_failed`，关闭码固定。
- 未知消息不忽略，统一 close `1003` `unknown_message`；不触发任何状态变更。

### 6.4 关闭与资源

- DRAINING 时 `beginDrain()`：
  1. 立即停止接受新升级；
  2. 对所有已鉴权连接丢弃待发送的 snapshot，优先放入 `shutting_down`；
  3. 发送 `shutting_down`（reason 固定 `daemon_stop`），随后 `close(1001)`；
  4. 不从连接队列等待客户端 close handshake，连接从集合移除；无法发送/队列已满的连接直接 close/terminate。
- `api.close()` 不等待 WS close handshake；WS 关闭是 transport cleanup，不是 Store 关闭的替代。`shutting_down` 尽力送达，不承诺网络级可靠。
- 关闭后清空出站队列；不保留重放/续传状态。
- 慢客户端或队列溢出：close `1013` `slow_client`；不得影响其他连接或 Daemon 主流程。
- 不设后台心跳轮询；首版没有周期性 ping 循环。鉴权超时和连接上限使用一次性定时器/计数。

---

## 7. Health 语义

### 7.1 ready 判定

返回 200 当且仅当：

1. `phase === 'RUNNING'`；
2. `store.isClosed === false`；
3. `isStoreUnusable(store) === false`；
4. `lockHeld === true`；
5. Recovery 已完成（启动摘要存在且无 `incomplete`）；
6. 未处于 `DRAINING`；
7. API 监听标志为真。

`lockHeld` 是 Daemon 当前持有的 `InstanceLock` 引用，**不重新读取锁文件**；Health ready 使用该进程内所有权句柄。外部删除锁文件不在同用户信任模型的支持范围，SH-009 不新增锁文件复核/文件系统探针。`storeOpen` 也同样来自 Daemon 引用；ready 的 Store 判断额外使用 `store.isClosed` 和 `isStoreUnusable`，不是写探针。

Scheduler 状态不进入 ready 的硬条件；它只在鉴权 `/v1/status` 中报告。这样不会把 `handlerKinds=0` 误报成“不能提供管理 API”。

### 7.2 不可伪造的数据

以下 RUNTIME-LIFECYCLE §10 目标字段当前没有可靠来源，SH-009 **不返回**：

- 队列深度（按 channel）；
- 最近一次成功提交时间；
- 最近一次错误。

不得用日志、猜测或空值冒充。它们作为后续 Runtime 统计接口/独立批次处理。Health v1 只返回 §3.8 的固定原因枚举和 liveness 固定 `ok`。

### 7.3 无后台循环

Health 每次请求即时计算；不注册 `setInterval` 健康检查、不启动 supervisor、不探测外部服务。

---

## 8. DaemonApi 窄接口与数据流

### 8.1 接口

API Server 只接收：

```ts
interface DaemonApi {
  getStatus(): DaemonStatus;
  getReadiness(): { ready: boolean; reason: ReadyReason | null };
  listPersonas(query: { state?: PersonaState; limit: number }): readonly PersonaView[];
  getPersona(id: PersonaId): PersonaView | null;
  createPersona(input: { displayName: string }): Promise<PersonaView>;
  startPersona(id: PersonaId): Promise<PersonaView>;
  suspendPersona(id: PersonaId): Promise<PersonaView>;
  resumePersona(id: PersonaId): Promise<PersonaView>;
  stopPersona(id: PersonaId): Promise<PersonaView>;
  listEvents(input: { personaId: PersonaId; status?: EventStatus; limit: number }): readonly EventView[];
  getEvent(input: { personaId: PersonaId; eventId: EventId }): EventView | null;
  listTasks(input: { personaId: PersonaId; state?: TaskState; limit: number }): readonly TaskView[];
  listSessions(input: { personaId: PersonaId; limit: number }): readonly SessionView[];
}
```

- 不包含 `Store`、`DatabaseSync`、`Repositories`、`PersonaLifecycle`、`StimulusIngress`、`TaskScheduler`。
- 不向 API 暴露 `acceptStimulus`。
- 所有方法由 `SoulDaemon` 内部组合现有 public APIs 实现；API 路由不执行 SQL。
- Event/Task/Session 读取由 Daemon 内部调用 `createRepositories(store)` 并映射为 DTO；Repository 句柄不离开 Daemon。
- Persona 操作调用 `PersonaLifecycle`；错误在 Daemon 层映射为固定的 API 错误语义。

### 8.2 数据流

```text
HTTP request
  -> Fastify auth/Host/Origin/body-limit/rate-limit
  -> route validator (local wire schema)
  -> DaemonApi method
  -> PersonaLifecycle or private Repository calls
  -> DTO mapping (no raw row)
  -> fixed response/error envelope
```

WS：

```text
Upgrade -> first-frame auth -> DaemonApi.getStatus() snapshot
        -> client pull -> DaemonApi.getStatus()
        -> DRAINING -> shutting_down -> close
```

---

## 9. 生命周期集成

### 9.1 启动

```text
BOOTING
  config
  logging
  dataDir + write probe
  instance lock
  token load/create
  Store open
MIGRATING
  migrate + verifySchema
RECOVERING
  Persona Recovery
  Runtime Recovery
READY
  Ingress create
  Scheduler create + start
  API server create + listen(127.0.0.1:18700)
  surface httpApi/healthEndpoint = running
RUNNING
```

- API listen 之前必须完成 Scheduler.start，符合冻结顺序。
- 端口占用 → `http_api_start_failed`，退出码 5；不换端口。
- Token 文件非法 → `api_token_invalid`（Daemon 本地错误码），启动失败，退出码 5。
- API server 创建/监听失败时，清理顺序固定为：API close（若已创建）→ Ingress close → `await scheduler.stop()` → Store close → Lock release。**只有 Scheduler stop 成功完成后**才可执行 Store/Lock 清理。
- **API listen 失败 + Scheduler stop 成功**：完成上述 Store/Lock 清理，启动错误保持 `http_api_start_failed`，最终退出码 5。
- **API listen 失败 + Scheduler stop reject**：不得关闭 Store、不得释放 Lock；不伪造/固定退出码绕过资源保留；记录 `shutdown_failed`，由正常停止路径报告 6（若能够 settle），否则保持 pending。
- **API listen 失败 + Scheduler stop 不 settle**：保持等待；不得关闭 Store/Lock；不得用超时、`process.exit` 或固定退出码绕过 D-R1。
- **API close 失败**：不执行 Store/Lock 清理；`shutdown_failed`，不能因为原始启动错误是 5 就覆盖资源保留规则。
- **Store.close 失败**：保留 Lock，`shutdown_failed`/退出 6。
- 启动中 stop：在 API listen 前后都有 boundary；结果 `startup_aborted`，按同一资源规则清理；若清理中的 Scheduler/API 失败，仍以 E4 保留规则优先。

### 9.2 关闭

```text
DRAINING
  api.beginDrain()       // 新请求 503；WS 停止升级并广播 shutting_down
  ingress.close()
  await scheduler.stop()
  await api.close()      // 关闭 listener、等待在途请求/WS；失败则不关 Store/不放 Lock
CLOSING
  Store.close()
  Instance Lock.release()
STOPPED
```

- `scheduler.stop()` 未 resolve 前不得进入 `api.close()` 后的 Store 关闭；若 stop reject，留在 DRAINING，不关 Store、不放 Lock。
- `api.close()` 失败：不关 Store、不放 Lock，`shutdown_failed`；这是新的资源安全条件。
- Store.close 失败：保留 Lock（D-E4-LOCK-1）。
- `api.beginDrain()` 失败：不进入 CLOSING，Store/Lock 不动，`shutdown_failed`；不得用强制 Store 关闭绕过。
- 不新增强制关闭超时；API/WS 关闭也不得用超时绕过 Scheduler/Store 规则。
- `Ingress.close()` 失败仍继续后续清理并报告失败；API close 失败不继续 Store（因为可能有请求仍持有 Store）。
- `api.close()` 不等待 WebSocket close handshake；WS 在 beginDrain 已发送 `shutting_down` 并 close/terminate；HTTP 在途请求必须在 API close 返回前结束。
- 关闭顺序中的 `CHECKPOINTING` 仍只跳过。

### 9.3 失败矩阵

| 失败点 | 行为 | Store/Lock | 结果 |
|---|---|---|---|
| Token 文件非法 | 启动失败；不打开 Store/不启动 API | 已获取的 Lock 按启动失败清理 | 退出 5 |
| API 端口占用/listen 失败 + Scheduler stop 成功 | API close、Ingress close、Scheduler stop、Store/Lock 清理 | 释放 | 退出 5，不进入 RUNNING |
| API listen 失败 + Scheduler stop reject | 不关闭 Store、不释放 Lock；记录 shutdown failure | 保留 | 若 stop 可 settle 则 6；不得伪造 5 |
| API listen 失败 + Scheduler stop 不 settle | 保持等待，不关闭 Store/Lock | 保留 | pending；无强制超时 |
| API close reject（启动或正常关闭） | 不进入 CLOSING，不关闭 Store/Lock | 保留 | `shutdown_failed`（正常关闭时 6） |
| Scheduler stop reject | 留在 DRAINING，API 保持 drain；不关闭 Store/Lock | 保留 | `shutdown_failed`（6） |
| Store.close reject | 不调用 Lock.release | Lock 保留 | 退出 6 |
| API/WS 慢连接 | beginDrain 关闭/terminate，不阻塞 Scheduler/Store 规则 | 取决于后续步骤 | 不得提前关 Store |

---

## 10. 分批实施计划

### E1 — Token、错误信封、DaemonApi 基础

| 项 | 内容 |
|---|---|
| 目标 | Token 生命周期、本地错误类型/固定文案、窄化 `DaemonApi` 类型和常量定义；不启动 HTTP |
| 新增/修改文件 | `apps/soul-daemon/src/api/token.ts`（新）、`api/errors.ts`（新）、`api/wire.ts`（新）、`api/daemon-api.ts`（新）、`src/errors.ts`（token 启动错误码）；测试 `test/api-token.test.ts`、`test/api-errors.test.ts`、`test/api-daemon-api.test.ts`（新） |
| 依赖 | 无 |
| 公开接口 | 内部 `loadOrCreateApiToken(dataDir)`、本地 `ApiError`/`ERROR_MESSAGES`、`DaemonApi` 类型、端口/版本常量 |
| 数据流 | 文件 Token → 内存 verifier；无 HTTP |
| 前置 | 本计划批准 |
| 测试 | 生成 32 字节/base64url；`wx`/0600；已存在合法读取；非法/符号链接/目录失败；不自动重生成；Token 不出现在异常；恒定时间比较；Windows 功能性（不宣称 ACL） |
| 验收 | POSIX 权限测试；无 Token 日志；错误文案固定 |
| 风险 | Windows ACL；测试临时目录清理 |

### E2 — Fastify HTTP 只读 API 与生命周期接线

| 项 | 内容 |
|---|---|
| 目标 | Fastify server、匿名 health、鉴权 status、Persona/Event/Task/Session 只读端点、Host/Origin/limit/auth，Daemon 启动/关闭接入 |
| 新增/修改文件 | `apps/soul-daemon/package.json`、`pnpm-lock.yaml`、`src/api/server.ts`（新）、`api/http/{auth,host-origin,errors,limits}.ts`（新）、`api/routes/{health,status,personas-read,events-read,tasks-read,sessions-read}.ts`（新）、`src/daemon.ts`、`src/phases.ts`、`src/logger.ts`、`src/main.ts`、`src/errors.ts`；测试 `test/api-http.test.ts`、`test/api-lifecycle.test.ts`、`test/process.test.ts` 扩展 |
| 依赖 | `fastify@5.12.8`（候选，见 §11） |
| 公开接口 | `GET /v1/health/live`、`/v1/health/ready`、`/v1/status`、Persona/Event/Task/Session GET |
| 数据流 | Fastify → auth/limits → DaemonApi read → DTO |
| 前置 | E1 |
| 测试 | `fastify.inject` 401/403/404/400/413/429/503；Host/Origin 矩阵；匿名 health；status auth；只读端点无 SQL；启动/关闭顺序；端口占用；**API listen 失败 + Scheduler stop reject/挂起**。HTTP 单元测试直接构造 `createLocalApiServer({ port: 0 })`；Daemon 生命周期测试使用模块 mock 或固定的 18700 真实端口，二者不得引入生产 test seam。 |
| 验收 | 只监听 127.0.0.1:18700；不自动换端口；无 Token/正文日志；API 失败不影响 Store 安全 |
| 风险 | Fastify 版本/类型；固定端口测试；API close 失败路径 |

### E3 — Persona 管理写 API

| 项 | 内容 |
|---|---|
| 目标 | create/start/suspend/resume/stop；固定错误映射；无 task/stimulus 写 |
| 新增/修改文件 | `api/routes/personas-write.ts`（新）、`api/server.ts` 接线、`src/daemon.ts` 的 `DaemonApi` 实现；测试 `test/api-personas.test.ts`（新） |
| 依赖 | 无新增 |
| 公开接口 | 4 个 Persona 动作 + create |
| 数据流 | HTTP → DaemonApi → PersonaLifecycle → DTO |
| 前置 | E2 |
| 测试 | 创建；404；409；displayName 1–128、空白/控制字符拒绝；状态动作；draining 时 503；错误文案固定；无正文回显 |
| 验收 | 写操作只经 PersonaLifecycle；API 无 SQL；Token 保护；Host/Origin 仍生效 |
| 风险 | 并发动作/版本语义；无 If-Match |

### E4 — WebSocket

| 项 | 内容 |
|---|---|
| 目标 | `/v1/ws` 首帧鉴权、`hello`/`snapshot`/`pull`/`shutting_down`、资源上限、关闭流程 |
| 新增/修改文件 | `apps/soul-daemon/package.json`、`pnpm-lock.yaml`、`src/api/ws.ts`（新）、`api/ws-protocol.ts`（新）、`src/api/server.ts`、`src/daemon.ts` 的 drain hook；测试 `test/api-ws.test.ts`（新）、`test/process.test.ts` 扩展 |
| 依赖 | `@fastify/websocket@11.3.7`（候选；包含 `ws`） |
| 公开接口 | `/v1/ws`；无写命令 |
| 数据流 | Upgrade → first-frame auth → snapshot/pull → DRAINING shutdown |
| 前置 | E2（E3 可并行，但不是 E4 前置） |
| 测试 | 首帧超时；错误 token；Host/Origin；协议不对；`maxPayload:4096` 传输层超大帧拒绝（handler 未收到完整帧，1009）；未鉴权/已鉴权重名额预留、Upgrade 失败释放、转换；重复 pull 合并；慢客户端；队列上限；shutdown 广播；重连重新 pull |
| 验收 | 无 URL token；无周期性推送；无事件续传；不阻塞 Daemon；API close 失败不关 Store |
| 风险 | 浏览器 Token 内存暴露；WS close 挂起；插件 API |

E2/E4 还必须更新现有测试中的 API 表面断言：`daemon.test.ts` 的 `skippedSteps`、`ready.test.ts`/`ready-failure.test.ts` 的 `httpApi`/`healthEndpoint`、`phases.test.ts` 的步骤状态。只能增加/改写这些状态预期；不得删除既有 Scheduler/Store/Lock 关闭断言，也不得削弱 E4 回归。

### E5 — 加固、进程测试、文档

| 项 | 内容 |
|---|---|
| 目标 | 真实进程/端口/token/security 回归；consumer-check/CI；README/架构文档状态同步 |
| 新增/修改文件 | `apps/soul-daemon/test/process.test.ts`、`README.md`、`docs/PLAN.md`、`docs/architecture/{OVERVIEW,MODULES,RUNTIME-LIFECYCLE}.md`（仅已批准的状态/接口同步）、必要的 API 说明文档 |
| 依赖 | 无新增 |
| 公开接口 | 无新接口；文档同步 |
| 前置 | E1–E4 |
| 测试 | 真实 `dist/main.js` 启动/停止；端口占用；Token 非法；Host/Origin；管理 API；WS；SIGTERM；重启；无残留锁/Store |
| 验收 | `pnpm run check`；consumer-check；文档不夸大；不虚假声明 Adapter/Handler/Health 队列指标 |
| 风险 | fixed 18700 端口；Windows ACL；CI 依赖安装 |

### 10.1 依赖关系

```text
E1 -> E2 -> E3
        └-> E4
E1–E4 -> E5
```

E4 只依赖 E2 的 server/health/status；E3 与 E4 可并行，但必须分别独立复审。E5 必须等待 E1–E4 全部通过。

---

## 11. 依赖与版本候选

### 11.1 Fastify

- 候选：`fastify@5.12.8`。
- 当前仓库无该依赖；不能把“最新版”当已批准。
- package 元数据没有 `engines` 字段；必须在 Node `24.21.0`（`.nvmrc`）上实际运行 `pnpm install`、typecheck、测试后才能确认。
- Fastify 5 的依赖树包含 pino/avvio 等；默认 request logging 必须关闭，使用 Daemon logger 的受控事件/字段。

### 11.2 WebSocket

- 候选：`@fastify/websocket@11.3.7`。
- 其依赖 `ws ^8.16.0`；不直接声明 `ws` 生产依赖。
- 注册插件时必须传 `options.maxPayload: 4096`，让传输层在接收阶段拒绝超大帧；应用层仍保留 4 KiB 检查作为第二道防线。
- 测试客户端使用 Node 24.21 的全局 `WebSocket`，避免新增直接 `ws` 依赖。
- 版本是否与 Fastify 5.12.8 类型/运行时兼容、`maxPayload` 是否按 1009 生效、close reason 是否可归一化，在 E4 安装后验证；不通过则停止，不用应用层长度检查冒充传输层上限。

### 11.3 pnpm / lockfile / allowBuilds

- pnpm `11.7.0`，frozen lockfile CI。
- 只允许修改 `apps/soul-daemon/package.json` 和 `pnpm-lock.yaml` 的依赖条目；不得升级已有包。
- Fastify/`@fastify/websocket`/`ws`/`duplexify`/pino 等目前未见必须的 install script；若 pnpm 报告需要 allowBuilds，停止并单独批准，不得静默扩大。
- `pnpm-lock.yaml` 的 importer 只增加 daemon 依赖；packages 段新增依赖版本必须由 lockfile 解析，不手写。

---

## 12. 测试矩阵

### 12.1 Token

| 场景 | 预期 |
|---|---|
| 首次无文件 | 生成 32 字节 base64url，文件普通、0600（POSIX）；目录 0700 |
| 已有合法文件 | 同 fd 读取，不覆盖 |
| 已有文件 mode 0644 | 启动失败（POSIX） |
| 已有文件 mode 0400 | 启动失败（要求精确 0600） |
| 目录 mode 0755 | 启动失败（现有目录检查，不自动 chmod） |
| 已有空/短/非 base64url/目录/设备 | 启动失败，不重生成 |
| 已有文件为符号链接 | POSIX O_NOFOLLOW 失败；Windows lstat 快速拒绝；不读取目标 |
| 路径在 open 后被替换 | 从已打开 fd 读取，不读取替换后的路径内容 |
| O_NOFOLLOW 不可用的 POSIX 平台 | fail closed（不退回路径读取） |
| 第二次启动 | 同一 token |
| 错误 token/缺 token | 401，无 token 返回 |
| 日志 sink 包含 token | 失败 |
| Windows | 普通文件/格式/读取通过；符号链接快速拒绝；不宣称 ACL 0600 |

### 12.2 Host/Origin/CORS

| 请求 | 预期 |
|---|---|
| Host `127.0.0.1:18700` + 合法 token | 允许 |
| Host `localhost:18700` | 403 |
| Host `evil.example` | 403 |
| 无 Origin + 合法 token（CLI） | 允许 |
| Origin `http://127.0.0.1:18701` | 允许并精确 CORS |
| Origin `http://localhost:18701` | 403 |
| Origin `https://evil.example` | 403 |
| OPTIONS 合法 Origin | 204，无 credentials |
| OPTIONS 非法 Origin | 403 |
| WS 非法 Host/Origin | 拒绝升级 |

### 12.3 HTTP 鉴权/限制/错误

| 场景 | 预期 |
|---|---|
| health live/ready 匿名 | 仅固定 status/reason |
| `/v1/status` 无 Token | 401 |
| 大小写/多余空格/Bearer 错误 | 401 |
| body > 64 KiB | 413 `too_large` |
| malformed JSON | 400 `invalid_request` |
| 未知路径/方法 | 404 `not_found` |
| 初始突发 20 次 | 全部通过；第 21 次 429 `rate_limited` |
| Fake Clock 前进 0.5 秒 | 补充 1 token；正好允许一次，其他仍受限 |
| Fake Clock 前进 1 秒 | 补充 2 tokens；验证边界与上限 20 |
| 连续请求跨路由（含 health） | 共享同一个全局 bucket |
| 真实时间等待 | 禁止用于补充测试 |
| Persona/Event/Task/Session 空 `limit` | 默认 50 |
| `limit=200` | 接受；最多 200 |
| `limit=201` | 400 `invalid_request`，不截断 |
| `limit=0/-1/1.5/abc` | 400 `invalid_request` |
| 超过默认/最大但 valid | 不声称返回完整列表；无游标 |
| draining | 503 `unavailable` |
| 未捕获异常 | 500 `internal_error`，无堆栈/正文 |

### 12.4 WS

| 场景 | 预期 |
|---|---|
| 无 auth 5 秒 | close 1008 `auth_timeout`；无 JSON 错误 |
| 错误 token | close 1008 `unauthorized`；无状态泄漏 |
| 首帧不是 auth/字段多余 | close 1008 `invalid_auth` |
| 任意阶段消息 > 4 KiB（含 auth 后） | 传输层 `maxPayload:4096` 拒绝；close 1009 `frame_too_large`；应用 handler 不收到完整超大帧 |
| 首帧/后续帧非法 JSON | close 1003 `invalid_json` |
| 未鉴权连接 > 16 | Upgrade 前 HTTP 503 `unavailable`；不建立 socket |
| 已鉴权 > 32（鉴权转换时） | close 1013 `server_busy`；释放原未鉴权名额 |
| 预留名额后 Upgrade 失败/握手断开 | 预留名额释放一次；下一个握手仍可用该名额 |
| 连续多次握手失败 | 不泄漏名额；随后合法连接可建立 |
| 正确 auth | hello + snapshot |
| `pull` | 新 snapshot |
| 连续重复 `pull` | 一个 in-flight + 一个 dirty 合并；不产生无界任务 |
| 断线/超时/失败 | 名额只释放一次；计数不泄漏 |
| 并发 Upgrade | 先预留再建连；不出现超过 16/32 的窗口 |
| 服务 DRAINING | 尽力发送 `shutting_down`，close 1001 `daemon_stop`；不等待 handshake |
| 慢客户端/队列满 | close 1013 `slow_client`；不阻塞其他连接 |
| URL query token | 不读取，视作无 token |
| 子协议缺失/错误 | HTTP 426 拒绝升级 |
| Origin/Host 非法 | 拒绝升级 |

### 12.5 生命周期/E4 回归

| 场景 | 预期 |
|---|---|
| 正常启动 | RUNNING，API listening，health ready |
| Scheduler stop 挂起 | DRAINING，Store/Lock 不关闭 |
| Scheduler stop reject | DRAINING，Store/Lock 不关闭，shutdown_failed |
| API close reject | 不进入 CLOSING，Store/Lock 不关闭，shutdown_failed |
| Store.close reject | Lock 保留，退出 6 |
| API listen 失败/端口占用 + Scheduler stop 成功 | 退出 5，资源释放，不进入 RUNNING |
| API listen 失败 + Scheduler stop reject | Store/Lock 保留，shutdown_failed；不得伪造 5 |
| API listen 失败 + Scheduler stop 不 settle | 保持 pending，Store/Lock 保留；无强制超时 |
| API close reject（启动/正常关闭） | 不进入 CLOSING，Store/Lock 保留，shutdown_failed |
| 启动中 stop | startup_aborted；清理按 Scheduler/API 失败规则优先 |
| WS 慢/挂起 + stop | beginDrain close/terminate；不阻塞 Scheduler/Store 规则；不提前关 Store |
| 现有 E4 关闭测试 | 原有断言保留；只增加 API/WS 步骤，不削弱 |

### 12.6 API / Health Surface

| 时刻 | 预期 |
|---|---|
| API 未引入 | 四个字段均为 `not_implemented` |
| server 创建、未 listen | components `assembled`；capabilities `unavailable` |
| listen 成功、RUNNING | components `running`；capabilities `available` |
| beginDrain、API close 前 | components `draining`；capabilities `draining` |
| API close 成功 | components `stopped`；capabilities `unavailable` |
| API close 失败 | components `failed`；capabilities `unavailable`；Store/Lock 保留 |
| API listen 失败 | components/capabilities 不进入 running/available；清理按 §9 |

### 12.7 真实进程

- `dist/main.js` 启动到 RUNNING，端口 18700，health/status/Persona 管理可用。
- 缺/错 Token、Host/Origin 非法、body 超限。
- SIGTERM：API beginDrain → ingress → scheduler → API close → Store → Lock；退出 0。
- 端口占用：退出 5，失败进程不持有 Store/Lock。
- 重启：token 复用；锁/Store 恢复；无重复事件。
- API close 失败：进程内测试/真实进程退出 6，锁保留。

---

## 13. 文档同步范围（E5）

E5 只同步已批准的状态/接口，不改变架构语义：

- `apps/soul-daemon/README.md`：API/WS/Health、Token 路径/权限/Windows 限制、**Studio 手动复制 Token 且仅内存保存**、端口、Host/Origin、错误、资源限制、生命周期。
- `docs/PLAN.md` §7/§13：SH-009 完成状态、P1 进度。
- `docs/architecture/OVERVIEW.md` §8/§9：API/WS/Health 当前实现状态。
- `docs/architecture/MODULES.md` §4/§5：Daemon 传输职责与当前状态。
- `docs/architecture/RUNTIME-LIFECYCLE.md` §2/§3/§10：API 启动/关闭、健康、无强制超时；不改变架构决议。
- `docs/architecture/TRUST-BOUNDARIES.md`：仅在需要记录本地 API 实际安全边界时增加状态说明，不改变红线。
- 不修改 `docs/SH-008E-PLAN.md`，除非独立任务要求历史状态同步。

---

## 14. 风险与停止条件

### 14.1 风险

| 风险 | 影响 |
|---|---|
| 固定端口 18700 被占用 | 启动失败；测试串行/端口竞争 |
| Windows token ACL 不足 | 同机其他用户可读 |
| 浏览器 Token 内存暴露 | Studio XSS/扩展可读；只用首帧/内存，无 Cookie |
| WS 首帧/慢客户端 | 未鉴权连接占用、内存增长 |
| API close 挂起 | Daemon 关闭挂起；不得强制关 Store |
| Fastify/插件版本不兼容 | 构建/类型/运行失败 |
| 新增依赖锁文件 | frozen lockfile/CI |
| Health 缺少队列/last error | 不满足 RUNTIME §10 全部目标；不得伪造 |
| 本地 token 单权限 | 无 Persona 级 scope；Studio 获得全部管理权限 |
| Host 精确校验阻断 `localhost` | 客户端必须用 127.0.0.1 |

### 14.2 停止条件

1. 需要修改 Persistence/Migration/Contracts/Runtime 业务语义，但未获单独批准。
2. Token 文件在目标平台无法达到可接受安全边界，且维护者不允许记录限制。
3. Fastify/@fastify/websocket 在 Node 24.21 / pnpm frozen lockfile 下无法通过。
4. API close 无法保证在 Store.close 前停止/隔离所有请求。
5. 要求实现 `POST /v1/stimuli` 或绕过 Adapter Registry。
6. 要求 Health 返回队列深度/最近提交/最近错误，但没有新增可验证统计接口。
7. 要求有界关闭/强制关库/放弃 Scheduler.stop，与 D-R1 冲突。
8. Host/Origin/CORS 无法按精确 allowlist 实现，或必须使用通配/Cookie。
9. 需要公开 Store/Repository/Runtime 句柄给 API。
10. 现有 E4 测试被削弱或关闭顺序被改变。

---

## 15. 仍需实际验证的实现细节

本计划在维护者最终裁决后**不再保留架构级 OPEN**。以下不是重新打开架构决议，而是 E1–E4 必须用真实运行验证/固定的实现细节；若验证失败，按 §14.2 停止：

- §4.6 的 64 KiB、Token Bucket（容量 20 / 2 tokens 每秒）、连接超时等是首版实现常量，不新增环境变量；若复审认为数值不合适，只调整常量与测试，不改变接口。
- API 单元测试可直接用 `port: 0` 构造本地 server；生产 Daemon 固定 `18700`，没有端口配置/回退。

- Fastify 5.12.8 与 Node 24.21、TypeScript strict/NodeNext 的实际编译/运行；
- `@fastify/websocket` 11.3.7 的首帧鉴权、close code、慢客户端行为；
- `@fastify/websocket` 依赖的 ws 版本是否与 lockfile 约束一致；
- pnpm 是否要求新的 `allowBuilds`（若有则停止/单独批准）；
- POSIX token 0600 与 Windows 文件行为；
- Fastify body limit/404/405/错误序列化与本地错误映射；
- 固定端口 18700 在测试环境的可用性；
- API close 失败路径与 WS 挂起时不得提前 Store 的实际测试；
- 只读 Event/Task/Session 查询的 scope 和 DTO 不含正文的测试。

---

## 16. 结论

SH-009 可以在现有 Daemon/Runtime/Persistence 公开接口上实施，不需要修改业务包、Migration 或 Contracts；管理 API 使用 Daemon 本地错误/DTO，Token 使用 `<dataDir>/api.token`，API 服务器通过窄化 `DaemonApi` 与现有组件交互，WebSocket 仅提供首帧鉴权后的 hello/snapshot/pull/shutting_down。

实施必须按 E1 → E2 → E3/E4 → E5 分批独立复审；每批完成即停止，不把阶段合并当成 SH-009 整批验收。

**本文件完成后停止，等待独立审查和下一步授权。**
