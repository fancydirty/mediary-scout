<!-- Hacker News 提交草稿 · ⚠️不是 Show HN。受众用不了中国网盘,所以投 dev.to 工程故事文链接(story submission),
     标题=文章标题,作者进评论区补首楼背景(HN 惯例)。时机:美东工作日 08:00-10:00 ET 发。
     Show HN 产品帖(show-hn.md)留作备选,别同时发。 -->

# 提交方式
- **Title:** I gave an LLM agent write access to my cloud drive. Three bugs taught me how to constrain it.
- **URL:** https://dev.to/fancy39_9841cbc02f99f729c/i-gave-an-llm-agent-write-access-to-my-cloud-drive-three-bugs-taught-me-how-to-constrain-it-42nd

（不填 text，这是 link submission；背景放到下面的首楼评论。）

# 首楼评论（提交后立刻自己贴，HN 惯例）

Author here. This is a writeup, not a Show HN, because the drives it speaks today are Chinese (115, Quark, GuangYaPan) and most of you can't use them out of the box. The part I think travels is the constraint pattern, so that's what the post is about.

The short version of the three lessons:

1. If the model emits a number (how many searches, how many candidates), put a deterministic ceiling on it. Rewording the prompt to ask for restraint did nothing. A greedy set-cover function and a hard search cap fixed it. The gate has to sit between the model and the irreversible action, not in the prompt.

2. Let the model judge the messy real-world question (what actually landed in the drive), but make it judge against the real files, not its own earlier narration. Keep the bookkeeping (what aired minus what I have) separate and dumb. The bugs came from those two bleeding into each other.

3. Test the artifact the user sees, not the proxy that's convenient to read. I "verified" a progress bar three times by reading `style.width` off a collapsed inline element. `getBoundingClientRect()` said zero the whole time. A confident-sounding number lied to me for three PRs.

Repo is open source and self-hosted (github.com/fancydirty/mediary-scout), there's a read-only demo, and desktop builds for Mac/Windows. If the pattern is useful and you'd want your own drive backend supported, the drive layer is a contained plugin and I'm happy to help scope a PR. Happy to answer anything about the architecture.
