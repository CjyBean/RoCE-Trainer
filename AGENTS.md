# RoCE Trainer 开发说明

- 本地 Node 隔离在 `.tools/node/bin`；所有 npm/npx 命令先执行 `export PATH="$PWD/.tools/node/bin:$PATH"`。
- 修改后必须运行 `npm test` 和 `npm run build`。
- `src/sim/types.ts` 是 UI、Worker、CLI 与仿真内核的共享契约，修改字段时需同步所有使用方。
- 仿真是教学模型：优先保证 ECN/CNP/DCQCN、PFC、DWRR、队列和 Goodput 的因果可解释性，不宣称硬件级精确。
- UI 为中文，React + TypeScript；仿真在 Web Worker，不能阻塞界面。
- CLI 只承诺 README 中列出的 CE 风格教学子集，新增命令需同步 README 和 parser 测试。
- 三个场景定义集中在 `src/data/labs.ts`；每个场景是「problem / fixed」两个变体，须各自设置完整前置状态，避免受上一个变体残留配置影响。
