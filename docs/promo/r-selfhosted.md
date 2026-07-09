<!-- r/selfhosted 草稿 · flair 建议:Release / Software · 调性:友好、带截图/GIF、强调 Docker + 自部署 + 开源 · 去 AI 味(去 em-dash) -->

# Title
[Release] Mediary Scout: self-hosted, agent-driven media library for your cloud drives (115 / Quark / GuangYaPan, brand-extensible)

# Body

I made a self-hosted app where you ask for a movie, show, or anime, and an LLM agent scouts resources across indexers, transfers the best match into your own cloud drive, reads the drive back to verify what actually landed, and keeps tracking which episodes are still missing.

- **Live demo (read-only, nothing to install):** https://demo.mediaryscout.app
- **Desktop builds (Mac / Windows, double-click):** https://mediaryscout.app
- **Source:** https://github.com/fancydirty/mediary-scout

The demo is a front-end replay of the real flow. It doesn't touch a real drive or write anything, so you can watch the agent go through search, transfer, verify, and shelve before deciding whether to host it.

Up front, the big caveat: the drives it supports today are 115, Quark, and GuangYaPan, which are Chinese cloud services. So this is most useful if you already use one of those, and I'm not expecting most of you to. Calling it out so nobody deploys expecting Google Drive support today. There's an open invitation on that at the end.

Why another media tool: most "media automation" either searches well but doesn't know what you're actually missing, or moves files but never verifies what landed. This treats acquisition as a state problem, driven by an agent that acts from evidence:

- **Agent-driven selection.** Reads real search results (PanSou, optionally Prowlarr / *arr indexers), picks by quality preference, subtitle requirements, and de-duplication, then re-reads the drive to confirm the transfer.
- **Cloud-native.** It transfers shares and magnets into your drive (the netdisk instant-save path), never downloads to local disk. No big local storage needed.
- **Tracking and scheduled gap-fill.** Season-level state machine; a scheduled sweep only returns for shows that still have missing episodes.
- **Multi-drive and multi-user.** One account can hold many drives, each a first-class workspace. One instance can be shared by several people, each binding their own drives and seeing their own library. Forgot-password is handled (owner reset plus a CLI escape hatch), no SMTP required.
- **Observable.** Live queue plus a ticker of every agent action. Failures report honestly ("transfer failed: <reason>") instead of "not found".

**Two ways to run it.** Prefer not to touch a terminal? Download the desktop build and double-click; data stays on your machine. Want it running 24/7 for scheduled gap-fill or a whole household? `docker compose up -d` brings up web, Postgres, and a bundled PanSou. Everything else is in Settings (drive login, LLM endpoint, any OpenAI-compatible with your own key, optional Prowlarr). Public access via Cloudflare Tunnel, no public IP needed. There's even a prompt in the README you can hand to an AI coding agent (Claude Code, Codex, opencode) to walk your deployment for you.

Note on resources: search quality depends on which Telegram channels your PanSou instance is wired to. The desktop build doesn't bundle PanSou; the docker stack does. The repo ships a good channel config.

Positioning: open-source, self-hosted only. Not offered, and never will be, as a hosted service. You run your own instance and bring your own drive, LLM, and metadata credentials. It performs the same file operations you could do by hand in your own cloud drive.

Back to the drive caveat, now that you've seen how it works. Most of you can't use the Chinese drives, and that's fine. But if the approach is useful and you'd want your own drive supported (Google Drive, Dropbox, a regional one), the drive layer is a self-contained plugin: a client plus a transfer executor behind a brand registry. I'd genuinely welcome a PR, and I'm happy to help scope and review one. No pressure. The tracking and verification design is the part that carries over regardless of which drive you plug in.

Stack: TypeScript, Next.js, Postgres, Vercel AI SDK, Electron, Docker Compose. Solo project. Happy to hear feedback, criticism, and feature or drive-brand requests.

<!-- 发帖时把 docs/images/demo.gif 直接拖进 reddit 上传(动图开场最抓人);library.png / activity.png 可作补充截图。 -->
