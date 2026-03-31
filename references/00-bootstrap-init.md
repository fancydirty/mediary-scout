# Bootstrap Init

This document defines the init gate for the `clawd-media-track` skill.

It is read by the agent before normal Type 1 / Type 2 / Type 3 execution.

Bootstrap is split into two stages:

- Step 1: environment setup
- Step 2: 115 workspace initialization and CID write-back

---

## Bootstrap States

Before any normal media workflow, classify the environment into one of these states:

- `ENV_NOT_READY`
  - none or almost none of the required environment values exist
- `ENV_PARTIAL`
  - some required values exist, but one or more are still missing
- `ENV_READY_CID_PENDING`
  - Step 1 is complete, but CID values are still missing or incomplete
- `BOOTSTRAP_COMPLETE`
  - environment values are valid and required CID values are present

Do not enter Type 1 / Type 2 / Type 3 until state is `BOOTSTRAP_COMPLETE`.

---

## Goal of Step 1

Bootstrap Step 1 is complete when the following values are all present and usable:

- local Python environment is ready
- `TMDB_READ_TOKEN`
- `PAN115_COOKIE`
- `PANSOU_BASE_URL`

At the end of this stage, CID values may still be empty.
That is expected.

Local database state is not part of the bootstrap gate.

- `tracking.db` is local runtime state
- it is intentionally not committed
- the current database module creates the database file and table automatically when it is first used
- do not treat a missing local database file as a bootstrap failure

---

## Goal of Step 2

Bootstrap Step 2 is complete when the 115 workspace exists and these values are present:

- `CLAWD_MEDIA_ROOT_CID`
- `MOVIES_CID`
- `TV_SHOWS_CID`
- `ANIME_CID`

The intended default 115 workspace shape is:

`clawd-media`
→ `Movies`
→ `TV Shows`
→ `Anime`

---

## Agent Protocol

Before any normal media workflow:

1. Ensure the local Python environment exists:
   - create `.venv` if missing
   - install repository dependencies before attempting runtime checks
   - if dependency installation fails due to network issues, retry with a PyPI mirror:
     ```bash
     python -m venv .venv
     .venv/bin/pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple/ -r requirements.txt
     ```
2. Check `.env` (or process environment) for the three required values above.
3. Classify the current state:
   - `ENV_NOT_READY`
   - `ENV_PARTIAL`
   - `ENV_READY_CID_PENDING`
   - `BOOTSTRAP_COMPLETE`
4. If state is `ENV_NOT_READY` or `ENV_PARTIAL`, stay in bootstrap mode.
5. If state is `ENV_READY_CID_PENDING`, complete Step 2 before normal workflows.
6. Do not jump into Type 1 / 2 / 3 until bootstrap is fully complete.

When multiple values are missing, resolve them in this fixed order:

1. `TMDB_READ_TOKEN`
2. `PAN115_COOKIE`
3. `PANSOU_BASE_URL`

Do not ask for multiple missing values in one message unless the human explicitly asks for the full checklist.

---

## Human / Agent Split

Bootstrap Step 1 is cooperative.

The human must obtain external credentials or choose deployment preferences.
The agent must:

- detect what is missing
- ask the human for the external help or approval that only the human can provide
- wait for the result
- prepare the local runtime needed for validation
- test connectivity when the human provides a value
- write verified values into `.env`
- initialize the 115 workspace only after explicit human approval

The agent must not improvise missing credentials.

For state handling:

- `ENV_READY_CID_PENDING` means Step 1 is done, but Step 2 has not started yet
- Step 2 still requires explicit human approval before any 115 directory creation or reuse work begins
- Do not treat `ENV_READY_CID_PENDING` as permission to initialize the workspace automatically

Before beginning detailed step-by-step guidance, the agent should first give the human a short bootstrap status summary:

- say which required Step 1 items are still missing
- say whether CID initialization will still be needed after Step 1
- make it clear that bootstrap is not done after the first credential is provided
- make it clear that the agent still needs the human's help and later approval
- then switch back to one detailed request at a time

---

## Human Relay Rules

When speaking to the human during bootstrap:

- first give a short missing-items summary when bootstrap starts or resumes
- say only the next required action
- prefer one short request at a time
- do not dump the whole bootstrap process at once
- do not repeat background explanation after the human has already chosen a path
- once the human provides a value, validate it before asking for the next thing
- when a credential requires a verified acquisition walkthrough, give the human the concrete verified steps, links, and field guidance instead of a vague summary sentence

Preferred pattern:

1. summarize what is still missing
2. say exactly what the next required action is
3. wait
4. validate
5. continue

Concrete relay order:

- if `TMDB_READ_TOKEN` is missing, ask for that first
- once TMDB is validated, if `PAN115_COOKIE` is missing, ask for that next
- once 115 is validated, if `PANSOU_BASE_URL` is missing, ask the human to choose between the default public service and a self-hosted deployment
- once Step 1 is complete, do not say bootstrap is done; ask for Step 2 approval instead
- only after Step 2 completes may the agent say bootstrap is complete and normal Type 1 / Type 2 / Type 3 work can begin

Suggested bootstrap summary when Step 1 is incomplete:

`Bootstrap is not complete yet. I still need your help with these Step 1 requirements before normal resource work can begin:
- TMDB read token
- 115 cookie
- Pansou base URL
After those are ready, I will still need your approval to initialize the 115 workspace and write the CID values into .env.
I will ask for them one at a time, starting with the next missing item.`

---

## Per-Value Handling

### `TMDB_READ_TOKEN`

If missing:

- read the TMDB instructions in `../docs/bootstrap-working-notes.md`
- tell the human how to obtain the TMDB read token
- wait for the token
- test a minimal TMDB request
- only write it into `.env` after a successful connectivity check

Suggested relay:

`TMDB token is missing, and I need your help to obtain it. Please do the following and then send me the API Read Access Token:
1. Sign in to your TMDB account in a browser.
2. Open https://www.themoviedb.org/settings/api
3. When TMDB asks whether the API is for personal use, choose Yes.
4. In the personal-use confirmation dialog:
   - check the confirmation box
   - continue with the personal-use option
5. Complete the Developer Plan form.
6. Fill the form like this:
   - Use Type: Personal
   - Application Name: any truthful personal project name
     Example: clawd-media-track (Personal)
   - Application URL: a real URL that represents you or the project
     Preferred: your GitHub profile URL
     Also acceptable: the repository URL for this project
   - Application Summary:
     A personal-use tool for retrieving TMDB metadata to help organize and track movies and TV shows in a private media workflow.
   - Contact Info: fill with your real personal information
7. Submit the form.
8. After submitting, TMDB will return you to the API settings page.
9. On that page, copy the long API Read Access Token.
10. Do not use the short API Key for this project.
11. Then send me the API Read Access Token.`

### `PAN115_COOKIE`

If missing:

- read the 115 instructions in `../docs/bootstrap-working-notes.md`
- tell the human how to obtain the full 115 cookie string
- wait for the cookie
- test connectivity with a minimal read operation
- only write it into `.env` after a successful connectivity check

Suggested relay:

`115 cookie is missing, and I need your help to obtain it. Please do the following and then send me the full cookie string:
1. Install the Chrome extension 115 Cookie Manager:
   https://chromewebstore.google.com/detail/115-cookie-manager/eommpjdhnkhahmekjplnkmnfbbjgpigp
2. Open the extension
3. Prefer one of these client types in the extension:
   - 115 Life (Alipay Mini Program)
   - 115 Life (WeChat Mini Program)
4. Avoid selecting the client you are using to scan the QR code, such as iOS
5. Be aware that if the selected client type is already logged in on another device, that device may be logged out
6. Scan the QR code with the 115 mobile app and complete login
7. After login succeeds, copy the full cookie string shown by the extension
8. Make sure it is a full cookie string like:
   UID=...; CID=...; SEID=...; KID=...
9. Then send me that full cookie string`

### `PANSOU_BASE_URL`

If missing:

- ask the human which path they want:
  - use the default public PanSou service provided by the repository
  - or self-host a `pansou-web` container
- do not frame this as "the human must provide a base URL"
- if the human chooses the public service, use the repository default value
- if the human chooses self-hosting, ask the human to provide a deployment environment
- once a base URL is known, test connectivity
- only write it into `.env` after a successful connectivity check

Suggested relay:

`PanSou is not configured yet, and I need your decision before I continue. You have two paths:
1. Use the default public service provided with this repository
   - fastest setup
   - no deployment work
   - good for bootstrap and normal use
   - results may differ from a self-hosted instance
   - if the public service becomes unavailable later, you will need to switch to a self-hosted deployment
2. Use a self-hosted pansou-web container
   - requires a deployment environment
   - gives you more control and independence
   - may be preferable if you want more consistent results or do not want to rely on a public service
Please tell me which path you want.
If you want the default public service, I will use the repository default URL, validate it, and write it into .env.
If you want self-hosting, tell me where I should deploy the pansou-web container.` 

If the human chooses the default public service:

- use the repository default URL
- validate connectivity
- then write the verified value into `.env`

If the human chooses self-hosting:

1. ask where the container should be deployed
2. go to the provided machine or environment
3. check whether Docker or an equivalent container runtime is available
4. read the upstream `pansou-web` repository documentation before deployment
5. follow the upstream repository's deployment instructions instead of inventing a local variant here
6. choose an unused reachable port
7. verify the deployed service is reachable
8. write the resulting `PANSOU_BASE_URL` into `.env`

This repository owns the orchestration around self-hosting.
The actual container deployment instructions belong to the upstream `pansou-web` project.

---

## Completion Criteria

Bootstrap Step 1 is complete when:

1. `TMDB_READ_TOKEN` exists
2. `TMDB_READ_TOKEN` passes a minimal connectivity check
3. `PAN115_COOKIE` exists and passes a minimal connectivity check
4. `PANSOU_BASE_URL` exists and passes a minimal connectivity check

If all three are ready, the correct next state is:

- `ENV_READY_CID_PENDING`

That means bootstrap can continue to Step 2, but normal resource workflows are still not ready yet.
It does not mean Step 2 may begin without human approval.

---

## Step 2 Prerequisites

Do not start Step 2 unless all of the following are true:

1. Step 1 is complete
2. `PAN115_COOKIE` has already passed a minimal connectivity check
3. the human explicitly approves directory initialization

Without those three conditions, stop and remain in bootstrap mode.

Suggested relay before Step 2:

`115 is reachable. If you approve, I can now initialize the clawd-media-track workspace in 115 by creating or reusing clawd-media, Movies, TV Shows, and Anime, then write the resulting CIDs into .env.`

---

## Step 2: 115 Workspace Initialization

The purpose of Step 2 is to create or recover the default workspace used by this skill and then write the resulting CIDs into `.env`.

### Agent Protocol

1. Perform a shallow root listing with `pan115.list_files(cid="0", depth=1)`.
2. Look for a directory named exactly `clawd-media`.
3. If it exists:
   - reuse it
   - capture its CID as `CLAWD_MEDIA_ROOT_CID`
4. If it does not exist:
   - create it with `pan115.create_folder(name="clawd-media", parent_id="0")`
   - capture the new CID as `CLAWD_MEDIA_ROOT_CID`
5. Perform a shallow listing under `CLAWD_MEDIA_ROOT_CID`.
6. For each required child directory:
   - `Movies`
   - `TV Shows`
   - `Anime`
   check whether it already exists
7. Reuse existing child directories when present.
8. Create missing child directories when absent.
9. Capture the resulting CIDs:
   - `MOVIES_CID`
   - `TV_SHOWS_CID`
   - `ANIME_CID`
10. Verify each CID with a minimal read check such as `get_file_info()`.
11. Only after successful verification, write all four CID values into `.env`.

### Safety Rules

- Use shallow listing only. There is no reason to recursively scan during Step 2.
- Reuse exact-name matches instead of creating duplicates.
- If the root contains ambiguous near-matches instead of exact names, stop and ask the human before creating new folders.
- Do not run Type 1 / Type 2 / Type 3 tasks during Step 2.

Suggested relay when ambiguity is found:

`I found existing folders that are close to the expected workspace names but do not exactly match. Please confirm whether I should reuse them or create clean new folders.`

---

## Step 2 Completion Criteria

Bootstrap Step 2 is complete when:

1. `CLAWD_MEDIA_ROOT_CID` exists
2. `MOVIES_CID` exists
3. `TV_SHOWS_CID` exists
4. `ANIME_CID` exists
5. all four values pass minimal 115 read verification
6. all four values are written into `.env`

If those conditions are met, the correct next state is:

- `BOOTSTRAP_COMPLETE`

Suggested relay after Step 2 completes:

`Bootstrap is complete. The environment and workspace CIDs are ready, so I can now continue with Type 1, Type 2, or Type 3 work.`

This is the first point where the agent may treat bootstrap as finished.

---

## Out of Scope for Bootstrap

Do not perform these during bootstrap:

- run Type 1 / Type 2 / Type 3 acquisition tasks
- perform transfer/dedup/mark logic as part of initialization
