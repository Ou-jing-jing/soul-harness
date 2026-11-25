# SH-008E — Daemon 集成与验收：规划任务书

- **文档状态**：E0.R1 规划修订，等待本修订的独立复审。**不是实施授权**，不表示 SH-008E 已开始或已完成，不得据此开始 E1。
  > **当前实施状态（2026-11）**：E1–E5、AUDIT-001 与 E6 README 同步已经完成并合并；本文正文中“等待复审 / E1 未开始 / E4 锁策略待决”等文字是历史阶段记录，不再作为当前要求。当前实施状态以文末 **§19 实施状态同步（E1–E6，2026-11）** 为准；该节不改变任何已批准架构决议。
- **开工基线**：远端 `main` HEAD `d451f90d20c6acea4af298b52f6041b08b12e90c`（2026-11-23，PR #8 并入本文件的初稿）。该提交相对 `8bd7f9e904e87135d10d0a4df14c7fdce319ecf1` 只新增本文件；生产代码与 `8bd7f9e` 相同。
- **E0 代码审计基线**：`8bd7f9e904e87135d10d0a4df14c7fdce319ecf1`（O-0 文档状态同步）。审计结论见本修订；不修改 Runtime / Persistence / Contracts。
- **历史规划基线**：初稿曾以 `4f290e8607633db5a6f19ce9209f9edf42a9dc5c`（D4.R1）为 HEAD。该提交仍是 `8bd7f9e` 的父提交，但不再是本文件的开工基线。
- **实施范围（若后续获批）**：仅 `apps/soul-daemon/**`。不得修改 `packages/runtime`、`packages/persistence`、`packages/contracts`、Migration、其他生产模块或已有设计文档。
- **本文件约定**：每条设计都标注以下类别之一，禁止把建议读成已确认契约。
  - **【事实】** 当前仓库代码/文档可以直接核对的现状。
  - **【已确认决议】** 此前批次或本轮维护者已批准、不得在本批改写的决议（P1–P8、R8.3、D-RT1、D-R1/D-R2/D-R3、O-1–O-11 等）。
  - **【本次建议】** 本规划提出的、实现层面的设计；不得与已确认决议冲突。
  - **【开工前置】** 必须先满足的外部条件（O-0），不是设计选项。

**本修订（复审反馈）已落实的维护者决策**：

- **D-R1（关闭）**：删除“硬超时后放弃 Scheduler.stop 并关闭 Store”的方案；本批不提供强制关闭上界，Scheduler 未停止前不得关闭 Store。
- **D-R2（Handler）**：SH-008E 不注入 Handler Map；Scheduler 固定使用空 Handler 快照。`Object.freeze(new Map())` 不是不可变性保证，不得作为设计依据。
- **D-R3（测试）**：补充 Recovery 部分完成后的重启与幂等测试；保留原阶段划分与 `apps/soul-daemon/**` 代码边界。测试参数以 E0.R1 的源码核对为准：`maxRowsPerRun` 计入 Persona 枚举行，不得再用 `maxRowsPerRun=1` 冒充“已经写下第一条任务”。

**E0.R1（审计修订，不改上述决议）**：

- 改正 §8.3 / §12.2 / §12.5 / §16.3 的部分提交预算。`maxRowsPerRun=2` 才是一条 Persona、两条 `running` 任务下的部分提交；`maxRowsPerRun=1` 只作为零写入对照。
- 补全九种 `incomplete` 原因的重启矩阵（§12.2.1）。不新增第十种原因，也不把抛错改记成 `incomplete`。
- 按 `StimulusIngress.close()` 的实现更正持久化副作用。O-11 的决议（无传输层、接受清缓冲、本批不做 drain）不改。
- `Store.close()` 失败后 Instance Lock 仍可能被释放。这是风险记录和 **E4 待决项**，本修订不选择、不批准任何处理策略。
- 回写 SH-008D 验收口径、O-0 完成事实、本文件状态和基线 SHA。O-0 的完成定义本身不改。
- 随后一次修正：`probe_budget_exceeded` 可以用已确认 env 在 Daemon 入口复现（§12.2.1，21 个 Persona、`maxRowsPerRun=22`）。`scan_query_budget_exceeded` 仍然不能，停止条件保留，不新增 env。

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
| 开工 HEAD | `d451f90d20c6acea4af298b52f6041b08b12e90c` |
| HEAD 含义 | Merge PR #8。相对父提交 `3eabe0d` 无树差异；`3eabe0d` 只把本文件初稿加入仓库 |
| 生产代码对应提交 | `8bd7f9e904e87135d10d0a4df14c7fdce319ecf1`。`git diff 8bd7f9e d451f90 -- . ':(exclude)docs/SH-008E-PLAN.md'` 为空 |
| O-0 提交 | `8bd7f9e`，父提交为初稿旧基线 `4f290e8607633db5a6f19ce9209f9edf42a9dc5c`（D4.R1）。`8bd7f9e` 至 `4f290e8` 之间只有六个文档的状态句 |
| 工作区 | E0.R1 开始时相对 `d451f90` 干净；本修订只改本文件 |
| 更早代码链 | `4f290e8` D4.R1 → `8c10f39` D4 → `2fb31dd` PR #6（含 `52549e9` D3 → `86eab59` D3.R1）→ D2.R1–R4：`9b5a55a`、`80a251c`、`ae54923`、`ea7afc9` |

**【事实】** `D4.R1` 的两项修正（Recovery 执行体内验证反向 lease、queued task 完整行快照）已独立复审通过；GitHub Actions Run #70（`45031522488`）attempt 2 全步骤成功。该次 CI 覆盖 Format/Lint/Typecheck/Test/Build/Consumer check。

### 2.2 SH-008D 验收状态与文档口径（O-0）

**【事实】** 维护者确认：SH-008D 已完成并通过独立复审与整批验收（D4 `8c10f39`，D4.R1 `4f290e8`）。

**【事实】** O-0 定义的六个位置已由 `8bd7f9e` 同步，且该提交是当前 `main` 的祖先：

- `docs/PLAN.md`
- `packages/runtime/README.md`
- `docs/architecture/RUNTIME-LIFECYCLE.md`
- `docs/architecture/MODULES.md`
- `docs/architecture/OVERVIEW.md`
- `docs/architecture/IDENTITY-PROTOCOL.md` 的 I05

**【事实】** 下面两处不在 O-0 清单里，本修订不改它们，也不把它们说成 O-0 失败：

- 根 `README.md` 仍有“D4 尚未开始、SH-008D 整批未验收”的旧句。
- `apps/soul-daemon/README.md` 仍按 SH-007A 的未装配现状书写；SH-008E 实施时只允许在该 app README 里更新本批事实。

**【已确认开工前置条件 O-0】** 决议不改。SH-008E **不得开工**，直到 SH-008D 验收状态的文档口径已同步：

1. 由维护者/文档维护者提交一个独立的**文档状态同步提交**（只改状态描述，不改架构决议），使 `docs/PLAN.md`、`packages/runtime/README.md`、`docs/architecture/RUNTIME-LIFECYCLE.md`、`MODULES.md`、`OVERVIEW.md`、`IDENTITY-PROTOCOL.md` I05 与“SH-008D 已验收”一致；
2. 该提交已合入 `main`。

在上述提交合入之前，**O-0 视为未完成，SH-008E 实施不得启动**；验收阶段再补、仅口头说明或仅在实施报告中记录都不算满足开工前置。

**【事实】** `8bd7f9e` 就是这个提交，并且已经在 `d451f90` 的历史上。O-0 因此视为完成。完成 O-0 仍然不是实施授权。

**【本次建议】**

- SH-008E 实施仍只改 `apps/soul-daemon/**`，不得回头修改 O-0 那六个文档，也不得顺手改根 `README.md`。
- Daemon README 只陈述本批装配事实，不替 SH-008D 宣布验收结论。
- E1 仍然要等本修订的独立复审和实施授权。O-0 完成只去掉文档口径这一闸，不去掉复审闸。

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
| P1 Ingress（事件总线存储侧） | `createStimulusIngress({ store, logger, config, now?, randomBytes?, timers?, ... })`；`acceptStimulus` / `readBuffered` / `listQueued` / `evictExpired` / `close()` / `metrics()` | **【事实】** 进程内受理、去重、会话复用、同事务提交 P1 信封、正文进 TTL 缓冲；**没有传输层**，Daemon 没有 `acceptStimulus` 入口，也没有 `drain`。`close()` 同步，但持久化范围只限于 `pendingTtl`，见 §7.7 |
| P1 Runtime Recovery | `recoverRuntime({ store, logger, policy, now?, batchSize?, maxRowsPerRun?, maxScanQueries?, maxPersonasPerRun?, maxProbeQueries?, signal? })` | **【事实】** 有界扫描。`maxRowsPerRun` 计入 Persona 枚举行和任务/事件页，不只计写入行。合法 `running` 经 `recoverRunningTask` 收敛（不加 attempt、不换 runId）；活跃事件收 `expired` + `buffer_lost`。不扫描 A/B、不读 Archive、不恢复检查点、不领取任务。`incomplete` 只有九种原因。每个 Repository 写是各自的 `withWrite` 并在返回前 COMMIT；扫描没有外包事务。`signal` 只在查询/行间隙检查 |
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
- 进入 `CLOSING`，`#releaseAll()` 同步逆序释放资源（store 先于 lock）。某一步抛错会被记下，循环继续，因此今天 `Store.close()` 抛错后锁仍会被释放。这是当前实现，**不是** SH-008E 已批准策略，见 §7.6。
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

**【事实边界】** 上表的“锁最后释放”只描述 `Store.close()` **成功返回**时的顺序。close 抛错之后还要不要调用 `lock.release()`，本修订不决定，见 §7.6。

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
   - **不**新增、也**不**传入 `maxScanQueries` / `maxProbeQueries`。未传入时使用 Runtime 自己的派生扫描预算和默认探测预算。要用这两个参数才能复现的 `incomplete`，按 §12.2.1 停止并报告，不得加 env，也不得加测试专用生产 API；
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
| 2 | DRAINING | 标记不再受理；`ingress.close()`（同步，副作用以 §7.7 为准）；`await scheduler.stop()`（异步，等待在途 Handler） | 见 §7.2（无强制上界）；记录步骤结果 |
| 3 | CHECKPOINTING | 仍**跳过** Runtime checkpoint；日志明确 `runtime_checkpoint_not_implemented` | 不伪造检查点 |
| 4 | CLOSING | **仅在 Scheduler stop resolve 后**才允许调用 `Store.close()`。当前代码的释放循环在 `Store.close()` 抛错后仍会继续 `lock.release()`；这个“失败后是否放锁”**不是已确认策略**，E4 见 §7.6 | 未决前不得把某一种失败策略写成实现 |
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

### 7.4 关闭步骤失败时记录什么

**【本次建议】**

- `ingress.close()` 抛错 → 记录 `event_bus_close` failed，继续后续步骤；
- `scheduler.stop()` **reject** → 记录 `scheduler_stop` failed；因为无法证明 Scheduler 已停止，**不进入会关闭 Store 的 CLOSING**；阶段保持 `DRAINING`（不置 `STOPPED`），`stop()` 以 `shutdown_failed` 拒绝；不伪造“清理完成”；
- `scheduler.stop()` pending（Handler 永不 settle）→ 不判失败、不关闭 Store，保持等待（§7.2）；阶段保持 `DRAINING`；
- `Store.close()` 失败后的锁处理：**未决**，见 §7.6。本条不再规定“记录失败后仍释放锁”；
- `lock.release()` 自身抛错 → 记录 failed（这只描述锁释放这一步自己失败，不决定上一步失败时要不要调用它）；
- 所有已执行步骤汇总到 `StopReport.steps`；任一失败 → `shutdown_failed`，不伪装干净关闭。

### 7.5 资源泄漏与任务丢失风险

| 风险 | 现状/缓解 |
|---|---|
| Scheduler 在途任务 | 本批空 Handler，正常无在途；未来 Handler 不 settle 时 `stop()` 可无限等待。不强制取消、不关闭 Store；任务保持 running，下次 Recovery 收敛 |
| Ingress 缓冲正文 | `close()` 丢掉进程内正文。没有传输层时生产路径不会受理数据。数据库副作用不是“全部变成终态”，见 §7.7。SH-009 的传输层与关闭前 drain 不在本批 |
| Store 关闭时仍有组件句柄 | D-R1 不变：CLOSING 只在 Scheduler `stop()` resolve 之后。若 stop 永不返回，不得关闭 Store |
| `Store.close()` 失败后锁被释放 | **E4 待决（§7.6）。** 当前 SH-007A 释放循环会在 Store 关闭抛错后继续放锁。本修订不把该行为批准为 SH-008E 的目标策略，也不批准相反策略 |
| 锁释放失败 | 若实施时确实调用了 `lock.release()` 且它自己失败：记录 `shutdown_failed`，锁文件保留。这不回答“Store 关闭失败时是否应该调用 release” |
| Daemon 无法自行退出 | 若未来 Handler 永不 settle，`stop()` pending；运维必须外部终止。下一次启动按崩溃恢复处理，不假装优雅关闭 |
| stop reject/pending 时资源未释放 | 不进入 CLOSING：Store 保持打开、锁文件保留；`stop()` reject 或 pending；下一次启动按陈旧锁/崩溃恢复处理，不报告 clean stop |
| 检查点 | 不写。没有 Runtime checkpoint 能力；跳过并记录，不伪造 |
| WAL | 仍无显式 `PRAGMA wal_checkpoint`；`Store.close()` 由 SQLite 自行决定是否自动 checkpoint；不在本批新增 |

### 7.6 E4 待决：`Store.close()` 失败后的 Instance Lock

> **历史状态（已取代）**：本节“E4 待决 / 不批准任何策略”的描述属于当时状态；D-E4-LOCK-1 已批准并实施。当前语义见 §19.2。

**【事实】** 当前 `packages/persistence` 的 `Store.close()` 在调用驱动 `database.close()` **之前**就把该实例记入已关闭集合并丢掉句柄。驱动关闭若抛错，异常会传出，但进程内这个 Store 已经不会再被使用。

**【事实】** 当前 `apps/soul-daemon` 的 `#releaseAll` 按获取的逆序释放，顺序是先 `store.close()` 后 `lock.release()`。某一步抛错会被记下，循环继续。因此今天若 `Store.close()` 抛错，Instance Lock **仍会被释放**。下一个进程可以按“目录上没有锁”打开同一个数据库文件，而前一次关闭并没有成功返回。

**【E4 待决设计项】** 本修订**不批准**下面任何一条，也不从中指定默认：

- 保持今天的循环：关闭失败也释放锁；
- 关闭失败则留下锁，让下次启动走陈旧锁或人工处理；
- 其他尚未提出的处理。

E4 在该决定经过独立复审之前，不得把其中一种写进实现并当成已确认行为，不得用关闭超时、强制取消 Handler 或放弃 `scheduler.stop()` 来回避它。D-R1 仍然有效：`scheduler.stop()` 未 resolve 时不得调用 `Store.close()`。本项只涉及 close **已经失败之后**要不要放锁。

### 7.7 `StimulusIngress.close()` 的实际副作用

**【事实】** 实现在 `packages/runtime/src/events/bus.ts` 的 `close()`，对照 `buffer.clear()` 与 `persistExpire`：

1. 先把内部 `closed` 设为 true。之后 `acceptStimulus` 拒绝新输入。
2. `buffer.clear()` 取消定时器并丢掉全部进程内正文。这一步**不写数据库**。当时仍是 `received` / `accepted` 的行保持原状态，不会变成 `expired`，也不会写成 `buffer_lost`。
3. 只有已经留在 `pendingTtl` 里的收口记录会尝试写库，而且每条是自己的 `withWrite`：
   - reason 为 `ttl_expired` 时调用 `expireActive`，命中则变成 `expired` / `ttl_expired`；
   - reason 为 `processing_failed` 时调用 `rejectIfActive`，命中则变成 `rejected` / `processing_failed`；
   - 条件不满足则返回 `null`，该条不改。
4. 注入时钟抛错时，`pendingTtl` 被清空，本次 `close()` **零数据库写**。
5. `persistExpire` 内部失败会被吞掉。`close()` 在循环结束后无条件 `pendingTtl.clear()`。补试回调又会看到 `closed === true` 后直接返回。因此关闭过程中没写成的收口**不会在 `close()` 返回后继续重试**。
6. 第二次 `close()` 看到空缓冲和空 `pendingTtl`，不再写。这里的幂等是“不重复写、不把正文放回来”，不是“所有曾经缓冲的行都已是终态”。

**【已确认决议 O-11 不改】** 本批没有传输层，没有真实受理数据，不实现 drain。上述条目只纠正事实，不新开一种关闭策略。下次启动时，仍为 `received` / `accepted` 且 `archive_state='none'` 的行由 `recoverRuntime` 收成 `expired` / `buffer_lost`；这是 Recovery 的行为，不是 `close()` 已经做过的事。

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

上表里的“逆序释放 Store→锁”只在 `Store.close()` 成功时成立。close 已经抛错之后是否放锁，不由本表决定，见 §7.6。

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

- **【事实】** Recovery 的写是按行/按事件各自 COMMIT 的条件写，不是整次扫描一个事务。停下来之前已经 COMMIT 的收敛保持有效。内存里的页游标不持久，下次从各查询的起点重扫，但查询只选择仍处于旧状态的行。
- **【事实】** `maxRowsPerRun` 把 Persona 枚举返回的行也算进行预算（`recover.ts` 在 `listPage` 之后 `state.rows += page.length`）。一个 Persona、两条 `running`、默认 `batchSize` 时：
  - `maxRowsPerRun=1`：枚举读到这一个 Persona 后预算已经用尽，`scanPersona` 不会运行。两条任务都仍是 `running`，计数为 0。用同一个预算再跑，仍然零写。这**不是**部分提交。
  - `maxRowsPerRun=2`：枚举占用 1，U1 再读并提交 id 较小的那一条（`ORDER BY id ASC`），然后 `row_budget_exceeded`。另一条仍是 `running`。这才是部分提交。
- 部分提交的重启（`maxRowsPerRun=2` 的那一组，第二次把 `maxRowsPerRun` 提高到足够扫完，O-2 仍要求第一次 `incomplete` 时启动失败、不创建 Scheduler）：
  - 已变成 `queued` 的那条不得再次 requeue，不得增加 attempt，不得更换 runId；
  - 仍为 `running` 的那条收敛为 `queued` 或 `failed`，attempt 与 runId 仍不因 Recovery 改变；
  - 第二次报告只统计这一轮真正 `changes===1` 的行。
- `maxRowsPerRun=1` 只保留为对照：断言两条都未被 Recovery 改写。禁止把“第一条已经是 queued”写进这组断言。对照通过后，若另一次启动使用足够预算，两条都会被**第一次**收敛，不存在“跳过第一条”。
- 九种 `incomplete.reason` 的触发参数、有没有提交、以及第二次怎么走，以 §12.2.1 为准。失败关闭三类（`invalid_task_row`、`archive_state_present`、`unexpected_event_status`）在脏行还在时不会因为加大预算而完成。
- 若第一次 Recovery **完整成功**、但之后在 READY 或创建组件时失败，重启应看到 0 个任务/事件变化。
- 进程在某次 `withWrite` 的 COMMIT 之前被杀死：该条未提交。下次只收敛仍是 `running` 或仍活跃的行。
- `recoverRuntime` 抛错（例如中途 `invalid_clock`）不是第十种 `incomplete`。抛错前已经 COMMIT 的行同样保持；lease 在 `finally` 里释放。

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
- **【事实，不是新决议】** `recoverRuntime` 还可以接收 `maxScanQueries` 与 `maxProbeQueries`。上表没有对应 env，本修订不新增它们，也不批准测试专用入口。不传 `maxProbeQueries` 时用 Runtime 默认 200；§12.2.1 的 Daemon 场景靠这个默认值制造 `probe_budget_exceeded`。不传 `maxScanQueries` 时按其他预算派生，派生值够扫完，已确认 env 复现不了 `scan_query_budget_exceeded`。后者仍按 §12.2.1 停止，不得加 env。

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

- **O-0 已完成的事实**：`8bd7f9e` 已合入当前 `main`（`d451f90`）的历史，六个文档口径与“SH-008D 已验收”一致。完成定义本身不改。完成 O-0 **不是**实施授权。
- 核对 §16.2 的已确认决议与 §16.3 实施核对条件。D-R1–D-R3 与 O-0–O-11 不在本修订中改写。
- **本规划仍有一个未决设计项**：`Store.close()` 失败后是否释放 Instance Lock（§7.6）。E0 不得把它写成已批准策略，也不得为了“消除未决”而选边。
- **O-3 契约核对**：阅读 Runtime 实际导出的 policy 类型与 `recoverRuntime` / `createScheduler` 参数，确认同一个冻结对象可同时满足双方；不符合则停止报告。
- 确认依赖范围仅为 `@soul-harness/runtime`（§10），不新增直接 contracts 依赖。
- 取得维护者的 SH-008E 实施授权；未取得前不写代码，不开始 E1。

### E1 — 配置、错误码、状态模型

- 扩展 `config.ts`、`errors.ts`、`phases.ts`（能力/步骤状态）。
- 增加配置单测；不接触 Daemon 生命周期。
- 验收：typecheck + config 测试。

### E2 — RECOVERING 装配

- `components.ts` 构造 `PersonaLifecycle`（bootId 来自锁）与 Recovery 调用。
- `daemon.ts` 在 RECOVERING 执行 normalize + recover；fail-closed；记录报告。
- 增加集成测试：空库、崩溃数据、recovery 抛错、incomplete。预算参数以 §12.2.1 为准。`row_budget_exceeded`、`persona_budget_exceeded` 和 `probe_budget_exceeded` 都只用已确认 env：探测预算用 Runtime 默认 200，Daemon 场景是 21 个 Persona 加 `SOUL_RECOVERY_MAX_ROWS=22`（见 §12.2.1）。`scan_query_budget_exceeded` 不能靠已确认 env 复现；E2 对此**停止并报告**，不得新增 env，也不得新增测试专用生产 API。
- 验收：RECOVERING 路径可独立验证；E2 完成时**不创建/不启动 Scheduler**，`phases` 可暂时把 scheduler 标为 pending；完整 `RUNNING` 留到 E3。

### E3 — READY 装配

- 创建 Ingress、Scheduler（固定空 Handler），start；扩展报告/状态/能力。
- 测试：组件存在、状态、日志顺序、空 Handler 不派发。
- 验收：完整启动；旧 `skippedSteps` 只剩 http/health。

### E4 — 关闭与资源栈（无强制上界）

- DRAINING：Ingress close、`await scheduler.stop()`（不放弃等待）；异步资源栈；仅 stop resolve 后 CLOSING Store/Lock。
- 测试：正常关闭、幂等、stop during boot。已经执行的步骤若自己失败，报告 failed，不伪装 clean。**不**把“`Store.close()` 失败后仍释放锁”写成用例的预期；该行为仍是 §7.6 待决，E4 在独立复审选定策略之前不得实现其中任何一条。不测试“超时后强制关闭”（该方案已删除）。
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
| 非法任务行 | Recovery fail-closed，boot 失败；不创建 Scheduler；`Store.close()` 成功时锁随之释放。触发参数与“已提交的那一行不再被处理”见 §12.2.1，不在本行用 `maxRows=1` 代替 |
| 行预算零写入对照（1 个 Persona，2 条 `running`，`maxRowsPerRun=1`，默认 `batchSize`） | `incomplete.reason='row_budget_exceeded'`；两条都仍是 `running`，requeued/failed/expired 为 0；boot fail closed；不创建组件。**禁止**断言第一条已 `queued`。同一个预算再跑仍然零写 |
| **部分恢复后重启（D-R3，`maxRowsPerRun=2`）** | 同一组种子、默认 `batchSize`。第一次：id 较小的任务已 `queued`，attempt 与 runId 不变，另一条仍 `running`，原因 `row_budget_exceeded`，boot 失败、无 Scheduler。第二次把 `maxRowsPerRun` 提高到足够扫完：只收敛剩余那条；已 `queued` 的不再 requeue、不增加 attempt、不换 runId；第二次报告只统计这一轮真正变化的行。其余八种原因见 §12.2.1 |
| **完整恢复后重启（幂等）** | 第一次启动成功并正常停止；第二次启动 Recovery 报告 requeued=0/failed=0/expired=0，任务/事件行与第一次结束后一致；`normalizeCrashedPersonas` 返回 0 |
| Recovery 抛错（注入 `now` 抛 `invalid_clock`，或损坏 schema） | 失败码 `runtime_recovery_failed`；资源释放；不创建组件 |
| 启动中 stop | `startup_aborted`；不创建 Scheduler；`Store.close()` 成功时锁/Store 释放。若停止请求已经置位，结果是 `startup_aborted`，不是 `recovery_incomplete`（O-2，决议不改） |

空库加上很小的 `maxScanQueries` 仍可能 `incomplete === null`（枚举后的探测把剩余范围证成空）。这**不能**拿来证明“部分提交之后的重启”。部分提交只按下一节的参数制造。

### 12.2.1 九种 `incomplete` 的 D-R3 重启矩阵

参数均按 `packages/runtime/src/recovery/recover.ts` 在基线 `d451f90`（生产代码同 `8bd7f9e`）的控制流核对，不是新策略。`incomplete` 只有这九种。中途 `invalid_clock` 是抛错，不是第十种；抛错前已经 COMMIT 的行保留，lease 在 `recoverRuntime` 的 `finally` 里释放。

共同事实：每个 Repository 写是各自的 `withWrite`，返回前 COMMIT，没有外包事务。`recoverRunningTask` / `failExhaustedTask` / `expireIfActive` 都不增加 attempt、不更换 runId。页顺序是 `ORDER BY id ASC`。`abort()` 只在 `stop === null` 时写入原因；探测预算耗尽会**替换**此前的扫描预算原因。失败关闭四类（`invalid_task_row`、`archive_state_present`、`unexpected_event_status`、`concurrent_modification`）以及 `aborted` 在探测之前返回。

| 原因 | 已核对的触发参数 | 第一次写出了什么 | 第二次 |
|---|---|---|---|
| `row_budget_exceeded`（部分提交） | 1 个 Persona，2 条合法 `running`，`batchSize=200`，`maxRowsPerRun=2`，扫描/探测预算保持默认 | 枚举占用 1 行后 U1 提交 id 较小的那条（`queued`，attempt/runId 不变），然后 `rows >= 2`。另一条仍 `running`。`requeued=1`。探测看见剩余行，但原因保持 `row_budget_exceeded` | 把 `maxRowsPerRun` 提高到足够：只收敛第二条；第一条不再被选中。报告只计这一轮的新变化 |
| `row_budget_exceeded`（零写入对照） | 同上种子，只把 `maxRowsPerRun` 改成 1 | 枚举读到这一个 Persona 后预算用尽，`scanPersona` 不运行。两条都仍是 `running`，计数为 0。同一个预算再跑仍然零写 | **禁止**断言第一条已 `queued`。之后若用足够预算启动，两条都在那一次被第一次收敛 |
| `scan_query_budget_exceeded`（不是 Daemon 入口） | `batchSize=1`，`maxScanQueries=3`，`maxRowsPerRun` 用默认或任何 ≥ 3 的值，`maxProbeQueries` 用默认 200，1 个 Persona，2 条 `running`。§9.2 没有 `maxScanQueries`，已确认 env 打不出这一行 | 查询 1 读到满页的 1 个 Persona（枚举未完成）；查询 2 读到空页（枚举完成）；查询 3 提交 id 较小的任务；查询 4 被拒绝。另一条仍 `running`。最终原因仍是 `scan_query_budget_exceeded`。**禁止**把这组的 `maxRowsPerRun` 设成 2，否则先变成 `row_budget_exceeded` | 默认扫描预算只收敛剩余那条；已 `queued` 的不再处理。本行不得写成 Daemon 已覆盖 |
| `persona_budget_exceeded` | 3 个 Persona，Persona 1 和 Persona 3 各有一条 `running`，`batchSize=200`，`maxPersonasPerRun=2`，`maxRowsPerRun` 保持默认 | 一页读到 3 人，只接受前 2 人，在 `scanPersona` 之前 abort。**零写入**，包括已经被接受的 Persona 1。`personasScanned=2`。探测可以跑，但不得改原因、不得写任务 | 同一上限再跑仍然零写。把 `maxPersonasPerRun` 提到 3：两条各收敛一次。不要同时把 `maxRowsPerRun` 降到小于本页人数，否则原因会先变成行预算，且第三人根本不在这一页 |
| `probe_budget_exceeded`（仅 Runtime 参数，此前已有提交） | 1 个 Persona，1 条 `running`，1 条 `archive_state='none'` 的 `received`，`batchSize=200`，`maxScanQueries=2`，`maxProbeQueries=1`，`maxRowsPerRun` 默认。**不是 Daemon 入口**：§9.2 没有这两个查询预算 | U1 提交这条任务。扫描在 U2 停在 `scan_query_budget_exceeded`，事件还没写。第一次探测（U2）是空的，第二次探测被拒绝，**最终原因被替换成** `probe_budget_exceeded`。事件仍是 `received` | 默认预算：`requeued=0`，`expired=1`；任务的 attempt/runId 仍不变。本行只说明 `recoverRuntime` 的参数行为，不得写成 Daemon 已覆盖 |
| `probe_budget_exceeded`（仅 Runtime 参数，零写入） | `maxScanQueries=1`，`maxProbeQueries=1`，1 个 Persona，没有任务。与 `packages/runtime/test/recovery.test.ts` 的探测预算用例相同。同样**不是 Daemon 入口** | 枚举用掉唯一一次扫描查询，U1 不再查询。零写。最终原因是 `probe_budget_exceeded`（替换掉扫描预算原因） | 默认预算：`incomplete === null`，计数为 0。不得把这条 Runtime 测试写成 SH-008E 已验证 |
| `probe_budget_exceeded`（Daemon 入口，此前已有提交） | **只用已确认 env。** 21 个 Persona，没有事件。唯一一条合法 `running` 必须在 id **最小**的 Persona 上。`batchSize=200`，`maxRowsPerRun=22`，`maxPersonasPerRun=200`（两项都是 §9.2 默认），**不传** `maxScanQueries` / `maxProbeQueries`（探测默认 200，扫描用派生值） | 枚举一页读到 21 人（21 < 22），枚举完成，`rows=21`。U1 以 `limit=1` 提交这条任务（`queued`，attempt/runId 不变），`rows=22` 后扫描停在 `row_budget_exceeded`，该 U1 不标完成。未完成单元是 21×10=210。探测跑满 200 次空范围，下一次被拒绝，**最终原因替换成** `probe_budget_exceeded`。`requeued=1`。boot fail closed，无 Scheduler | **同一个** `maxRowsPerRun=22` 再启动即可完成，不必加大预算：任务已不是 `running`，空页不再把行预算耗尽，`incomplete === null`，`requeued=0`，已 `queued` 的行不再处理。若这条 `running` 不在最小 id 上，前面的空 Persona 会先扫完，探测可能把剩余范围证成空并报 **complete**（写入仍会发生）。20 个 Persona 且 `maxRowsPerRun=21` 时未完成单元正好 200，200 次空探测都成功，结果也是 **complete**，不是本原因。人数必须是 21，任务必须在最小 id 上，且不能再放会让探测提前命中的行 |
| `probe_budget_exceeded`（Daemon 入口，零写入） | 20 个 Persona，没有任务、没有事件。`batchSize=20`，`maxRowsPerRun=20`，`maxPersonasPerRun` 保持默认 200，不传两个查询预算 | 枚举读满一页 20 人后行预算用尽，`scanPersona` 不运行。游标之后没有 Persona，探测继续走单元。零写。第 201 次探测被拒绝，原因是 `probe_budget_exceeded` | 同一对预算再跑仍然零写、仍然是这个原因。把 `batchSize` / `maxRowsPerRun` 提高到默认（200 / 10000）后，第二次 `incomplete === null`，计数为 0 |
| `aborted` | 2 个 Persona，各 1 条 `running`。沿用 Runtime 测试的时钟：`resolveOptions` 的预检是第 1 次 `now()`，Persona 1 的 `finishedAt` 是第 2 次；在第 2 次 abort signal。abort 在行间隙才被看到，所以这次条件写仍然提交 | Persona 1 已 `queued`，attempt/runId 不变；Persona 2 仍 `running`。`requeued=1`。原因是 `aborted`，不进入探测 | 不再 abort：只收敛 Persona 2。若 Daemon 在这次启动里已经请求停止，进程结果是 `startup_aborted`，**不是** `recovery_incomplete`（O-2） |
| `archive_state_present` | 1 个 Persona。两条都是 `received`：id 较小的 `archive_state='none'`，id 较大的 `archive_state='pending'` | U5 先提交较小的那条（`expired` / `buffer_lost`），再在较大的那条上 fail closed，不写它。探测不运行 | 第二次 `expired=0`，较小那条的 `updated_at` 不变，原因相同。加大预算也不会完成，直到那条 archive 行被数据修复。这不是预算重启 |
| `unexpected_event_status` | 1 个 Persona。至少一条 `archive_state='none'` 的 `received`，另有一条 `noticed`（`understood` / `response_committed` 同样） | U5 先提交那条 `received`。U6 看到 `noticed` 后 fail closed，不写 U6 行，探测不运行。只有 U6 行、没有可提交的 U5 行时，本次零写 | U6 行还在就一直是同一原因，第二次 `expired=0`。加大预算无效 |
| `invalid_task_row` | 两条 `running`，默认 `batchSize`：id 较小的合法，id 较大的 `attempt=0` | 较小的那条先提交为 `queued`；较大的那条停在校验，仍是 `running` 且 attempt 仍为 0。探测不运行。同一页若在物化时抛 `RangeError`，则这一页一行都不写（任务页才把 `RangeError` 收成这个原因）。事件页没有这层包装，那里的 `RangeError` 是抛错，不是本原因；本修订不为此改 Runtime | 脏行还在就永久 incomplete，第二次 `requeued=0`，已 `queued` 的不再处理 |
| `concurrent_modification` | 两条 `running`。第 1 次 `now()` 是 `resolveOptions`，第 2 次是第一条的 `finishedAt` 并提交，第 3 次是第二条的 `finishedAt`：在这一次把第二条的 `run_id` 改掉，使随后的 CAS 落空 | 第一条已 `queued`，attempt/runId 不变。第二条仍是 `running`，而且是新的 `run_id`；这一次 CAS 没有写它 | 去掉竞态后再跑：按新快照收敛第二条，attempt 不增加。不是永久原因。若竞态已经把行改成终态，第二次不得把它改回去 |

**【Daemon 覆盖边界，不是新决议】**

- `daemon.start()` 可以用已确认 env 覆盖：`row_budget_exceeded`（`SOUL_RECOVERY_MAX_ROWS`）、`persona_budget_exceeded`（`SOUL_RECOVERY_MAX_PERSONAS`）、`batchSize`（`SOUL_RECOVERY_BATCH_SIZE`），以及上表两行 **Daemon 入口** 的 `probe_budget_exceeded`（默认探测预算 200，不新增 env）。三个失败关闭原因用 SQL 种子。`aborted` 与 `concurrent_modification` 沿用 §6.2 / §12.6 已经写明的可注入 `now`；真实 `dist/main.js` 没有这只时钟，**进程级不算已覆盖**。
- 上表标成“仅 Runtime 参数”的两行 `probe_budget_exceeded` 依赖显式 `maxScanQueries` / `maxProbeQueries`。它们说明原因如何被替换，**不是** Daemon 验收，不得算作已通过。
- `scan_query_budget_exceeded` 仍要显式 `maxScanQueries`。不传时扫描预算按 `ceil(maxPersonas/batch)+1 + 10×maxPersonas + maxRows` 派生，派生值够扫完，已确认 env 打不出这个原因。不得新增该 env，也不得新增测试专用生产 API。E2 复现不了就停止并报告。Runtime 的 `recovery.test.ts` 只证明原因码，不能代替这条 Daemon 验收，也不能写成“已经覆盖”。

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
| 清理失败 | 已经执行的步骤若自己失败：报告 failed，不伪装 clean。`Store.close()` 失败后是否调用 `lock.release()` **不在本用例里预先断言**，见 §7.6 |
| 停止后重启 | 新 Daemon 能创建 Scheduler（lease 已释放）、锁可获取、DB 可打开 |

### 12.5 真实进程

- 无 env/缺 policy → 退出码 2。
- 正常启动 + SIGTERM → 0；日志有 `scheduler_started`/`scheduler_stopped`。
- 同目录第二实例 → 4；不建库。
- 迁移失败 → 5；锁释放。
- SIGKILL → 残留锁；下次启动接管；若上一次已留下 running 任务，Recovery 按 D-RT1 收敛；重新创建 Scheduler。
- 不同目录两实例 → 各自 RUNNING（锁按目录）。
- 进程测试全部等待日志事件/退出，不用固定 sleep；超时只作为测试失败保护。
- **Recovery 部分完成的进程级覆盖**（O-2 fail-closed；用预算制造，不用 sleep，也不用杀进程时序）。种子固定为 1 个 Persona、2 条合法 `running`：
  - `SOUL_RECOVERY_MAX_ROWS=2`（其余预算用 §9.2 默认）：第一次以 `recovery_incomplete` 失败退出，无 Scheduler；id 较小的任务已是 `queued`，attempt 与 runId 不变；另一条仍是 `running`。第二次把 `SOUL_RECOVERY_MAX_ROWS` 提高到足够扫完：只收敛剩下的那条；已 `queued` 的不再 requeue、不增加 attempt、不换 runId；第二次计数只包含这一轮真正变化的行。
  - `SOUL_RECOVERY_MAX_ROWS=1` 只做零写入对照：第一次同样失败，但两条都仍是 `running`，计数为 0。禁止断言“第一条已经 queued”。再用足够预算启动时，两条都在这一次被第一次收敛。
- 进程级测试不得新增 env 去制造 `scan_query_budget_exceeded`。做不到就按 §12.2.1 停止并报告，不得把 Runtime 单测写成进程级已覆盖。`probe_budget_exceeded` 不要新 env：用上一节的 Daemon 入口（21 个 Persona，唯一 `running` 在最小 id 上，`SOUL_RECOVERY_MAX_ROWS=22`，其余预算默认）。同一预算第二次启动应 `incomplete === null` 且 `requeued=0`。

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
| Recovery 部分完成后重启 | Daemon 入口只覆盖 §12.2.1 标明能由 `daemon.start()` 复现的原因：`maxRowsPerRun=2` 的部分提交、`=1` 的零写入对照、`persona_budget_exceeded`、Daemon 入口的 `probe_budget_exceeded`（21 个 Persona / `maxRowsPerRun=22`），以及三个 SQL 种子失败关闭原因。§12.5 进程级同样只覆盖这些，外加 `maxRows=2` 与 `=1`。`aborted` / `concurrent_modification` 依赖可注入 `now`，真实进程不算已覆盖。标成“仅 Runtime 参数”的探测行，以及 `scan_query_budget_exceeded`，**都不得写成已验证** |
| Recovery 幂等 | 12.2 完整恢复后第二次启动 0 变化；normalize 0 条。Daemon 入口的 `probe_budget` 第二次在同一 `maxRowsPerRun=22` 下也是 0 变化 |
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
3. **恢复与幂等**：崩溃种子数据被正确收敛（Persona 归一、running 任务 attempt 不变、活跃事件 expired）；Recovery 抛错/`incomplete` 时 boot 失败且无 Scheduler 残留；`Store.close()` 成功时锁/Store 释放。**部分完成后的重启不会重复处理已收敛行**，参数以 §12.2.1 为准：`maxRowsPerRun=2` 才是一条 Persona、两条 `running` 的部分提交，`maxRowsPerRun=1` 必须保持零写入。Daemon 入口的 `probe_budget_exceeded` 按该节的 21 Persona / `maxRowsPerRun=22` 场景验收，第二次同一预算为 0 变化。完整恢复后的第二次启动为 0 变化。`scan_query_budget_exceeded` 和“仅 Runtime 参数”的探测行没有 Daemon 入口，**验收时不得写成已通过**。
4. **lease**：Recovery 与 Scheduler 不重叠；只有 Recovery 成功后才创建 Scheduler；**Scheduler stop resolve 后**才关闭 Store；重启后新 Scheduler 可创建。
5. **关闭**：正常关闭顺序正确；重复关闭幂等；空 Handler 路径无在途任务；**不声称有界关闭或超时强制关闭**。`Store.close()` 成功时锁在其后释放；没有“放弃等待后继续关库”的路径。close 失败后是否放锁仍是 §7.6 待决，验收不得把未决策略写成已通过。
6. **配置与契约**：新配置有边界/默认/必填语义，非法值在接触 DB 前失败；两个 policy env 必填、无默认；**实施前已核对 Runtime 实际导出的 policy 类型与 `recoverRuntime` / `createScheduler` 参数（§16.3 O-3），同一个冻结对象同时满足两边**；兼容现有退出码。
7. **bootId**：启动报告 `bootId` 与锁文件 `bootToken` 完全一致；该值通过当前 `BOOT_ID_PATTERN` / `isBootId` 的实际校验（以 `createPersonaLifecycle` 接受为准，并记录当前 pattern 文本）；PersonaLifecycle 使用同一个值。不兼容时停止报告，不修改 Runtime/Contracts/锁协议。
8. **测试**：新增测试覆盖 §12 里标明由 Daemon 入口验证的用例；`pnpm --filter @soul-harness/soul-daemon test`、运行时全量、根 `pnpm run check` 全绿；真实进程测试覆盖 SIGTERM/SIGKILL/双实例。`scan_query_budget_exceeded` 未取得显式扫描预算入口之前不算本项通过；不得用 Runtime 既有测试填这个缺口，也不得为此改矩阵以外的生产代码。
9. **文档**：`apps/soul-daemon/README.md` 与实现一致；状态/能力/限制明确；不修改其他设计文档；**O-0 开工前置已满足（文档同步提交已合入）**。
10. **不夸大**：不声称 HTTP/健康、检查点、Handler 认知、跨进程 lease、运行期监督已完成；不把 `scheduler: 'running'` 写成可派发能力。
11. **独立复审**：实施报告 ≠ 复审结论；CI 结果以远端为准，不接受“本地通过”替代。

---

## 14. 风险与停止条件

### 14.1 主要风险

> **历史/当前状态（2026-11）**：本表其余风险及其缓解仍然有效；涉及 §7.6 锁策略的行已由 D-E4-LOCK-1 更新，O-0 行保留“阶段完成不等于整批验收”的治理含义。当前实施状态见 §19。

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
| 用 `maxRowsPerRun=1` 描述部分提交 | 断言与源码相反 | §8.3 / §12.2 / §12.5 / §16.3：一条 Persona、两条 `running` 的部分提交是 `maxRowsPerRun=2`；`=1` 只做零写入对照 |
| `Store.close()` 失败后锁被释放（历史风险） | 关库未成功，下一进程仍可能打开同一文件 | 已由 D-E4-LOCK-1 处理：close 失败保留 Instance Lock，报告 `shutdown_failed` / 退出码 6；当前实现见 §19.2。旧“E4 待决”不再适用 |
| 把 O-0 完成或阶段合并误读成整批验收 | 未经最终复审就宣称完成 | O-0 已完成，E1–E5 已合并；阶段合并不等于 SH-008E 整批验收。当前状态见 §19.1 |
| 测试依赖 sleep/时序 | CI 抖动 | §12.6 注入时钟/定时器 |

### 14.2 停止条件（遇到即停，不自行扩大范围）

> **历史/当前状态（2026-11）**：第 1 条中 O-0 尚未完成、不得开始 E1 的前置条件已被后续实施事实取代；第 2 条中本批实施授权的前置条件已满足，但新的生产实现仍需维护者明确授权，SH-008E 整批验收仍需独立最终复审。第 11 条中的锁策略待决状态已被 D-E4-LOCK-1 取代；Recovery 预算和测试 API 限制继续有效。

1. **把 O-0 仍当成未完成，或把阶段完成当成整批验收**：`8bd7f9e` 已完成 O-0 的六处文档同步，E1–E5 已合并。不得改写 O-0 的完成定义，也不得因阶段合并宣告 SH-008E 整批验收；新的实施仍需相应授权，最终验收仍需独立复审。
2. **新的实施或验收未获相应授权**：E1–E5 已完成，但任何新的生产实现仍需维护者明确授权；SH-008E 整批验收仍需独立最终复审。未取得授权或复审未通过时，不得开始新的实施或宣告验收。
3. 需要修改 `packages/runtime/**`、`packages/persistence/**`、`packages/contracts/**`、Migration 或已有设计文档才能完成。
4. Runtime 公开 API 不足以完成装配（例如无法用同一 Store 创建 Scheduler、无法取得 Recovery 报告），且不能通过 Daemon 层配置/顺序解决。
5. 必须新增测试专用生产 API 或直接访问内部 lease 才能验证。
6. 依赖范围超出 O-1：需要直接依赖 `@soul-harness/contracts`、增加其他 workspace 依赖、或 lockfile 出现非 runtime 依赖的版本升级。
7. O-3 契约核对失败：Runtime 实际导出的 policy 类型/工厂参数无法由同一个冻结对象同时满足；不得修改 Runtime/Contracts 迁就规划。
8. O-9 格式核对失败：`lock.holder.bootToken` 不被当前 `BOOT_ID_PATTERN` / `isBootId` 接受，或启动报告、锁、PersonaLifecycle 三处不能保持同值；不得修改 Runtime/Contracts/锁协议或另生成 ID 绕过。
9. 维护者要求本批提供 Handler 注入/真实 Handler、或有界关闭；这些超出 D-R1/D-R2 的已确认范围，需先取得新决议。
10. 发现 D1–D3 的真实缺陷：停止，提交复现/影响/建议报告；不在本批顺手修。
11. 为了覆盖 `scan_query_budget_exceeded` 而新增 env 或测试专用生产 API；`probe_budget_exceeded` 必须用 §12.2.1 的已确认 env 场景，不得改成新增 `maxProbeQueries` env。§7.6 的锁策略已由 D-E4-LOCK-1 决定并实施，不得推翻或重新选择该决议。

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
- 修改根 CI、根脚本、其他 app/package、已有架构文档。O-0 的六处状态同步已由 `8bd7f9e` 完成；实施时仍不得再改那些文档，也不得改根 `README.md`。

---

## 16. 开工前置、已确认决议与实施核对

### 16.1 开工前置条件（O-0，必须先完成）

| 项 | 要求 |
|---|---|
| 前置 | **O-0：SH-008D 验收状态的文档口径已同步** |
| 完成定义 | 独立的文档状态同步提交已合入 `main`，使 `docs/PLAN.md`、`packages/runtime/README.md`、`docs/architecture/RUNTIME-LIFECYCLE.md`、`MODULES.md`、`OVERVIEW.md`、`IDENTITY-PROTOCOL.md` I05 与“SH-008D 已验收”一致 |
| 时点 | **SH-008E 实施开始之前**；验收阶段再补不算满足 |
| 未完成时 | 不得写代码、不得创建实施分支/提交；本规划不能作为开工依据 |
| 当前核对 | `8bd7f9e` 已在 `d451f90` 的历史上，O-0 定义的六个位置已同步。完成定义不改。该事实不是实施授权，也不取消对本修订的独立复审 |
| 责任 | 维护者/文档维护者；不属于 SH-008E 的 `apps/soul-daemon/**` 范围 |

### 16.2 已确认决议（全部生效）

| ID | 已确认决策 |
|---|---|
| D-R1 / O-6 | 不设强制关闭上界。删除“硬超时 → 放弃 `scheduler.stop()` → 关闭 Store”；Scheduler stop 未 resolve 前不得关闭 Store；不新增 `shutdown_timeout`；`SOUL_SHUTDOWN_TIMEOUT_MS` 本批不赋予关闭语义；Daemon 不承诺有界退出。 |
| D-R2 / O-4 | Scheduler 固定空 Handler 快照可接受为“已装配”；报告固定 `handlerKinds: 0`；不注册假 Handler。 |
| D-R2 / O-5 | 不注入 Handler Map；`DaemonOptions` 不提供 handlers 参数；后续批次另行批准注册/注入边界。 |
| D-R3 | 增加 Recovery 部分完成后的重启与幂等测试（§8.3、§12.2、§12.5）。参数以 §12.2.1 为准，禁止用 `maxRowsPerRun=1` 充当“已经写下第一条任务”。决议本身不改。 |
| O-1 | 依赖只新增 `@soul-harness/runtime`（`workspace:*`）；**不**新增直接的 `@soul-harness/contracts` 依赖；`pnpm-lock.yaml` 只允许因该 workspace 依赖发生预期变化，不夹带版本升级。 |
| O-2 | Recovery 返回 `incomplete !== null` 时 **fail closed**：启动失败（`recovery_incomplete`），不创建 Ingress/Scheduler；若启动中已请求停止，则优先 `startup_aborted`。 |
| O-3 | `SOUL_TASK_MAX_ATTEMPTS` 与 `SOUL_TASK_RETRY_BACKOFF_MS` **必填、无默认**；范围分别为 1–100、0–86400000 的安全整数；同一个冻结 policy 对象传给 Recovery 与 Scheduler。实际类型契约必须在实施前核对（§16.3 O-3），规划示例不是契约。 |
| O-6 | 同 D-R1（不设强制上界）。 |
| O-7 | Ingress 默认值批准为 256 / 300000 / 8；范围按 §9.2：queue 1–1000000、bufferTtl 1–86400000、persona 1–1024；不在运行时静默夹值。 |
| O-8 | 四个维度分开：**assembled / started / acceptsInput / dispatchesTasks**。PersonaLifecycle：assembled，`autoStarted: false`；Event Bus：assembled、`initialized: true`（Ingress 无独立 start，initialized 表示构造完成）、`transport: 'none'`、`acceptsInput: false`，能力为 `assembled_no_transport` + `eventIngress: 'unavailable_no_transport'`；Scheduler：`started: true`（start 成功）、`state: 'running'`、`handlerKinds: 0`、`dispatchesTasks: false`，能力必须同时有 `scheduler: 'running'` 与 `taskDispatch: 'unavailable_no_handlers'`；HTTP API / Health：`not_implemented`。`StartReport`、`DaemonStatus`、能力报告使用同一组字段与值，禁止只写 `scheduler: 'running'` 而不给派发维度。 |
| O-9 | `bootId` 复用 `lock.holder.bootToken`，不生成第二份 boot 标识。**格式兼容性不是已默认事实**：实施前核对当前 `BOOT_ID_PATTERN` / `isBootId` 与锁的实际 `randomUUID()` 输出；启动报告值与锁 token 完全一致、被当前 parser 接受、PersonaLifecycle 使用同一值。不兼容时停止报告，不修改 Runtime/Contracts/锁协议。 |
| O-10 | 运行期监督缺失接受为已知限制：不新增 supervisor/health loop，不伪造健康状态；只在 `status` 中提供拉取式 `scheduler.stats()` 与最近一次 Recovery 摘要。 |
| O-11 | Ingress `close()` 当前会清空缓冲；本批没有传输层、没有真实受理数据，接受并记录该限制；真实受理路径与关闭前 drain 由 SH-009 重新设计。持久化副作用的事实订正见 §7.7，不改变本决议。 |

### 16.3 实施核对条件

| 检查项 | 核对方式 |
|---|---|
| O-0 | `8bd7f9e` 已在当前 `main`（`d451f90`）历史上；实施前仍要核对这六个文档没有被改回旧口径。未满足则停止。完成 O-0 不是实施授权 |
| O-1 | 审查 `apps/soul-daemon/package.json` 只多出 runtime；源码无 `@soul-harness/contracts` 直接 import；lockfile diff 只含预期 workspace 依赖 |
| O-2 | 分开两组，都是 1 个 Persona、2 条合法 `running`，默认 `batchSize`。`maxRowsPerRun=1`：首次 `row_budget_exceeded`，两条都仍是 `running`，计数为 0，无 Scheduler；禁止断言第一条已 `queued`。`maxRowsPerRun=2`：首次失败，id 较小的一条已 `queued` 且 attempt/runId 不变，另一条仍 `running`；预算足够后重启只收敛剩余那条。`Store.close()` 成功时释放锁。若启动中已请求停止，结果是 `startup_aborted` 而不是 `recovery_incomplete`。其余原因见 §12.2.1 |
| O-3 | **先做实际契约核对（不按规划示例假定）**：读取 Runtime 当前导出的 `RecoveryPolicy` / `SchedulerPolicy`，核对 `recoverRuntime` 与 `createScheduler` 的真实参数；用类型赋值/构造检查确认同一个冻结对象可同时满足两边。不符合 → 停止报告，不修改 Runtime/Contracts 迁就规划。再做配置测试：缺 env → 退出码 2；边界值 1/100、0/86400000 通过，越界/小数拒绝；无隐式默认 |
| O-7 | 默认值精确为 256/300000/8；越界拒绝；配置对象冻结 |
| O-8 | 断言 `components.personaLifecycle.autoStarted === false`；`components.eventBus.initialized === true`、`acceptsInput === false`、`transport === 'none'` 且 `capabilities.eventIngress === 'unavailable_no_transport'`；`components.scheduler.started === true`、`state === 'running'`、`handlerKinds === 0`、`dispatchesTasks === false` 且 `capabilities.taskDispatch === 'unavailable_no_handlers'`；`StartReport`/`DaemonStatus`/能力报告同值；无假 Handler；http/health 仍 `not_implemented` |
| O-9 | **三项同时确认**：① 启动报告 `bootId` 与 `soul.lock` 的 `bootToken` 完全一致；② 该值被仓库当前实际 `BOOT_ID_PATTERN` / `isBootId` 接受（`createPersonaLifecycle` 的构造校验使用同一个 `isBootId`；接受即证明符合当前 parser；同时记录当前 pattern 文本）；③ PersonaLifecycle 使用同一个值（创建的 Persona/快照 bootId 与锁一致）。任一失败则停止报告，不改 Runtime/Contracts/锁协议 |
| O-10 | README 明确无 supervisor/health；代码不新增后台健康循环或假端点 |
| O-11 | `ingress.close()` 幂等测试只证明第二次不再写，不证明所有曾经缓冲的行都已终态（§7.7）。README/启动报告明确无传输层；不声称“可受理事件” |
| D-R1 | 代码无“超时后关闭 Store”；无 `shutdown_timeout`；stop pending 时 Store/锁不被关闭 |
| D-R2 | `DaemonOptions` 无 handlers 字段（`@ts-expect-error` 断言）；Scheduler 创建参数固定空 Map；报告 `handlerKinds: 0` |
| D-R3 | §12.2 / §12.2.1 / §12.5 里 **Daemon 入口** 的用例通过。部分提交用 `maxRowsPerRun=2`；`=1` 的对照必须保持零写入。`probe_budget_exceeded` 的 Daemon 验收只认 21 个 Persona / `maxRowsPerRun=22` 那一行。`scan_query_budget_exceeded` 与“仅 Runtime 参数”的探测行不得算作已通过 |

---

## 17. 开工条件与结论

> **历史状态（已取代）**：本节“尚未获实施授权 / E1 未开始 / 锁策略未决”的记录是规划阶段状态；当前已实施至 E5，状态见 §19.1、§19.2。

**【本次建议的结论】**

### 17.1 开工条件（必须按顺序满足）

1. **O-0 已经满足，但不是开工令**：文档同步提交 `8bd7f9e` 已在当前 `main` 历史上。完成定义不改。**未取得本修订的独立复审和实施授权，不得开始任何 SH-008E 实施，包括 E1。**
2. **维护者实施授权**：独立复审通过，并明确批准 SH-008E 进入实施；本规划本身不构成授权。E4 的锁策略（§7.6）在被单独决定之前，也不得夹进实施。
3. **已确认决议生效**：§16.2 的 D-R1/D-R2/D-R3 与 O-1–O-11 均已生效；实施必须按这些决策执行。
4. **依赖范围锁定**：只新增 `@soul-harness/runtime`；不直接依赖 contracts；lockfile 只做预期变更。
5. **实施前契约核对**：O-3 的 Runtime policy 实际类型、O-9 的 `BOOT_ID_PATTERN` 实际兼容性、O-8 的四维能力字段必须按 §16.3 在写代码前完成核对；核对失败即停止，不得按本规划示例假定通过。

### 17.2 结论

- **代码级前置**：规划核对**未发现**必须修改 Runtime/Persistence/Contracts 的阻塞；但 O-3（policy 类型）与 O-9（boot 格式）仍是实施前必须用当前实际代码验证的条件，未验证前不得写成“已通过”。
- **已确认决议**：D-R1/D-R2/D-R3 与 O-0–O-11 均不改。O-0 的文档同步已经完成，这只去掉文档口径这一闸。
- **仍未决的设计项**：只有 §7.6，即 `Store.close()` 失败后是否释放 Instance Lock。本修订不批准“继续放锁”“留下锁”或其他策略。除此之外不新开决议。
- **实施状态**：SH-008E **尚未获实施授权**，E1 未开始；本规划不提前宣布 SH-008E 或 SH-008D 整批结果。
- **关闭语义已知限制**：接受“Scheduler stop 可能无限等待、Daemon 无法自行退出”，不提供强制终止；正常空 Handler 路径不受影响。

---

## 18. 本修订没有做的事

- 未修改 Runtime、Persistence、Contracts、Migration、生产代码、测试、依赖或其他文档。唯一改动是本文件。
- 未开始 E1，未开始 SH-009，未创建实施分支。
- 未改 D-R1–D-R3 或 O-0–O-11。未为 §7.6 选择策略。
- E0.R1 的提交只提供本修订供独立复审，不是实施授权。

---

## 19. 实施状态同步（E1–E6，2026-11）

> **性质与效力**：本节是当前实施状态的权威补充，只记录已经发生的实施、合并和测试事实，不新增架构决议，也不改变原计划中的已确认决议。就“当前实施状态”而言，本节与正文中标注为历史状态的旧文字冲突时，以本节为准；架构决议本身仍以原 §16.2 及已批准决议为准，本节不改写其含义。
>
> 本节不把“阶段已合并”写成“SH-008E 整批已验收”。SH-008E 的整批最终验收仍待独立复审。

### 19.1 阶段状态与合并事实

基线事实：本节同步时的 `main` 为 `cc00bfb344cf4b68a34cd99cc92b73351b5f2d82`，即 E6 README 同步 PR #21 的合并提交。

| 阶段 | 当前状态 |
|---|---|
| E0 | 已完成并合并（PR #9） |
| E1 | 已完成并合并（PR #10） |
| E2 | 已完成并合并（PR #11） |
| E3 | 已完成并合并（PR #13） |
| E4 | 已完成并合并（PR #18） |
| E5 | 已完成并合并（PR #19） |
| AUDIT-001 | 已完成并合并（PR #14；R1 修复 PR #20） |
| E6 README 同步 | 已完成并合并（PR #21，合并提交 `cc00bfb`） |
| E6 计划文档状态同步 | 当前任务：本补充章节；PR 待独立复审 |
| SH-008E 整批验收 | **尚未签署**；等待独立最终验收 |

### 19.2 D-E4-LOCK-1：已批准并已实施

`Store.close()` 失败后的 Instance Lock 策略已经由 **D-E4-LOCK-1** 决定并实施：

- `Store.close()` 失败时保留 Instance Lock；
- 不调用 `lock.release()`；
- 锁文件保留，后续启动按既有 stale-lock 协议处理，不把未成功关闭的数据库视为可安全接管；
- 关闭结果报告 `shutdown_failed`，退出码 6；
- 该策略已在 E4 实施，并有对应测试覆盖；
- 测试通过 wrapper 在实际 close 之后抛错来模拟该路径，**不应**声称完整模拟 SQLite 原生底层的所有 close 失败方式。

本节不改变 D-E4-LOCK-1 的含义。原计划中将该策略描述为“尚未决议”“E4 待决”“不得提前实施”或“不得选择其中一种”的文字，属于历史阶段状态，不再是当前有效要求；原文保留用于追溯。

### 19.3 Shutdown 当前语义

已经批准并实施的关闭顺序：

```text
ingress.close()
  → await scheduler.stop()
  → Store.close()
  → Instance Lock release
```

当前语义：

- `Ingress.close()` 失败时仍继续后续清理，并报告 `shutdown_failed`；
- `Scheduler.stop()` reject 时停留在 `DRAINING`，不关闭 Store，不释放 Instance Lock；
- `Scheduler.stop()` 一直 pending 时不关库、不放锁；没有强制关闭上界；
- `Store.close()` 失败时保留 Instance Lock（D-E4-LOCK-1）；
- `SOUL_SHUTDOWN_TIMEOUT_MS` 只有配置和校验，不具有关闭 deadline、强制取消 Scheduler 或放弃等待的语义。

原计划中关于同步释放循环、`Store.close()` 失败后仍释放锁、或在超时后强制关库的描述，都是已被后续实施取代的历史语义，不再是当前要求。D-R1 的“不设置强制关闭上界”仍然有效。

### 19.4 E1–E5 已实施的总体能力边界

- Daemon 已完成配置、启动、RECOVERING、READY 装配和关闭流程。
- Recovery 在 `incomplete !== null` 时 fail closed；不创建 Ingress / Scheduler；部分已提交的行保留，重启后可继续且不重复处理已收敛行。
- Ingress 没有 transport；`acceptsInput=false`，不代表已经能够接收外部真实输入。
- Scheduler 使用固定空 Handler Map：`handlerKinds=0`，`taskDispatch=unavailable_no_handlers`，不派发实际业务任务。
- Persona 生命周期已装配，但不自动启动 Persona（`autoStarted=false`）。
- 没有 HTTP API、Health endpoint、Supervisor 或 health loop。
- 没有强制取消在途 Handler 的保证，也没有有界 Shutdown 保证。
- 当前运行能力与配置的详细说明见 `apps/soul-daemon/README.md`；本节不把该 README 的能力边界扩展成新的架构决议。

### 19.5 过时状态与历史内容的对照

以下旧文字保留在原位，作为历史规划和审查记录；它们不再作为当前实施要求。仍然有效的架构原则继续有效，不因本节而失效。

| 位置 | 旧状态 / 旧语义 | 当前事实 |
|---|---|---|
| 文档顶部“文档状态” | E0.R1 等待独立复审；不表示已开始；不得开始 E1 | E1–E5、AUDIT-001、E6 README 已完成并合并；E6.R2 待复审 |
| §7.6 | `Store.close()` 失败后的锁策略是 E4 待决项；不批准任何选择 | D-E4-LOCK-1 已批准并实施：close 失败保留 Instance Lock |
| §7 / §12 中旧释放循环描述 | 同步逆序释放；某步抛错后循环继续，close 失败仍可能放锁 | E4 已改为异步释放栈；Store.close 失败时不放锁 |
| §11 E0 / §17 / §18 | 尚未取得实施授权；E1 未开始；不创建实施分支 | E1–E5 已完成并合并；E6 进行中 |
| §11 E4 | 在独立复审选定策略前不得实现任何锁策略 | 已按 D-E4-LOCK-1 实现并测试 |
| §13 验收 / §16.1–§16.3 | close 失败后的锁行为仍未决，验收不得写成已通过 | 已决议、已实施、已有测试；整批验收仍待最终签署 |
| §14.1 风险表 | `Store.close()` 失败仍被写成 E4 待决；O-0 完成被写成不能开工 | D-E4-LOCK-1 已实施；E1–E5 已合并；阶段合并不等于整批验收 |
| §14.2 停止条件第 1、2、11 条 | O-0 未完成时不得开始 E1；本批实施授权尚未取得；独立复审前不得选定 §7.6 锁策略 | E1–E5 已实施；新的实施仍需授权、整批验收仍需独立复审；锁策略已由 D-E4-LOCK-1 决定；新增 env/测试 API 的限制仍有效 |

### 19.6 本补充没有做的事

- 不修改 `apps/soul-daemon/**`、Runtime、Persistence、Contracts、Migration、依赖或 CI；
- 不修改 `apps/soul-daemon/README.md` 或其他文档；
- 不改变 D-R1–D-R3、O-0–O-11、D-E4-LOCK-1 或其他已批准决议的含义；
- 不新增架构能力，不开始 SH-009；
- 不把 SH-008E 宣告为整批验收通过；
- 不删除任何历史决策、审查意见或实施记录。
