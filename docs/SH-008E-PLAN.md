# SH-008E — Daemon 集成与验收：规划任务书

- **文档状态**：规划草案，等待独立复审。**不是实施授权**，不表示 SH-008E 已开始或已完成。
- **适用基线**：`4f290e8607633db5a6f19ce9209f9edf42a9dc5c`（`main`，SH-008D D4.R1）。
- **实施范围（若后续获批）**：仅 `apps/soul-daemon/**`。不得修改 `packages/runtime`、`packages/persistence`、`packages/contracts`、Migration、其他生产模块或已有设计文档。
- **本文件约定**：每条设计都标注以下类别之一，禁止把建议读成已确认契约。
  - **【事实】** 当前仓库代码/文档可以直接核对的现状。
  - **【已确认决议】** 此前批次或本轮维护者已批准、不得在本批改写的决议（P1–P8、R8.3、D-RT1、D-R1/D-R2/D-R3、O-1–O-11 等）。
  - **【本次建议】** 本规划提出的、实现层面的设计；不得与已确认决议冲突。
  - **【开工前置】** 必须先满足的外部条件（O-0），不是设计选项。

**本修订（复审反馈）已落实的维护者决策**：

- **D-R1（关闭）**：删除“硬超时后放弃 Scheduler.stop 并关闭 Store”的方案；本批不提供强制关闭上界，Scheduler 未停止前不得关闭 Store。
- **D-R2（Handler）**：SH-008E 不注入 Handler Map；Scheduler 固定使用空 Handler 快照。`Object.freeze(new Map())` 不是不可变性保证，不得作为设计依据。
- **D-R3（测试）**：补充 Recovery 部分完成后的重启与幂等测试；保留原阶段划分与 `apps/soul-daemon/**` 代码边界。

---

## 1. 任务背景及目标

### 1.1 背景

`packages/runtime` 已经具备 Persona 生命周期、进程内 P1 Ingress（事件总线存储侧）、P1 Runtime Recovery 和 Task Scheduler；`apps/soul-daemon` 目前只完成 SH-007A 的基础设施半段（配置、日志、数据目录、单实例锁、SQLite、Migration、Schema、启停状态机）。二者之间没有接线：

- Daemon 不创建 Runtime 组件，不调用 `normalizeCrashedPersonas`、`recoverRuntime`、`createStimulusIngress` 或 `createScheduler`。
- `phases.ts` 把 `persona_recovery`、`runtime_recovery`、`event_bus`、`scheduler` 标为 `not_implemented`。
- Daemon 进入 `RUNNING` 只表示“持有数据库与锁”，不表示恢复或调度已发生。

**【事实】** 以上与 `apps/soul-daemon/README.md`、`docs/architecture/RUNTIME-LIFECYCLE.md` §2 注释、`docs/architecture/MODULES.md` 的现状描述一致。

### 1.2 本批目标

在**只改 Daemon**的前提下：

1. 在 `RECOVERING` 阶段装配 Persona 生命周期并执行崩溃归一与 `recoverRuntime`。
2. 在 `READY` 阶段装配进程内 Ingress 与 Scheduler，并启动 Scheduler。
3. 用同一 `Store` 对象满足 SH-008D 的 Recovery/Scheduler lease 互斥约束。
4. 设计并实现可关闭的生命周期：Scheduler 停止、Ingress 关闭、Store 关闭、锁释放，顺序正确、失败可报告、重复调用幂等。
5. 让启动报告、状态与日志如实区分“已装配”“已恢复”“可调度但无 Handler”“仍属 SH-009”。
6. 用确定性测试覆盖启动、关闭、回滚、重启、租约时序与资源释放，并保持现有退出码契约。

### 1.3 非目标（详见 §15）

不实现认知 Handler、HTTP/WebSocket、健康检查、检查点读写、显式 WAL checkpoint、Persona 自动启动、跨进程互斥扩展、SH-009 或 SH-007B 验收。

---

## 2. 基线与前置依赖

### 2.1 仓库基线

| 项 | 值 |
|---|---|
| 分支 | `main` |
| HEAD | `4f290e8607633db5a6f19ce9209f9edf42a9dc5c` |
| HEAD 父提交 | `8c10f395f71190a9b2bda476f067c79e293b9008`（D4） |
| 工作区 | 干净（规划开始时核对） |
| 最近提交链 | `4f290e8` D4.R1 → `8c10f39` D4 → `2fb31dd` PR #6（含 `52549e9` D3 → `86eab59` D3.R1）→ 更早的 D2.R1–R4：`9b5a55a`、`80a251c`、`ae54923`、`ea7afc9` |

**【事实】** `D4.R1` 的两项修正（Recovery 执行体内验证反向 lease、queued task 完整行快照）已独立复审通过；GitHub Actions Run #70（`45031522488`）attempt 2 全步骤成功。该次 CI 覆盖 Format/Lint/Typecheck/Test/Build/Consumer check。

### 2.2 SH-008D 验收状态与文档口径（O-0）

**【事实】** 维护者在本次任务书中确认：SH-008D 已完成并通过验收。  
**【事实】** 仓库现有文档仍在若干位置记录“D4 等待独立复审、SH-008D 整批未验收”，例如：

- `docs/PLAN.md`：顶部状态、§13 进度段、SH-008D 表行与审查表 D4 行；
- `packages/runtime/README.md`：状态行与 §1.5 开头；
- `docs/architecture/RUNTIME-LIFECYCLE.md`：状态行与 §4 注记；
- `docs/architecture/MODULES.md`、`OVERVIEW.md`、`IDENTITY-PROTOCOL.md` I05。

**【已确认开工前置条件 O-0】** SH-008E **不得开工**，直到 SH-008D 验收状态的文档口径已同步：

1. 由维护者/文档维护者提交一个独立的**文档状态同步提交**（只改状态描述，不改架构决议），使 `docs/PLAN.md`、`packages/runtime/README.md`、`docs/architecture/RUNTIME-LIFECYCLE.md`、`MODULES.md`、`OVERVIEW.md`、`IDENTITY-PROTOCOL.md` I05 与“SH-008D 已验收”一致；
2. 该提交已合入 `main`。

在上述提交合入之前，**O-0 视为未完成，SH-008E 实施不得启动**；验收阶段再补、仅口头说明或仅在实施报告中记录都不算满足开工前置。

**【本次建议】** 这不是代码缺陷，也不是 SH-008E 的实施内容：

- SH-008E 只改 `apps/soul-daemon/**`，不得顺手修改上述文档（本批范围与规划阶段都禁止）。
- SH-008E 自身 README 只能陈述本批的装配事实，不能替 SH-008D 宣布验收结论。
- O-0 完成后，本规划才可进入 E0 的实施准备；E0 仍需维护者的实施授权。

### 2.3 本规划的实际核对范围

实际阅读/核对的 repository 内容：

- 总计划与架构：`docs/PLAN.md`、`docs/architecture/OVERVIEW.md`、`MODULES.md`、`RUNTIME-LIFECYCLE.md`、`IDENTITY-PROTOCOL.md`（I05 相关段）。
- Runtime：`packages/runtime/README.md`、`src/index.ts`、`src/persona/lifecycle.ts`、`src/events/bus.ts`、`src/events/buffer.ts`、`src/recovery/recover.ts`、`src/recovery/budget.ts`、`src/scheduler/scheduler.ts`、`src/store-lease.ts`。
- Persistence：`src/index.ts`、`src/db/open-store.ts`、`src/migrations/migrator.ts`、`src/repositories/tasks.ts`、`src/repositories/events.ts`、`src/repositories/personas.ts`、`src/db/store.ts`。
- Daemon：全部 `src/*.ts`、`test/*.ts`、`test/helpers/harness.ts`、`package.json`、`README.md`、`tsconfig*.json`。
- 工程：根 `package.json`、`turbo.json`、`vitest.config.ts`、`pnpm-workspace.yaml`、`.github/workflows/ci.yml`、`pnpm-lock.yaml`（依赖解析方式）。
- Git 历史：`git log` 与 SH-008A–D 相关提交说明。

---

## 3. 已有能力清单

### 3.1 Runtime 包

| 能力 | 公开入口 | 现状与限制 |
|---|---|---|
| Persona 生命周期 | `createPersonaLifecycle({ store, logger, bootId, now?, randomBytes? })`；`createPersona` / `getPersona` / `listPersonas` / `queryPersonas` / `startPersona` / `suspendPersona` / `resumePersona` / `stopPersona` / `restorePersona` / `normalizeCrashedPersonas` | **【事实】** 只做进程内状态机与条件写；没有 `close()`；不自动启动任何 Persona；`normalizeCrashedPersonas` 只把其它 boot 的 `STARTING`/`STOPPING` 收成 `STOPPED`，不碰 `RUNNING` / `FAILED`；没有“启动所有 RUNNING Persona”的 API |
| P1 Ingress（事件总线存储侧） | `createStimulusIngress({ store, logger, config, now?, randomBytes?, timers?, ... })`；`acceptStimulus` / `readBuffered` / `listQueued` / `evictExpired` / `close()` / `metrics()` | **【事实】** 进程内受理、去重、会话复用、同事务提交 P1 信封、正文进 TTL 缓冲；**没有传输层**，Daemon 没有调用 `acceptStimulus` 的入口；`close()` 同步、幂等，会清空缓冲并尽力持久化待收口元数据 |
| P1 Runtime Recovery | `recoverRuntime({ store, logger, policy, now?, batchSize?, maxRowsPerRun?, maxScanQueries?, maxPersonasPerRun?, maxProbeQueries?, signal? })` | **【事实】** 有界扫描，合法 `running` 任务经 `recoverRunningTask` 收敛（不加 attempt），活跃事件收 `expired` + `buffer_lost`；不扫描 A/B、不读 Archive、不恢复检查点、不领取任务；返回 `RecoveryReport`，`incomplete` 表达预算停止/异常状态；`signal` 只在扫描间隙检查（同步扫描期间无法被外部事件打断） |
| Task Scheduler | `createScheduler({ store, logger, policy, handlers, config?, now?, timers?, randomBytes? })`；`start` / `wake` / `tick` / `stop` / `enqueueTask` / `pauseTask` / `resumeTask` / `cancelTask` / `stats` | **【事实】** 创建时取得 Store-scoped scheduler lease；`start()` 后事件驱动领取/派发；`handlers` 是创建时不可变映射，允许空 Map；空 Map 时 `runTick` 直接返回零报告（不调用 `claimNext`），但仍会调用 `nextDueAt` 安排未来任务的定时器；`stop()` 等待在途 Handler，Handler 永不 settle 时可能无限等待；running 任务不可取消 |
| Store lease | 内部 `acquireStoreLease`（不导出） | **【事实】** `WeakMap<Store, 'scheduler' | 'recovery'>`；同一 Store 对象上互斥，冲突抛 `RuntimeError('illegal_transition')`；不跨进程、不跨 Store 对象 |

### 3.2 Persistence 与 Daemon

| 能力 | 入口/位置 | 现状 |
|---|---|---|
| Store | `openStore({ file, busyTimeoutMs? })` | 打开 SQLite、应用 WAL/foreign_keys 等 pragma；不跑 Migration |
| Migration / Schema | `migrate(store)`、`verifySchema(store)` | Migration 失败/校验失败会抛出；Daemon 已有失败清理路径 |
| Daemon 配置 | `apps/soul-daemon/src/config.ts` | 现有 3 个 env：`SOUL_DATA_DIR`（必填）、`SOUL_LOG_LEVEL`（默认 info）、`SOUL_SHUTDOWN_TIMEOUT_MS`（默认 10000，范围 100–600000） |
| Daemon 日志 | `src/logger.ts` | JSON lines；敏感键打码；`Error.message` 固定 `[redacted]`；`child()` 绑定字段 |
| Daemon 单实例锁 | `src/lock.ts` | 数据目录级原子锁；`lock.holder.bootToken` 为每次启动生成的 UUID；持锁进程存活则拒绝启动；陈旧锁按快照认领 |
| Daemon 生命周期 | `src/daemon.ts` | `BOOTING → MIGRATING → RECOVERING → READY → RUNNING`；关闭 `DRAINING → CHECKPOINTING → CLOSING → STOPPED`；同步资源栈逆序释放；重复 stop 返回同一 Promise |
| Daemon 进程入口 | `src/main.ts` | 信号接入、保持进程存活、稳定退出码 0/2/3/4/5/6 |
| Daemon 状态/能力 | `src/phases.ts` | 静态 `CAPABILITIES`，四个 Runtime 相关能力均为 `not_implemented`；`STARTUP_STEPS` 是目标顺序的显式清单 |

### 3.3 明确没有的能力

**【事实】** 以下在 SH-008D 结束时仍不存在，SH-008E 不得假装拥有：

- 单一 `createRuntime()` / Runtime 容器对象；Runtime 包只有多个工厂。
- 任何认知 Handler、任务 kind 注册表或业务处理器。
- HTTP/WebSocket/健康检查/传输层（SH-009）。
- Runtime checkpoint 读写、队列/活跃思维恢复、扫描 A/B。
- Scheduler running 任务取消/硬超时；Scheduler `stop()` 的强制终止。
- 显式 `PRAGMA wal_checkpoint`。
- 组件运行期监督（supervisor/health loop）：Scheduler 内部 tick 失败只写日志，Daemon 没有观察通道。
- 跨进程 lease；只有单实例锁提供跨进程互斥。

---

## 4. 当前 Daemon 架构分析

### 4.1 类与依赖

**【事实】** `SoulDaemon` 目前只依赖 `@soul-harness/persistence`（`migrate` / `openStore` / `verifySchema`），不依赖 `@soul-harness/runtime` 或 `@soul-harness/contracts`。

- `DaemonOptions = { config, logger, clock? }`；`clock` 只用于 `startedAt`。
- `#resources: Resource[]` 保存 `{ step, release: () => void, released }`；**release 全是同步函数**。
- `#lock: InstanceLock | null`、`#store: Store | null`。
- `#phase`、`#startPromise`、`#stopPromise`、`#shutdownDone`。
- `status` 是同步 getter，返回 phase/pid/dataDir/startedAt/storeOpen/lockHeld/lockPath/capabilities。

### 4.2 启动实现

**【事实】** `#boot()` 顺序：

1. 记录 config、logging、data_directory 的 `step_ok`；
2. `ensureDataDir`；
3. `acquireInstanceLock`，资源栈记录 `instance_lock`；
4. `openStore({ file: <dataDir>/soul.db })`，资源栈记录 `sqlite_open`；
5. `enter('MIGRATING')` → `migrate` + `verifySchema`；
6. `enter('RECOVERING')` → `skipSteps`（persona/runtime recovery 只记日志）；
7. `enter('READY')` → `skipSteps`（event bus/scheduler/http/health）；
8. `enter('RUNNING')` → 写 `startedAt`，返回 `StartReport`。

每个关键步骤后 `await #boundary()`：`setImmediate` 让出事件循环，再检查 `#stopRequested`；停止请求会在下一个边界抛 `startup_aborted`。

**【事实】** `StartReport` 目前只含 phase/pid/dataDir/databaseFile/appliedMigrations/currentVersion/skippedSteps/capabilities。`capabilities` 是静态常量，Runtime 四项均为 `not_implemented`。

### 4.3 关闭实现

**【事实】** `#shutdown(reason)`：

- 若已经 `STOPPED` 且有 `#lastStopReport`，直接返回缓存；
- `ranForReal = phase === RUNNING || READY`；是则进入 `DRAINING`，记录 `scheduler_drain` skipped；
- 无条件记录 `checkpoint_skipped`，理由 `runtime_not_implemented`；
- 进入 `CLOSING`，`#releaseAll()` 同步逆序释放资源（store 先于 lock）；
- 进入 `STOPPED`，构造报告；清理失败时 `#shutdownDone.reject` 并抛 `DaemonError('shutdown_failed')`。

**【事实】** `stop()` 幂等（同一 Promise），在启动期间调用时先 `await startPromise.catch()`，再执行 shutdown。

### 4.4 资源栈的结构性缺口

- **同步栈无法容纳 Scheduler**：`TaskScheduler.stop()` 是异步的；现有 `release: () => void` 不能直接放进去。若在 `CLOSING` 里同步 `store.close()` 而不先 `await scheduler.stop()`，会关闭仍有 lease/在途 Handler 的 Store。
- **没有组件引用**：`#ingress`/`#scheduler`/`#personas` 都不存在；`status` 无法报告组件状态或 `scheduler.stats()`。
- **没有启动报告字段**：无法把 Recovery 计数、`incomplete`、`bootId`、Handler 数等暴露给测试或运维。
- **`shutdownTimeoutMs` 只被记录，没有执行**：全仓搜索确认它只在 config 校验与 `step_ok` 日志中出现。
- **停止没有任何组件级等待**：目前 DRAINING 只写日志。

### 4.5 配置与测试现状

**【事实】**

- 配置只有 3 个 env；`loadConfig` 返回冻结对象；数值校验集中在 `CONFIG_LIMITS`。
- `test/config.test.ts` 7 项；`test/daemon.test.ts` 9 项；`test/process.test.ts` 9 项；加上 lock/logger/child-watch，README 记录 **61 项**。
- `daemon.test.ts` 目前断言：phase 顺序为 `MIGRATING, RECOVERING, READY, RUNNING`；`skippedSteps` 含 `persona_recovery` / `runtime_recovery` / `scheduler` / `http_api`；`report.capabilities.runtime === 'not_implemented'`。
- `process.test.ts` 走构建产物 `dist/main.js`；`buildDaemonApp()` 只显式构建 persistence（若缺失）和 daemon，其余靠 turbo/上游构建。
- 根 `pnpm test` 通过 vitest projects 跑整个 workspace；CI 用同一套命令。

### 4.6 职责与依赖方向

**【事实】** 依赖方向应为 `apps/soul-daemon → packages/runtime → packages/persistence → packages/contracts`。当前 Daemon 只到 persistence；SH-008E 新增的运行时依赖不会形成反向依赖或循环。

---

## 5. 目标装配架构

### 5.1 组件与依赖图

**【本次建议】** 目标装配（不新增 Runtime 生产 API）：

```text
SoulDaemon
├─ DaemonConfig（冻结；含共享 policy、恢复预算、ingress/scheduler 配置）
├─ Logger（daemon 结构化日志；同时满足 RuntimeLogger）
├─ InstanceLock（bootToken 复用为 Runtime bootId）
├─ Store（唯一对象；先 migrate/verifySchema）
├─ PersonaLifecycle（RECOVERING 创建；持有到关闭）
├─ Recovery（一次性调用；不保留对象）
├─ StimulusIngress（READY 创建；无传输层）
└─ TaskScheduler（READY 创建并 start；固定空 Handler）
```

**依赖注入**：由 Daemon 在启动阶段构造并传入；组件只接收构造参数，不反向依赖 Daemon。没有循环。

### 5.2 生命周期所有权

| 组件 | 创建者 | 关闭者 | 关闭方式 | 备注 |
|---|---|---|---|---|
| `InstanceLock` | Daemon | Daemon | `release()` 同步 | 最后释放 |
| `Store` | Daemon | Daemon | `close()` 同步 | 在 Scheduler/Ingress 之后 |
| `PersonaLifecycle` | Daemon | — | 无 close | 无后台定时器/句柄 |
| `StimulusIngress` | Daemon | Daemon | `close()` 同步、幂等 | 关闭后不再受理 |
| `TaskScheduler` | Daemon | Daemon | `stop()` 异步 | 必须在 Store 关闭前 resolve；本批不设强制上界，不超时放弃 |
| Recovery | 调用即返回 | — | 无资源 | lease 在 Promise settle 时释放 |

### 5.3 Daemon 不应重复实现的能力

**【本次建议】** 以下必须调用 Runtime/Persistence，不得在 Daemon 写 SQL 或复制状态机：

- Persona 状态迁移、崩溃归一：`createPersonaLifecycle` / `normalizeCrashedPersonas`。
- 任务状态机、attempt/runId、领取、收口：`claimNext` / `completeTask` / `failTask` / `recoverRunningTask`（Recovery/Scheduler 内部）。
- Recovery 扫描、预算、fail-closed 分类。
- Scheduler 并发、轮转、退避、定时唤醒、lease。
- P1 信封提交、去重、会话复用、TTL 缓冲。
- Migration/Schema 校验。

Daemon 只负责：配置、顺序、依赖装配、阶段标签、资源释放、进程信号、把组件的真实结果转成报告/日志/退出码。

### 5.4 不发明 `createRuntime`

**【事实】** Runtime 包没有单一容器对象。  
**【本次建议】** SH-008E 不新增 `createRuntime`，也不在 Daemon 内伪造一个“Runtime 已恢复”的 facade。报告用 `components` / `recovery` 字段表达已装配的部件。

### 5.5 职责交叉检查

- **Persona 恢复 vs Runtime 恢复**：先 `normalizeCrashedPersonas`（Persona 行状态），再 `recoverRuntime`（任务/事件行）。两者不互相调用，顺序由 Daemon 固定。
- **Event Bus vs Scheduler**：Ingress 只落 Envelope/缓冲，不领取任务；Scheduler 只领取任务，不读缓冲正文。Daemon 不把两者互相接线。
- **Recovery vs Scheduler**：唯一交互是 Store lease；Daemon 必须严格串行（§6.5），不绕过、不并发。

---

## 6. 启动生命周期设计

### 6.1 目标启动顺序

**【本次建议】** 在现有 RUNTIME-LIFECYCLE §2 顺序内填充：

| # | 阶段 | 动作 | 前置条件 | 成功条件 | 失败处理 |
|---|---|---|---|---|---|
| 1 | BOOTING | `loadConfig(env)` | 进程启动 | 冻结配置；新 policy 完整 | 退出码 2 |
| 2 | BOOTING | `createLogger` | 配置 | logger 可用 | 退出码 5（现有 fatal 路径） |
| 3 | BOOTING | `ensureDataDir` | 配置 | 目录可写 | 退出码 3 |
| 4 | BOOTING | `acquireInstanceLock` | 目录存在 | 锁持有；拿到 `bootToken` | 退出码 4 |
| 5 | BOOTING | `openStore` | 锁持有 | Store 打开 | 清理锁；退出码 5 |
| 6 | MIGRATING | `migrate` + `verifySchema` | Store 打开 | 版本/形状正确 | 逆序清理；退出码 5 |
| 7 | RECOVERING | 创建 `PersonaLifecycle`（`bootId = lock.holder.bootToken`；格式兼容性实施前核对，见 §16.3） | Store 可用 | 实例创建；`bootId` 被 Runtime 接受 | 清理 |
| 8 | RECOVERING | `normalizeCrashedPersonas()` | 生命周期就绪 | 返回归一列表 | 启动失败（`persona_recovery_failed`） |
| 9 | RECOVERING | `recoverRuntime({ store, logger, policy, now, budgets, signal })` | 上一步完成 | `incomplete === null` | 抛出或 `incomplete !== null` → 启动失败 |
| 10 | READY | 创建 `StimulusIngress({ store, logger, config, now })` | Recovery 完成 | 实例创建 | 启动失败（`event_bus_start_failed`） |
| 11 | READY | `createScheduler({ store, logger, policy, handlers, config, now, timers })` | Ingress 创建完成；无 lease 冲突 | 实例创建（state=created） | 启动失败（`scheduler_start_failed`） |
| 12 | READY | `scheduler.start()` | Scheduler created | state=running | 启动失败，`stop()` 回收 |
| 13 | READY | 记录 READY 完成；`http_api` / `health_check` 仍 skipped（SH-009） | — | — | 不伪造 |
| 14 | RUNNING | 写 `startedAt`，返回报告 | 以上全部 | 进程常驻 | — |

**【事实】** 第 11–12 步不能与第 9 步重叠：`recoverRuntime` 在 Promise settle 前持有 recovery lease；Scheduler 创建会因 lease 冲突抛 `illegal_transition`。

### 6.2 RECOVERING 细节

**【本次建议】**

1. `bootId` **复用** `lock.holder.bootToken`（已确认 O-9），不生成第二份 boot 标识。**【事实】** 当前锁用 `crypto.randomUUID()` 生成 `bootToken`；当前 `packages/contracts/src/ids/patterns.ts` 的 `BOOT_ID_PATTERN` 文本为 `^[A-Za-z0-9._:-]{1,64}$`，`isBootId` 用该正则校验。规划阶段只记录这两个来源与当前 pattern 文本，**不预先断言实际输出一定通过**；是否兼容必须在实施前用当前 parser 核对，见 §16.3 O-9。
2. **实施前必须核对格式兼容性**：
   - 读取当前仓库实际导出的 `BOOT_ID_PATTERN` / `isBootId` 与锁的 `bootToken` 生成方式，确认实际值被当前 parser 接受；
   - 以 `createPersonaLifecycle` 实际创建（其内部执行 `isBootId`）作为运行时验收，而不是只看类型或本规划示例；
   - 若实际格式不兼容（`invalid_argument` 或校验失败），启动失败并停止报告；**不得**修改 Runtime、Contracts 或锁协议，也不得自行生成另一套 ID 绕过。
3. `normalizeCrashedPersonas()`：只调用一次；报告返回条数；不自动 `startPersona`。`RUNNING` 的旧 boot 行保持原状（没有重新盖章的 API，也不在本批发明）。
4. `recoverRuntime`：
   - `policy` 与 Scheduler 使用**同一个冻结对象**；
   - 显式传 `batchSize` / `maxRowsPerRun` / `maxPersonasPerRun`（来自配置），不依赖库内默认值；
   - `now` 与 Daemon 注入时钟一致；
   - `signal`：创建 `AbortController`，`stop()` 请求时 `abort()`。**【事实】** 扫描体同步执行，外部信号在一次扫描中无法抢占；因此 abort 只保证“下一次查询/边界”停止，不能承诺即时中断。报告必须如实说明。
5. 结果处理：
   - 抛错 → 启动失败（`runtime_recovery_failed`），不得继续 READY；
   - `incomplete !== null` → **【已确认决议 O-2】** fail closed，启动失败（`recovery_incomplete`，details 只放 `reason`，不放正文/异常消息）；不创建 Ingress/Scheduler。
   - 若 `#stopRequested` 已置位，优先按 `startup_aborted` 走清理，不把“停止过程中的 incomplete”报告成启动失败。

### 6.3 READY 细节

**【本次建议】**

1. **PersonaLifecycle**：`assembled: true`；**不自动启动任何 Persona**（`autoStarted: false`）。启动路径只调用 `normalizeCrashedPersonas`，不调用 `startPersona`；旧 boot 的 `RUNNING` 行也不会被“重新启动”。
2. **Event Bus**：创建 `StimulusIngress`，`assembled: true`、`initialized: true`；`transport: 'none'`、`acceptsInput: false`。没有 HTTP/WS/适配器入口，`acceptStimulus` 在本批不可达；日志与报告不得说“可以受理事件”。
3. **Scheduler**：
   - **【已确认决议 D-R2】** SH-008E 不提供 Handler 注入：`DaemonOptions` 不接受 Handler Map，`main.ts` 也不注册任何 kind。
   - `handlers` 固定为空映射：可以使用 `new Map<string, TaskHandler>()` 或等价空 `ReadonlyMap`，但**不能**声称 `Object.freeze(new Map())` 使其不可变（`Map.set` 仍可修改）。真正的边界是：Daemon 不保留该 Map 的可变引用，且 `createScheduler` 在创建时自行遍历/复制为内部 Handler 表；本批两者都为空。
   - `policy` 与 Recovery 同一对象；`config` 传 §9 的并发值；`now`/`timers` 可注入。
   - 创建成功后在 READY 内 `start()`；组件状态记录 `assembled: true`、`started: true`、`state: 'running'`、`handlerKinds: 0`、`dispatchesTasks: false`。
   - 空 Handler 时：Scheduler 真实运行，但没有可领取的 kind；不得写一个“假 Handler”消费任务，也不得把 `state: 'running'` 报告成“可派发任务”。
   - 后续批次若需要 Handler，必须单独批准注册/注入边界，不在本批预留未批准 API。
4. **阶段顺序**：`enter('READY')` 后可创建组件；全部成功后再 `enter('RUNNING')`。若 READY 中途失败，按资源栈逆序清理（scheduler → ingress → store → lock）。
5. **API/健康检查**：`http_api` / `health_check` 仍为 `not_implemented`，`skippedSteps` 只保留这两项。

### 6.4 启动边界、报告与能力

**【本次建议】** 用**同一套组件状态与能力字段**构造 `StartReport`、`DaemonStatus` 与日志，避免“已装配”“已启动”“能受理”“能派发”互相冒充：

```ts
interface DaemonComponents {
  personaLifecycle: { assembled: true; autoStarted: false };
  eventBus: { assembled: true; initialized: true; transport: 'none'; acceptsInput: false };
  scheduler: {
    assembled: true;
    started: true;
    state: 'running';
    handlerKinds: 0; // 本批固定
    dispatchesTasks: false; // 本批固定
  };
}

interface DaemonCapabilities {
  persistence: true;
  migrations: true;
  instanceLock: true;
  structuredLogging: true;
  personaLifecycle: 'assembled';
  runtimeRecovery: 'assembled';
  eventBus: 'assembled_no_transport';
  eventIngress: 'unavailable_no_transport';
  scheduler: 'running';
  taskDispatch: 'unavailable_no_handlers';
  httpApi: 'not_implemented';
  healthEndpoint: 'not_implemented';
}

interface StartReport {
  phase: 'RUNNING';
  pid: number;
  dataDir: string;
  databaseFile: string;
  bootId: string;
  appliedMigrations: readonly number[];
  currentVersion: number;
  recovery: RecoveryReport;
  personasNormalized: number;
  components: DaemonComponents;
  skippedSteps: readonly string[]; // http_api, health_check
  capabilities: DaemonCapabilities;
}

interface DaemonStatus {
  phase: DaemonPhase;
  pid: number;
  dataDir: string;
  startedAt: string | null;
  bootId: string | null;
  storeOpen: boolean;
  lockHeld: boolean;
  lockPath: string | null;
  components: DaemonComponents;
  capabilities: DaemonCapabilities;
  recovery: RecoveryReport | null;
  scheduler: { state: SchedulerState; activeHandlers: number; activeUnits: number };
}
```

**一致性不变量**：

- `components.personaLifecycle.autoStarted` 恒为 `false`；`personaLifecycle: 'assembled'` 只表示对象存在，不表示 Persona 已启动。
- `components.eventBus.initialized` 恒为 `true`（Ingress 已构造）；`acceptsInput` 恒为 `false`，`transport` 恒为 `'none'`；能力上 `eventBus: 'assembled_no_transport'` 与 `eventIngress: 'unavailable_no_transport'` 同时出现，任何一项都不得被单独读成“可受理”。
- `components.scheduler.started` 恒为 `true`，`state` 可以是 `'running'`；但必须同时有 `handlerKinds: 0` 与 `dispatchesTasks: false`；能力上必须同时有 `taskDispatch: 'unavailable_no_handlers'`。**禁止只写 `scheduler: 'running'` 而不给 `taskDispatch` 维度。**
- `httpApi` / `healthEndpoint` 恒为 `not_implemented`；不因其他组件装配而改变。
- `StartReport`、`DaemonStatus`、`daemon_running` 日志必须引用同一构造结果，不允许各自手写不同的能力字符串。

- `RecoveryReport` 直接复用 Runtime 类型（只读快照；不把 `detail` 正文写日志）。
- `components.scheduler.handlerKinds` 在本批固定为 `0`：空 Handler 是 D-R2 的批准形态，不代表可派发认知任务。
- 能力值必须区分“对象存在”“能受理”“能派发”：禁止把空 Handler 的 Scheduler 写成“可执行认知任务”。

### 6.5 lease 时序（硬约束）

**【已确认决议】** P7/P8：同一 Store 对象上 Recovery 与 Scheduler 互斥；Scheduler 创建时持租，stop 完成才释放；Recovery 在成功/异常路径都释放。

**【本次建议】** Daemon 的保证方式：

1. 只创建一个 `Store` 对象，并把它同时传给 Recovery 与 Scheduler（不得包一层或另开连接）。
2. `recoverRuntime` 必须 `await` 完成（含异常处理）后，才调用 `createScheduler`；不得使用 `Promise.all`、不得并行。
3. 若 Recovery 失败或 `incomplete`，不创建 Scheduler。
4. Scheduler `stop()` **resolve 后**才关闭 Store；本批不把“超时后放弃等待”当作合法路径。
5. 启动报告/日志记录 `recovery_completed` 在 `scheduler_created` 之前；测试以此断言顺序。

**【事实】** lease 只覆盖进程内同一 Store；跨进程仍由单实例锁保证，不得在 Daemon 文档里夸大为跨进程 lease。

---

## 7. 关闭生命周期设计

### 7.1 目标关闭顺序

**【本次建议】**

| # | 阶段 | 动作 | 失败处理 |
|---|---|---|---|
| 1 | 接收信号/`stop()` | `stopRequested=true`；同一 Promise；启动中则在边界中止 | 保持幂等 |
| 2 | DRAINING | 标记 `accepting=false`；`ingress.close()`（同步，停止受理、清缓冲）；`await scheduler.stop()`（异步，等待在途 Handler） | 见 §7.2（无强制上界）；记录步骤结果 |
| 3 | CHECKPOINTING | 仍**跳过** Runtime checkpoint；日志明确 `runtime_checkpoint_not_implemented` | 不伪造检查点 |
| 4 | CLOSING | **仅在 Scheduler stop resolve 后**逆序释放剩余资源：`Store.close()` → `lock.release()` | 收集失败，继续释放 |
| 5 | STOPPED | 仅当前序全部 resolve 时进入；构造 `StopReport`；有清理失败则 `shutdown_failed`（退出码 6） | 报告真实失败；stop reject/pending 时不得伪装 STOPPED |

**【本次建议】** 资源栈改为支持 `void | Promise<void>` 的释放函数，或在 DRAINING 中显式释放 Scheduler/Ingress 并从栈中标记已释放；CLOSING 只处理 Store/Lock。无论哪种实现，都必须保证：**Scheduler 未 resolve stop 之前，绝不关闭 Store、绝不把这次关闭报告为成功。**

### 7.2 Scheduler stop 没有强制上界（D-R1）

**【事实】** Scheduler `stop()` 没有超时；Handler 永不 settle 时 P5 语义允许无限等待。Daemon 现有 `SOUL_SHUTDOWN_TIMEOUT_MS` 只被校验/记录，未执行。

**【已确认决议 D-R1】** 删除原规划的“硬超时 → 放弃等待 → 关闭 Store”方案：

- 不做 `Promise.race` 后继续 CLOSING；
- 不新增 `shutdown_timeout` 错误码，不把“超时放弃”写成可接受路径；
- 不关闭一个仍有 Scheduler 在运行的 Store，也不在此时释放锁假装干净退出；
- 本批不声称关闭有硬上界。若 `scheduler.stop()` 永不 resolve，Daemon 的 `stop()` 也会保持 pending；运维只能外部终止进程。该进程退出后：
  - 任务行保持 `running`（或已 settle 的状态），下一次启动由 Recovery 按 D-RT1 收敛；
  - 锁文件按崩溃残留处理，由下次启动的快照认领协议接管；
  - 不写“已取消”“已完成”或伪造检查点。

**【本次建议】** `SOUL_SHUTDOWN_TIMEOUT_MS` 在本批**不赋予关闭语义**：保留现有校验/日志字段，避免把它误读成“可以安全强制关闭”的开关。本修订不删除该 env（它属于现有配置 API，删除会改变配置契约）；只删除其“超时后关闭 Store”的语义。若未来需要真正的有界关闭，必须先有 Scheduler 的取消/超时协议；那是独立任务，不在本批发明。

**【本次建议】** 由于 SH-008E 固定空 Handler Map，正常路径下 Scheduler 没有在途 Handler，`stop()` 会立即 resolve；无限等待只作为未来接入 Handler 后的已知限制记录，不是本批可测试的场景。

### 7.3 重复 shutdown

**【本次建议】** 保持现实现：

- 第一次 `stop()` 创建 `#stopPromise`；后续调用返回同一 Promise；
- 已 `STOPPED` 且有报告 → 返回缓存报告；
- 清理失败导致拒绝 → 后续调用返回同一拒绝 Promise；
- 启动中调用 → 等待 `startPromise` settle 后再执行 shutdown；boot 侧在边界抛 `startup_aborted`，启动报告不会完成。

### 7.4 各阶段失败仍继续清理

**【本次建议】**

- `ingress.close()` 抛错 → 记录 `event_bus_close` failed，继续后续步骤；
- `scheduler.stop()` **reject** → 记录 `scheduler_stop` failed；因为无法证明 Scheduler 已停止，**不进入会关闭 Store 的 CLOSING**；阶段保持 `DRAINING`（不置 `STOPPED`），`stop()` 以 `shutdown_failed` 拒绝；不伪造“清理完成”；
- `scheduler.stop()` pending（Handler 永不 settle）→ 不判失败、不关闭 Store，保持等待（§7.2）；阶段保持 `DRAINING`；
- `store.close()` 抛错 → 记录 failed，仍尝试释放锁；
- `lock.release()` 抛错 → 记录 failed；
- 所有已执行步骤汇总到 `StopReport.steps`；任一失败 → `shutdown_failed`，不伪装干净关闭。

### 7.5 资源泄漏与任务丢失风险

| 风险 | 现状/缓解 |
|---|---|
| Scheduler 在途任务 | 本批空 Handler，正常无在途；未来 Handler 不 settle 时 `stop()` 可无限等待。不强制取消、不关闭 Store；任务保持 running，下次 Recovery 收敛 |
| Ingress 缓冲正文 | `close()` 清空缓冲；没有传输层时不会有真实受理数据。若 SH-009 后接入，需要在关闭前先停止 transport 并处理已受理事件；**不在本批实现** |
| Store 关闭时仍有组件句柄 | 本批不会发生：CLOSING 只在 Scheduler stop resolve 后执行；若 stop 永不返回，Daemon 也不关闭 Store |
| 锁释放失败 | 记录 `shutdown_failed`，锁文件保留；下次启动按陈旧锁协议或人工处理 |
| Daemon 无法自行退出 | 若未来 Handler 永不 settle，`stop()` pending；运维必须外部终止。下一次启动按崩溃恢复处理，不假装优雅关闭 |
| stop reject/pending 时资源未释放 | 不进入 CLOSING：Store 保持打开、锁文件保留；`stop()` reject 或 pending；下一次启动按陈旧锁/崩溃恢复处理，不报告 clean stop |
| 检查点 | 不写。没有 Runtime checkpoint 能力；跳过并记录，不伪造 |
| WAL | 仍无显式 `PRAGMA wal_checkpoint`；`Store.close()` 由 SQLite 自行决定是否自动 checkpoint；不在本批新增 |

---

## 8. 异常处理与恢复设计

### 8.1 启动失败矩阵

**【本次建议】**

| 失败点 | 行为 | 资源处理 | 退出码/错误码 |
|---|---|---|---|
| 配置缺失/非法（含新 policy） | 不创建锁/Store | — | 2 / `config_*` |
| 数据目录 | 不创建 Store | — | 3 / `data_dir_*` |
| 锁竞争 | 不打开数据库 | — | 4 / `lock_*` |
| Store 打开失败 | 释放锁 | 锁 | 5 / `startup_failed` |
| Migration/Schema | 逆序释放 Store→锁 | Store、锁 | 5 / `startup_failed` |
| `normalizeCrashedPersonas` 抛错 | 逆序释放 | Store、锁 | 5 / `persona_recovery_failed`（新码） |
| `recoverRuntime` 抛错 | 逆序释放 | Store、锁 | 5 / `runtime_recovery_failed`（新码） |
| Recovery `incomplete !== null` | fail closed，不创建组件 | Store、锁 | 5 / `recovery_incomplete`（新码） |
| Ingress 创建失败 | 逆序释放 | Store、锁 | 5 / `event_bus_start_failed`（新码） |
| Scheduler 创建失败 | 逆序释放 | Store、锁 | 5 / `scheduler_start_failed`（新码） |
| `scheduler.start()` 失败 | `stop()` 回收后逆序释放 | 同上 | 5 / `scheduler_start_failed` |
| 启动中请求停止 | 边界抛 `startup_aborted` | 逆序释放 | 0 / `startup_aborted` |

**【本次建议】** 新错误码加入 `DAEMON_ERROR_CODES`；`main.ts` 的 `exitCodeFor` 把新启动错误映射到 5；`shutdown_failed` 仍映射到 6。未知错误仍走 `startup_failed`/5。**不新增 `shutdown_timeout`**：本批没有“超时后强制关闭”的合法路径（D-R1）。

### 8.2 运行期间异常

**【事实】** Scheduler 的 `tick` 异常由内部 `scheduler_tick_failed` 日志捕获；Handler 失败由 Scheduler 自行 `failTask`；Daemon 没有订阅这些事件的通道。Ingress 没有传输层，没有后台受理循环。  
**【本次建议】**

- SH-008E **不**新增 Daemon 级 supervisor/health loop；不把“进程还活着”说成“组件健康”。
- `status`/`StartReport` 提供最近一次 Recovery 结果与 Scheduler `stats()` 快照；这是拉取式状态，不是主动监督。
- 若未来需要运行期告警/自动重启，属于独立批次（依赖 SH-009 的 health/API 或新的 supervisor 设计），不在本批伪造。

### 8.3 重启后的状态恢复与幂等

**【本次建议】**

1. 进程被杀/崩溃：锁文件残留，下次启动按 SH-007A 的快照认领协议接管；SQLite 重新打开。
2. `normalizeCrashedPersonas` 把旧 boot 的 `STARTING`/`STOPPING` 收成 `STOPPED`，不自动启动 Persona；再次执行应返回 0 条变更（幂等）。
3. `recoverRuntime` 把合法 `running` 任务退回 `queued`（attempt 不变）或 `failed`；活跃事件收 `expired` + `buffer_lost`。
4. 只有 Recovery 完整成功，才创建/启动 Scheduler；随后它领取 `queued` 任务。
5. 旧 boot 的 `RUNNING` Persona 保持原状（没有重新盖章 API）；Scheduler 的 `claimNext` 只看 Persona 是否 `RUNNING`，不检查 bootId。**【事实】** 因此重启后这些 Persona 可被领取，但这不等于“Daemon 显式重启了 Persona”。

**Recovery 部分完成后的重启（D-R3）**：

- Recovery 的写是按行/按事件的条件写，不是整个扫描一个事务；预算停止或中途失败时，**已经完成的收敛保持有效**。
- 例：两条 `running` 任务、`maxRowsPerRun=1`。第一次启动可能只把第一条退回 `queued`，第二条仍 `running`，然后以 `row_budget_exceeded` 返回 `incomplete`；按已确认的 O-2（fail closed），Daemon 启动失败，不创建 Scheduler。
- 第二次启动（预算足够）必须满足：
  - 第一条已经是 `queued`，**不得再次 requeue**、不得增加 attempt、不得换 runId；
  - 第二条从 `running` 收敛为 `queued` 或 `failed`，attempt 不变；
  - 最终两条任务都在可继续的状态；事件收敛不重复写、不产生第二条终态；
  - 第二次 Recovery 报告只统计本次真正变化的行。
- 若第一次 Recovery **完整成功**、但之后在 READY/创建组件等步骤失败，重启会再次执行 Recovery；此时应观察到 0 个任务/事件变化（幂等），而不是重复 requeue。
- 失败关闭原因（`invalid_task_row`、`archive_state_present`、`unexpected_event_status`）**不是**预算问题，重启不会自动修复；需要运维/迁移处理。测试不得把这类原因当作“再跑一次就好”。
- 外部在 Recovery 写入过程中杀死进程：每条条件写已提交或未提交；下次 Recovery 必须把未完成的 `running` 行重新收敛，不能把半途状态当成成功。

**幂等边界**：

- Recovery 幂等性的依据是“只对仍处于预期旧状态的行做条件写”，不是“扫描结果缓存”。
- `normalizeCrashedPersonas` 同样是条件迁移；第二次执行为 0 条。
- Daemon 不在启动前手动清理任务/事件，不写自定义 SQL；幂等由 Runtime/Persistence 保证。

### 8.4 当前无法实现的能力（必须如实记录）

- Recovery 同步扫描无法被外部信号即时打断。
- Scheduler 无 running 任务取消、无 Handler 硬超时；stop 可能无限等待。
- 没有 Runtime checkpoint，无法在关闭时提交队列游标/活跃线程。
- 没有传输层，Event Bus 初始化后不可达。
- 没有组件监督/健康检查；运行期异常只存在于组件日志。
- 没有跨进程 Store lease；只有单实例锁。

---

## 9. 配置设计

### 9.1 现有配置（事实）

| 变量 | 必填 | 默认 | 范围 | 当前用途 |
|---|---|---|---|---|
| `SOUL_DATA_DIR` | 是 | — | 非空字符串 | 数据目录；相对 cwd 解析 |
| `SOUL_LOG_LEVEL` | 否 | `info` | `debug`/`info`/`warn`/`error` | 日志级别 |
| `SOUL_SHUTDOWN_TIMEOUT_MS` | 否 | `10000` | 100–600000 整数 | **仅校验/记录，未执行**；本批明确不作为强制关闭上界（D-R1） |

### 9.2 新增配置（已确认 O-3 / O-7）

**【本次建议】** 所有新值加入 `CONFIG_ENV_VARS`/`CONFIG_LIMITS`，在 `loadConfig` 一次校验并冻结；Daemon 不重新读 `process.env`。

| 变量 | 必填 | 默认（已确认） | 范围 | 传给谁 |
|---|---|---|---|---|
| `SOUL_TASK_MAX_ATTEMPTS` | **必填（O-3）** | — | 1–100 整数 | Recovery policy + Scheduler policy（同一对象） |
| `SOUL_TASK_RETRY_BACKOFF_MS` | **必填（O-3）** | — | 0–86400000 安全整数 | 同上 |
| `SOUL_RECOVERY_BATCH_SIZE` | 否 | 200 | 1–500 | `recoverRuntime.batchSize` |
| `SOUL_RECOVERY_MAX_ROWS` | 否 | 10000 | 1–1000000 | `recoverRuntime.maxRowsPerRun` |
| `SOUL_RECOVERY_MAX_PERSONAS` | 否 | 200 | 1–10000 | `recoverRuntime.maxPersonasPerRun` |
| `SOUL_SCHEDULER_MAX_TOTAL` | 否 | 8 | 1–1024 | `SchedulerConfig.maxConcurrentTotal` |
| `SOUL_SCHEDULER_PER_UNIT` | 否 | 1 | 1–64 | `SchedulerConfig.perPersonaChannelConcurrency` |
| `SOUL_INGRESS_QUEUE_CAPACITY` | 否 | 256（O-7） | 1–1000000 | `StimulusIngressConfig.queueCapacity` |
| `SOUL_INGRESS_BUFFER_TTL_MS` | 否 | 300000（O-7） | 1–86400000 | `StimulusIngressConfig.bufferTtlMs` |
| `SOUL_INGRESS_PERSONA_CAPACITY` | 否 | 8（O-7） | 1–1024 | `StimulusIngressConfig.personaAdmissionCapacity` |

**理由与边界说明**：

- **【事实】** Runtime 的 `RecoveryPolicy` / `SchedulerPolicy` 没有库内默认值（D-RT2/D-RT3）。**【已确认 O-3】** `maxAttempts`/`retryBackoffMs` 必填、无默认；不再讨论“有界默认”替代。
- Recovery 预算沿用 Runtime 的文档默认值，但 Daemon 显式传入并在启动报告中记录，避免“以为用了默认，实际不同”。
- Scheduler 并发默认与 D-SCH2 一致（1/8），Daemon 显式传入。
- Ingress 的上界是 Daemon 自己的防护（Runtime 只要求正整数），避免配置出 10^9 级队列/ TTL；默认值按 O-7 已确认（见 §16.2）。
- 不新增端口/令牌配置：SH-009 之前没有 API。

### 9.3 policy 对象

**【本次建议】** 规划示例（**不是 Runtime 契约**）：

```ts
const policy = Object.freeze({
  maxAttempts: config.taskMaxAttempts,
  retryBackoffMs: config.taskRetryBackoffMs,
});
```

- 同一个引用传给 `recoverRuntime` 与 `createScheduler`；不得构造两个值相同但独立的 policy。
- **实施前必须核对实际契约**（§16.3 O-3）：阅读 Runtime 当前导出的 `RecoveryPolicy` / `SchedulerPolicy` 与两个工厂的真实参数，确认该对象能同时赋值给两边；不能只按本段示例假定兼容。若实际 API 与规划不符，停止并报告，不修改 Runtime/Contracts 迁就规划。

### 9.4 单进程与并发约束

**【事实/决议】** 单实例锁按数据目录保证单进程；Scheduler 的并发上限只覆盖本进程。  
**【本次建议】** Daemon 不新增跨进程调度/协调；配置只影响本进程 Scheduler。`maxConcurrentTotal` 不是系统级上限，文档不得夸大。

### 9.5 配置失败语义

- 所有新变量在 `loadConfig` 阶段失败 → `config_invalid`/`config_missing`，退出码 2；不获取锁、不打开数据库。
- 不把非法值静默夹到边界；不把空字符串当 0。
- 日志只记录变量名与范围，不记录用户输入值（尤其未来可能含敏感值）。

---

## 10. 文件级变更范围

**【本次建议】** 若后续获批实施，预计变更：

| 文件 | 变更 |
|---|---|
| `apps/soul-daemon/package.json` | **只增加** `@soul-harness/runtime`（`workspace:*`）；**不增加** 直接的 `@soul-harness/contracts` 依赖 |
| `apps/soul-daemon/src/config.ts` | 新增 env/limits/字段；冻结 policy/ingress/scheduler 配置 |
| `apps/soul-daemon/src/errors.ts` | 新增 `persona_recovery_failed`、`runtime_recovery_failed`、`recovery_incomplete`、`event_bus_start_failed`、`scheduler_start_failed`（建议命名，实施时以封闭错误码集合为准）；不新增 `shutdown_timeout` |
| `apps/soul-daemon/src/phases.ts` | 更新 `STARTUP_STEPS` 状态；能力模型从静态 `not_implemented` 改为装配结果 |
| `apps/soul-daemon/src/components.ts`（新） | 集中构造 Persona/Ingress/Scheduler，集中适配日志/策略；不写业务逻辑；Scheduler 固定空 Handler |
| `apps/soul-daemon/src/daemon.ts` | RECOVERING/READY 装配；异步资源栈；DRAINING（无强制上界）；状态/报告；bootId |
| `apps/soul-daemon/src/main.ts` | 新错误码 → 退出码映射；关闭不新增强制超时 |
| `apps/soul-daemon/README.md` | 更新状态、生命周期、配置、能力、已知限制（仅本 app 文档） |
| `apps/soul-daemon/test/config.test.ts` | 新配置项、默认/边界/必填/冻结 |
| `apps/soul-daemon/test/daemon.test.ts` | 装配、恢复、失败回滚、关闭顺序、幂等、重启；替换“skipped”断言 |
| `apps/soul-daemon/test/process.test.ts` | 真实进程：正常启停、崩溃恢复、退出码、锁；新 env |
| `apps/soul-daemon/test/helpers/harness.ts` | 构建 runtime；进程 env 必填项；日志等待 |
| `apps/soul-daemon/test/components.test.ts`（新，可选） | 组件构造/关闭的确定性单元测试 |
| `pnpm-lock.yaml` | 仅因新增 `@soul-harness/runtime` workspace 依赖而变化；生成物，实施时在 diff 中单独核对，不得夹带版本升级 |

**依赖收紧（O-1）**：

- Daemon 只依赖 `@soul-harness/runtime`（以及既有的 `@soul-harness/persistence`）。`@soul-harness/contracts` 是 runtime/persistence 的传递依赖，**不**在 Daemon 的 `package.json` 中声明，也不从 Daemon 直接 `import '@soul-harness/contracts'`。
- 需要的 `BootId` 类型通过 Runtime 的公开类型派生（例如 `PersonaLifecycleOptions['bootId']`），不额外引入 contracts 依赖。
- 不允许为了少写一个类型而扩大依赖面；若 Runtime 没有导出必要类型，使用本地结构性类型别名或停止并报告，不新增 contracts 直接依赖。

**明确不改**：`packages/**`、`migration/**`、`contracts` schema、`apps/soul-daemon` 以外的应用、根脚本/CI（lockfile 仅限上述 runtime 依赖变化）。

---

## 11. 分阶段实施计划

**【本次建议】** 每阶段完成后独立验证，未通过不得进入下一阶段；不把多个阶段压成一个提交。

### E0 — 开工前置与实施准备（无生产代码）

- **先确认 O-0 已完成**：SH-008D 验收状态的文档同步提交已合入 `main`。
- 核对 §16.2 的已确认决议与 §16.3 实施核对条件；本规划不再保留未决设计项。
- **O-3 契约核对**：阅读 Runtime 实际导出的 policy 类型与 `recoverRuntime` / `createScheduler` 参数，确认同一个冻结对象可同时满足双方；不符合则停止报告。
- 确认依赖范围仅为 `@soul-harness/runtime`（§10），不新增直接 contracts 依赖。
- 取得维护者的 SH-008E 实施授权；未取得前不写代码。

### E1 — 配置、错误码、状态模型

- 扩展 `config.ts`、`errors.ts`、`phases.ts`（能力/步骤状态）。
- 增加配置单测；不接触 Daemon 生命周期。
- 验收：typecheck + config 测试。

### E2 — RECOVERING 装配

- `components.ts` 构造 `PersonaLifecycle`（bootId 来自锁）与 Recovery 调用。
- `daemon.ts` 在 RECOVERING 执行 normalize + recover；fail-closed；记录报告。
- 增加集成测试：空库、崩溃数据、recovery 抛错、incomplete。
- 验收：RECOVERING 路径可独立验证；E2 完成时**不创建/不启动 Scheduler**，`phases` 可暂时把 scheduler 标为 pending；完整 `RUNNING` 留到 E3。

### E3 — READY 装配

- 创建 Ingress、Scheduler（固定空 Handler），start；扩展报告/状态/能力。
- 测试：组件存在、状态、日志顺序、空 Handler 不派发。
- 验收：完整启动；旧 `skippedSteps` 只剩 http/health。

### E4 — 关闭与资源栈（无强制上界）

- DRAINING：Ingress close、`await scheduler.stop()`（不放弃等待）；异步资源栈；仅 stop resolve 后 CLOSING Store/Lock。
- 测试：正常关闭、幂等、stop during boot、清理失败继续；不测试“超时后强制关闭”（该方案已删除）。
- 验收：关闭顺序、锁/Store 释放、无挂起（空 Handler 路径）。

### E5 — 真实进程与重启

- 更新 `process.test.ts`、harness、env；崩溃/陈旧锁/重启恢复。
- 测试：SIGTERM/SIGKILL、退出码、双实例、崩溃后任务收敛。
- 验收：真实 `dist/main.js` 全绿。

### E6 — 文档与全量验证

- 更新 `apps/soul-daemon/README.md`；必要时在 `docs` 之外不写。
- 运行 `pnpm run check`、CI；核对 diff 范围。

---

## 12. 每阶段测试方案

### 12.1 配置

- 新变量缺失/空值/越界/小数/非数字 → `config_invalid` / `config_missing`，退出码 2。
- 默认值冻结；policy 对象 `Object.isFrozen` 且值符合预期；本批没有 Handler 注入 seam，不通过测试 API 观察内部引用。policy 的**结构兼容性**不能由本测试证明，必须按 §16.3 O-3 先对照 Runtime 实际类型。
- 现有 3 个变量的全部旧用例保留。
- 不读 `process.env` 之外的来源；不静默回退。

### 12.2 RECOVERING 集成（真实 SQLite）

种子方式：测试在 daemon 启动前用 `openStore`+`migrate`+repositories 写入数据（或 `DatabaseSync` 仅限测试构造非法行），关闭连接，再 `daemon.start()`；断言通过 `DatabaseSync`/repositories 读回。

| 用例 | 断言 |
|---|---|
| 空库 | `recovery.incomplete===null`；计数 0；Persona 归一 0 |
| bootId 格式与一致性 | 启动报告 `bootId` 与 `soul.lock` 的 `bootToken` 相同；该值被当前 `BOOT_ID_PATTERN` / `isBootId` 接受（以 `createPersonaLifecycle` 创建成功为准）；创建的 Persona/快照 bootId 与锁一致 |
| 旧 boot `STARTING`/`STOPPING` | 变 `STOPPED`；`RUNNING`/`FAILED` 不变；不自动 start |
| `running` 任务（合法 attempt/runId） | Recovery 后 `queued`，attempt **不变**、runId 不变（D-RT1） |
| attempt 达上限的 running | `failed`，attempt 不变 |
| 活跃 `received`/`accepted` 事件 | `expired` + `buffer_lost` |
| 非法任务行 | Recovery fail-closed，boot 失败；不创建 Scheduler；锁释放；Store 可重新打开 |
| 预算耗尽（用 `maxRows=1` + 2 条 running） | `incomplete.reason='row_budget_exceeded'`；boot 按建议 fail closed；不创建组件 |
| **部分恢复后重启（D-R3）** | 第一次只处理 1 条后 incomplete、boot 失败；检查第一条已 `queued` 且 attempt 不变；第二次预算足够，第二条收敛；第一条**不再被处理**；最终两条状态正确；第二次报告只统计真正变化的行 |
| **完整恢复后重启（幂等）** | 第一次启动成功并正常停止；第二次启动 Recovery 报告 requeued=0/failed=0/expired=0，任务/事件行与第一次结束后一致；`normalizeCrashedPersonas` 返回 0 |
| Recovery 抛错（注入 `now` 抛 `invalid_clock`，或损坏 schema） | 失败码 `runtime_recovery_failed`；资源释放；不创建组件 |
| 启动中 stop | `startup_aborted`；不创建 Scheduler；锁/Store 释放 |

### 12.3 READY / Scheduler 生命周期

- 启动后 `status.components.scheduler.started === true`、`state === 'running'`，`handlerKinds === 0`，`dispatchesTasks === false`（D-R2：本批不注入 Handler）。
- `status.components.personaLifecycle.autoStarted === false`；`status.components.eventBus.initialized === true`、`acceptsInput === false` 且 `transport === 'none'`。
- `status.capabilities.taskDispatch === 'unavailable_no_handlers'`；`status.capabilities.eventIngress === 'unavailable_no_transport'`；`scheduler: 'running'` 不得单独作为派发能力。
- `StartReport.components` / `StartReport.capabilities` 与 `status` 同值（同一构造结果），不得各自手写字面量。
- `scheduler.stats().activeHandlers===0`（空 Handler 不派发）。
- 日志顺序：`recovery_completed` 早于 `scheduler_created`/`scheduler_started`；`scheduler_stopped` 早于 Store close。
- 不允许在 Recovery 未完成时创建 Scheduler：成功启动本身 + 日志顺序证明；Runtime 层 lease 测试已覆盖冲突（不重复造测试钩子）。
- 空 Map 时，即使存在该 kind 的 queued 任务也不会被领取（任务保持 queued）；不注册假 Handler。
- **API 边界**：用 `@ts-expect-error` 证明 `DaemonOptions` 不接受 `handlers`（或任何 Handler Map 注入字段）；该断言只存在于测试/类型检查，生产接口不预留未批准的注入点。

### 12.4 关闭

| 用例 | 断言 |
|---|---|
| 正常 stop | `DRAINING`→`CHECKPOINTING`→`CLOSING`→`STOPPED`；`scheduler_stopped` 先于 `store.close`；`ingress.close`；锁删除 |
| 重复 stop | 同一 Promise；第二次返回同一报告 |
| stop during boot | 边界中止；资源释放；无组件泄漏 |
| 空 Handler 的 stop | `scheduler.stop()` 立即 resolve；无在途 Handler；不涉及超时/强制关闭 |
| 清理失败 | 锁目录破坏等场景仍继续释放 Store；报告 failed，不伪装 clean |
| 停止后重启 | 新 Daemon 能创建 Scheduler（lease 已释放）、锁可获取、DB 可打开 |

### 12.5 真实进程

- 无 env/缺 policy → 退出码 2。
- 正常启动 + SIGTERM → 0；日志有 `scheduler_started`/`scheduler_stopped`。
- 同目录第二实例 → 4；不建库。
- 迁移失败 → 5；锁释放。
- SIGKILL → 残留锁；下次启动接管；若上一次已留下 running 任务，Recovery 按 D-RT1 收敛；重新创建 Scheduler。
- 不同目录两实例 → 各自 RUNNING（锁按目录）。
- 进程测试全部等待日志事件/退出，不用固定 sleep；超时只作为测试失败保护。
- **Recovery 部分完成的进程级覆盖**（在 O-2 fail-closed 前提下）：以“小预算 + 两条 running 任务”启动进程，确认第一次退出/失败、DB 中第一条已收敛；再次启动（更大预算）确认第二条收敛且第一条未被重复处理。该场景用预算制造，不用 sleep 或杀进程时序。

### 12.6 确定性要求

- 单元/集成测试注入 `now`；Scheduler 定时器可注入；不引入关闭超时定时器（D-R1 已删除该路径）。
- 不使用真实等待来证明超时；本批不承诺有界关闭，相关限制写在文档，不伪造用例。
- 不使用概率竞速；不使用“多跑几次通常能过”的断言。
- 真实进程测试的等待是事件驱动（日志行/退出），不是 sleep。

### 12.7 测试矩阵覆盖

| 需求 | 覆盖 |
|---|---|
| 正常启动 | 12.2 空库/崩溃数据；12.3 |
| 正常关闭 | 12.4；12.5 SIGTERM |
| 启动失败回滚 | 12.2 invalid/incomplete/throw；12.5 迁移失败 |
| 重复关闭 | 12.4 幂等 |
| Recovery 部分完成后重启 | 12.2 预算部分恢复 + 第二次启动；12.5 进程级小预算重试 |
| Recovery 幂等 | 12.2 完整恢复后第二次启动 0 变化；normalize 0 条 |
| Recovery/Scheduler lease | 12.3 顺序；Runtime 既有 D4 测试；重启创建 Scheduler |
| Scheduler 启动/停止 | 12.3/12.4 |
| 运行期异常 | 明确限制：无 supervisor；Scheduler 内部日志；不伪造用例 |
| 重启恢复 | 12.5 SIGKILL；12.2 种子 |
| 资源释放 | 12.4 锁/Store；12.5 真实进程 |
| 完整集成 | 12.2–12.5 + `pnpm run check` |

---

## 13. 最终验收标准

**【本次建议】** SH-008E 只有在以下全部满足时才能提交验收（且需独立复审，不由实施方自证）：

1. **代码范围**：生产代码改动只在 `apps/soul-daemon/**`；`pnpm-lock.yaml` 只含新增 runtime workspace 依赖的预期变化（O-1），不夹带版本升级；未改 runtime/persistence/contracts/migration。
2. **启动与能力声明**：空库启动到 `RUNNING`；RECOVERING 真实执行 normalize + `recoverRuntime`；READY 真实创建 Ingress + Scheduler 并 start；`StartReport` / `status` / 日志使用同一组 `components` 与 `capabilities`，明确：PersonaLifecycle assembled 但 `autoStarted=false`；Ingress assembled/initialized 但 `acceptsInput=false` / `eventIngress='unavailable_no_transport'`；Scheduler `started=true` / `running` 但 `handlerKinds=0` / `dispatchesTasks=false` / `taskDispatch='unavailable_no_handlers'`；HTTP/Health 仍 `not_implemented`。**Scheduler 的 `running` 不得被报告成可派发任务。**
3. **恢复与幂等**：崩溃种子数据被正确收敛（Persona 归一、running 任务 attempt 不变、活跃事件 expired）；Recovery 抛错/`incomplete` 时 boot 失败且无 Scheduler 残留、锁/Store 释放；**部分完成后的重启不会重复处理已收敛行**，完整恢复后的第二次启动为 0 变化。
4. **lease**：Recovery 与 Scheduler 不重叠；只有 Recovery 成功后才创建 Scheduler；**Scheduler stop resolve 后**才关闭 Store；重启后新 Scheduler 可创建。
5. **关闭**：正常关闭顺序正确；重复关闭幂等；空 Handler 路径无在途任务；**不声称有界关闭或超时强制关闭**；锁最后释放；没有“放弃等待后继续关库”的路径。
6. **配置与契约**：新配置有边界/默认/必填语义，非法值在接触 DB 前失败；两个 policy env 必填、无默认；**实施前已核对 Runtime 实际导出的 policy 类型与 `recoverRuntime` / `createScheduler` 参数（§16.3 O-3），同一个冻结对象同时满足两边**；兼容现有退出码。
7. **bootId**：启动报告 `bootId` 与锁文件 `bootToken` 完全一致；该值通过当前 `BOOT_ID_PATTERN` / `isBootId` 的实际校验（以 `createPersonaLifecycle` 接受为准，并记录当前 pattern 文本）；PersonaLifecycle 使用同一个值。不兼容时停止报告，不修改 Runtime/Contracts/锁协议。
8. **测试**：新增测试覆盖 §12 矩阵；`pnpm --filter @soul-harness/soul-daemon test`、运行时全量、根 `pnpm run check` 全绿；真实进程测试覆盖 SIGTERM/SIGKILL/双实例。
9. **文档**：`apps/soul-daemon/README.md` 与实现一致；状态/能力/限制明确；不修改其他设计文档；**O-0 开工前置已满足（文档同步提交已合入）**。
10. **不夸大**：不声称 HTTP/健康、检查点、Handler 认知、跨进程 lease、运行期监督已完成；不把 `scheduler: 'running'` 写成可派发能力。
11. **独立复审**：实施报告 ≠ 复审结论；CI 结果以远端为准，不接受“本地通过”替代。

---

## 14. 风险与停止条件

### 14.1 主要风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Recovery `incomplete` 策略选择错误 | 启动失败过多或带病运行 | 已确认 O-2：fail closed；测试覆盖 budget incomplete 与重启 |
| Scheduler stop 无限等待 | Daemon 无法自行退出 | §7.2 不强制关闭、不放弃等待；记录为已知限制；未来需要取消协议 |
| 空 Handler Scheduler 被误读为“可执行认知” | 过度承诺 | 报告/能力/日志同时给出 `handlerKinds: 0`、`dispatchesTasks: false`、`taskDispatch: 'unavailable_no_handlers'`；不注册假 Handler |
| 关闭 Store 时 Handler 仍在写 | 错误/数据风险 | CLOSING 只在 Scheduler `stop()` resolve 后执行；未来 Handler 接入前需要先有取消协议 |
| 配置默认值被当成 Runtime 契约 | 策略漂移 | policy 必填，Daemon 文档说明值是装配方选择 |
| Runtime policy 实际类型与规划不一致 | 编译/运行失败 | §16.3 O-3 先读实际导出类型与工厂参数；不一致停止，不改 Runtime |
| `bootToken` 实际格式不被 `BOOT_ID_PATTERN` 接受 | 启动失败或绕过校验 | §16.3 O-9 实施前用当前 parser 实际核对；不兼容停止，不改 Runtime/Contracts/锁 |
| 新增依赖/锁文件超出 apps 范围 | 范围违规 | 已确认 O-1：只加 `@soul-harness/runtime`，不加 contracts 直接依赖，不升级版本 |
| Recovery 同步扫描阻塞关闭信号 | stop 无法即时中断 Recovery | 如实记录；不在本批改 Runtime |
| SH-008D 文档状态不一致 | 验收口径混乱 | **O-0 是开工前置**；未完成不得开工 |
| 测试依赖 sleep/时序 | CI 抖动 | §12.6 注入时钟/定时器 |

### 14.2 停止条件（遇到即停，不自行扩大范围）

1. **O-0 未完成**：SH-008D 验收状态的文档同步提交尚未合入 `main`。此时不得开工。
2. 未取得维护者对 SH-008E 的实施授权，或独立复审未通过。
3. 需要修改 `packages/runtime/**`、`packages/persistence/**`、`packages/contracts/**`、Migration 或已有设计文档才能完成。
4. Runtime 公开 API 不足以完成装配（例如无法用同一 Store 创建 Scheduler、无法取得 Recovery 报告），且不能通过 Daemon 层配置/顺序解决。
5. 必须新增测试专用生产 API 或直接访问内部 lease 才能验证。
6. 依赖范围超出 O-1：需要直接依赖 `@soul-harness/contracts`、增加其他 workspace 依赖、或 lockfile 出现非 runtime 依赖的版本升级。
7. O-3 契约核对失败：Runtime 实际导出的 policy 类型/工厂参数无法由同一个冻结对象同时满足；不得修改 Runtime/Contracts 迁就规划。
8. O-9 格式核对失败：`lock.holder.bootToken` 不被当前 `BOOT_ID_PATTERN` / `isBootId` 接受，或启动报告、锁、PersonaLifecycle 三处不能保持同值；不得修改 Runtime/Contracts/锁协议或另生成 ID 绕过。
9. 维护者要求本批提供 Handler 注入/真实 Handler、或有界关闭；这些超出 D-R1/D-R2 的已确认范围，需先取得新决议。
10. 发现 D1–D3 的真实缺陷：停止，提交复现/影响/建议报告；不在本批顺手修。

---

## 15. 明确不属于本批次的工作

- HTTP API、WebSocket、健康检查、令牌鉴权（SH-009）。
- 任何认知 Handler、任务 kind 注册表、思维/睡眠/梦境执行；**包括 DaemonOptions 的 Handler 注入**（D-R2）。
- Runtime checkpoint 装载/写出、扫描 A/B、Archive 读取、Action Gateway。
- 显式 `PRAGMA wal_checkpoint` 或 DATA-MODEL 的 WAL 收口。
- Persona 自动 `start`、旧 boot `RUNNING` 行的重新盖章、`FAILED` 自动恢复。
- Scheduler running 任务取消、Handler 硬超时/强制终止、运行期 supervisor。
- 有界关闭/超时后强制关库（D-R1 明确删除）。
- Event Bus 传输层或真实刺激受理路径。
- 跨进程 Store lease、跨 Store 对象协调、多实例编排。
- SH-007B 的 Daemon 集成验收（它依赖 SH-008 与 SH-009 全部接入）。
- 修改根 CI、根脚本、其他 app/package、已有架构文档（O-0 按 §16.1 先完成）。

---

## 16. 开工前置、已确认决议与实施核对

### 16.1 开工前置条件（O-0，必须先完成）

| 项 | 要求 |
|---|---|
| 前置 | **O-0：SH-008D 验收状态的文档口径已同步** |
| 完成定义 | 独立的文档状态同步提交已合入 `main`，使 `docs/PLAN.md`、`packages/runtime/README.md`、`docs/architecture/RUNTIME-LIFECYCLE.md`、`MODULES.md`、`OVERVIEW.md`、`IDENTITY-PROTOCOL.md` I05 与“SH-008D 已验收”一致 |
| 时点 | **SH-008E 实施开始之前**；验收阶段再补不算满足 |
| 未完成时 | 不得写代码、不得创建实施分支/提交；本规划不能作为开工依据 |
| 责任 | 维护者/文档维护者；不属于 SH-008E 的 `apps/soul-daemon/**` 范围 |

### 16.2 已确认决议（全部生效）

| ID | 已确认决策 |
|---|---|
| D-R1 / O-6 | 不设强制关闭上界。删除“硬超时 → 放弃 `scheduler.stop()` → 关闭 Store”；Scheduler stop 未 resolve 前不得关闭 Store；不新增 `shutdown_timeout`；`SOUL_SHUTDOWN_TIMEOUT_MS` 本批不赋予关闭语义；Daemon 不承诺有界退出。 |
| D-R2 / O-4 | Scheduler 固定空 Handler 快照可接受为“已装配”；报告固定 `handlerKinds: 0`；不注册假 Handler。 |
| D-R2 / O-5 | 不注入 Handler Map；`DaemonOptions` 不提供 handlers 参数；后续批次另行批准注册/注入边界。 |
| D-R3 | 增加 Recovery 部分完成后的重启与幂等测试（§8.3、§12.2、§12.5）。 |
| O-1 | 依赖只新增 `@soul-harness/runtime`（`workspace:*`）；**不**新增直接的 `@soul-harness/contracts` 依赖；`pnpm-lock.yaml` 只允许因该 workspace 依赖发生预期变化，不夹带版本升级。 |
| O-2 | Recovery 返回 `incomplete !== null` 时 **fail closed**：启动失败（`recovery_incomplete`），不创建 Ingress/Scheduler；若启动中已请求停止，则优先 `startup_aborted`。 |
| O-3 | `SOUL_TASK_MAX_ATTEMPTS` 与 `SOUL_TASK_RETRY_BACKOFF_MS` **必填、无默认**；范围分别为 1–100、0–86400000 的安全整数；同一个冻结 policy 对象传给 Recovery 与 Scheduler。实际类型契约必须在实施前核对（§16.3 O-3），规划示例不是契约。 |
| O-6 | 同 D-R1（不设强制上界）。 |
| O-7 | Ingress 默认值批准为 256 / 300000 / 8；范围按 §9.2：queue 1–1000000、bufferTtl 1–86400000、persona 1–1024；不在运行时静默夹值。 |
| O-8 | 四个维度分开：**assembled / started / acceptsInput / dispatchesTasks**。PersonaLifecycle：assembled，`autoStarted: false`；Event Bus：assembled、`initialized: true`（Ingress 无独立 start，initialized 表示构造完成）、`transport: 'none'`、`acceptsInput: false`，能力为 `assembled_no_transport` + `eventIngress: 'unavailable_no_transport'`；Scheduler：`started: true`（start 成功）、`state: 'running'`、`handlerKinds: 0`、`dispatchesTasks: false`，能力必须同时有 `scheduler: 'running'` 与 `taskDispatch: 'unavailable_no_handlers'`；HTTP API / Health：`not_implemented`。`StartReport`、`DaemonStatus`、能力报告使用同一组字段与值，禁止只写 `scheduler: 'running'` 而不给派发维度。 |
| O-9 | `bootId` 复用 `lock.holder.bootToken`，不生成第二份 boot 标识。**格式兼容性不是已默认事实**：实施前核对当前 `BOOT_ID_PATTERN` / `isBootId` 与锁的实际 `randomUUID()` 输出；启动报告值与锁 token 完全一致、被当前 parser 接受、PersonaLifecycle 使用同一值。不兼容时停止报告，不修改 Runtime/Contracts/锁协议。 |
| O-10 | 运行期监督缺失接受为已知限制：不新增 supervisor/health loop，不伪造健康状态；只在 `status` 中提供拉取式 `scheduler.stats()` 与最近一次 Recovery 摘要。 |
| O-11 | Ingress `close()` 当前会清空缓冲；本批没有传输层、没有真实受理数据，接受并记录该限制；真实受理路径与关闭前 drain 由 SH-009 重新设计。 |

### 16.3 实施核对条件

| 检查项 | 核对方式 |
|---|---|
| O-0 | 实施前检查文档状态同步提交已合入 `main`；未满足则停止 |
| O-1 | 审查 `apps/soul-daemon/package.json` 只多出 runtime；源码无 `@soul-harness/contracts` 直接 import；lockfile diff 只含预期 workspace 依赖 |
| O-2 | 种子 2 条 running + `maxRows=1`：首次启动失败、无 Scheduler、锁/Store 释放；预算足够后重启完成，已收敛行不重复处理 |
| O-3 | **先做实际契约核对（不按规划示例假定）**：读取 Runtime 当前导出的 `RecoveryPolicy` / `SchedulerPolicy`，核对 `recoverRuntime` 与 `createScheduler` 的真实参数；用类型赋值/构造检查确认同一个冻结对象可同时满足两边。不符合 → 停止报告，不修改 Runtime/Contracts 迁就规划。再做配置测试：缺 env → 退出码 2；边界值 1/100、0/86400000 通过，越界/小数拒绝；无隐式默认 |
| O-7 | 默认值精确为 256/300000/8；越界拒绝；配置对象冻结 |
| O-8 | 断言 `components.personaLifecycle.autoStarted === false`；`components.eventBus.initialized === true`、`acceptsInput === false`、`transport === 'none'` 且 `capabilities.eventIngress === 'unavailable_no_transport'`；`components.scheduler.started === true`、`state === 'running'`、`handlerKinds === 0`、`dispatchesTasks === false` 且 `capabilities.taskDispatch === 'unavailable_no_handlers'`；`StartReport`/`DaemonStatus`/能力报告同值；无假 Handler；http/health 仍 `not_implemented` |
| O-9 | **三项同时确认**：① 启动报告 `bootId` 与 `soul.lock` 的 `bootToken` 完全一致；② 该值被仓库当前实际 `BOOT_ID_PATTERN` / `isBootId` 接受（`createPersonaLifecycle` 的构造校验使用同一个 `isBootId`；接受即证明符合当前 parser；同时记录当前 pattern 文本）；③ PersonaLifecycle 使用同一个值（创建的 Persona/快照 bootId 与锁一致）。任一失败则停止报告，不改 Runtime/Contracts/锁协议 |
| O-10 | README 明确无 supervisor/health；代码不新增后台健康循环或假端点 |
| O-11 | `ingress.close()` 幂等测试；README/启动报告明确无传输层；不声称“可受理事件” |
| D-R1 | 代码无“超时后关闭 Store”；无 `shutdown_timeout`；stop pending 时 Store/锁不被关闭 |
| D-R2 | `DaemonOptions` 无 handlers 字段（`@ts-expect-error` 断言）；Scheduler 创建参数固定空 Map；报告 `handlerKinds: 0` |
| D-R3 | §12.2/§12.5 的部分恢复重启与幂等用例通过 |

---

## 17. 开工条件与结论

**【本次建议的结论】**

### 17.1 开工条件（必须按顺序满足）

1. **O-0 先完成**：SH-008D 验收状态的文档同步提交已合入 `main`。**未完成 O-0，不得开始任何 SH-008E 实施工作。**
2. **维护者实施授权**：独立复审通过，并明确批准 SH-008E 进入实施；本规划本身不构成授权。
3. **已确认决议生效**：§16.2 的 D-R1/D-R2/D-R3 与 O-1–O-11 均已生效；实施必须按这些决策执行。
4. **依赖范围锁定**：只新增 `@soul-harness/runtime`；不直接依赖 contracts；lockfile 只做预期变更。
5. **实施前契约核对**：O-3 的 Runtime policy 实际类型、O-9 的 `BOOT_ID_PATTERN` 实际兼容性、O-8 的四维能力字段必须按 §16.3 在写代码前完成核对；核对失败即停止，不得按本规划示例假定通过。

### 17.2 结论

- **代码级前置**：规划核对**未发现**必须修改 Runtime/Persistence/Contracts 的阻塞；但 O-3（policy 类型）与 O-9（boot 格式）仍是实施前必须用当前实际代码验证的条件，未验证前不得写成“已通过”。
- **决策级前置**：无未决项；O-2/O-3/O-7/O-8/O-9/O-10/O-11 已确认，D-R1/D-R2/D-R3 已生效。
- **唯一开工前置**：**O-0**。它不是代码任务，但必须先于实施完成；未完成时本规划只能停留在规划状态。
- **实施状态**：SH-008E **尚未获实施授权**，未开始实施；本规划不提前宣布 SH-008E 或 SH-008D 整批结果。
- **关闭语义已知限制**：接受“Scheduler stop 可能无限等待、Daemon 无法自行退出”，不提供强制终止；正常空 Handler 路径不受影响。

---

## 18. 规划阶段未执行的事项

- 未修改任何生产代码、测试代码、Contracts、Migration、已有设计文档。
- 未创建实施分支、未创建提交、未推送。
- 未开始 SH-008E 实施；未开始 SH-009 或其他批次。
- 本文件本身尚未提交（按任务书要求：规划文档提交也暂不需要）。
