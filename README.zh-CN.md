# Attention Notifier（注意力提醒）

**简体中文** | [English](README.md)

当 DeepSeek Harness 需要你操作、或任务已经结束时提醒你——尤其是窗口被最小化、你正在做别的事情的时候。

## 提醒哪四个时刻

| 时刻 | 触发来源 | 默认策略 | 说明 |
|---|---|---|---|
| **权限确认等待中** | `approval/request` 瀑布 | 始终提醒 | 工具请求越权执行，等待「允许一次 / 拒绝」。**阻塞型**：智能体在你回答前无法继续 |
| **提问等待中** | `user-questions/request` 瀑布 | 始终提醒 | `ask_user_question`，含 plan-mode 的计划评审。同为阻塞型 |
| **任务完成** | `session/event` 的 `turn/end`（`agent/status → idle` 是辅助信号） | 仅窗口不在前台 | 一轮任务跑完。受最短运行时长约束 |
| **任务出错** | `agent/error` | 始终提醒 | 轮次以 error 结束。**用户主动停止不算**（中止走 `turn/end{aborted}`，与 error 互斥） |

> **插件加载时若智能体已经在运行**，那一轮可能一次 `agent/status` 都收不到（该事件只在状态字符串
> **变化**时派发）。所以完成提醒以 `turn/end` 为准 —— 它同时携带 `reason.kind`，能区分
> `completed` / `aborted` / `interrupted`。

## 用哪些渠道提醒

| 渠道 | 实现方式 | 能否在窗口最小化时生效 |
|---|---|---|
| **Windows 系统通知** | `powershell.exe` 5.1 → WinRT Toast，AppId `com.deepseek.dsh`；**带「打开 DSH」按钮** | 能，且点按钮可唤回窗口 |
| **提示音** | 随 Toast 的 `<audio>` 标签播放（`ms-winsoundevent:Notification.Default`） | 能 |
| **应用内提示条** | 客户端插件注册到 `shell.overlay`，右上角浮动卡片 | 需要窗口存在 |

> **「任务栏闪烁」渠道已被移除**，而不是修复。插件唯一够得着的做法是给网页标题加 `●` 前缀，
> 但本应用窗口**没有可见标题栏**，这个标记不会被渲染到任何用户看得见的地方；Electron 真正的
> `win.flashFrame` 需要窗口句柄，而 Host 半边拿不到。**一个做不到任何可见效果的开关，比没有这个开关更糟。**

### 最小化时怎么把用户叫回来

这是设计上最关键的一点：**窗口最小化时，应用内的一切都看不见**。所以：

1. **系统通知弹在你当前使用的界面上**（覆盖任何应用），并播放提示音 —— 这是最小化时唯一有效的提醒；
2. **通知上带一个「打开 DSH」按钮**，点击激活 `dsh://open` 协议；DSH 的 `open-url` 处理器调用
   `focusPrimaryWindow()`（恢复 → 显示 → 聚焦），把窗口唤回前台。该协议由安装器注册，
   按钮的 XML 形状与激活路径都已实测通过。

**因此应用内提示条里没有「打开 DSH」按钮** —— 它只在窗口已位于前台时可见，那个按钮等于空操作。
提示条的价值是**完整显示待处理内容**（系统通知会被截断），而不是把窗口唤到前台。

> 把 `restoreOnClick` 设为 `false` 可以让通知不带按钮，代价是用户只能手动切回窗口。

> **不再占用侧栏徽标槽**：早先版本曾在折叠侧栏的展开按钮上放一个未读小圆点，但
> `sidebar.toggle.badge` 是**单值插槽**，应用自身已经占用（报错文本为
> `single slot "sidebar.toggle.badge" already has a registration at priority 0`）。
> 该装饰已移除。

每个时刻可独立选择策略：**关闭 / 仅窗口不在前台 / 始终**。

### 三个渠道开关各自管什么

| 开关 | 作用位置 | 关掉之后 |
|---|---|---|
| `channels.toast` | **Host** 调 WinRT 弹通知 | 不再有系统通知（会退化为只响提示音） |
| `channels.sound` | 作为 Toast 的 `<audio>` 一起发出 | 通知静音 |
| `channels.inApp` | **Host** 的页面消息队列 | 队列不再入队、也不再下发给页面 → 提示条不出现 |

> ⚠️ 这些开关都必须由 **Host 侧**真正消费。只在前端隐藏界面是不够的：
> 早期版本里 `inApp` **只被解析、从未被使用**，于是把开关关掉后提示条照样出现。
> 现在有回归测试锁定（`_cases.mjs` 的 "the inApp channel gates the page queue"）。

## 配置

设置页位置：**侧栏 → 插件（Plugins）→ 官方分组 → 注意力提醒**。

运行时偏好写入 `$DSH_HOME/attention-notifier/settings.json`（原子写：临时文件 + rename）。
行配置仍是默认值来源，位于 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: attention-notifier
      name: 'dsh-attention-notifier'
      config:
        triggers: { approval: always, question: always, done: unfocused, error: always }
        minDurationMs: 0
        channels: { toast: true, sound: true, inApp: true }
        restoreOnClick: true
        rawFallback: false
        windows: { appId: com.deepseek.dsh, toastTimeoutMs: 10000, soundTimeoutMs: 5000, focusTimeoutMs: 5000 }
        external: []
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `triggers.*` | 见上表 | 每个时刻的提醒策略：`off` / `unfocused` / `always` |
| `minDurationMs` | `0` | 「任务完成」的最短运行时长。**选 `always` 时会绕过它**，否则两个设置会互相抵消 |
| `channels.toast` | `true` | Windows 系统通知 |
| `channels.sound` | `true` | 提示音（随 Toast 一起） |
| `channels.inApp` | `true` | 应用内提示条 |
| `restoreOnClick` | `true` | 点击「打开 DSH」时恢复并聚焦窗口 |
| `rawFallback` | `false` | 改用 `scenario="reminder"` 的通知，会保留在操作中心 |
| `windows.appId` | `com.deepseek.dsh` | Toast 的应用标识；由安装器的开始菜单快捷方式注册 |
| `external` | `[]` | 预留位：手机推送渠道（见「已知限制」） |

## 设置页里的自测

设置页有 4 个测试按钮，分别验证一条链路，并显示内联的成功/失败文本：

- **测试系统通知** — 普通 Toast（带声音，带「打开 DSH」按钮）
- **测试提醒通知** — `scenario="reminder"` 路径（可留在操作中心）
- **测试提示音** — 单独播放 `C:\Windows\Media\notify.wav`
- **测试恢复窗口** — 走 `dsh://` 单实例路径恢复窗口

**请务必至少点一次「测试系统通知」**：Windows 专注助手/勿扰会静默吞掉通知，而 API 不会返回错误，所以这是唯一能确认投递真的可用的方法。

## 界面何时出现

插件是在运行中安装的，而页面的插件清单（boot payload）是**每次请求 index 时重新生成**的，所以：

- **只需要刷新页面**（在 DSH 窗口里按 **F5** 或 **Ctrl+R**）就能看到设置卡片，不必重启 DSH。

## 自动化测试

两套可复跑的测试，共 **237 条断言**，都不需要真的弹通知：

```powershell
# Host 半边：四时刻判定逻辑、设置路由、注入行、观测计数、无配置行（157 条）
node ./_statemachine.mjs

# 客户端半边：模块契约、插槽注册、瀑布委托、生命周期、自动保存（80 条）
node ./_client_cases.mjs
```

`npm test` 会依次跑两套；如果 PowerShell 的执行策略禁止 `npm.ps1`，用 `npm.cmd test`。

**Host 半边**用 loader hook（`_loader.mjs`）把 Windows 投递层换成记录器（`_delivery_stub.mjs`），再用假的 Cordis context 驱动**真实的插件代码**，所以断言的是真实决策而不是复刻逻辑。每次安装都会拿到一个全新的 Harness home 与空的设置文档，因此设置类的用例不会泄漏到后面的用例。

覆盖：四个时刻各自的触发与文案、按 `callId` 去重（权限）与计划评审的 `detail` 取值、`off`/`unfocused`/`always` 三种策略、最短时长阈值、排队消息/子 agent/被委派子会话的抑制、用户中断与 `interrupted` 轮次的抑制、等待审批期间不误报完成、投递渠道的组合回退、**四个时刻各自的投递一致性**（都用真实载荷跑一遍，断言 toast+sound+按钮齐全）、设置路由的读写/校验/404/405 与恶意输入归一化、**插件页开关的实时闸门**（关掉立即静默、打开立即恢复、读不到则 fail open）、注入行的结构（脚本本身还要过 `new Function` 语法检查），以及观测计数器的增量。

**客户端半边**在 Node 里执行 `client.js`（它是普通 JS，只是需要 `window.__ModuleLoader__`、`document`、`fetch` 等桩），验证：注册 id 等于**包名**、工厂返回合法的插件对象、三个插槽注册、两个 Remote Event 订阅、**两个瀑布监听器都调用 `next()`**、异常请求不破坏流程、页面生命周期监听的挂载与卸载、以及设置卡片能渲染且会去读插件路由。

React 走桩（页面的 React 来自 shell 自带 bundle，Node 里取不到），所以**不断言真实渲染结果**；卡片文案改为断言 bundle 里确实包含这些字符串。

## 可观测性：确认插件真的在工作

插件把「页面接触情况」写到 `$DSH_HOME/attention-notifier/status.json`，**每次页面联系插件时以及每 60 秒**刷新一次。
页面本身在 Host 侧是不可见的，所以这个文件是唯一能自己确认「浏览器半边到底有没有加载」的凭据 —— 不必去读页面控制台。

```powershell
Get-Content "$env:DSH_HOME\attention-notifier\status.json" -Raw
```

| 字段 | 含义 |
|---|---|
| `client.seen` | **页面联系插件的次数。大于 0 就证明客户端半边确实加载并运行了** |
| `clientProbe` | 页面自己访问 `/api/attention-notifier/state` 的结果（url / ok / status / error / body）。用来判断 `dsh-app://` 下 `fetch` 是否可用 |
| `observed` | 观测计数（见下表） |
| `stats` | 投递结果计数（toast ok/fail、sound ok/fail、最近一次错误） |
| `delivery` | 本机是否具备系统通知能力 |

设置页的「状态」区显示同样的数据。「已观测」计数器：

```
已观测（状态变化 / 权限 / 提问 / 轮次结束 / 已提醒 / 已抑制）: 12 / 1 / 0 / 6 / 3 / 4
```

| 计数 | 含义 |
|---|---|
| 状态变化 | 收到的 `agent/status` 事件数。**只要它不为 0，就证明插件确实接上了 agent 状态机** |
| 权限 / 提问 | 收到的两个瀑布请求数 |
| 轮次结束 | 收到的 `turn/end` 事件数 |
| 已提醒 | 实际发出的提醒数 |
| 已抑制 | 结算为 idle 但被有意压掉的次数（排队消息、子 agent、时长不足、策略为 off、用户中断等） |

### 验证状态（诚实记录）

**已实测确认：**

| 项 | 证据 |
|---|---|
| **真实通知已发出并投递** | 实时 `status.json`：`delivered: 6`、`toastOk: 6`、`toastFail: 0`、`suppressed: 0` |
| 四个时刻的事件观测 | 同一份数据：`status: 12`、`turnEnd: 6`、`question: 1` |
| 通知上的「打开 DSH」按钮会渲染 | 实测弹出两条对比通知，确认 `<actions>` 写法有效 |
| 按钮的激活路径 | `dsh://open` 已注册；`main.js` 的 `open-url` 处理器调用 `focusPrimaryWindow()`（恢复→显示→聚焦）；实测启动成功 |
| 插件被 Loader 加载并执行完 `apply` | `loaded.json` 记录了真实 `pid` 与 `hasConfig` |
| 客户端半边运行 | 页面轮询持续，`client.seen` 稳步增长 |
| 页面 ↔ Host 通信 | 页面自测探针返回 **HTTP 200 + 完整 JSON** —— 证明 `dsh-app://` 下相对 `fetch` 可用 |
| 焦点检测与即时上报 | `focusReports` 持续增长，`signals` 形如 `hidden/unfocused/away` |
| 有效配置可核对 | `effective` 字段随诊断一同发布 |
| 提示音 / 提醒类通知 / 恢复窗口 | 逐条实跑，均返回 `ok`；exe 路径已能正确解析 |
| 启动不再崩溃 | `settings/describe` 的遍历已用真实逻辑验证不再抛错 |

**唯一仍需人工确认的一项**：点「打开 DSH」按钮后窗口是否被唤回。
按钮渲染与协议注册都已验证，但「点击 → 窗口恢复」这一跳只能靠人眼确认
（`focusPrimaryWindow` 是恢复+显示+聚焦三步，无法从进程列表可靠观测）。

### 这套测试抓到的四个真实缺陷

**1. 重启后插件会加载失败（最严重）。**
`apply` 里写的是 `rawConfig ?? Config({})`，但 `Config` 是**对象而不是函数**，调用它就抛 `TypeError: Config is not a function`。而这个分支恰好是**重启后必然走到的那条路**：同一份 patch 文件里后面的 id 定向覆盖（`- id: attention-notifier / disabled: false`）会把 `insert` 里的整份 `config` **整体替换掉**，于是行到达时为 `undefined`。也就是说，插件在当前会话里一切正常，但**下次重启 DSH 就会整个加载失败**。改成 `defaultConfig()`（`config.js` 导出的一个真函数）后修复，并补了「无配置行」整段测试。

**2. 瞬时 `idle → running` 会误报「任务完成」。**
最初用 `queued` 布尔量做去抖，但「轮次被取消后有排队消息立刻唤醒」这条路径会先发 `idle`、再在**同一同步步内**发 `running`，而 `running` 分支会把 `queued` 清掉，于是微任务里的守卫失效。改成**每次状态变化都递增的 generation 计数**后才正确（两条护栏：generation 未变 + 实时状态是 idle）。这个靠读源码发现不了。

**3. 路由的 404/405 语义。**
把方法检查放在路径校验之前，会让**任何未知路径**都返回 405。正确顺序：先判断 action 是否属于已知集合（否则 404），再判断方法（否则 405）。

**4.「恢复窗口」的 exe 路径永远解析不出来。**
从注册表读 `dsh://` 协议命令时，`reg.exe` 的输出形如
`    (默认)    REG_SZ    "C:\…\DeepSeek Harness.exe" "%1"`。
最初用 `/(?:^|\s)([A-Za-z]:\\[^"]+?\.exe)/` 匹配 —— 因为刻意排除了引号（怕误匹配 `"%1"`），
盘符前既不是行首也不是空白，于是**永远匹配不上**；而本机路径含空格
（`D:\dsh\AppData\DeepSeek Harness\DeepSeek Harness.exe`），这个 bug 一直静默存在。
改成优先匹配**被引号包裹**的路径 `/"([A-Za-z]:\\[^"]+?\.exe)"/` 后修复
（引号同时也让 `"%1"` 不可能被误匹配）。
这类「静默降级」正是能力探测（`probe()` 报告 `appExe`）值得存在的原因。

测试本身也修过三处「测试写错而非代码错」的问题，值得记下来：

1. 用例之间共享设置文档会让前一个用例的写入泄漏到后一个（现在每次安装都拿全新的 Harness home）；
2. `unfocused` 策略在页面从未上报可见性时会**刻意保持沉默**（这是无人值守时的保守取向），所以相关用例必须先上报可见性；
3. **最值得警惕的一条**：「提问等待」这一时刻曾**完全不提醒**，而 234 条断言**全绿**。根因是处理器要求了一个不存在的字段
   （`request.wait.callId`），而测试载荷里的 `wait` 是**照着实现编出来的** —— 测试迎合了错误的代码，
   验证了一个现实中不存在的输入形状。现在夹具都改为从真实发射点抄写的载荷，并额外断言代码里不存在对该字段的读取。

### 诊断为什么要分时刻计数

`stats.byKind` 按时刻分别记录 `attempted` / `toastOk` / `toastFail`。只有总数时，
「提问提醒从没触发」和「完成提醒多触发了两次」看起来完全一样；分了时刻之后，
`observed.question = 1` 但 `byKind = {}` 这一次性把范围锁死在「处理器内部的前置条件」而不是投递层。

## 独立验证投递是否真的到达 Windows

不依赖插件，直接查注册表即可确认 Toast 是否被系统接收：

```powershell
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\com.deepseek.dsh' |
  Select-Object LastNotificationAddedTime, PeriodicNotificationCount
```

`PeriodicNotificationCount` 与 `LastNotificationAddedTime` 会随每次成功投递增长。本插件开发时用这个方法确认过两次测试通知真的到达了系统。

## 已知限制

1. **专注助手/勿扰会静默吞掉系统通知**，插件无法探测（Windows 没有给普通桌面应用这种 API）。缓解手段：`rawFallback` + 提示音 + 应用内提示条并行，并提供自测按钮。手机推送渠道是本问题的根本解法，但 v1 未实现（见第 4 条）。
2. **审批提醒只在策略为 `ask` 的会话里出现**。`approval/request` 瀑布在 `never` 策略下根本不会派发——服务在派发前就直接返回 `rejected`。所以 `never` 会话不会产生权限确认提醒，这是设计使然。
3. **提示条只在窗口存在时可见**（浏览器模式或桌面窗口）。纯终端/headless 组合下只剩系统通知与声音。
4. **`external`（微信/QQ/手机推送）只有配置位，没有实现**。调研结论：个人微信与 QQ 没有官方推送接口，现实做法是用中转推送服务（Server酱³ / PushPlus / 企业微信机器人 / ntfy / Bark），需要你自行注册并持有 token；而 Wechaty/PadLocal/hook 这类非官方个人号桥接违反微信用户规范、有封号风险，因此明确不做。要加的话，渠道接口已经留在 `external`。
5. **不做远程审批**：通知渠道是单向出站的，绝不能当成审批路径。审批仍在应用内完成。
6. **没有「任务栏闪烁」渠道**。插件唯一够得着的做法是改网页标题，而本窗口没有可见标题栏；
   Electron 的 `win.flashFrame` 需要窗口句柄，Host 半边拿不到。该渠道因此被**移除**而非保留。
7. **恢复窗口走单实例路径**（重新启动应用 → `second-instance` → `restore/show/focus`）。如果 DSH 已经退出，这会冷启动它。
8. **应用内提示条的错误/完成消息来自轮询**（2 秒一次），因此最多有约 2 秒延迟；审批与提问是事件驱动，无延迟。

## 实现要点（为什么这么做）

三层分工，每一层都受 DSH 的实际约束决定：

- **Host 半边**（`index.js`）负责事件检测与状态机、系统级投递、运行时设置持久化，并拥有一个 `/api/attention-notifier` 路由。
- **客户端半边**（`client.js`）负责应用内提示条、设置页，以及「用户是否在看窗口」的判断——只有页面知道这件事。
- **注入脚本**（由 `webserver/index-inject` 下发）只剩一个**可选的诊断条**（`?attention-probe=1`），
  用来单独验证页面能否访问插件路由；正常使用时它什么都不做。

几条硬性约束（都来自对 DSH 源码的核对）：

- **不能向 Electron 主进程发自定义 IPC 消息**：未知消息类型会直接终止整个 Host 进程（`main.js` 对 Host 发来的消息做严格白名单校验）。所以系统通知用 `powershell.exe` 5.1 的 WinRT 投影实现，零依赖。
- **两台瀑布监听器必须 `return next()`**：`approval/request` 的默认 `next` 解析为 `unavailable`（等于拒绝工具），`user-questions/request` 的默认 `next` 抛 `NO_PROVIDER`。任何不调用 `next()` 的返回值都会抢占请求、顶掉真正的 UI 应答者。两个监听器都用 `{ prepend: true }` 注册，以保证「先提醒、再交回 UI」的顺序确定。
- **`agent/status` 只在状态字符串真正变化时发出**，且 `running` 覆盖整个轮次（含等待审批与等待回答）。但当中止后立刻有新消息唤醒时，`idle` 会紧跟 `running` 在同一同步步内连续发出。完成判定因此在微任务里用**generation 计数**（每次状态变化递增）加实时 `agent.status` 双重护栏，避免把这次续跑误报成「任务完成」。详见「自动化测试」一节。
- **投递永不阻塞智能体**：所有子进程调用都带超时、`windowsHide`、`detached` + `unref`，并发上限 8；任何失败只记日志、绝不上抛到 agent 路径。
- **文案通过环境变量传递给 PowerShell，不拼接进命令行**；Toast 的标题与正文用 `CreateTextNode` 作为文本节点附加，XML 只用常量生成。会话标题与审批理由可以包含任意字符（包括引号与换行），注入路径因此被彻底切断。
- **路由复用连接服务的准入检查**（Host/Origin 围栏 + 浏览器会话 cookie），因为 webserver 自身不提供任何认证。未通过时返回 401/403，已实测。

## 文件

| 文件 | 角色 |
|---|---|
| `index.js` | Host 半边：事件监听、完成状态机、投递调度、设置持久化、HTTP 路由、注入 |
| `config.js` | 自带的 Standard Schema 配置校验器（不依赖 `@deepseek-ai/schemastery`，链接安装的插件无法解析该包） |
| `win32.js` | Windows 投递层：Toast、提醒类通知、提示音、恢复窗口、能力探测 |
| `client.js` | 客户端半边：提示条、设置页、两个 Remote Event 监听器、页面自测探针 |
| `cordis.patch.yml` | 行配置（同时作为 bundle 层与 profile 补丁层被组合，因此用 id 定向覆盖而非 insert） |
| `locale/{zh,en}.json` | 插件卡片标题与描述 |
| `_statemachine.mjs` / `_cases.mjs` / `_loader.mjs` / `_delivery_stub.mjs` | Host 半边的测试 |
| `_client_cases.mjs` | 客户端半边的测试 |
| `references/` | 开发期调研记录（见下） |

## 调研记录

`references/` 里是三份开发期写下的技术记录，对后续做 DSH 插件同样有用：

| 文件 | 内容 |
|---|---|
| `dsh-plugin-findings.md` | **最值得先读**。实测确认的硬约束汇总：Electron IPC 白名单（乱发消息会杀掉 Host 进程）、WinRT Toast 正确配方与「未注册 AppId 也返回成功」这个陷阱、页面权限自动授予、插件包约定（bundle id 必须等于包名、`Config` 只需标准 schema、schemastery 不可被链接插件导入）、四时刻事件契约、以及两个只有实测才能发现的缺陷 |
| `dsh-notification-investigation.md` | Windows 通知投递的完整调研：主进程源码分析、IPC 通道枚举、AUMID 注册验证、Toast/声音/恢复窗口的具体命令与实测结果 |
| `dsh-plugin-authoring-contract.md` | 插件包结构、patch 方言、安装机制、兼容性门槛、HMR 语义的逐条取证 |

## 安装

### 从 npm 安装（推荐）

```powershell
# 在你的 DSH profile 目录里执行
cd $env:USERPROFILE\.dsh\profiles\desktop
npm install dsh-attention-notifier
```

然后在页面 **插件 → dsh-attention-notifier** 把它打开。若列表里没有，在 profile 的
`cordis.patch.yml` 末尾加上：

```yaml
- insert:
    - id: attention-notifier
      name: 'dsh-attention-notifier'
```

### 从源码安装

```powershell
git clone https://github.com/RisingSun785/dsh-attention-notifier.git
cd dsh-attention-notifier
npm test          # 237 条断言，无需 DSH 在运行
```

再按上面同样方式安装（把 `dsh-attention-notifier` 指向你 clone 下来的目录即可，
例如 `plugin_manager` 的 `install_bundle`，`target` 填该目录的绝对路径）。

### 运行要求

| 项 | 要求 |
|---|---|
| 操作系统 | **Windows**（投递层走 `powershell.exe` 5.1 + WinRT Toast） |
| DSH | 桌面版（`dsh-app://` 窗口 + `com.deepseek.dsh` 的 Toast AppId） |
| Node | ≥ 20 |
| 运行时依赖 | **零** —— 只用 `node:*` 内置模块 |

> 在非 Windows 平台上插件会加载但 `delivery: false`，此时只剩应用内提示条这一个渠道。
> 跨平台投递（`osascript` / `notify-send`）尚未实现。

## 开发与重载

```powershell
# 插件管理器安装（本地开发时的推荐路径）
# plugin_manager: install_bundle, target = <插件目录的绝对路径>
```

### ⚠️ Host 半边的代码改动必须重启 DSH 才生效

**这是本项目踩得最久的一个坑。** `plugin_manager` 的 `set_plugin`（disable → enable）只会重写
loader 行的启用状态并重组 profile 补丁，**不会重新导入已缓存的 ES 模块**。也就是说：

| 你改了什么 | 怎么生效 |
|---|---|
| `client.js`（浏览器半边） | **无需重启** —— `dsh-client-hmr` 以 500 ms 轮询文件字节，变化后经 SSE 让页面重新执行工厂。刷新页面即可 |
| `index.js` / `config.js` / `win32.js`（Host 半边） | **必须重启 DSH** —— 模块已在 ESM 注册表里，`set_plugin` 不会重新导入 |
| profile 的 `cordis.patch.yml` | **无需重启** —— HMR 监视该文件并协调 Loader 条目 |

排查时用得上：`apply()` 的第一行会写
`$DSH_HOME/attention-notifier/loaded.json`（含时间戳与 pid）。**这个文件没更新，就说明 Loader
根本没调用到这个模块** —— 问题在「模块有没有重新导入」，而不在 `apply` 内部。
另外 `$DSH_HOME/attention-notifier/status.json` 每 60 秒被心跳重写一次，所以
**文件时间戳陈旧 = 插件没在运行**，而不是「什么都没发生」。

### ⚠️ 改了包名必须跑 `pnpm install`

`package.json` 的 `name`、profile 的 `dependencies`、`bundles` 列表、`cordis.patch.yml`
的 `name`，以及 **`node_modules` 里的符号链接** 是五处。前四处是文本，第五处只有包管理器能重建：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm install
```

漏掉这一步的症状是 `cannot resolve profile bundle "<包名>"`（插件页显示「异常」），
而且**整个 Host 上下文建立不起来 → 连对话都会失败**，报一个看不出原因的
`REQUEST_EXTENSION`。名字只改了文档或补丁而没重装，就会撞上这个。

## ⚠️ 已知运维陷阱：设置界面会重写 profile 补丁

**现象**：本插件装好后曾经「消失」过一次 —— 插件管理器报 `unknown-plugin`，行不再出现在组合里。

**原因**：在 DSH 的设置界面里改动任何**由设置表单管理的**偏好（聊天记录视图、界面设置等）时，`configEditor` 会把整个
`C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml` **按它自己的模型重新序列化**。这个重写**只会保留它管理的行**，于是：

- 手工写进去的 `- insert: … attention-notifier …` 被**整段丢弃**；
- 顺带还丢掉了 `agent-default-model` 那一行（原本把模型固定为 `deepseek-account` / `deepseek-flash` / `reasoningEffort: max`）；
- `ui-settings-account` 的 `purpose` / `completion` / `developerTools` 也被重置（例如 `purpose: both` → `null`、`completion: completed` → `skipped`）。

**当前对策**：profile 补丁里的插件行改成**最小形式**（只有 `insert` + `id` + `name`，不带 `config`），插件自身的默认值放在 `config.js`，实时偏好放在 `$DSH_HOME/attention-notifier/settings.json`（设置界面不碰这个文件）。这样即使补丁被重写，也只需要恢复两行。

## 插件页那个开关是怎么生效的

DSH 的插件页开关**只编辑 profile 的 bundle 列表**（`dsh.profile.bundles`），它**不会**增删 profile 补丁里的
`- insert:` 行，因此**无法卸载一个已经在运行的插件**。补丁行才是「是否加载」的唯一决定因素。

本插件据此把开关做成了**实时生效的闸门**：每次要发提醒前都去读一次 profile 的 bundle 列表，
不在列表里就整条丢弃（并计入 `observed.suppressed`）。所以：

| 你的操作 | 效果 | 需要重启吗 |
|---|---|---|
| 插件页**关**开关 | **立即**不再有任何提醒（插件仍在内存里空转） | 不需要 |
| 插件页**开**开关 | **立即**恢复提醒 | 不需要 |
| 删掉 `cordis.patch.yml` 的 `- insert:` 行 | 插件被真正卸载，连空转都没有 | 不需要（补丁被 HMR 监视） |
| 加回那两行 | 重新加载插件 | 不需要 |

> **判定顺序是「先看开关，再看事件」**：开关关闭时，`observed.suppressed` 会增长而 `observed.delivered` 不变。
> 诊断文件里的 `switch.enabled` 直接显示当前判定，以及这个判定是从哪个 profile 目录读来的 ——
> 「开关是关的」和「找不到 profile」这两种情况必须能区分开，否则无法排查。

> **读不到就当作开启**（fail open）。一个因为找不到偏好文件就悄悄不再提醒的插件，
> 比一个在该安静时响了一下的插件糟糕得多。

**闸门的两条前提**：插件必须在 `bundles` 列表里、且补丁行存在。只满足一个都不行 ——
只关开关会让插件空转，只删补丁行会让开关的开启状态无法体现。

**插件消失后怎么恢复**：在 `cordis.patch.yml` 末尾追加

```yaml
- insert:
    - id: attention-notifier
      name: 'dsh-attention-notifier'
```

并确认 `dsh.profile.bundles` 里也有 `dsh-attention-notifier`。

> 本地开发安装（`link:` 到源码目录）时，包名可能是你自己起的名字，例如
> `plugin_manager install_bundle <绝对目录>` 会按被链接包的 `package.json` 名字写进 `bundles`。
> **补丁行里的 `name` 必须与那个名字完全一致**，两处不一致会导致插件静默不加载。

保存即生效（该文件被 HMR 监视，无需重启）。若插件管理器此时报 `unknown-plugin`，说明行确实不在组合里 —— 补上这两行即可。

**另外注意**：`plugin_manager` 的 `install_bundle` 在依赖已存在时会以 `ambiguous-install` 失败，**不会**重新组合 bundle 自带的补丁层。所以不能靠「重装一次」来恢复行。
