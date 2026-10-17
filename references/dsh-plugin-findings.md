# DSH 插件开发：实测确认的技术约束

本文件记录在开发 `dsh-attention-notifier` 期间**通过读源码 + 实机验证**确认的关键结论。
每条都标注了证据来源，以及是「已验证」还是「推断」。记录时间：本插件开发会话。

---

## 一、Electron 主进程 IPC 不可扩展（高危）

**结论**：插件**绝对不能**向 Electron 主进程发送自定义 IPC 消息。

**证据**：`app.asar/lib/main.js` 对来自 Host 子进程的消息做严格白名单校验：

```js
child.on("message", (message) => {
    if (!isDesktopHostEvent(message)) {
        this.fail(new Error("dsh desktop host sent an invalid IPC event"));
        child.kill("SIGTERM"); return; }
```

合法的 Host→主进程消息只有 6 种：`ready`、`platform-session`、`shutdown-complete`、`fatal`，以及 `update-tasks` / `quit-inspection` 的响应。
主进程→Host 只有 3 种：`update-tasks`、`quit-inspection`、`shutdown`。

**推论**：任何「让主进程弹原生通知」的插件设计都是死路。系统通知必须由 Host 自己实现。

---

## 二、Windows 系统通知：可用方案

**结论**：用 `powershell.exe`（**不是 `pwsh`**）投影 WinRT 弹 Toast，AppId 用 `com.deepseek.dsh`。

**已验证的事实**：
- `pwsh` 未安装；`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` 是 5.1。
- `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]` 在 5.1 中可解析。
- `CreateToastNotifier(String)` 返回**同步**的 `ToastNotifier`（不是 `IAsyncOperation`），因此**不需要 `AsTask` 等待助手**。
- `app.setAppUserModelId(...)` 在主进程源码中**完全不存在**；AppId 由开始菜单快捷方式 `DeepSeek Harness.lnk` 的 `System.AppUserModel.ID` 注册（`Get-StartApps` 可查）。
- BurntToast 模块**未安装**，不可依赖。

**实测验证投递真的到达系统**（不依赖插件，直接查注册表）：

```powershell
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\com.deepseek.dsh' |
  Select-Object LastNotificationAddedTime, PeriodicNotificationCount
```

`PeriodicNotificationCount` 与 `LastNotificationAddedTime` 会随每次成功投递变化。开发期间用这个方法确认了两次 Toast 真的到达。

**重要陷阱**：`CreateToastNotifier` 对**未注册的 AppId 也返回成功**（实测传 `com.example.not.registered` 仍 `ok`）。所以「调用没报错」**不等于**「通知显示了」。必须用上面的注册表方法或人工确认。

**注入防护**：文案通过**环境变量**传给 PowerShell，再用 `CreateTextNode` 作为文本节点附加；XML 只用常量字符串生成。会话标题/审批理由可含引号、换行、`;`、`<script>`，实测无法逃逸成代码。

---

## 三、页面权限与窗口焦点

**结论**：DSH 页面的**非媒体权限被自动授予**。

**证据**：`main.js` 在主窗口的 `session.defaultSession` 上安装：

```js
session.setPermissionCheckHandler((contents, permission) => permission !== "media" ? true : ...)
session.setPermissionRequestHandler((contents, permission, callback) => {
    if (permission !== "media") { callback(true); return } ... })
```

只有麦克风被拦截。页面是安全上下文（`dsh-app://` 注册为 `standard + secure`），所以 `new Notification(...)` 可用。

### ✅ 已实测：`dsh-app://` 下的 `fetch` 到 Host 的 `/api` 可用

这是本项目最担心的一点（Electron 窗口不在 `http://127.0.0.1:<port>` 上，而是在
`dsh-app://app/`），实测结论是**可以正常工作**：页面里的
`fetch('/api/attention-notifier/state', { credentials: 'same-origin' })`
返回 **HTTP 200 + 完整 JSON**。

也就是说：**相对路径的 `fetch` 会被主进程的 `protocol.handle('dsh-app')` 转发到 Host，
并带上浏览器会话 cookie**，和浏览器标签页里的行为一致。所以页面插件**不需要**为了取 Host 数据
而绕道 Remote Events / typert；一个普通的 `/api/<plugin>/...` 路由 + 相对 fetch 就够了
（前提是路由自己复用连接服务的准入检查，见第四节）。

**但**：插件**无法**在渲染进程调用 `BrowserWindow.flashFrame()` —— DSH 没有暴露任何这样的通道。

**Host 侧也拿不到窗口焦点状态**。只有页面知道（`document.hasFocus()` / `visibilityState`），
所以「仅当窗口不在前台时提醒」这个策略必须由客户端半边判断，或由页面上报给 Host。

---

## 四、插件包的硬性约定

| 事项 | 结论 | 证据 |
|---|---|---|
| 客户端 bundle 的 `__ModuleLoader__.load({id})` | **必须等于包名**（如 `dsh-attention-notifier`），不是 loader 行 id | `dsh-client-modules`：`entry: graphRow(packageName, …)` |
| bundle 的 URL | `/plugins/<包名>/client.js?rev=<rev>`；**`rev` 必须正确**，错误 rev 返回 404 | 实测：`POST /plugins/x/client.js?rev=1` → **405**（证明路由已注册，只有方法检查会返回 405） |
| `Config` 的消费方式 | Loader 只调用 `Config["~standard"].validate(raw)`，**同步**，返回 `{value}` 或 `{issues:[{message,path?}]}` | `cordis/lib/index.js` `resolveConfig()` |
| 是否需要 schemastery | **不需要**。可以自己实现标准 schema，避免依赖解析问题 | 见下条 |
| `@deepseek-ai/schemastery` 能否被插件导入 | **不能**（对 `link:` 安装的插件）。它随 DSH 安装目录提供，不在 profile 的 `node_modules` 里 | 实测 `Cannot find package '@deepseek-ai/schemastery'` |
| 兼容性门槛字段 | `peerDependencies` 中指向 `@deepseek-ai/dsh*` 的会被校验；`@deepseek-ai/cordis` 与 `schemastery` 的 peer **不被校验** | `dsh-app-boot` |
| 设置页能否自动生成 | `dsh-settings` 的表单**只暴露 `.volatile()` 字段**；没有 volatile 字段时 `Config` 状态显示 `unsupported` | `dsh-settings/lib/index.js` `volatileForm()` / `schema()` |
| index 注入是否每次重新生成 | **是**。`renderIndex` 每次请求 index 时重新跑 `webserver/index-inject` | `dsh-host-frontend-static/lib/index.js` |
| Electron 窗口是否走 HTTP | **否**。窗口在 `dsh-app://app/`，主进程转发到 Host；裸 HTTP 端口 19387 是 Host 自己的监听 | `main.js` `protocol.handle('dsh-app')` |
| `/plugins` 路由 | 注册在 `ctx.inject(['webServer'], …)`，**无认证**（静态资源公开） | 实测 405 |
| `/api` 路由 | 被 `dsh-client-connection` 以 prefix 整体认领；**Host/Origin 围栏 + 浏览器 cookie**，未认证返回 401 | 实测 |
| webserver 自身的认证 | **没有**。README 明确：route owner 自己负责请求策略 | `dsh-host-webserver/README.md` |

---

## 五、四个「需要用户」时刻的事件契约

| 时刻 | 事件 | 关键约束 |
|---|---|---|
| 权限确认 | `approval/request`（waterfall） | 字段只有 `agent / toolName / callId? / reason? / displayReason? / signal?`。**没有 `id`，没有工具参数**。`displayReason` 是 `{en, zh, …}` 现成本地化文案 |
| 提问 | `user-questions/request`（waterfall） | `agent` 可能为 `undefined`（agentless）。`wait.callId` 存在才代表有真实工具调用卡片。`questions[0].intent.kind === 'plan-review'` 是计划评审 |
| 任务完成 | `agent/status` → `idle` | **只在状态字符串真正变化时发出**；`running` 覆盖整个轮次（含等待审批/回答）。`maintenance` 阶段也报 `idle` 且**不发事件** |
| 出错 | `agent/error` | `error` 类型是 `unknown`，必须防御性取值 |

**两条必须遵守的规则**：

1. **瀑布监听器必须 `return next()`**。`approval/request` 的默认 `next` 解析为 `unavailable`（= 拒绝工具）；`user-questions/request` 的默认 `next` 抛 `NO_PROVIDER`。不调用 `next()` 就会抢占请求、顶掉真正的 UI 应答者。
2. **用户中断与出错互斥**：用户 abort 时 `throwError` 被刻意跳过，**不发 `agent/error`**，只留 `turn/end{reason:{kind:'aborted'}}`。要区分中断必须监听 `session/event` 的 `turn/end`。

**未作用域的监听器可以收到所有 agent 的事件**（`scopeTarget`：`tag === undefined` 即放行）。客户端侧同理（`ctx.remote.$on` 在插件顶层注册）。

**审批策略 `never` 时瀑布根本不会派发**——`ApprovalService.decide` 在派发前直接返回 `rejected`。所以权限提醒在 `never` 会话中永远为 0，这是设计使然。

---

## 六、三个只有实测才能发现的缺陷

### 1. 重启后插件加载失败：`Config` 是对象，不是函数

**现象**：插件在运行中的会话里一切正常，但重启 DSH 后整个行加载失败。

**根因**：`apply` 里写 `const config = rawConfig ?? Config({})`。`Config` 是**对象**（带 `~standard`），不是函数，调用它抛 `TypeError: Config is not a function`。

**为什么只在重启后暴露**：同一份 patch 文件里，后面的 **id 定向覆盖会整体替换 `config`**：

```yaml
- insert:
    - id: attention-notifier
      name: 'dsh-attention-notifier'
      config: { … 完整配置 … }
- id: attention-notifier        # 插件管理器写入的启用状态
  disabled: false
```

后一条把 `config` 整个换掉，于是**行到达 `apply` 时 `rawConfig` 是 `undefined`**。运行中通过 `set_plugin` 触发的重载恰好走另一条路径，掩盖了这个问题。

**教训**：插件必须容忍「完全没有 config」，而且这条路径**必须显式测试**——它是重启后的常态而非例外。

### 2. `agent/status` 的瞬时 idle→running 会误报「任务完成」

当一条消息唤醒的 agent，其当前轮次的 cancel signal **已经 aborted** 时：`kick` 的 finally 先 `setPhase(idle)`，紧接着 `wakeDriver()` → `setPhase(running)`。**两个事件在同一同步步内连续发出**。

最初用 `queued` 布尔量去抖会失效：`running` 分支把 `queued` 清掉，于是微任务里的守卫不再成立。若此时 `agent.status` 恰好读到 `idle`（观测顺序可能如此），就会把这次续跑误报成「任务完成」。

**正确做法**：用**每次状态变化都递增的 generation 计数**。微任务里同时校验「generation 未变」且「实时 status 是 idle」——前者是权威判据。

### 3. 路由的 404/405 语义

把方法检查放在路径校验之前，会让**任何未知路径**都返回 405。正确顺序：先判断 action 是否属于已知集合（否则 404），再判断方法（否则 405）。

### 附：三条测试自身的陷阱

- **用例之间会通过设置文档互相污染**：插件每次 `apply` 都重读设置文件，所以前一个用例写入的设置会泄漏到后一个。对策是每个用例给一个全新的 Harness home 和空设置文档。
- **`unfocused` 策略在页面从未上报可见性时是刻意沉默的**（无人值守时的保守取向）。测试这类策略前必须先上报可见性，否则会把「正确的保守行为」误判成缺陷。
- **`sidebar.toggle.badge` 是单值插槽且已被应用占用**：注册它会抛
  `single slot "sidebar.toggle.badge" already has a registration at priority 0 (registered by af)`。
  在单值插槽上做装饰前，先查 `Slots.listSubTree` 的 `kind`：`single` 表示**只能有一个占用者**，
  已有占用时注册会失败。

### 附：插件 `apply` 必须按步隔离

浏览器半边的 `apply` 里任何一步抛错，**后面所有步骤都不会执行**。实测遇到过：
`sidebar.toggle.badge` 注册失败导致**设置卡片、两个事件监听器、轮询全部没有安装** —— 表现是
「插件装了但界面空的、也不提醒」，而且控制台默认什么都不说。

对策：把 `apply` 拆成一组各自 `try/catch` 的命名步骤，每步打印 `ok`/`STEP FAILED`，结尾打印一行
汇总。这样一次刷新就能定位失败步骤，而且**一个可选步骤失败不会拖垮核心功能**。

### 附：测试如果照着实现写，就抓不到「实现假设错了」这类 bug

**实测后果**：「提问等待」这一时刻**完全不提醒**，而 234 条断言**全绿**。

根因是处理器里的前置条件检查了一个不存在的字段：

```js
// dsh-user-questions 的 ask() 派发的载荷是 { ...request, agent }，
// 而 request 只有 questions 和 signal：
this.ctx.waterfall(scopeTarget(agent, agent), "user-questions/request", {
  ...request, agent
}, noAnswerer)

// 插件却要求：
if (... && request?.wait?.callId !== undefined && first !== undefined) { notify(...) }
//              ^^^^^^^^^^^^^^^^^^ 永远不存在，于是 notify 从未被调用
```

`callId` 由服务**内部**分配，不属于这个载荷；最接近的稳定身份是 `question.id`
（计划评审则是 `intent.callId`）。

**为什么测试没抓到**：测试里的载荷是**照着实现写出来的**，里面写着
`wait: { callId: 'call-q1' }` —— 于是测试**迎合了错误的代码**，验证了一个现实中不存在的输入形状。

**规避方式**：
1. **测试夹具必须来自真实发射点**，不是来自你对自己代码的理解。
   在写「某事件到达时应该 X」这类断言前，先去读**派发那个事件**的那行源码，
   把载荷原样抄下来（本例：`{ questions, agent, signal }`）。
2. **对「事件形状」加一条形状断言**：用**完整的真实载荷**跑一遍，
   并附一条「代码里不出现对某不存在字段的读取」的断言。
3. **诊断要能区分「事件没到」和「到了但没处理」**：
   - `observed.question = 1`（处理器跑了）但 `delivered = 0` 且 `byKind = {}`（没投递）
   → 立刻把范围锁死在「处理器内部的前置条件」，而不是投递层。
   如果只有事件总数的聚合计数，这一点看不出来。

### 附：插件管理器的开关只改 bundle 列表，卸载不了运行中的插件

**实测**：在插件页把某个本地插件的开关**关掉**，插件**照常运行**。

| 动作 | 改动的文件 | 是否停止插件 |
|---|---|---|
| 关掉插件页的开关（`set_bundle(enabled:false)`） | `profiles/<name>/package.json` 的 `dsh.profile.bundles` | **否** |
| 删掉 `- insert:` 那一行（手工编辑） | `profiles/<name>/cordis.patch.yml` | **是**（该文件被 HMR 监视，立即生效） |

**证据**：关掉开关后 `bundles` 里已无该插件，但插件自己写的诊断心跳仍在继续、投递计数仍在增长；
删掉 patch 行后心跳随即停止。

**插件侧的正确应对**：既然开关改的是 `dsh.profile.bundles`，那就**在每次要产生效果之前读一次它**，
不在列表里就整条丢弃。这样开关无需重启即可实时生效，即使插件仍被加载。

```js
// profile 目录来自桌面宿主的命令行参数；环境变量 DSH_PROFILE_DIR 是兜底。
const dir = process.argv.find((a) => /[\\/]profiles[\\/][^\\/]+$/.test(a)) ?? process.env.DSH_PROFILE_DIR
const bundles = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))?.dsh?.profile?.bundles
const enabled = !Array.isArray(bundles) || bundles.includes(packageName)   // 读不到就当开启
```

**三条实践建议**：
1. **读不到就当作开启**（fail open）。因为读不到偏好文件就静默失效的插件，比偶尔多响一下的危险得多。
2. **把判定结果连同判定依据一起写进诊断**（例如 `switch: { enabled, profileDir }`）。
   「开关是关的」与「找不到 profile」必须能区分，否则用户报「没通知」时无法定位。
3. **给依赖 profile 路径的代码写测试时，先隔离 `DSH_PROFILE_DIR`**：开发者自己的 shell 往往已经导出了
   真实 profile 路径，测试会读到真实配置而不是夹具 —— 表现为「代码明明对，测试却失败」。

### 附：只被「解析」而从未被「使用」的配置项

**实测后果**：把「应用内提示条」关掉后，提示条**照样出现**。诊断文件里 `effective.channels.inApp`
明明已是 `false`，运行中的实例也确实解析出了 `false` —— 因为该字段只在配置解析处出现，
**投递路径里从来没读过它**。

同一个 bug 还有第二处：「任务栏闪烁」的 `flashPending` **只由设置卡片里的测试按钮设置**，
真实事件路径从不设置它 —— 这个渠道看起来实现了，实际从不为真实通知触发。

**为什么危险**：这类 bug **不报错、不失败测试、界面上也看不出**。用户以为开关生效了，
实际什么都没变；而「配置已被正确解析」这件事还容易让人误判为「配置已生效」。

**规避方式**：
1. **每个配置项都要有一个消费点**，并为它写一条「关掉之后行为确实不同」的断言。
   只断言「配置被正确解析」是不够的 —— 那正是漏掉这个 bug 的原因。
2. 对渠道类开关，**在 Host 侧设闸**，不要只在前端隐藏界面。前端隐藏会让消息继续流过来，
   只是没人渲染；任何渲染路径的遗漏都会让开关失效。
3. 定期做机械检查：对每个配置键 grep 出所有出现位置，若只有「解析」两处而无「消费」，就是死配置。

### 附：手写 Config 必须带 `meta`，否则整个应用启动失败

**现象**：插件一加载，桌面应用立刻报
`desktop welcome: Web RPC failed` 且无法启动；禁用第三方插件后恢复正常。
**与时机无关** —— 推迟注册、去掉磁盘写入、给注册加 try/catch 全都无效。

**根因**：`dsh-settings` 的 `describe` 会遍历**每一条**配置的 schema 来生成设置表单，
而它的遍历函数**直接解引用节点字段**：

```js
function volatileForm(schema) {
	if (schema.meta.volatile) return plainSchema(schema);   // ← schema.meta 必须存在
	if (schema.type === "object") { /* 递归 schema.dict */ }
}
```

一个只有 `~standard` 的普通对象没有 `meta` → `undefined.volatile` → TypeError →
`settings/describe` 整个 RPC 被拒 → 欢迎窗口拿到失败结果并终止启动。

**为什么容易踩**：Loader 只要求 Standard Schema 形状（`~standard.validate`），
于是很自然会写一个「够用」的普通对象。但**设置服务要的是 Schemastery 的节点形状**，
两套形状必须同时满足。

**规避方式**：
1. 每个节点都带 `meta`（至少 `{}`）、`type`、`dict`（对象节点）、`toJSON()`；
2. **`toJSON()` 的输出也要在每一层带 `meta`** —— 遍历会逐层 `delete node.meta.volatile`，
   根节点与嵌套对象节点都不能漏；
3. 把这个遍历逻辑复刻进测试，直接对真实 `Config` 跑一遍。这个 bug 是**确定性**的，
   测试能 100% 抓到，而手工点界面极易误判为「时序问题」。

### 附：`agent/status` 只在状态字符串变化时才派发

同一会话里 `session/event` 的 `turn/end` 会到达，但 `agent/status` 可能一次都不来 ——
例如插件在 agent 已处于 `running` 之后才加载。所以**不要只依赖 `agent/status` 判断轮次结束**：
`session/event` 的 `turn/end` 是更可靠的那一路，它还携带 `reason.kind` 能区分
`completed` / `aborted`，而**用户中止不会产生 `agent/error`**。

### 附：同一字段在两处做单位换算 = 每次保存乘一次

**实测后果**：一个「秒 ↔ 毫秒」输入框，把 `draft` 存成毫秒、保存时又按秒乘 1000。
于是每点一次保存值就乘一次 1000 —— 用户的配置最终变成 `minDurationMs: 5000000000`（≈57.8 天），
**「任务完成」提醒再也不触发**，而界面上看不出异常（重进显示的是被除回来的数字）。

**规避方式**：
1. **换算是边界职责，只做一次。** 表单内部统一用显示单位（秒），只在提交处转成宿主单位（毫秒）。
2. **别给数字输入框设小 `step`。** `step: 5` 会让「1」被浏览器吸附到 0 —— 用户输入的值在到达你的代码前已被改动。
   需要任意值时用 `step: 'any'`。
3. **把解析后的有效配置发布出来**（写进诊断文件之类）。只有磁盘上的 `settings.json` 时，无法区分
   「这个值已生效」和「实例里还留着旧的」—— 这次的 50 亿正是靠这一点才定位到。

### 附：两个设置互相抵消，而用户看不见

「任务完成 = 始终提醒」配上一个正的「最短运行时长」，会让短任务被静默丢弃 —— 用户以为自己选了
「每次都提醒」，实际得到「超过阈值才提醒」。**模式语义要能压过阈值**：`always` 应当绕过时长门槛，
把阈值留给默认的 `unfocused` 模式。

### 附：从注册表解析 exe 路径要匹配被引号包裹的形式

`reg.exe query … /ve` 的输出形如：

```
HKEY_CURRENT_USER\Software\Classes\dsh\shell\open\command
    (默认)    REG_SZ    "D:\…\DeepSeek Harness.exe" "%1"
```

用 `/(?:^|\s)([A-Za-z]:\\[^"]+?\.exe)/` 会**永远匹配不上**：为了避开 `"%1"` 而排除引号后，
盘符前既不是行首也不是空白。而这样的安装路径通常含空格。正确做法是优先匹配
`/"([A-Za-z]:\\[^"]+?\.exe)"/`（引号同时消除了 `"%1"` 的歧义）。

**教训**：这类失败是**静默降级** —— 功能看起来「有」，实际退化到备用路径。所以能力探测
（把解析结果报告出来）比事后调试便宜得多。

---

## 七、开发与安装工作流

| 目的 | 做法 |
|---|---|
| 安装本地插件 | `plugin_manager` `install_bundle`，`target` = 包的**绝对目录**（会 pnpm link 到 profile 并加入 `dsh.profile.bundles`） |
| 重复安装同一个包 | **会失败**（`ambiguous-install`）：包已在 `dependencies` 中，安装器无法判断「哪个包变了」。要么先 `remove_bundle`，要么手动在 profile 的 `cordis.patch.yml` 加行 |
| bundle 自带的 patch 何时生效 | 只在**被安装器组合成本层**时。依赖已存在、安装被跳过时**不会**重新读取 |
| 让 Host 半边重新加载代码 | **做不到，必须重启 DSH**。`set_plugin`（disable→enable）只重写行状态并重组补丁，**不重新导入已缓存的 ES 模块**；HMR 默认 `root: []`，不监视模块 |
| 让客户端半边重新加载 | `dsh-client-hmr` 以 500 ms 轮询 bundle 的 **mtime/size 字节**，变化后经 SSE 通知页面重新执行工厂。**改完保存刷新页面即可** |
| 新增 index 注入（`webserver/index-inject`） | 注入表每次渲染 index 时重建，所以**刷新页面即可**；但 Electron 主进程在 `ready` 时缓存了一份 injection 列表，桌面形态下可能需要重启 |
| 恢复一个消失的行 | 在 profile 的 `cordis.patch.yml` 末尾追加 `- insert: { id, name }`；该文件被 HMR 监视，保存即生效 |

### ⚠️ desktop 启动失败与内置恢复选项

**症状**：DSH 启动时弹出对话框
`DeepSeek Harness is unavailable — desktop welcome: Web RPC failed`，
附一个诊断报告路径，以及三个按钮：`Exit` / `Restart` /
**`Disable third-party plugins, back up profile patch, and restart`**。

**这是一个症状，不是诊断。** 「welcome」是启动时的初始窗口，它连上 Host 后通过 Web RPC
读取设置与引用信息；**这个 RPC 失败的原因可以是很多种**。要定位必须看时间戳：

```
loaded.json  at 01:35:10.086    ← 插件 apply 完成
crash log       01:35:10.411    ← 325 毫秒后
```

**本插件踩到的真实根因是 schema 形状**：`settings/describe` 遍历配置条目时碰到一个没有
`meta` 的 `Config` 就抛 TypeError，整个 RPC 被拒。这是**确定性**错误 —— 只要有人读设置就必然发生，
与启动快慢无关。（详见上文「手写 Config 必须带 `meta`」一节。）

> ⚠️ **教训**：这个错误文本在**没有该插件时也出现过**（同一台机器、同一份安装），
> 我因此把它归因成「启动时序问题」，并围绕时序做了三轮加固（推迟注册、去掉同步 I/O、
> 加 try/catch）—— **全部无效**，因为崩溃点根本不在那里。
> **不要把「曾经无关地出现过」当成「与我的改动无关」的证据。**

**第三个按钮是最安全的恢复手段**：实测它把 `dsh.profile.bundles` 里的第三方 bundle 全部取消选择，
把 profile 补丁备份成 `cordis.patch.yml.bak-<epoch-ms>`，然后把 DSH 恢复到可启动状态。
注意它同时也**删掉了 profile 补丁里的插件行**，所以恢复后需要手动把行加回去。

**给插件作者的三条实践**：
1. **手写 `Config` 时补齐 Schemastery 的节点形状**（`meta` / `type` / `dict` / `toJSON()`，
   且 `toJSON()` 的每一层都要有 `meta`）。这是本插件造成启动失败的**唯一**原因。
2. **把可能与他人冲突的注册（HTTP 路由、注入槽位）包在 try/catch 里**，让冲突只降级功能，
   而不是冒泡到激活阶段 —— 那时用户看到的是**整个应用起不来**，报错完全指不到插件。
3. **不要在 `apply` 里做同步磁盘 I/O**，诊断写入放 `setImmediate(...)`。
   这条**不是**本插件崩溃的原因（实测过，无效），但让启动窗口保持干净仍然是好习惯。

### 附：bundle 的 `insert` 行可能不生效，`rows` 会是空的

实测：bundle 自带补丁用 `- insert:` 声明了一行，`install_bundle` 报告成功、bundle 也在
`dsh.profile.bundles` 里（`enabled: true, installed: true`），但 `list_bundles` 返回
**`rows: []`**、只有 `overrides: ["<row id>"]` —— **行没有被插入**。
`install_bundle` 也不会自愈：依赖已存在时它以 `ambiguous-install` 失败，**不会重新组合 bundle 层**。

因此本项目的启用路径是 `set_bundle`（把 bundle 放回 `dsh.profile.bundles`），
必要时再在 profile 的 `cordis.patch.yml` 里补一个 `- insert:` 行。
排查时先看 `list_bundles` 的 `rows` 是否为空 —— 这比翻日志快得多。

### ⚠️ Host 半边改代码后必须重启（踩得最久的坑）

**症状**：改完 `index.js`，用 `set_plugin` disable→enable，返回 `application: "applied"`，但
新代码**完全没有生效** —— 没有报错、没有日志、路由照旧工作（旧代码的）。

**根因**：ES 模块导入结果被缓存。Loader 重建 row 时会重新 `import()`，但拿到的是**同一份缓存**，
所以 `apply` 不会以新代码再次执行。`dsh-plugin-manager` 的 README 里也写着
「replacing an installed package requires restart to load a fresh JavaScript module generation」。

**为什么客户端半边不受影响**：`dsh-client-hmr` 不依赖模块系统，它是直接比较 bundle 文件的
mtime/ctime/size 再让页面重新执行工厂。

**排查手法（很有用）**：在 `apply` 的**第一行**写一个标记文件（含时间戳与 `process.pid`）。
这个文件没更新，就直接排除了「`apply` 内部某处失败」这一整类假设 —— 问题在「模块有没有重新导入」。
同理，让插件周期性地重写一个状态文件，可以让「插件是否在运行」变成一个可观测事实，
而不是靠推理。

**patch 层的行语法**：`insert: [rows]` 或 id 定向覆盖。`insertBefore` / `insertAfter` **不存在**。id 定向覆盖时 `config` 是**整体替换**（不深合并）。

### ⚠️ 设置界面会重写 profile 补丁，并丢弃非托管行

**已实测的破坏性行为**：在设置界面改动任何**由设置表单管理的**偏好时，`configEditor` 会把整个 profile 的 `cordis.patch.yml` 按自己的模型重新序列化，只保留它管理的行。实测后果：

- 手工写的 `- insert: …` 行被**整段丢弃**（行从组合中消失，`plugin_manager` 随后报 `unknown-plugin`）；
- `agent-default-model` 行（模型固定配置）被删除；
- `ui-settings-account` 的 `purpose` / `completion` / `developerTools` 被重置（如 `purpose: both` → `null`）。

**推论**：不要把必须存在的配置只放在 profile 补丁里。插件应自带默认值（`config.js` 之类），把可变偏好放到设置界面不碰的文件（如 `$DSH_HOME/<plugin>/settings.json`），profile 补丁里只留最小的 `insert` 行以便恢复。

---

## 八、验证方法论（值得复用）

1. **投递链路**：不要相信「调用没报错」。用注册表回执（上面第二节）或人工确认。
2. **判定逻辑**：用 Node 的 `module.register()` 注册一个 loader hook，把副作用模块（spawn PowerShell）替换成记录器，然后用假的 Cordis context 驱动真实插件代码。这样能测到真实的决策，而不需要真的弹通知。这套做法最终抓到第六节的全部三个缺陷。
3. **路由表面**：直接对 `route.handler` 喂合成 req/res。并且要用**方法检查**来区分「路由未注册」和「资源未找到」——405 vs 404 是可靠信号。
4. **契约核对**：DSH 的 `cordis_inspect_query`（`Service` / `Event` / `Config`）是权威来源，比读编译产物更快；`dsh-tool-cordis/lib/types/api-catalog.js` 有完整的 `declaration` 字符串。注意其中 `Agent` 的声明是**被截断的**，完整形状在 `dsh-*/lib/typert.host.js` 里。
5. **浏览器的替身**：客户端半边是普通 JS，只要给 `window.__ModuleLoader__`、`document`、`fetch`、`CustomEvent` 打桩就能在 Node 里执行。能验证注册 id、工厂形状、插槽注册、瀑布委托、生命周期挂载/卸载——这些一旦出错会**让整个页面启动失败**，最值得在浏览器之前先测掉。
