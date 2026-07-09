<!-- r/LocalLLaMA 草稿 · 自帖(text post)+ 链 dev.to 文 · 切题钩子=BYO OpenAI 兼容端点,本地模型(Ollama/llama.cpp/vLLM)能驱动整个 agent。
     调性:工程实操、无营销、先给教训。去 AI 味(无 em-dash)。⚠️该 sub 对硬广敏感,重心放「我学到啥」不是「看我项目」。 -->

# Title
What three bugs taught me about constraining an agent that has real, irreversible tool powers

# Body

I built a self-hosted media library where a local (or any OpenAI-compatible) model drives an agent that transfers files into a cloud drive and reads them back to verify. The whole loop runs against whatever endpoint you point it at, so a local model does the planning and selection. That part is why I'm posting here: giving a local model real side effects surfaced problems that no amount of prompt tuning fixed.

Three things I got wrong, and what actually worked:

1. **The model will emit a number and act on it.** Mine decided a 12-episode season needed 11 overlapping packs, after 16 searches, and tripped the drive's rate limit before dedup could run. I spent an afternoon asking the prompt for restraint. It did nothing. The fix was a deterministic set-cover function plus a hard cap on distinct searches, sitting between the model and the transfer. If your agent produces a count, cap it in code, not in English.

2. **Let the model judge the messy question, against the real world, not its own narration.** Coverage (which episodes exist) has to come from reading the actual files, not a filename parser or a re-read the model can fake. I kept trying to compute it mechanically and kept corrupting the state. Separate the probabilistic judgment from the dumb bookkeeping.

3. **Verify the artifact, not the proxy.** I "checked" a progress bar three times by reading `style.width` and seeing a sane percentage. It was a collapsed inline element painting zero pixels the whole time. `getBoundingClientRect()` would have told me on round one.

Full writeup with the code-level details: https://dev.to/fancy39_9841cbc02f99f729c/i-gave-an-llm-agent-write-access-to-my-cloud-drive-three-bugs-taught-me-how-to-constrain-it-42nd

The agent has narrow, audited powers inside a sandbox, and a deterministic workflow owns every side effect. State lives in Postgres so runs resume across restarts by rebuilding from the real drive plus DB state, not cached chat history. Repo is open source (github.com/fancydirty/mediary-scout). The drive backends it speaks today are Chinese, which most of you won't use, but the constraint pattern is model-agnostic and endpoint-agnostic. Curious how others here gate the irreversible actions their local agents can take.
