<!-- Show HN 草稿 · 提交时:Title = 下面标题;URL = 仓库或 demo(见末尾建议);Text = 正文。
     HN 调性:极低吹度、技术诚实、先认局限。角度=工程故事(给有真实副作用权力的 agent 上镣铐)。
     去 AI 味(stop-slop):无 em-dash、句长变化、别编数据。 -->

# Title
Show HN: I gave an LLM agent real side-effect powers over my cloud drive, then spent months constraining it

# URL
https://github.com/fancydirty/mediary-scout

# Text (submission body / or first comment)

Mediary Scout is an open-source, self-hosted media library. You ask for a movie, show, or anime; an LLM agent scouts resources across indexers, transfers the best match into your own cloud drive, reads the drive back to verify what actually landed, and keeps tracking which episodes are still missing.

Read-only live demo (nothing to install, doesn't touch a real drive): https://demo.mediaryscout.app. Desktop builds for Mac and Windows are on https://mediaryscout.app if you want to double-click and run it.

The honest limitation up front: the drives it supports today are 115, Quark, and GuangYaPan, which are Chinese cloud services. So out of the box it's most useful if you already use one of those, and I'm not expecting most of you to. Flagging it so nobody deploys expecting Google Drive support today. More on that at the end.

The reason I think this is worth a Show HN isn't the media part. It's what happens when you hand an LLM agent a tool that has real, irreversible side effects on a remote system, and then try to make it trustworthy. A few things that took real work:

- The agent has narrow, audited powers inside a sandbox. A deterministic workflow owns every side effect; the agent only searches, transfers, and reads back inside that box. State lives entirely in Postgres, so runs resume across worker restarts. The agent rebuilds from the real drive plus DB state, not from cached chat history.
- Early on it would search 16 times in a loop and blow the token budget on one title. The fix wasn't a better prompt. It was a deterministic gate that cuts the loop off, plus vitality hints so it reports "no coverage" instead of grinding.
- The rule that acquisition is a state problem, not a fetch, is enforced in code, not vibes. The agent judges what actually landed by reading the drive back; it never parses filenames or trusts its own earlier claims.
- The whole run is observable, a live ticker of every tool call, and failures report honestly ("transfer failed: <reason>") rather than collapsing into "not found".

Positioning, so it's clear: open-source, self-hosted only. Not a hosted service, and never will be. You run your own instance and bring your own drive, LLM, and metadata credentials. It performs the same file operations you could do by hand in your own cloud drive.

And the drive thing, now that you've seen the shape of it. Most of you can't use the Chinese drives, and that's fine. But if the pattern is useful and you'd want your own drive supported (Google Drive, Dropbox, a regional one), the drive layer is a self-contained plugin: a client plus a transfer executor behind a brand registry. I'd genuinely welcome a PR, and I'm happy to help scope and review one. No pressure. The plumbing above is the part I think travels regardless of which drive you plug in.

Stack: TypeScript, Next.js (App Router / PPR), Postgres, Vercel AI SDK, Electron for the desktop shell, Docker Compose for self-host. Solo project. Feedback, criticism, and PRs all welcome.

---
<!-- URL 选择建议:
  - 想突出「开源/工程」(HN 更常见)→ URL 填 repo(上面默认),正文已把 demo + 桌面版放第二段。
  - 想突出「可玩」→ URL 填 demo https://demo.mediaryscout.app,正文里给 repo。
  repo 当 URL 更稳。⚠️HN 受众用不了中国网盘,所以标题/正文主打「给 agent 上镣铐」的工程故事,网盘只当领域背景。 -->
