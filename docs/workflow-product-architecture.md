# clawd-media-track Workflow Product Architecture

Status: product architecture note, not an implementation plan.

This document captures the current product direction for turning
`clawd-media-track` from an agent skill into a workflow product.

The core shift is:

> The user should not supervise an agent.
> The user should express intent, connect their 115 account, and receive results.

The agent should become mostly invisible. It should appear inside the system only as
a narrow semantic judgment component, not as the main product surface.

## Product Thesis

The current skill is a disciplined way to make a general agent behave safely:

- read the right references
- identify Type 1 / Type 2 / Type 3
- show evidence
- stop before side effects
- bind transfer plans
- verify after actions

That is the right shape for a prompt-driven skill.

It is not the final product shape.

A product should move most of those rules out of prompt discipline and into
software:

- workflow state
- typed inputs and outputs
- persisted snapshots
- policy checks
- retries
- audit logs
- notification delivery

The user-facing product should feel closer to a media acquisition and tracking
service:

1. Search for a movie or show.
2. Click "get" or "track".
3. Let the system work in the background.
4. Receive a notification when episodes are available.
5. Watch the media in 115.

The user may know that a workflow plus AI judgment is used behind the scenes, but
they should not need to spend attention supervising it.

## Correct User Experience Model

The earlier "user sees evidence and confirms" framing is too developer-oriented.
It describes an agent safety workflow, not the intended consumer experience.

For this product, evidence and auditability still matter, but they are primarily
system properties:

- for debugging
- for rollback
- for explaining failures
- for improving prompts and heuristics
- for trust when the user opens a details page

They are not the normal interaction path.

Normal user path:

```text
User clicks get/track
-> system runs workflow
-> system transfers, verifies, organizes, and tracks
-> user receives notification
-> user watches the show
```

The visible UI should therefore be a control surface and status surface, not an
agent trace monitor.

Possible user-facing states:

- "Queued"
- "Searching"
- "Transferring"
- "Verifying"
- "Tracking future episodes"
- "Ready to watch"
- "No covering resource found yet"
- "Needs account reconnect"

Possible notification:

```text
《七王国的骑士》S01E06 已获取。
已整理到 115 / clawd-media / TV Shows / ...
仍缺：无
下一次检查：明天 08:00
```

## Frontend Read Path vs Workflow Commit Path

The frontend should not become a media portal that scrapes everything the user
browses.

The product should assume that the user roughly knows what they want to watch.
The UI helps them confirm the target and then asks the backend to do useful work.

This means there are two separate paths.

### Read Path

The read path powers browsing inside the product:

- existing tracked shows
- recently acquired episodes
- current workflow status
- missing episode counts
- next scheduled check
- notifications
- cached search candidates

This data should come from the product database first.

If a resource is already tracked or acquired, its metadata should already be
stored locally. The UI should not call TMDB live every time it renders the page.

For new searches, the server can use TMDB as a confirmation bridge:

```text
user searches title
-> server checks local MediaTitle table
-> server checks MediaSearchCache
-> server calls TMDB only on cache miss
-> UI shows lightweight candidates
```

The read path may show title, year, poster, type, and short description.
It should not call PanSou, invoke an agent, or touch 115.

### Commit Path

The commit path begins only when the user explicitly clicks "get" or "track".

At that moment the product can create durable state:

- `MediaTitle`
- `TrackedSeason`
- `WorkflowRun`
- `ResourceSnapshot`
- `AgentDecision`
- `EpisodeState`
- `Notification`

Only the commit path should start expensive or side-effectful work:

- full TMDB sync for the selected title
- PanSou search
- agent judgment nodes
- 115 transfer
- flatten / dedup
- notification delivery

This keeps the UI from accidentally becoming a Douban/TMDB clone.
TMDB is a metadata confirmation tool, not the live dependency behind every page.

In the TypeScript kernel, `prepareTrackingTarget()` is the first server-side
commit-path step. It takes a selected TMDB tv id, season number, quality
preference, and storage directory id, then produces the typed `MediaTitle`,
`TrackedSeason`, and search keyword consumed by `requestTrackingInitialization`.
It uses TMDB details and season metadata, including `last_episode_to_air` when
it belongs to the selected season, but it remains a prepare step rather than a
browser render dependency.

## Product Surface Boundary

The first product surface should be small and practical:

- search for a known movie/show
- connect 115
- click get/track
- view tracked shows
- view acquired episodes
- view missing episodes and failures
- receive notifications

It should not start as:

- a general media discovery site
- an infinite poster wall
- a recommendation engine
- a public metadata browser
- a full playback app

Those products already exist.

The product's unique value is upstream of playback:

```text
I want to watch this
-> the system finds it
-> the system lands it in my 115
-> my player/media library can now see it
```

This is why the UI should feel more like a media acquisition and tracking
console than a streaming homepage.

## Resource Source Strategy

Resource source is one of the hardest product problems.

The product should not pretend there is one perfect source that solves all
cases. It should treat resource discovery as a pluggable provider layer.

Important distinction:

```text
metadata source      -> answers "what is this movie/show?"
resource index source -> answers "where might a candidate resource exist?"
acquisition executor -> answers "how does it land in storage?"
```

TMDB is a metadata source.
PanSou is a resource index source.
Magnet links are not a source by themselves; they are a resource locator and
transfer format that must still come from an index.
115 is an acquisition/storage execution layer.

The current skill uses PanSou because it has strong practical coverage,
especially for new Chinese-language resources maintained through Telegram-style
resource channels. That is useful for self-use and early workflow validation.

For a product, PanSou should not become the whole product's identity or promise.
It should be one `ResourceProvider`.

Possible provider interface:

```ts
interface ResourceProvider {
  name: string;
  search(input: {
    mediaTitleId: string;
    title: string;
    aliases: string[];
    season?: number;
    missingEpisodes?: string[];
  }): Promise<ResourceCandidateSnapshot>;
}
```

The common flow should be:

```text
ResourceProvider
-> ResourceSnapshot
-> agent judgment nodes
-> validated AgentDecision
-> storage executor
-> verification
```

Recommended provider stages:

1. `PansouProvider`
   - Keep using it as the first practical engine.
   - Treat it as private/internal and replaceable.
   - Do not market the product as "full web resource search".

2. `ManualLinkProvider`
   - Let users provide links they already have permission or intent to use.
   - The product still adds value by organizing, verifying, tracking, and
     notifying.
   - This validates the workflow even when automated search is incomplete.

3. `UserConfiguredProvider`
   - Advanced users can configure their own lawful/authorized indexers later.
   - This keeps PT/Sonarr/Radarr/Prowlarr-style complexity optional instead of
     forcing it into the default product.

4. Future official or compliant providers
   - Explore only after the product proves the workflow value.

The user interface should not expose raw provider complexity by default.
Normal users should see:

```text
Searching available sources
Found high-confidence candidate
Obtained S01E06
Still missing S01E07; will retry later
```

The audit layer can record:

```text
provider=pansou
candidate_count=12
selected_candidate_ids=["snapshot_1_candidate_4"]
confidence=high
verification=passed
```

This keeps resource discovery replaceable, auditable, and less coupled to any
single fragile source.

## Deterministic Workflow Rails

The program should own anything that can be made reliable without model judgment.

Program-owned responsibilities:

- TMDB lookup and metadata persistence
- PanSou calls, pagination, caching, and search result snapshots
- 115 file listing, transfer execution, directory creation, flattening, and delete
- snapshot-scoped candidate binding and decision integrity
- Type 1 / Type 2 / Type 3 state transitions
- retry budgets and recoverable failure states
- physical verification after side effects
- database updates for tracked shows and episodes
- audit events
- notifications

The workflow should be explicit and persistent.

The database, not the agent context, should hold the durable truth:

- user account connection
- target media
- desired quality and policy preferences
- workflow run state
- search snapshots
- selected transfer plans
- 115 directory bindings
- episode status
- notification history

This is the main robustness gain over the current skill form.

## Preserve Effects, Not Current Methods

The product should not treat the current Python methods as sacred APIs.

The current `scripts/*.py` modules are valuable because they prove real behavior
against TMDB, PanSou, and 115. They should be treated as a working reference
implementation, not as the product architecture.

What must be preserved is the effect logic:

- create landing directories with stable names
  - movie: `Title (Year)`
  - series/anime: `Title (Year) / Season N`
- never flatten root or category directories
- only flatten final landing directories
- snapshot resource candidates before choosing
- execute only candidates selected from that exact snapshot
- verify physical video files after transfer
- flatten nested transfer output
- deduplicate from a stable file snapshot
- mark episodes obtained only after files physically exist
- record side effects and verification results

What can be replaced:

- Python method names
- module layout
- command-line execution shape
- `.env` bootstrap shape
- prompt-first checklist flow
- current `TransferPlan` object implementation

Future product code may implement the same semantics as TypeScript services or
workflow steps:

```text
createLandingDirectory()
executeTransfer()
verifyMaterializedVideos()
flattenLandingDirectory()
deduplicateVideos()
recordVerifiedOutcome()
```

The important thing is not preserving `pan115.flatten_directory()` as a method.
The important thing is preserving the invariant:

> transferred resources often land nested, so the workflow must flatten only the
> safe final landing directory and verify the resulting video files.

This distinction keeps the product from being trapped by the shape of the
current agent skill.

This is the correction to keep in mind during implementation:

> Do not port the skill line-by-line. Port its proven effects as workflow
> invariants.

The current skill is shaped by the need to make a general agent behave safely.
That means some of its complexity is harness complexity, not product
complexity. In the GUI product, these effects should become acceptance criteria
for deterministic workflow steps. If a new implementation creates the right
directory, transfers only the selected resource, verifies real video files,
flattens only the intended landing directory, and records the verified outcome,
then it has preserved the skill's value even if none of the old helper methods
survive.

## Agent as Stateless Judgment Nodes

The agent should not own the workflow.

Instead, the system should use several stateless specialist judgment nodes.
Each node should behave like a standardized function:

```text
input packet + system instruction -> structured output
```

The node should not need previous conversation history.
It should receive only the context required for the current decision.

Example input:

```json
{
  "target": {
    "title": "七王国的骑士",
    "season": 1,
    "missingEpisodes": ["S01E06"]
  },
  "snapshot": {
    "id": "search_abc123",
    "candidates": [
      {
        "index": 0,
        "title": "七王国的骑士.S01E06.1080p",
        "type": "magnet",
        "source": "pansou"
      }
    ]
  }
}
```

Example output:

```json
{
  "selectedCandidateIds": ["snapshot_1_candidate_1"],
  "episodeMapping": {
    "snapshot_1_candidate_1": ["S01E06"]
  },
  "rejected": [],
  "uncertain": [],
  "confidence": "high"
}
```

The system then validates the output:

- candidate ids must exist in the current snapshot
- selected resources must map to missing episodes
- low-confidence or uncertain cases follow product policy
- side effects use bound snapshot candidate data, not freshly searched data

This does not mean the model node should be weak.

A node is not just a normal API call with a thin prompt wrapped around it.
The Type 2 run below showed that acquisition often depends on real problem
solving: search providers fail in strange ways, titles have aliases, exact
keywords may return errors, and useful resources may hide behind a different
name. The right design is:

```text
strong agent intelligence + narrow workflow authority
```

The agent should be free to reason, recover, try alternate valid keywords,
compare evidence, reject wrong matches, and explain uncertainty inside its
bounded task. What it should not be free to do is create directories, transfer
resources, delete files, or mutate database state directly.

This captures the useful part of the current agent skill while removing long,
fragile, memory-heavy agent execution.

## Specialist Nodes

The likely specialist nodes are:

| Node | Responsibility | Should See |
| --- | --- | --- |
| `KeywordAgent` | Generate search keyword candidates | TMDB metadata, title aliases, season, media type |
| `CandidateMatchAgent` | Decide whether candidate titles refer to the target | target metadata, candidate titles, source/type |
| `EpisodeCoverageAgent` | Map candidate resources to episodes | missing episodes, candidate titles, season info |
| `QualitySelectionAgent` | Choose among valid covering resources | title evidence, size hints, quality preference |
| `DedupAgent` | Decide which duplicate files to keep | verified 115 file list, sizes, episode mapping |
| `FailureExplainAgent` | Convert failure state into user-facing explanation | workflow state, attempts, missing resources |
| `NotificationAgent` | Write notification text | verified outcome, remaining missing episodes |

These nodes can be implemented with any structured-output LLM tool.
They do not require ADK as a dependency.

For the TypeScript product path, the first concrete implementation can use
Vercel AI SDK as an `AgentNodes` adapter. The model provider should be treated
as a replaceable implementation detail behind the typed port. For Xiaomi Mimo or
any other OpenAI-compatible endpoint, configure the provider with a local API
key, base URL, and model id; the workflow should still validate every structured
output before side effects.

The important principle is ADK-like:

- deterministic orchestration
- scoped agent nodes
- explicit state
- structured input/output
- validation around every model boundary

## Type 1, Type 2, and Type 3 in Product Form

### Type 1: One-Time Acquisition

Type 1 is a background acquisition workflow.

The user clicks "get this movie" or "get this completed season".
The system searches, selects, transfers, verifies, organizes, and reports.

If confidence is high, the workflow should not require user approval per step.
If confidence is low, the product can either:

- defer and notify "not found yet"
- retry later
- expose an advanced review screen

The default path should still be unattended.

### Type 2: Tracking Initialization

Type 2 initializes long-term tracking.

The user clicks "track this show" or "get and keep tracking".
The workflow gets currently available episodes, creates the 115 directory shape,
binds the tracked season in the database, marks verified obtained episodes, and
keeps future episodes visible without treating them as ordinary missing gaps.

The user should not see the old step-by-step confirmation flow.
They should see a result:

- "tracking initialized"
- "episodes obtained"
- "still missing"
- "next check time"

### Type 3: Unattended Monitoring

Type 3 is the clearest product signal.

It should run with no human supervision.

The system should:

1. sync tracked shows with TMDB
2. find actionable missing episodes
3. inspect existing 115 files first
4. search only for uncovered gaps
5. select resources through judgment nodes
6. transfer and flatten safely
7. deduplicate safely
8. mark episodes obtained only after physical verification
9. notify the user

This means Type 3 should be treated as a durable background workflow, not as a
chat interaction.

## Episode State Semantics

Ongoing shows have three episode concepts that must not be collapsed into one.

First, there is total episode count.
TMDB usually returns this as `number_of_episodes`.
It defines the season shape and the eventual UI grid length when known.

Second, there is the latest aired episode cursor.
The current skill mostly uses TMDB `last_episode_to_air` for this.
It creates the default range the system expects to obtain:

```text
S01E01 -> S01E<latest aired>
```

This signal is useful but not perfect. TMDB can lag, be wrong, or be updated
after resource providers already have a newer episode.

Third, there are verified obtained episodes.
These come from actual target-directory file verification.
This is the strongest local truth about what the user can watch.

The product data model should therefore distinguish:

- unaired or unknown episodes
- aired but missing episodes
- aired and obtained episodes
- provider/storage-ahead episodes whose files exist before TMDB catches up

The UI can later project these states visually:

```text
unaired / unknown           -> low-density cell
aired + obtained            -> full, confident cell
aired + missing             -> visible gap / retry cell
obtained + provider-ahead   -> full cell with metadata-pending nuance
```

This also explains an important Type 3 rule from the current skill: before
searching for a missing episode, Type 3 should inspect the target directory.
If the file already exists, it should mark the episode obtained and stop for
that episode.

This matters because sometimes resource availability can run ahead of TMDB.
For example:

```text
TMDB latest aired = S01E20
provider materializes S01E21
```

The system should not discard that verified `S01E21` file just because TMDB has
not caught up. It should record it as obtained with metadata pending, then
reconcile it into normal episode state when a later TMDB sync includes that
episode.

## Real Type 1 Run Lessons

A real Type 1 run was executed for:

```text
我的僵尸女儿 / 我和我的僵尸女儿 (2025)
```

The purpose was not media acquisition itself. The purpose was to experience the
current skill's full side-effect path and use that to improve the product design.

Observed flow:

```text
TMDB search
-> PanSou search
-> magnet candidate extraction
-> ResourceSnapshot and validated AgentDecision binding
-> create 115 movie directory
-> add magnet as 115 offline task
-> verify file materialized
-> flatten directory
-> list videos
-> dedup no-op
-> final verification
```

Result:

- TMDB found one movie candidate.
- PanSou returned no 115 links and one magnet candidate.
- The magnet title clearly matched the target movie.
- 115 accepted the offline magnet task.
- A video file materialized under the new movie directory.
- `flatten_directory()` moved one video and removed one nested directory.
- Final verification found one video and no duplicates.

Product lessons:

1. `PansouProvider` can validate the first product loop.
   Even without 115 share links, a magnet candidate can complete the workflow.

   The TypeScript kernel now treats PanSou as a `ResourceProvider` adapter. Its
   job is to call `/api/search`, expand 115 and magnet links into
   `ResourceCandidate` rows, attach episode/quality hints when they are visible
   in titles, and return a content-hashed `ResourceSnapshot`. It does not own
   transfer, 115 execution, or agent judgment. Those remain separate workflow
   steps.

2. Verification must use video-file discovery, not only current-level folder
   listing.
   In the run, `list_files(depth=2)` returned no visible items immediately after
   transfer, while `list_video_files(depth=3)` found the materialized video.

3. Flatten should be a fixed workflow step.
   The transferred file landed inside a nested directory. The product should not
   ask an agent to decide whether cleanup is needed in normal successful cases.

4. TransferPlan cannot be treated as durable state, and raw result indexes are
   not a product architecture.
   The current Python `TransferPlan` object cannot cross process/session
   boundaries. A product must persist its own stable transfer selection:

   ```text
   ResourceSnapshot
   -> selected snapshot-scoped candidate ids
   -> provider payload
   -> executable transfer reconstruction inside the worker
   ```

   The database should store the decision and snapshot. The worker can rebuild
   the provider-specific executable plan at execution time.

   The deeper lesson from the skill is not that the product needs the same
   `TransferPlan` class. It is that resource ordering from PanSou-like
   aggregators is not stable. If a search is repeated, index `0` may describe a
   different resource. The product invariant is therefore:

   ```text
   search -> immutable ResourceSnapshot -> validated AgentDecision
   -> transfer by candidate ids from that same snapshot
   ```

   A fresh search creates a fresh snapshot and fresh candidate ids. Old indices,
   old selected ids, and stale mapping fields must not be reused across that
   boundary.

5. Idempotency matters immediately.
   The real run created a 115 directory. A duplicate user request could create
   duplicate directories or duplicate transfer attempts unless the product
   prevents it through workflow state and database constraints.

6. The UI should show verified outcome, not internal agent trace.
   A normal user only needs to know that the movie was obtained, where it landed,
   and whether anything failed.

7. The audit log should still preserve the chain.
   For debugging and trust, the system should store candidate count, selected
   candidate, transfer result, flatten result, final file list, and duplicate
   decision.

This real run supports the product direction:

> The workflow should own 115 execution and verification. The agent should own
> only the semantic candidate judgment.

## Real Type 2 Run Lessons

A real Type 2 run was executed for:

```text
翘楚 / Ashes to Crown (2026)
TMDB tv/289271
```

This was a better stress test than the Type 1 movie run because it involved an
ongoing show, episode coverage, search recovery, 115 side effects, and database
tracking state.

Observed target facts from TMDB:

- `tmdb_id=289271`
- season 1 has 24 total episodes
- the show is still in production
- TMDB reported `last_episode_to_air=S01E14`
- TMDB reported `next_episode_to_air=S01E15` on 2026-06-11

Observed provider behavior:

- Searching PanSou for `翘楚` returned a provider error instead of useful
  resources.
- Searching variants such as `翹楚`, `Ashes to Crown`, and `翘楚 第一季`
  returned no useful resources.
- Searching `楚后` returned resources, but the evidence was wrong-target noise:
  unrelated titles such as other dramas, movies, and anime.
- Searching `电视剧翘楚` returned precise 115 episode links for some episodes.
- Searching `翘楚 4K` returned the best usable coverage: 4K single-episode
  resources for `S01E01-S01E13`, plus a precise `S01E14` resource.

The final selected resource plan obtained `S01E01-S01E14`, which matched the
currently aired TMDB state at that moment.

Observed side-effect flow:

```text
TMDB search and detail lookup
-> PanSou plain keyword failure
-> alias and keyword recovery
-> reject wrong-target search results
-> extract complete 115 evidence for valid keyword
-> choose episode-covering snapshot candidate ids
-> persist ResourceSnapshot and validated AgentDecision in the execution session
-> create 115 show directory
-> create Season 1 directory
-> execute snapshot-scoped candidate transfer requests
-> verify 14 materialized videos
-> flatten Season 1 directory
-> dedup no-op
-> add show to tracking database
-> update save_dir_id
-> sync TMDB episodes
-> mark only verified episodes as obtained
-> verify current missing list is empty
```

Result:

- 14 selected 115 resources transferred successfully.
- 14 video files materialized in the Season 1 directory.
- Flattening was a no-op because the provider already landed files flat.
- Dedup was a no-op because there was one verified file per episode.
- The local tracking database created the show row.
- The database stored the Season 1 save directory.
- `sync_all()` first produced missing episodes `S01E01-S01E14`.
- After verifying files, `mark_obtained()` marked exactly `S01E01-S01E14`.
- A follow-up sync showed no missing currently aired episodes.

Product lessons:

1. A `KeywordAgent` must be strong, not decorative.
   The obvious keyword failed. The successful path required trying title
   variants, recognizing the adaptation/source-title clue, rejecting false
   positives, and discovering that `翘楚 4K` exposed the useful resources.

2. Provider errors are normal workflow states.
   A provider can return HTTP errors, timeouts, empty results, or wrong-target
   noise. The product should classify those states and continue through a
   bounded search strategy instead of treating the first failure as "not found."

3. Agent nodes still need freedom inside their lane.
   The node should be allowed to generate alternate keywords and reason over
   evidence. It should not be allowed to mutate 115 or the database. This is the
   key distinction between "agent node" and "dumb API call."

4. Candidate matching must stay semantic.
   `楚后` was a plausible clue because public metadata connected the show to
   that source material, but the actual returned resources were unrelated.
   The correct behavior was to reject them from title evidence, not transfer
   them just because the keyword had a plausible story.

5. Type 2 should optimize for current coverage first.
   For an ongoing show, the right goal was not perfect archival quality for all
   future episodes. It was to obtain currently aired missing episodes and leave
   future episodes active for Type 3.

6. Database marks must follow verified files.
   The workflow first verified the 14 materialized videos, then marked
   `S01E01-S01E14` obtained. The database never marks episodes merely because a
   transfer call returned success.

7. The product UI should hide this complexity.
   A normal user should see "tracking initialized, 14 episodes obtained, future
   episodes will be monitored." The provider failures, keyword recovery, and
   rejected false positives belong in the audit log.

This real run refines the agent-node thesis:

> The model should be powerful inside a narrow responsibility boundary. The
> workflow should be powerful over side effects. Mixing those two powers is what
> makes the current skill need so many prompt and code guardrails.

## Real Type 3 Run Lessons

A real Type 3 simulation was executed after intentionally creating a mismatch:

```text
翘楚 / Ashes to Crown (2026)
TMDB tv/289271
manual deletion of S01E13 and S01E14 from the 115 target directory
```

The purpose was to simulate unattended monitoring with a fresh agent context,
not to rely on the main conversation's memory of the Type 2 run.

Setup:

- 115 was manually changed so the Season 1 directory only contained
  `S01E01-S01E12`.
- The local tracking database still marked `S01E01-S01E14` as obtained.
- The database was then corrected to mark only `S01E13` and `S01E14` as missing.
- A fresh sub-agent was spawned without previous conversation context and asked
  to run the skill's Type 3 checklist from the repository state alone.

Observed flow:

```text
sync tracking database with TMDB
-> detect missing S01E13 and S01E14
-> verify target 115 directory currently has S01E01-S01E12
-> search PanSou
-> recover from transient provider error
-> extract complete candidate evidence
-> select exact missing-episode resources
-> execute primary transfer plan
-> detect no files were added to target directory
-> switch to fallback exact-episode resources
-> transfer fallback resources
-> verify restored video files
-> flatten Season 1 directory
-> dedup no-op
-> mark restored episodes obtained
-> resync and verify no current missing episodes
```

Result:

- `missing_before` was exactly `S01E13` and `S01E14`.
- The fresh sub-agent identified that the target directory lacked those two
  files.
- PanSou had a transient error during search, then returned valid candidates on
  retry.
- The primary selected resources were rejected by 115 as already transferred
  elsewhere and did not add files to the target directory.
- The agent did not treat that as success.
- It selected fallback exact-episode resources from the evidence window.
- The fallback resources restored `S01E13` and `S01E14`.
- Final 115 verification found 14 video files.
- Final database verification showed no currently missing episodes.

Important boundary observation:

The "already transferred, target directory did not gain files" behavior is
probably tied to the artificial test setup. The user manually deleted files from
the target directory, but 115 still retained a transfer/materialization record
for the original resource. In a normal production Type 3 path, where the system
is obtaining newly aired episodes that were never previously transferred, this
specific callback should be less common.

It still matters as a boundary case because users can mutate cloud storage
outside the product:

- they may manually delete files
- they may move files elsewhere
- they may restore from trash or duplicate folders
- 115 may preserve provider-side transfer history in ways the product cannot
  fully observe

Product lessons:

1. Type 3 must be stateless enough to recover from database/drive mismatch.
   The fresh sub-agent did not need the previous Type 2 conversation. It used
   the database, TMDB, and 115 directory state to reconstruct the missing work.

2. Transfer results are not final truth.
   A transfer API response can say "already transferred" or "success" while the
   target directory still lacks the expected file. The product must treat the
   post-transfer target-directory scan as the source of truth.

3. Recovery should stay inside the same evidence discipline.
   The fallback transfer was not an improvised raw URL call. It came from the
   same candidate evidence and targeted only the missing episodes.

4. Manual external mutation is a first-class boundary.
   Even if the normal product path never deletes files, the user can. Type 3
   should reconcile actual files against database state instead of assuming
   stored `obtained=true` flags remain true forever.

5. The product should distinguish ordinary "new episode missing" from
   "previously obtained file disappeared."
   The latter may deserve different audit labels and notifications, but both
   should be recoverable by the same verification-first workflow.

6. The GUI should not expose this complexity by default.
   The user-facing outcome can be "2 episodes restored." The audit log should
   retain the provider callback, fallback selection, final file list, and DB
   resync result.

This real run strengthens the workflow thesis:

> Side effects are not complete when the provider call returns. Side effects are
> complete only when the target state has been re-read and matches the workflow
> invariant.

## Why This Is More Elegant

This design is more elegant than a single long-running agent because it separates
the real problem into the right kinds of parts.

Deterministic work stays deterministic.
Semantic judgment stays semantic.
User intent stays simple.
State lives in a database.
Models are used only where rules are brittle.

The current skill already contains this insight in prompt form:

- evidence before decisions
- snapshot-scoped candidate binding
- protected collections
- no glue scripts
- verification after side effects

The product version makes those rules structural instead of rhetorical.

The workflow does not need to hope that an agent remembers the rules.
The workflow can enforce them.

This is also why the product can become more elegant than the current skill.

The current skill has to block bad behavior from both sides:

- prompt rules tell the agent not to skip steps
- code guardrails prevent dangerous calls when the agent still tries

That double guard is necessary for a general-purpose agent harness. The agent
has broad tool access, so the skill has to repeatedly forbid sampling,
re-searching, raw URL transfer, wrong-directory flattening, and skipped
verification.

In the GUI product, the agent nodes should not receive that level of authority
in the first place.

A candidate-matching agent should not be able to create folders.
A coverage agent should not be able to transfer files.
A dedup agent should not be able to delete files directly.

They should only return structured judgment.
The workflow owns every side effect.

That means safety comes from capability design:

- model nodes receive only the context needed for one judgment
- model nodes return typed decisions, scores, or explanations
- workflow code performs all writes, transfers, flattening, deletion, and status
  transitions
- each side-effect step re-checks the database state and the allowed directory
  boundary before acting

The agent can still be intelligent, but it is no longer powerful in the
dangerous sense. It cannot jump to a later step, flatten the wrong directory, or
start an unapproved transfer, because those actions are not in its tool surface.

This reduces the blast radius of model mistakes and removes much of the prompt
ceremony that exists only because the current skill must supervise a powerful
general agent.

## Why This Is More Robust

It is more robust for several concrete reasons.

First, it is resumable.
If a transfer fails, the system can resume from the persisted workflow step.
It does not need to reconstruct a long conversation.

Second, it is testable.
Each judgment node can be tested against saved snapshots.
The same input packet should produce a valid structured output, or fail in a
known way.

Third, it is inspectable.
Every decision can be stored as:

- input snapshot
- model output
- validation result
- selected action
- side-effect result
- verification result

Fourth, it is safer.
The model never gets arbitrary authority over 115.
It can recommend candidate ids or classifications.
The program decides whether those recommendations are valid and executable.

Fifth, it is easier to replace parts.
The workflow can switch model providers, search backends, notification channels,
or storage execution layers without rewriting the whole mental model.

## Objective Assessment

The idea is stronger than the current skill-only architecture.

It is more elegant because it removes accidental complexity from the agent:

- no long prompt execution as the main control plane
- no dependence on hidden conversation memory
- no repeated re-reading of procedural docs during every run
- no user-facing trace unless the user asks for details

It is more robust because it gives hard responsibilities to software:

- state transitions
- retry logic
- idempotency
- permission boundaries
- audit logs
- validation

The main caveat is that this architecture is only better if the boundaries stay
strict.

It would become worse if:

- agent nodes begin calling side-effecting tools directly
- the workflow stores vague text instead of typed state
- "confidence" becomes an excuse to skip verification
- the UI exposes too much internal trace to normal users
- Type 3 failure handling is left as free-form agent narration

So the answer is:

> Yes, this direction is more elegant and more robust, provided the product keeps
> agent judgment narrow, typed, validated, and subordinate to the workflow.

## Stack Implication

This does not require adopting ADK.

The architecture can borrow the ADK philosophy without taking on the full ADK
runtime:

- graph-like workflow
- node-level responsibility
- callbacks/hooks for logging and policy
- structured state passing
- agents as replaceable nodes

A practical first stack can still be:

- Next.js for UI and API
- database-backed workflow state
- Vercel AI SDK or equivalent for structured judgment nodes
- a queue/workflow layer when long-running Type 3 execution needs durability
- server-owned TMDB and PanSou access
- user-owned 115 authorization

ADK, Prefect, OpenHands, or other runtimes can remain references until the
product proves it needs their weight.

## Data Storage Architecture

The current skill uses SQLite for the right reason: it is self-use first, local,
small, and easy for a user-run agent skill.

A product version should use Postgres as the main database.

Postgres should be the only source of truth for durable state:

- users
- 115 account connection records
- media titles
- seasons
- episodes
- tracked seasons
- workflow runs
- workflow step events
- resource provider configs
- resource snapshots
- agent decisions
- snapshot-scoped transfer decisions
- notifications
- TMDB metadata cache

Neon Postgres through Vercel is a reasonable first production choice because it
fits the Next.js/Vercel deployment model and keeps database setup managed.

The P1 kernel starts with a repository contract before choosing a concrete
database adapter.

That contract stores one workflow run snapshot as a coherent unit:

- media title
- tracked season
- episode states
- workflow run
- resource snapshots
- agent decisions
- transfer attempts
- notifications

The in-memory implementation is not the production database. Its job is to make
the persistence boundary explicit and testable. It validates references before
mutation, returns defensive copies, and enforces that agent decisions only refer
to candidates from persisted resource snapshots. A later SQLite or Postgres
adapter should satisfy the same contract rather than re-implementing workflow
rules in route handlers or UI components.

The workflow runner is the adapter between side effects and durable state.

The core workflow functions perform typed workflow steps and return facts:
episode state, resource snapshots, agent decisions, transfer attempts,
notifications, and audit events. A thin runner should pass a concrete workflow
run id into those steps, then persist the returned result through the repository
contract. This keeps route handlers and future queue jobs from hand-building
database records differently. It also makes no-op Type 3 runs explicit: when
storage is already current, the persisted run has no resource snapshots or
transfer attempts, but still records the verified episode state and notification.

The server command is the UI entrypoint.

When a user clicks "get", the browser should optimistically disable the button,
but the server must still own the idempotency rule. The command layer should:

- check for an active workflow for the same tracked season and workflow kind
- return that active workflow instead of starting another one
- return already-tracked state when episode state already exists
- reserve a new workflow run before side effects
- call the runner and return a compact UI summary

This gives the future Next.js route a single safe function to call instead of
letting route handlers duplicate workflow rules.

The next hardening step is stale-run recovery. If a worker crashes after
reservation and before marking the run failed or succeeded, the active workflow
can otherwise block future requests forever. Production storage should add a
lease, heartbeat, or explicit stale-timeout recovery path.

The first concrete adapter can be SQLite.

For local development, tests, and a single-machine worker, SQLite is enough to
prove the schema shape without requiring a running service. The P1 SQLite
adapter uses the same repository contract and stores normalized entity rows for
media titles, tracked seasons, workflow runs, episode states, resource
snapshots, agent decisions, transfer attempts, and notifications. JSON payload
columns keep the adapter flexible while the workflow model is still settling.

Postgres remains the intended production target. A Postgres adapter should keep
the same table boundaries and repository contract, then gradually promote JSON
payload fields into typed columns when query patterns become clear.

Redis can be useful, but it should not become the truth store.

Redis is appropriate for:

- rate limiting
- short-lived search cache
- workflow locks
- debounce windows
- "same user clicked twice" protection windows
- queue/helper state

Redis data should be treated as recoverable from Postgres. If Redis disappears,
the system should be slower or less coordinated, not logically corrupt.

Mongo is not needed at the start.

The fact that some data is flexible or semi-structured does not require Mongo.
Postgres `jsonb` is enough for the flexible payloads this product needs:

- TMDB raw responses
- PanSou raw result snapshots
- ResourceProvider payloads
- agent structured outputs
- workflow event payloads
- notification payloads

This gives the product relational integrity for the core entities and flexible
storage for changing provider/model payloads.

Recommended first storage boundary:

```text
Neon Postgres
  = truth + metadata cache + workflow event log + JSONB snapshots

Redis / Upstash
  = ephemeral cache + locks + rate limits + queue helper

No Mongo
  = until there is a real document-store pressure
```

The central rule:

> Durable product state lives in Postgres. Redis accelerates and coordinates.
> Mongo waits until there is a concrete need that Postgres plus JSONB cannot
> satisfy.

## Next.js App Router Boundary

Next.js App Router is a good fit because it separates the browser interface from
server-owned work.

The initial page request can return an interactive UI shell.
After that, the browser asks the server for product state:

- tracked shows
- acquired episodes
- search candidates
- workflow status
- notification history

The browser should not own external API calls.
The server should own:

- TMDB credentials
- PanSou access
- 115 integration
- agent/model calls
- workflow state transitions
- notification delivery

This keeps user setup simple.

Even if the backend later becomes a cluster, that should be a deployment detail
on the service side. It should not become a burden the user must understand.

The first deployable version can be:

```text
Next.js app
-> server actions / route handlers
-> database
-> background workflow/queue when needed
-> external services
```

This is enough to prove the product without asking users to run containers,
prepare TMDB tokens, self-host PanSou, or understand the agent runtime.

## Boundary Cases and Idempotency

The UI should help prevent duplicate user actions, but it should not be trusted
as the only protection.

The right boundary is layered:

```text
Client prevents accidental double-clicks.
Server guarantees idempotency.
Database enforces truth.
```

### Client Layer

When the user clicks "get" or "track", the client should immediately put that
control into a pending state:

```text
Get
-> Requesting...
-> disabled
```

This is good UX and prevents accidental repeat clicks in the same browser view.

If the request fails before reaching the server, the local pending state can
clear on error or disappear naturally on page refresh. If the request succeeds,
the next server state should replace the optimistic UI.

The client state is only provisional.
It should never be the final authority.

### Server Layer

The server should treat "get/track this media" as an idempotent operation.

Instead of:

```text
create new workflow run every time
```

it should behave like:

```text
create workflow if no active equivalent exists
otherwise return the existing workflow
```

This protects against:

- double clicks
- browser retries
- two tabs
- mobile reconnects
- manual repeated API calls
- delayed UI refreshes

### Database Layer

Postgres should enforce the rule with a unique constraint or equivalent active
workflow invariant.

Example intent:

```text
one user + one media title + one season + one workflow kind
can have only one active get/track workflow
```

Implementation can use a unique index over the active scope and an upsert-style
server operation.

The server response should then return canonical state:

```json
{
  "mediaTitleId": "tmdb_123",
  "trackingState": "active",
  "activeWorkflowRunId": "run_456",
  "canRequestTracking": false
}
```

The frontend renders from this server state.

If the database says the show is already tracked or an active workflow exists,
the button becomes "Tracking" or "In progress" and is no longer clickable.

This is more elegant than relying on client-only state because it makes the
workflow correct across tabs, sessions, devices, and retries.

### External Storage Mutation

The product must assume 115 storage can be changed outside the product.

The database's `obtained=true` flag is a record of a verified past state, not a
permanent guarantee that the file still exists. Type 3 therefore needs a
reconciliation path:

```text
database says obtained
-> target directory scan disagrees
-> classify as disappeared / externally mutated
-> unmark or repair through the same missing-episode workflow
-> mark obtained again only after files are present
```

This boundary was observed in the Type 3 simulation: manually deleted files
caused 115 to report that some resources had already been transferred elsewhere,
while the target directory still lacked the episodes. The correct invariant is
not "the provider accepted the transfer." The correct invariant is "the target
directory now contains the expected video files."

## UI and Component Reuse

MagicPath can be useful as a UI component and canvas source.

It should be treated as a visual/productivity wheel, not as the architecture.
Good candidate surfaces for MagicPath components:

- search command palette
- tracked-show cards
- episode progress indicators
- workflow status timeline
- account connection page
- notification center
- empty states
- failure/retry panels

MagicPath should not decide:

- the workflow model
- the data model
- the agent boundaries
- the credential boundary
- background execution semantics

The product can borrow polished UI building blocks while keeping the core
application logic explicit and owned by this project.

## NetEase Popcorn / Filmly as Reference, Not Target

NetEase Popcorn / Filmly is useful as a product reference because it shows how
comfortable a personal media library can feel:

- cloud storage and protocol connections
- automatic metadata scraping
- poster walls
- season/episode grouping
- playback-oriented media browsing

But it should not be treated as the product to clone.

This project does not need to become the player, the media library terminal, or
the poster-wall destination.

The stronger position is upstream:

```text
clawd-media-track finds, transfers, verifies, organizes, and tracks resources.
Filmly / Infuse / Jellyfin / 115 can handle playback and rich library browsing.
```

The lesson to borrow is the feeling:

> The media is already organized and ready to watch.

The implementation target is narrower:

> Make the wanted media appear in the user's storage reliably.

## Credential Boundary

The product should not ask normal users to prepare TMDB or PanSou credentials.

A reasonable product boundary is:

- user provides only their own 115 connection
- service provides TMDB metadata access
- service provides or brokers PanSou-compatible search
- user configures preferences, not infrastructure

This changes onboarding from:

```text
clone repo -> create env -> prepare tokens -> run agent skill
```

to:

```text
connect 115 -> choose media -> receive results
```

That is the right product direction.

## 115 Account Connection Strategy

The current skill uses `PAN115_COOKIE` as a local environment value.
That is acceptable for self-use and for an agent skill that a technical user
bootstraps manually.

A product should turn this into a 115 account connection flow.

Important principle:

> The 115 cookie is a high-risk bearer credential.
> Anyone who has it can act as the user's 115 session.

So the product should never treat it as ordinary form data.

### Development / Internal Stage

For early development and internal testing, it is reasonable to keep using the
existing 115 Cookie Manager workflow:

```text
install 115 Cookie Manager
-> scan QR code
-> copy full 115 cookie string
-> paste into internal/dev UI
-> server validates with minimal read
-> server encrypts and stores
```

This is good enough to validate the product workflow.
It avoids building browser-extension infrastructure before the media workflow is
proven.

The downside is that it is not a polished consumer experience:

- users must install a third-party extension
- users must copy/paste a sensitive cookie
- the product has to explain too much
- support/debuggability is poor

This path should be treated as an internal bootstrap bridge, not the final user
experience.

### Product Stage

The more product-ready path is a first-party browser extension plus web pairing.

Possible flow:

```text
web app shows "Connect 115"
-> web app creates a short-lived pairing code
-> user opens the first-party extension
-> extension performs 115 QR login / cookie capture
-> extension sends the cookie to the backend over HTTPS with the pairing code
-> backend validates with a minimal read
-> backend encrypts and stores the connection
-> web app shows "115 connected"
```

This is better because:

- the normal web page does not need direct cookie access
- the extension owns browser-cookie permissions
- the user sees a focused account-connection flow
- the backend can validate before storing
- the product can later guide reconnect/revoke flows cleanly

The extension can borrow ideas from 115 Cookie Manager, but product ownership
matters. The user is trusting this product with their storage session, so the
connection path should eventually be first-party, auditable, and documented.

### Ideal Stage

The cleanest user experience would be a web-native 115 QR login flow:

```text
web app displays QR code
-> user scans with 115 mobile app
-> backend receives usable session credential
-> backend validates and stores securely
```

This would avoid a browser extension entirely.

However, it may depend on 115's private or unstable login APIs. That makes it a
later-stage investigation, not the first implementation target.

### Secure Storage Rules

The database should store a 115 connection record, not a loose cookie string.

Suggested shape:

```text
115AccountConnection
- user_id
- encrypted_cookie
- cookie_fingerprint
- status
- last_validated_at
- created_at
- revoked_at
```

Hard rules:

- never store the cookie in plaintext
- never send the cookie back to the browser
- never write the cookie into logs
- never place the raw cookie in queue/job payloads
- decrypt only inside the server-side 115 execution boundary
- validate with the smallest safe read operation
- support user-initiated disconnect/revoke
- report expiration as "needs reconnect", not as raw cookie failure text
- bind every 115 operation to a user/account scope

This keeps the product aligned with the larger credential boundary:

```text
user provides 115 authorization
service provides TMDB/PanSou/model infrastructure
workflow runs server-side
```

## Open Questions

The next design pass should answer:

1. What side effects are allowed after one-time user authorization?
2. What confidence threshold is enough for unattended Type 1 and Type 2?
3. What happens when a judgment node returns `uncertain`?
4. Should low-confidence cases be retried later, skipped, or sent to an advanced review page?
5. Which notification channel comes first: email, WeChat, or in-app only?
6. How much of the audit log should normal users see by default?
7. What is the minimum workflow engine needed for Type 3 durability?
8. What is the smallest useful UI surface before building any poster-wall view?
9. Which metadata fields must be persisted at commit time versus cached only for search?
10. Which player/media-library apps should be first-class downstream targets?
11. Which ResourceProvider should be considered product-supported versus internal?
12. How should manual links be accepted without making the product feel like a link toolbox?
13. What is the exact unique constraint for "one active workflow" per user/media/season?
14. Which workflow states should lock the UI from starting duplicate requests?
15. Which payloads deserve first-class Postgres columns versus `jsonb` storage?
16. Is the first public 115 connection flow third-party-extension assisted,
    first-party extension based, or web-native QR based?
17. What encryption/key-management mechanism protects stored 115 cookies?
18. What is the reconnect/revoke UX when a 115 session expires?

These are product policy questions, not just technical questions.

The central direction is already clear:

> clawd-media-track should become an unattended media workflow product with
> deterministic rails and stateless specialist agent nodes.
