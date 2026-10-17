# DSH Codex Control

让 **Codex 负责方案、派工和验收**，由正在运行的 **DeepSeek Harness 桌面 Host** 执行任务。

本项目包含一个 DSH Host 插件和一个本地 stdio MCP 连接器。插件创建的普通 DSH 会话会附加到工作区，可在桌面查看；连接器将任务管理能力提供给 Codex。无需再次启动一套 headless/ACP Harness。

**版本状态：0.1.0，Windows 预览版。** 已在 DeepSeek Harness Desktop **0.2.1-rc.2** 实机验证。其他版本和其他操作系统尚未实机验证。DSH 的 Host 接口处于快速迭代期，升级 DSH 后请先重新运行验证。

## 工作方式

```text
Codex（主控）
  ↕ stdio MCP
本地连接器
  ↕ 仅回环 HTTP + 每次启动更新的凭据
DSH Host 插件
  ↕ Session Controller / Agent API
专用执行会话 → 项目文件和 DSH 已配置的工具
```

插件只管理它自己创建并记录在账本中的会话，不支持绑定任意已有聊天。Codex 子智能体插件不是必需依赖；如需使用，应由主控在任务中明确安排，避免递归派工。

## 安装

需要 Node.js **22.19.0 或更新版本**、已经配置模型的 DSH Desktop，以及可连接本地 MCP 的 Codex。

```powershell
git clone https://github.com/Smilehyu/dsh-codex-control.git
cd dsh-codex-control
npm ci --ignore-scripts
npm test
```

从源码目录安装连接项，指定你允许创建执行会话的目录：

```powershell
node scripts/configure.mjs --root 'D:\Projects\MyProject' --codex-config "$env:USERPROFILE\.codex\config.toml"
```

配置脚本会：

- 备份原有 DSH profile patch 和 Codex 配置，并输出备份位置。
- 在标记段内添加插件的绝对路径、允许目录和 MCP 连接器。
- 保留既有配置；再次运行会替换本项目的标记段。

默认 DSH profile 是 `~/.dsh/profiles/desktop`。自定义安装可传 `--profile-dir`、`--data-dir`；每个路径均须为绝对路径。省略 `--codex-config` 时仅配置 DSH。

保留源码目录和 `node_modules`：当前安装通过绝对路径加载源码。DSH 通常会自动加载 patch；必要时在工作结束后重启 DSH。Codex 的 MCP 配置需重新连接或重新打开聊天才会被工具列表采用。

检查连接：

```powershell
node scripts/doctor.mjs
```

## 手动配置

也可以将下面的条目加入 DSH profile 的 `cordis.patch.yml`，调整路径：

```yaml
- insert:
    - id: codex-control
      name: 'D:/Tools/dsh-codex-control/src/plugin.js'
      config:
        allowedRoots:
          - 'D:/Projects/MyProject'
        # 可选，默认 ~/.dsh/codex-control
        dataDir: 'D:/Private/dsh-control-data'
        # 可选，0 表示自动选择回环端口
        port: 0
```

Codex MCP 配置示例见 [examples/codex.toml](examples/codex.toml)。连接器每次调用都会重读连接文件，支持 DSH 重载后更换端口和凭据。

包同时提供 DSH bundle 元数据；bundle 初始为禁用状态，须配置 `allowedRoots` 后再启用。源码安装是本版本实机验证过的安装路径。

## 派工流程

1. `get_capabilities` 检查连接与允许目录。
2. `create_worker_session` 在项目下创建专用会话，获得 `sessionId`。
3. `submit_task` 提交目标、约束和验收标准。`requestId` 使用 UUID；重试相同请求必须复用原值。
4. `wait_task` 等待新增证据或终态。将返回的 `cursor` 作为下一次的 `afterSeq`，每次最多等待 30 秒。
5. Codex 读取真实文件和验证结果，独立验收。需要修正时通过 `continue_task` 在同一会话发起新的任务。

| 工具 | 用途 |
| --- | --- |
| `get_capabilities` | 查看版本、控制范围和能力 |
| `list_worker_sessions` | 列出插件创建的会话 |
| `create_worker_session` | 创建桌面可见的执行会话 |
| `submit_task` | 提交任务并立即返回任务编号 |
| `get_task` / `wait_task` | 查询状态、增量事件和答案 |
| `continue_task` | 保留会话上下文，创建关联的后续任务 |
| `cancel_task` | 请求取消并清理该会话待执行输入 |
| `get_result` | 读取已有任务的答案和证据 |

提交示例：

```json
{
  "sessionId": "session-returned-by-create-worker-session",
  "requestId": "9d812b73-69d7-4887-8759-da8a858ff344",
  "objective": "分析存档加载失败的原因，先给出文件和日志证据。",
  "constraints": ["只读分析，不修改文件，不委派回主控 Codex。"],
  "acceptance": ["列出定位结果、证据以及建议的最小修复范围。"]
}
```

`completed` 表示 agent 及其受管子任务已经结束且完成日志已持久化，**不等于结果正确**。所有记录的 `verified` 保持 `false`，由主控独立验收。`interrupted` 表示执行或观测不确定，需要检查，插件不会自动重新发送任务。

第一版同时仅允许一个桥接任务处于执行状态。手动操作同一个执行会话可能影响任务结果和取消范围；任务运行时请通过 Codex 追加要求，或先取消再手动接管。

## 数据与权限

- 默认数据目录：`~/.dsh/codex-control/`，含连接文件、进程锁和任务账本。
- 连接凭据每次启动重新生成，不放入 MCP 参数、日志或 Git。
- 控制端口仅绑定 `127.0.0.1`，验证 Host 和 Bearer 凭据，拒绝浏览器 Origin 与跨域请求。
- 数据目录应保存在当前用户私有目录；Windows 依赖该目录继承的用户 ACL，Node 文件 mode 不能替代 Windows ACL。
- `allowedRoots` 检查会话的初始与派工目录，包括实际路径和符号链接。**它不是文件系统沙箱**：DSH agent 的文件、命令和网络权限仍由 DSH 原有配置执行。不要将提示词中的限制当作强制权限边界。
- 账本包含任务文本和答案。测试文件、账本、连接文件和凭据不得提交到仓库。
- 取消不回滚已写入文件或外部操作。DSH 权限审批仍由原有 UI/策略处理，插件不自动放宽权限。
- 插件重启会核对账本和会话日志，不自动重发无法确定是否接收的请求。没有完整事务式的文件修改恢复。
- 不提供后台唤醒当前 Codex 聊天的保证；主控运行时通过 `wait_task` 等待结果。

## 验证

```powershell
npm test
npm run check
```

自动化测试覆盖：请求去重、并发准入、上下文继续、取消、失败归类、重启对账、坏账本拒绝、目录和链接限制、认证与跨域拒绝、锁与凭据轮换、真实 stdio MCP 握手，以及等待子任务和父会话总结。

2026-10-17 在 Windows / DSH Desktop 0.2.1-rc.2 的实机验证：

- 插件在正在运行的桌面 Host 中自动加载。
- 创建工作区和专用执行会话，并在桌面观察到工作区。
- 提交指定测试码任务，收到真实 agent 回答。
- 在同一会话继续任务，要求以此前测试码写入测试文件；独立回读文件确认内容正确。
- 修改适配器后再次完成真实会话往返。

实机模型调用依赖你的 DSH 模型配置并使用相应账户额度；常规自动化测试使用替身，不调用模型。完整的取消和 Host 进程重启场景目前由自动化测试覆盖，不宣称已完成所有桌面异常场景的实机验证。

## 卸载与恢复

```powershell
node scripts/configure.mjs --uninstall --codex-config "$env:USERPROFILE\.codex\config.toml"
```

此命令只移除标记配置段；任务账本、测试会话和备份保留。重载/关闭插件会取消其仍在执行的任务。需要精确恢复时，可使用配置脚本输出的备份文件；恢复前检查之后是否又有其他配置变更。

## 实现依据

- [DSH Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.md)
- [DSH Agent API](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/README.md)
- [DSH headless settlement](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/src/index.ts)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)

本项目独立开发，未复制第三方桥接项目源码，与 DeepSeek 和 OpenAI 无隶属关系。
