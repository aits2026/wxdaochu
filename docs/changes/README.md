# AI Commit Journal

这里会自动存放每次提交对应的变更记录文档（Markdown）。

目标：

- 记录这次提交改了什么（基于 staged diff）
- 记录为什么要做（基于 Codex 对话上下文自动提取/归纳）
- 保留一些过程中的思考痕迹，便于后续回看
- 自动回填真实 Git 提交时间（`post-commit` hook）
- 对话上下文按“最近一次成功 `git push` 之后到本次生成时刻”截断，避免同一会话多次推送相互污染

推荐使用方式（可拿到更完整的 commit message）：

```bash
python3 scripts/ai_commit_journal.py commit -- -m "feat: xxx"
```

或使用 `package.json` 脚本：

```bash
npm run ai:commit -- -m "feat: xxx"
```

如已安装 hook（`python3 scripts/ai_commit_journal.py install-hooks`），直接使用原生 `git commit` 也会自动生成文档（但可能拿不到最终 commit message）。
