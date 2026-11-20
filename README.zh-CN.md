# AgentTrace

[English](README.md) | 简体中文

AgentTrace 是一个本地查看器，用于回放 Codex rollout JSONL 中的对话和工具调用、查看原始记录，以及对照会话指标和关联的 Codex Trace 数据。手动上传的文件由浏览器解析，不会发送到本地服务。

## 快速开始

使用 Node.js 18 或更新版本，运行：

```sh
npm ci
npm start
```

打开 [http://127.0.0.1:8789](http://127.0.0.1:8789)。服务在内存中编译并提供 Vue 页面，不需要单独运行构建命令，也不需要 `dist/` 目录。如需更改端口，运行 `npm start -- --port 8790`。

1. 点击 **Upload session files**，或将 `.jsonl` 文件拖到页面。
2. 在左侧选择会话。搜索框按文件名或模型筛选会话。
3. 通过 **Conversation**、**Events**、**Tools**、**Tokens** 和 **Trace** 查看会话。右侧 **Overview**、**Metrics** 和 **Details** 显示全会话信息。

## 扫描本地会话和 Trace 目录

打开 **Settings**，填写 Codex 会话目录、额外会话目录和 Trace 目录。保存后刷新会话列表，也可以开启每 10 秒自动刷新。AgentTrace 会在会话目录中递归扫描 `rollout-*.jsonl`。列表先加载元数据，选中会话后才读取完整日志和匹配的 Trace bundle。

服务仅监听本机回环地址，设置保存在 `.agenttrace/settings.json`。尚未保存过设置时，可以用下面的命令指定初始 Trace 目录：

```sh
CODEX_ROLLOUT_TRACE_ROOT="/path/to/codex-traces" npm start
```

Trace 目录可以是单个 bundle，也可以是包含多个 bundle 的父目录。一个 bundle 包含 `manifest.json`、`trace.jsonl` 和被引用的 payload 文件。AgentTrace 仅读取 bundle 引用的文件。Trace 首条非空记录声明的会话身份必须匹配 rollout 的 `session_meta`，并与 manifest 一致。缺失、冲突或无法唯一匹配的情况会列在目录诊断中。匹配不依赖文件名或时间戳。

在 **Trace** 中查看模型请求和响应、响应 Token 用量、工具执行阶段、线程和诊断。打开 **Request payload** 可查看请求快照。Trace 响应用量与 rollout 总量分开显示。

## 回放和检查会话

- **Conversation** 分开显示 `response_item` 中的模型消息和 `event_msg` 中的客户端消息。默认优先显示模型消息，没有模型消息时显示客户端消息。切换来源不会改变会话消息数。**Events** 单独列出运行事件。
- 会话默认停在时间线末尾。按空格或 **K** 播放或暂停，用左右方向键在事件边界间跳转。也可以拖动进度条或调整速度。相同时间戳的事件会同时显示。
- 工具调用开始时显示输入，回放到对应结果时才显示输出。向后定位会隐藏尚未到达的结果。全会话统计不会随回放位置变化。
- 打开 **Details → Browse raw records**，可搜索和筛选完整 JSONL，包括无法解析的行。查看器每页显示 50 条记录。展开内嵌预览后，可切换语言、格式化视图和原文、调整换行，或复制完整内容。日志只按文本展示，不执行其中的命令或脚本。

## 导出离线报告

选择会话后点击 **Export**。下载的 HTML 包含查看器、所选会话的原始 JSONL 和关联的 Trace bundle。可以直接用浏览器打开，不需要本地服务或网络。导出不会修改原始日志，也不会包含其他会话。

## 指标口径

| 指标 | 计算方式 |
| --- | --- |
| 记录跨度 | 首末有效日志时间戳之间的时间。 |
| 回合耗时 | 优先使用日志中的 `duration_ms`，否则取回合开始与结束的时间差。 |
| 消息数 | 用户和助手的消息，不含推理和工具记录。优先统计模型消息，没有时统计客户端消息。 |
| 工具耗时 | 按调用身份配对后计算调用至结果之间的时间。运行阶段耗时和工具报告耗时分开显示。重叠调用不能相加当作实际经过时间。 |
| Token | 按 `total_token_usage` 的增量统计，不重复累计相同快照。缓存输入和推理输出分别是输入和输出的子集。缺失总量时不估算。 |

消息时间戳是记录时间，不代表模型生成耗时。如果缺少回放所需的时间戳，查看器会标明时间线使用演示时间，不把演示时间计入实测耗时。

## 开发与验证

| 目录 | 内容 |
| --- | --- |
| [`src/client/`](src/client/) | Vue 组件、浏览器状态、HTML 模板和样式。 |
| [`src/core/`](src/core/) | 共享的 rollout 和 Trace 解析器、回放逻辑与文档格式化。离线页面内嵌这些模块，Node 也可以直接加载。 |
| [`src/server/`](src/server/) | 本地 HTTP API、会话库、Trace 文件读取和内存页面组装。 |
| [`tests/`](tests/) 和 [`checks/`](checks/) | Node 测试和 Playwright 浏览器检查。 |

`npm start` 运行 `src/server/start.mjs`。根目录存放项目配置和文档。`package-lock.json` 应纳入 Git。[`.gitignore`](.gitignore) 排除安装的依赖、本机设置、工作文件、环境配置、测试产物、`rollout-*.jsonl` 日志和默认命名的 `*-replay.html` 导出报告。含私有数据的自定义命名日志和报告也不要提交。

```sh
npm test
npm run verify:framework
```

Node 测试覆盖解析、回放、Trace 关联和本地 API。框架检查确认生成的页面无需外部脚本或样式表，且嵌入日志仍作为数据处理。准备好可通过 Node 加载的 Playwright 和 Chromium 后，运行 `npm run test:browser`，在真实浏览器中验证本地服务和导出报告。

Codex 日志格式可参考 [App Server 文档](https://developers.openai.com/codex/app-server/)和 [rollout 持久化策略](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/policy.rs)。
