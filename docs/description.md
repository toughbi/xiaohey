# xiaohey 应用描述

## 一句话

一个留在你 Windows 电脑上的编码代理：读代码、改文件、跑命令，改动可回退。

## 短描述（约 50 字）

xiaohey 是 Windows 桌面上的本地编码代理。它在你选中的文件夹里读代码、改文件、运行命令，每一步都可审批、可检查、可回退。

## 完整描述（约 150 字）

xiaohey 是一个运行在本机的 Windows 桌面编码代理。打开一个工作区，它就能读代码、定位问题、修改文件、运行测试，并把结果交回来。

与网页版助手不同，xiaohey 的工作发生在你的磁盘上：会话、上下文、工具执行记录、检查点都存在本机。你可以按需选择完全访问、自动批准或逐条审批；每次写入都有快照，随时能预览改动、整步回退或撤销回退。它支持任意 OpenAI 兼容端点，DeepSeek、OpenAI、本地 llama.cpp 都能接。

界面是三栏布局：左边工作区与会话，中间对话，右边文件与改动、记忆、检查点。输入框是磨砂玻璃质感的悬浮底栏，回合进行中可以继续输入，消息先排队，也可以直接插入当前对话。

## 功能要点

- **本机运行**：数据落在 `%APPDATA%\xiaohey`，不上传会话；模型只收到你发的内容和引用的文件。
- **真实工具**：读文件、写文件、列目录、执行命令、检索，写操作带契约与快照。
- **审批与回退**：完全访问 / 自动批准 / 每次询问；每个检查点可预览、回退、撤销。
- **问题澄清**：需要确认范围、方案或偏好时，输入框上方会磁吸一张提问卡（2–4 个选项 + 自定义回答），答完同一轮继续，不另开会话。
- **任务清单**：模型拆出多步计划时，输入框上方磁吸一张实时任务卡（已完成 / 进行中 / 待处理），可折叠，回合结束自动收起。
- **长会话可用**：上下文超预算时折叠成摘要，记忆与计划外置到磁盘。
- **模型自由**：DeepSeek、OpenAI、任意 OpenAI 兼容端点，模型配置集中在设置里。
- **桌面交互**：三栏工作区、文档预览与 diff、检查点、审批记录；无边框窗口，深浅两套“纸与墨”主题。
- **回合中继续输入**：消息磁吸排队，可编辑、删除，或点箭头立即插入当前对话。
- **对话导航**：右侧细条纹按轮定位，悬停看这一轮的问题与回答摘要，点击跳转。

## English

**One line:** A coding agent that lives on your Windows machine: reads code, edits files, runs commands, and can undo every change.

**Short:** xiaohey is a desktop coding agent for Windows. Point it at a folder and it reads the code, edits files, runs commands, and reports back — with approvals, checkpoints and undo at every step.

**Full:** xiaohey runs on your own machine. Open a workspace and it can read the code, track down a problem, change files and run the tests, reporting what it did. Sessions, context, tool logs and checkpoints stay local. Choose full access, auto-approval or per-command approval; every write is captured in a snapshot you can preview, revert, or undo. It works with any OpenAI-compatible endpoint, including DeepSeek, OpenAI and local llama.cpp. The three-column window keeps workspaces and sessions on the left, the conversation in the middle, and files, diffs, memory and checkpoints on the right. The composer is a floating frosted dock: keep typing while a turn runs, queue the message, or send it straight into the current conversation.

## 不建议使用的说法

- “赋能”“无缝”“革命性”“重新定义”“AI 原生”这类词。
- “10 倍效率”“百万开发者选择”这类无法核实的数字。
- 把“本地”说成“绝对隐私”：模型仍会收到你发送的内容与引用的文件。
