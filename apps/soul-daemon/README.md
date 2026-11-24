# `@soul-harness/soul-daemon` — 生命周期与装配层

- **地位**：应用层。只做装配与生命周期，业务逻辑在 `packages/`（[MODULES](../../docs/architecture/MODULES.md) §4）。
- **状态**：本进程已装配配置、结构化日志、数据目录、单实例锁、SQLite、Migration、Schema 校验、Persona 归一、`recoverRuntime`、无传输层的进程内 Ingress，以及空 Handler Map 的 Scheduler。HTTP/WebSocket 与健康检查传输仍未实现。
  关闭顺序是 `ingress.close()` → `await scheduler.stop()` → `Store.close()` → 实例锁。`SOUL_SHUTDOWN_TIMEOUT_MS` 只被校验和记录，**不是**关闭截止时间。不写 Runtime checkpoint，不进入 `CHECKPOINTING`，不声称 drain，也不在 `scheduler.stop()` 未结束时关库或放锁。`Store.close()` 抛错时不调用 `lock.release()`（D-E4-LOCK-1）。
- **上位文档**：[RUNTIME-LIFECYCLE](../../docs/architecture/RUNTIME-LIFECYCLE.md) §2/§3/§4/§9、
  [PLAN](../../docs/PLAN.md) §6/§7、[MODULES](../../docs/architecture/MODULES.md) §1/§4。

## 1. 职责与非职责

| 负责 | 不负责 |
|---|---|
| 读取并校验配置（缺项即失败） | 解释配置之外的业务语义 |
| 结构化日志（禁正文/令牌） | 采集遥测或上传 |
| 数据目录与写权限探测 | 自动回退到临时目录 |
| 按数据目录获取单实例锁 | 进程级互斥之外的调度 |
| 打开 SQLite、跑 Migration、校验 Schema | 直接写表（必须经 `@soul-harness/persistence`） |
| 在 `RECOVERING` 做 Persona 归一并 `await recoverRuntime` | 自动启动 Persona；恢复失败后继续装配 |
| 在 `READY` 创建无传输层的进程内 Ingress，并启动空 Handler 的 Scheduler | 受理外部事件、派发任务、HTTP/健康检查 |
| 按固定顺序关闭；失败记 `failed`，不报成干净成功 | 有界关闭、Handler 取消、Runtime checkpoint、显式 WAL checkpoint |

**本进程不伪造未实现的能力。** 跑起来之后，能力面是：Persona 生命周期 `assembled`（不自动启动）、Runtime Recovery `assembled`、Event Bus `assembled_no_transport`、Ingress `unavailable_no_transport`、Scheduler `running` 且 `taskDispatch` 为 `unavailable_no_handlers`。HTTP 与健康检查仍是 `not_implemented`。「数据库已打开」或「Scheduler 在跑」都不等于「可以派发任务」。

## 2. 生命周期状态

启动（RUNTIME-LIFECYCLE §2）：

```
BOOTING → MIGRATING → RECOVERING → READY → RUNNING
```

| 阶段 | 本进程真实动作 | 未实现部分 |
|---|---|---|
| BOOTING | 配置校验、日志、数据目录探测、**单实例锁**、打开 Store | — |
| MIGRATING | `migrate()` + `verifySchema()` | — |
| RECOVERING | Persona 归一，然后 `await recoverRuntime`。失败或 `incomplete` 时不创建 Ingress / Scheduler | 不自动启动 Persona |
| READY | 进程内 Ingress（`transport: none`，不接收外部输入）与空 Handler Map 的 Scheduler，并 `start()` | HTTP/WebSocket、健康检查传输 |
| RUNNING | Scheduler 在跑，Handler 数仍为 0，不派发任务；进程持有数据库与锁 | 外部输入与任务执行 |

RECOVERING 的边界：

- Persona 归一会把旧 boot 遗留的 `RUNNING` Persona 收为 `STOPPED`，但**不会自动启动 Persona**。
- Recovery 不是覆盖整轮的总事务。每条任务/事件写入有自己的事务；`incomplete !== null` 时本阶段 fail closed，不创建 Ingress / Scheduler，但此前已经提交的行保留。
- 重启后，已收敛的行不会被重复处理；未完成部分在预算或数据条件满足后继续。当前测试覆盖 `maxRowsPerRun=1` 的零任务写入对照、`maxRowsPerRun=2` 的部分提交与重启，以及 `row_budget`、`persona_budget`、`probe_budget`、取消、并发修改、归档状态、unexpected event status 和非法任务行等 incomplete 原因。Daemon 不传 `maxScanQueries`，因此 `scan_query_budget_exceeded` 不是可通过 Daemon 环境变量单独复现的场景；它由 Runtime 测试覆盖。
- `startup_aborted` 优先于 `recovery_incomplete`：Recovery 返回后、解释结果前，阶段边界会先处理停止请求。

READY 的能力边界：

- Ingress 对象存在并初始化，但没有 transport；`acceptsInput` 为 `false`，不能通过 HTTP、WebSocket 或网络接受真实输入。
- Ingress 的 `close()` 会清空 buffer 和 pending TTL，并可能产生持久化 TTL 过期；它没有 drain API。`close()` 失败可能留下 TTL 状态，后续 Recovery 可能按 `buffer_lost` 收敛。
- Scheduler 使用创建时固定的空 Handler Map，`handlerKinds = 0`，`taskDispatch = unavailable_no_handlers`。`start()` 成功只表示 Scheduler 在运行，**不表示能够派发任务**；本进程不提供 Handler 注入接口。
- 这些能力只存在于进程内；没有 supervisor 或 health loop，也没有 HTTP/健康检查端点。

关闭：

```
RUNNING → DRAINING → CLOSING → STOPPED
```

不进入 `CHECKPOINTING`。checkpoint 只打一条 `checkpoint_skipped`（`reason: runtime_not_implemented`），不写 `checkpoint_json`。这也不是 SQLite WAL checkpoint。

| 步骤 | 行为 |
|---|---|
| DRAINING | `ingress.close()`，然后 `await scheduler.stop()`。空 Handler 时 `stop()` 会结束；若它一直 pending，阶段停在 `DRAINING`，不关库、不放锁。没有“drain 已完成”的声明 |
| checkpoint | 跳过。不进入 `CHECKPOINTING` |
| CLOSING | **只在 `scheduler.stop()` resolve 之后**：先 `Store.close()`，成功后再 `lock.release()`。没有显式 `PRAGMA wal_checkpoint` |
| STOPPED | 已执行步骤里只要有失败，`stop()` 拒绝并给出 `shutdown_failed`（退出码 6），不把这次关闭报成成功 |

失败：

- `ingress.close()` 抛错：记下 `event_bus` / `failed`，继续停 Scheduler、关库、放锁，最后仍是 `shutdown_failed`。
- `scheduler.stop()` reject：记下 `scheduler` / `failed`，停在 `DRAINING`，不关库、不放锁，`stop()` 拒绝 `shutdown_failed`。之后的清理也不会补关库。
- `scheduler.stop()` 一直不结束：不记失败、不关库、不放锁，`stop()` 保持 pending。本进程不取消 Handler，也没有强制退出上界。
- `Store.close()` 抛错：记下 `sqlite_open` / `failed`，**不调用** `lock.release()`。锁文件留下，下次启动走现有陈旧锁协议。阶段进入 `STOPPED` 后 `stop()` 仍拒绝，退出码 6。测试用 wrapper 在 close 之后抛错来模拟该路径，不声称覆盖 SQLite 原生底层的所有失败方式。
- `lock.release()` 自己抛错：记下 `instance_lock` / `failed`，锁文件留下，同样是 `shutdown_failed`。

启动失败：已经拿到的资源按同一规则释放。锁在数据库之前获取，锁竞争失败时**不会创建数据库文件**。启动过程中请求停止会在下一个阶段边界中止（`startup_aborted`，退出码 0），并释放锁。

## 3. 配置

全部来自环境变量。必填项缺失或为空白直接失败；数值项必须是范围内的安全整数，**不做静默夹值**。

| 变量 | 必填 | 默认 | 范围与用途 |
|---|---|---|---|
| `SOUL_DATA_DIR` | ✅ | — | 非空数据目录；相对路径按进程 cwd 解析为绝对路径。没有临时目录回退 |
| `SOUL_LOG_LEVEL` | ❌ | `info` | `debug` / `info` / `warn` / `error`；非法值使启动失败 |
| `SOUL_SHUTDOWN_TIMEOUT_MS` | ❌ | `10000` | 整数 100–600000。只校验并记录，**不是**关闭截止时间，也不会中止 `scheduler.stop()` |
| `SOUL_TASK_MAX_ATTEMPTS` | ✅ | — | 整数 1–100；Recovery 与 Scheduler 共用的冻结 `policy.maxAttempts` |
| `SOUL_TASK_RETRY_BACKOFF_MS` | ✅ | — | 整数 0–86400000；共用 `policy.retryBackoffMs`，Scheduler 用固定退避 |
| `SOUL_RECOVERY_BATCH_SIZE` | ❌ | `200` | 整数 1–500；Recovery 分页查询的批量大小 |
| `SOUL_RECOVERY_MAX_ROWS` | ❌ | `10000` | 整数 1–1000000；单轮 Recovery 行预算，**包含 Persona 枚举行** |
| `SOUL_RECOVERY_MAX_PERSONAS` | ❌ | `200` | 整数 1–10000；单轮 Recovery 最多扫描的 Persona 数 |
| `SOUL_SCHEDULER_MAX_TOTAL` | ❌ | `8` | 整数 1–1024；Scheduler 全局并发 Handler 上限 |
| `SOUL_SCHEDULER_PER_UNIT` | ❌ | `1` | 整数 1–64；每个 Persona × channel 的并发槽 |
| `SOUL_INGRESS_QUEUE_CAPACITY` | ❌ | `256` | 整数 1–1000000；进程内 Ingress 队列容量 |
| `SOUL_INGRESS_BUFFER_TTL_MS` | ❌ | `300000` | 整数 1–86400000；进程内 buffer 的 TTL |
| `SOUL_INGRESS_PERSONA_CAPACITY` | ❌ | `8` | 整数 1–1024；每个 Persona 的 in-flight admission 上限 |

校验分类：

- 必填项缺失、空字符串或纯空白 → `config_missing`；
- 格式错误、非安全整数或越界 → `config_invalid`；
- 可选项缺失或空白 → 使用上表默认值；
- `SOUL_SHUTDOWN_TIMEOUT_MS` 保留旧的 `Number()` 解析，接受 `2500.0`、`2.5e3`、`+2500` 等整数值形式；其余 10 个数值项只接受十进制数字字符串。

Ingress 的三个参数会传给进程内 Ingress；由于没有 transport，配置本身**不代表**外部输入已经接入。Scheduler 的两个并发参数会传入 Scheduler，但当前 Handler Map 固定为空，仍不会派发任务。

## 4. 数据目录与单实例锁

```
<SOUL_DATA_DIR>/
├─ soul.lock     # 单实例锁（JSON：pid / bootToken / startedAt / dataDir）
└─ soul.db       # SQLite（WAL）
```

锁语义：

1. **原子创建**：`open(..., 'wx')`（O_CREAT\|O_EXCL）；不是"先检查再创建"。
2. **不假设持锁进程已死**：记录的 PID 仍存活（或 `EPERM` 无法判定）→ 拒绝启动，锁保持原样。
3. **陈旧锁按「快照」接管**（SH-007A.R1 修复）：
   - 读取锁文件并保留其**精确字节**（快照）；
   - 用 `soul.lock.claim.<sha256(快照)>` 的独占创建选出**唯一**认领者：
     所有看到同一份旧锁的竞争者会竞争同一个 claim 文件名，只有一个能创建成功；
   - 认领者**重新读取**锁文件，字节仍与快照一致才继续；不一致说明路径上已是别人的新锁 →
     抛 `lock_held` 且什么都不改；
   - 只有此时才 `unlink` 这份旧锁，最终仍由原子创建决定谁拿到锁。
   因此任何进程都不会删除自己没快照过的锁；「读 PID → rename 固定路径」的竞态不复存在。
4. **非法锁数据不接管**：PID 不是**正安全整数**（`0`、负数、小数、超出 2^53−1、字符串、null）
   一律 `lock_unreadable`，不 rename、不删除、不留 claim 文件。
5. **只有持有者释放**：释放前重新读取并比对 `bootToken`，不匹配则拒绝删除并报 `lock_release_failed`。
6. **残留锁**：崩溃（SIGKILL）后锁文件残留，下次启动按第 3 条接管；
   PID 被无关进程复用（无法证明已死）或残留 `soul.lock.claim.*`（认领窗口内崩溃）时，
   启动拒绝并给出 `claimPath`，需人工确认无 Daemon 在运行后删除。
   这两种情况下 `soul.db` 都不会被触碰。

跨平台（已在 Windows 11 / Node 24 实测；POSIX 语义一致）：

| 能力 | Windows | Linux / macOS |
|---|---|---|
| `O_EXCL` 原子创建 | ✅ | ✅ |
| `process.kill(pid, 0)` 探活 | ✅（`ESRCH` 表示不存在） | ✅ |
| 独占 claim 文件选主 | ✅ | ✅ |
| 从父进程投递 SIGINT/SIGTERM | ❌（Node 只能终止，不能投递） | ✅ |

> Windows 上优雅停止的测试改用同进程 `process.emit('SIGINT'/'SIGTERM')`——这正是 Node 内部
> 触发该事件的同一路径；POSIX 上真实信号到达的是同一个处理函数。
>
> 锁只使用 `open('wx')` / `read` / `unlink` 三种原语：Node 不提供可移植的 `flock`/`fcntl`，
> 因此不假设任何建议锁（advisory lock）语义；同目录内的文件系统原子性由 `O_EXCL` 与单文件
> 读/删操作承担。网络文件系统若不能保证 `O_EXCL` 原子性，本协议不适用。

## 5. 启动与关闭行为

```bash
pnpm --filter @soul-harness/soul-daemon build
SOUL_DATA_DIR=/var/lib/soul \
SOUL_TASK_MAX_ATTEMPTS=3 \
SOUL_TASK_RETRY_BACKOFF_MS=1000 \
node apps/soul-daemon/dist/main.js     # 前台运行
```

- 正常启动：日志出现 `phase_entered: RUNNING`，进程常驻（内部持有 ref'd timer，避免空事件循环退出）。Scheduler 已启动，Handler 数是 0。
- 停止：`SIGINT` / `SIGTERM` → 同一套受控停止流程；重复 `stop()` 返回同一个 Promise。
- 启动中收到停止请求 → 在下一个阶段边界中止，已取得资源按关闭规则释放，退出码 0。
- `Store.close()` 失败 → 锁文件保留，退出码 6。正常关闭才会删锁。
- 退出码：

| 码 | 含义 |
|---|---|
| 0 | 正常停止（含启动中被中止） |
| 2 | 配置缺失/非法 |
| 3 | 数据目录不可用/不可写 |
| 4 | 单实例锁竞争或锁文件不可读 |
| 5 | 启动失败（Migration、Store、Schema 等） |
| 6 | 关闭过程中清理失败 |

## 6. 当前真实支持的能力

- ✅ 环境配置校验、结构化 JSON 日志（未登记字段名直接丢弃；自由字符串和普通错误对象会打码）
- ✅ 数据目录创建 + 真实写入探测
- ✅ 按目录的单实例锁（原子、探活、陈旧接管、持有者校验）
- ✅ Store 打开、Migration、Schema 校验
- ✅ `RECOVERING`：Persona 归一 + `recoverRuntime`（失败即中止，不继续装配）
- ✅ `READY`：进程内 Ingress（无传输层）+ 空 Handler Scheduler（已 `start()`，不派发）
- ✅ 关闭：先关 Ingress，再等待 Scheduler `stop()`，然后关库、放锁。关闭失败是 `shutdown_failed`，不是成功
- ✅ 幂等 `stop()`、启动期与 `RUNNING` 的 SIGINT/SIGTERM

## 7. 尚未实现（不要当成已完成）

| 能力 | 事实 |
|---|---|
| 外部事件进入本进程 | Ingress 没有传输层，`acceptsInput` 为 false |
| 任务派发 | Handler Map 固定为空。Scheduler `running` 不等于会执行任务 |
| 在途 Handler 的取消或有界等待 | `scheduler.stop()` 未结束就一直等。没有超时强制关库 |
| HTTP / WebSocket、健康检查传输 | 未实现。进程内 `status` 不是健康端点 |
| Supervisor / health loop | 未实现。没有外部监督进程或自动重启循环 |
| Runtime checkpoint | 不写。只记录 `checkpoint_skipped` |
| 显式 `PRAGMA wal_checkpoint` | 未实现。关闭只调用 `Store.close()` |
| drain | 未实现。不要把 `DRAINING` 读成“缓冲已排空” |
| `Store.close()` 失败后仍放锁 | **不做**。锁文件留下，下次按陈旧锁协议处理 |

## 8. 测试

```bash
pnpm --filter @soul-harness/soul-daemon test
pnpm test
```

| 文件 | 覆盖 |
|---|---|
| `test/config.test.ts` | 缺配置、必填项空值、13 个变量的范围/格式、相对路径解析、默认值 |
| `test/logger.test.ts` | JSON 行、未知字段名丢弃、敏感值打码、错误不带堆栈、级别过滤 |
| `test/components.test.ts` | 组件适配：同一 policy 对象、clock/logger 适配、不复制 policy 字段 |
| `test/phases.test.ts` | 生命周期步骤与 capability surface 不夸大实现状态 |
| `test/lock.test.ts` | 原子创建、同目录拒绝、不同目录独立、幂等/持有者校验、损坏锁拒绝、活锁拒绝、死锁接管、抢占唯一性 |
| `test/lock-race.test.ts` | 陈旧锁接管竞态（真实进程）：多个竞争者恰好一个胜出；胜者持锁时后来者被拒绝 |
| `test/child-watch.test.ts` | 子进程观察器：spawn 失败不挂起；runtime error 不算 close；超时是清理失败；批量清理等待每一个子进程 |
| `test/daemon.test.ts` | 启动到 RUNNING、阶段顺序、锁竞争不建库、Migration 失败清理、启动中停止、关闭顺序、锁释放失败仍报 `shutdown_failed`、重启 |
| `test/recovery.test.ts` | 空库、崩溃收敛、部分提交与重启幂等、budget/probe/取消/并发/归档/非法行等 incomplete、恢复失败不装配 Scheduler |
| `test/ready.test.ts` | Ingress / 空 Handler Scheduler 的装配、日志顺序、边界上的启动中止 |
| `test/ready-failure.test.ts` | 装配失败、`stop()` 未结束前不关库、`Store.close()` 失败留锁且退出码 6、Ingress 关闭失败、`scheduler.stop()` 拒绝 |
| `test/process.test.ts` | 真实进程：退出码 2/3/4/5、`RUNNING` 时信号优雅停止、`MIGRATING` 时 SIGTERM 中止且放锁、双实例拒绝、SIGKILL 后数据库与任务行、陈旧锁接管、部分 Recovery 后锁释放、恢复失败不派发 |

进程测试在 `beforeAll` 中构建 `dist/`（Node 的类型剥离不能把 `.js` specifier 解析成 `.ts`），
随后以真实子进程运行构建产物——与部署路径一致。
信号夹具用同进程 `process.emit`，因为 Windows 不能向子进程投递 SIGTERM。`SOUL_TEST_SIGNAL_AT` 只存在于该夹具。
