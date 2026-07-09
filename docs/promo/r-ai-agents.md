<!-- r/AI_Agents 草稿 · 自帖(text post)+ 链 dev.to 文 · 角度=agent 设计模式(probabilistic core + deterministic plumbing)。
     调性:架构讨论、给可迁移的模式、邀讨论。去 AI 味(无 em-dash)。 -->

# Title
A pattern for agents with real side effects: probabilistic core, deterministic plumbing

# Body

I've been running an agent in production that does irreversible things (transfers files into a cloud drive, moves and organizes them, marks state). The pattern that made it trustworthy is the same one every fix converged on, so I wrote it up.

The shape: the model gets the smallest possible blast radius. It proposes. A deterministic workflow decides whether the proposal is allowed, performs the side effect, and reads the world back. Every irreversible action and every check lives in code the model never sees and cannot argue with.

Three concrete lessons, each from a bug:

- **Gate the numbers the model emits.** It wanted 11 overlapping downloads after 16 searches and blew a rate limit. Prompting for restraint did nothing. A set-cover function plus a hard search cap, placed between the model and the action, fixed it. Do not trust the model to limit itself and do not trust a later step to clean up.

- **Judge against the real world, not the model's account of it.** Let the model decide the messy question by inspecting real files, then declare a result. Keep the bookkeeping (expected minus actual) separate and deterministic. The failures came from those two responsibilities bleeding together.

- **Verify the artifact a user actually sees.** I trusted a convenient proxy value for three rounds while the real output was empty.

Writeup with the code details: https://dev.to/fancy39_9841cbc02f99f729c/i-gave-an-llm-agent-write-access-to-my-cloud-drive-three-bugs-taught-me-how-to-constrain-it-42nd

The project is open source and self-hosted (github.com/fancydirty/mediary-scout). It runs against any OpenAI-compatible endpoint, and state lives in Postgres so runs resume across worker restarts by rebuilding from the real world plus DB state rather than cached conversation history. I'd be interested in how others here draw the line between what the model owns and what deterministic code owns, especially for actions you can't undo.
