# LangGraph.js 本地源码基座

ObsidianLink 是 Node.js + TypeScript 项目，所以应用层智能体基座使用 LangGraph.js，而不是 Python 版 LangGraph。

- 本地源码目录：`vendor/langgraphjs`
- 上游仓库：https://github.com/langchain-ai/langgraphjs
- 当前记录的 upstream HEAD：`bd72a897e15d0a29a06b8b8b4c589851b6c7b4a6`
- 项目 import alias：`#langgraph` -> `./vendor/langgraphjs/libs/langgraph-core/dist/index.js`

约束：

- 不直接魔改 LangGraph core。
- ObsidianLink 的二开逻辑放在 `src/agent/`。
- 后续需要升级时，先刷新 `vendor/langgraphjs`，再跑 `npm test` 和 `npm run build`。
