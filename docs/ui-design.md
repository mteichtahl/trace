# Trace web app: interface design

> Design only: nothing here is built. The screens below are drawn in a design canvas; their sources are in [`docs/ui/source/`](ui/source/) and rendered images in [`docs/ui/screens/`](ui/screens/). Sample names, numbers, part codes and run ids in the screens are illustrative.

Oct 27, 2026 · @Marc Teichtahl

## Summary

The trace web app is built around one question on every screen: what needs me next? Home answers it across projects, the project page answers it for one board, and every task a person does opens as a focused, guided screen that will not submit until it meets its quality bar.

- **Three places, no more.** Home (what needs you), a project (its record and next step), and a focused task (one skill at a time). Library and Admin sit beside them for shared parts and people.
- **One next step per project.** The project page leads with a single card naming the one thing that moves the project forward, with trace's recommendation and the reason. Everything else is one tap below it.
- **trace is always one keystroke away.** A chat panel built on CopilotKit, talking to trace's agents over AG-UI, knows the screen you are on. Agent questions, recommendations, live runs and plots appear inside it as real interface parts, not paragraphs.
- **Nothing moves out of sight.** One live connection keeps every screen current; anything trace checks on a timer says when it last looked and when it will look next, with a Check now button.
- **Built from stock parts.** shadcn/ui components on Tailwind with the neutral theme and one accent colour, so the build is mostly assembly.

This is design only: nothing here is built. Twenty-three screens are drawn in the design canvas, covering every area in light mode, Home and the gate in dark mode, and three phone screens; the rest of the forty follow the same layouts and are specified here in words.

**How to review.** Read the principles and the screen map first, then the three core screens (Home, Project, Focused task) and the gate. The last section lists twelve decisions to make before building, each with a recommendation.

## Principles

Each interface rule below comes from a rule trace already holds; the right column is what a person sees because of it.

| trace's rule | What the interface does |
| --- | --- |
| People decide, agents prepare | Every screen shows who the next move belongs to. Agent work is shown as live progress; person work is shown as one primary button. |
| Every decision comes with a recommendation | One shared Decision card: the recommended option first and marked, why (with cited evidence chips), what it gives up, the alternatives folded below. Picking another option opens a one-line "Your reason" field that must be filled. |
| Summary first, detail on request | Every card, message, finding and notification has a one or two sentence summary. Detail opens in place (a fold) or in a side sheet, never on a new page that loses your place. |
| Plain, contextual words | No unexplained acronym. Technical terms are dotted-underlined; hovering or tapping shows the glossary line. Labels name the board, the stage and the action ("Sign the schematic gate", not "Approve"). |
| Gates are hard | Stages after the current gate are visible but locked, with "Queued: starts when the schematic gate is signed". The Sign button stays disabled until every criterion is met and every piece of evidence has been opened. |
| Events, not polling | One live connection. A small status dot in the top bar shows Live, Reconnecting or Offline. Timed checks always show a Wait line: what, last checked, next check, Check now. |
| The person is always in control | Every click answers within 100 ms with what started. Long work shows its current step, an estimate, and Pause, Cancel and Move up. Cancel reports what was kept. |
| Visuals wherever they help | Each guided task opens with the picture for its step. Findings are drawn on the sheet or board, not given as coordinates. A person can ask for a picture at any time. |
| Told only when it matters | Four kinds of notification only: a gate is ready, an agent is stuck, a question blocks work, money is about to be spent. Everything else waits in the record. |
| Guided skills with a quality bar | Every person-task runs in Focus mode, with the quality bar as a live checklist at the foot of the screen and Submit disabled until it passes. |

Three visual rules keep the screens quiet:

1. **One accent colour, used only for "your move".** Primary buttons, the current stage and items waiting on you. Everything agent-owned is neutral.
2. **Status is never colour alone.** Every status carries an icon and a word (Verified, Failing, Untested, Waived), so it reads in greyscale and to colour-blind readers.
3. **One reading column.** Content sits in a column no wider than 960 px; wide views (boards, sheets, the traceability view) get the full width only inside their own canvas.

## Technology

The app is a single-page React app styled with shadcn/ui on Tailwind, served from AWS like the rest of trace, with every conversation running through CopilotKit over the AG-UI protocol to trace's agents.

![How the app reaches AWS: five paths behind one address](ui/diagrams/architecture.png)

*how the app reaches AWS · five paths, one address*

Chat is the only two-way stream; record changes come back on the one live channel, never by the screen asking again.

| Layer | Choice | Why |
| --- | --- | --- |
| App | React 19, Vite, TanStack Router and TanStack Query | A static app needs no server of its own; it ships from S3 and CloudFront in the existing CDK stack, so nothing runs outside AWS |
| Components | shadcn/ui (Radix base), Tailwind CSS v4, lucide icons, neutral base colour | Accessible parts the team owns as source; the theme is a handful of CSS variables |
| Chat and agent interface | CopilotKit v2 (`@copilotkit/react-core/v2`) | Chat, shared agent state, human-in-the-loop and tool rendering are ready-made and can be fully restyled with shadcn |
| Agent protocol | AG-UI (`@ag-ui/client` HttpAgent) | trace's agents stream standard events; the interface reacts to the event type, not to parsing text |
| Live record | One live connection per browser carrying record events | Every screen updates the moment the record changes; Query's cache is patched from the events |
| Charts and plots | shadcn Chart (Recharts) | Run plots with limit lines, margins and hover values in the same theme |
| Sheets and boards | The SVG trace already exports (`kicad.export`) with an overlay layer drawn by the app | Findings sit on the drawing; zoom and pan are the app's |
| Sign-in | trace's own sign-in pages, calling the Cognito user pool's API directly; Cognito's hosted pages are never shown | The same identity, its account class, and each project's part (Contributor or Reviewer), all enforced by the API |

**How CopilotKit is used.** Each piece maps to one job:

- `CopilotKit` provider at the root, pointed at a CopilotKit runtime endpoint that registers trace's agents as AG-UI `HttpAgent`s.
- `CopilotSidebar` (desktop) and `CopilotChat` inside a shadcn `Drawer` (phone) for Ask trace; `CopilotChat` embedded in Focus mode for the conversational skills (Intent builder, Question answer).
- `useAgentContext` on every screen, telling the agent where the person is: project, stage, the item selected, what is on screen. "Why is this failing?" works without naming what "this" is.
- `useAgent` for shared state: the Intent builder's draft statements and topic checklist live in agent state, so the chat and the draft panel stay in step.
- `useHumanInTheLoop` for every decision an agent asks for: it renders the Decision card in the conversation and waits for the person's answer.
- `useRenderTool` to draw tool calls as interface parts: a parts search becomes a part list, a simulation becomes a plot card, a check becomes a findings card.
- `useFrontendTool` for the few things an agent may do to the screen itself: open a run, zoom the board to a finding, show a sheet. They never change the design.

**How AG-UI events reach the screen.**

| AG-UI events | What the person sees |
| --- | --- |
| `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` | The run's header line: working, done, or stopped with the reason and a Try again |
| `STEP_STARTED`, `STEP_FINISHED` | The current step in plain words ("Checking each part against its datasheet") with a step count |
| `TEXT_MESSAGE_START`, `_CONTENT`, `_END` | trace's reply, streamed as it is written |
| `TOOL_CALL_START`, `_ARGS`, `_END`, `_RESULT` | A one-line, foldable tool row ("Searched parts: 12 in stock"), or a full card where the tool has a renderer |
| `STATE_SNAPSHOT`, `STATE_DELTA` | Shared state, such as the intent draft, updating beside the chat |
| `ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA` | Progress for long work: a bar, an estimate, Pause and Cancel |
| `REASONING_*` | Hidden by default; a quiet "Show reasoning" fold for those who want it |
| `SUBAGENT_STARTED`, `_FINISHED`, `_ERROR` | "Handed to the Analog specialist" with that specialist's steps nested under it |
| `CUSTOM` | trace's record events inside a run, such as a gate becoming ready |

## Navigation and the app shell

The app has three levels a person moves between, Home, a project and a focused task, and the shell stays the same on every screen so nothing has to be relearned.

![Screen map: Home, six areas, project tabs, Focus mode](ui/diagrams/screen-map.png)

*screen map · Home, six areas, project tabs, Focus mode*

A person is never more than two steps from Home: an area from the rail, then an item in it. Focus mode is the only place the rail folds away.

**The shell, on a desktop.**

- **Left rail** (shadcn `Sidebar`, collapsible to icons): Home, Projects, Knowledge, Agents, Operations, and Admin for admins. Below them, the person's pinned projects with a small badge counting what waits on them. Nothing else.
- **Top bar:** where you are as a breadcrumb (Soil sensor · Rev A · Capture), the search and command box (⌘K), the live status dot, the notifications bell, and the person's menu.
- **Ask trace:** a button at the top right and the shortcut ⌘J open the chat panel docked on the right. It stays open as the person moves between screens and always knows which screen they are on.

**The shell, on a phone.** A bottom bar with four tabs: Home, Projects, Ask, Inbox. The breadcrumb shrinks to the current page's title with a back arrow. Side sheets become bottom drawers. Focus mode takes the whole screen.

**Inside a project.** A project page has one header and a short row of tabs. Tabs appear only once the project has reached the stage that fills them, so a new project shows three tabs, not nine.

| Tab | Holds | Appears from |
| --- | --- | --- |
| Overview | The stage rail, the next step, what is waiting on whom, what trace is doing now | Always |
| Requirements | The intent, the requirements and the traceability view | Define |
| Design | The block diagram, schematic sheets, the pin plan, the board, each with its findings | Architect |
| Evidence | The coverage matrix, every run with its plots, waivers | Prove |
| Build | Releases, orders, boards by serial, the bench | Release |
| Decisions | Gate records, change requests, answered questions, the decision log | First gate signed |
| Cost and time | Spent, committed and forecast cost, and the stage timeline | Always, for admins |
| Settings | Template, build quantity, budget, people on the project, rules | Always |
| Memory | What the agents remember: long-term memories to switch off and on, recent activity, the change log | The first agent session |

**Focus mode.** Every guided skill opens as Focus mode: the shell's rail and tabs fold away, leaving the task, its steps, its picture, its quality bar and trace. Escape or the close button returns to exactly where the person was. A draft is kept, so leaving is never losing work.

**Finding anything.** The ⌘K command box searches projects, requirements, parts, runs and people, and runs actions by name ("Sign gate", "Raise a change", "Render bottom side"). Anything it cannot find it offers to ask trace.

**Addresses.** Every screen and every item has its own web address, so a link in a notification, an email or a chat opens the exact thing: `/p/soil-sensor/requirements/R-014`, `/p/soil-sensor/gates/schematic`, `/p/soil-sensor/runs/run_8f2c`.

## Screen inventory

Forty screens cover the whole system, but most are one of six shared layouts, so the build is six layouts and their content. "In canvas" marks the screens planned for drawing; all of those are drawn, plus dark-mode Home and gate. The rest follow the layout named.

| Area | Screen | Address | Layout | Who | In canvas |
| --- | --- | --- | --- | --- | --- |
| Sign-in | Sign in | `/sign-in` | Centred card | Everyone | Yes |
| Sign-in | Enter code (second factor or email code) | `/sign-in/code` | Centred card | Everyone | Yes |
| Sign-in | Accept invitation and set up sign-in | `/invite/:token` | Centred card | Invited people | Yes |
| Sign-in | Forgot password | `/sign-in/reset` | Centred card | Everyone | No |
| Sign-in | No access yet | `/no-access` | Centred card | Signed in, no class or project | Yes |
| Home | Home: what needs you | `/` | Shell + column | Everyone | Yes |
| Home | Inbox (notifications) | `/inbox` | Shell + column | Everyone | Phone |
| Projects | All projects | `/projects` | Shell + list | Everyone | No |
| Projects | New project | `/projects/new` | Focus mode | Admins | Yes |
| Project | Overview | `/p/:id` | Shell + project | Assigned | Yes |
| Project | Requirements and traceability | `/p/:id/requirements` | Shell + canvas | Assigned | Yes |
| Project | Requirement detail | `…/requirements/:rid` | Side sheet | Assigned | No |
| Project | Design: architecture, sheets, pin plan, board | `/p/:id/design/…` | Shell + canvas | Assigned | Yes (sheet) |
| Project | Evidence: coverage and runs | `/p/:id/evidence` | Shell + list | Assigned | No |
| Project | Run detail, live or finished | `/p/:id/runs/:run` | Shell + column | Assigned | Yes |
| Project | Build: releases, orders, boards, bench | `/p/:id/build/…` | Shell + list | Assigned | Yes (order) |
| Project | Decisions: gates, changes, questions, waivers | `/p/:id/decisions` | Shell + list | Assigned | No |
| Project | Cost and time | `/p/:id/cost` | Shell + column | Admins | No |
| Project | Settings | `/p/:id/settings` | Shell + column | Assigned (edit: admins) | No |
| Gate | Gate review and signing | `/p/:id/gates/:gate` | Focus mode | Admins sign; others read | Yes |
| Skills | Each of the 19 guided skills | `/p/:id/do/:skill` | Focus mode | Contributors and admins | Yes (3) |
| Chat | Ask trace panel | Over any screen | Docked panel / drawer | Everyone | Yes |
| Chat | Question from an agent | In chat, Home and Inbox | Decision card | Contributors and admins | Yes |
| Library | Parts search | `/library/parts` | Shell + list | Everyone | No |
| Library | Part detail: stock, prices, lifecycle, datasheet | `/library/parts/:mpn` | Side sheet | Everyone | No |
| Library | Datasheet viewer | `/library/datasheets/:id` | Shell + canvas | Everyone | No |
| Admin | People and access | `/admin/people` | Shell + list | Admins | Yes |
| Admin | Agent instructions and system prompts (installation; a project's under its Settings) | `/admin/prompts` | Shell + list | Admins | No |
| Admin | Installation health and keys | `/admin/installation` | Shell + column | Admins | No |
| Admin | Usage and cost, all projects | `/admin/usage` | Shell + column | Admins | No |
| You | Preferences: profile, sign-in, notifications, voice, chat, display, work | `/me` | Shell + column | Everyone | No |
| Installer | Welcome, GitHub, AWS, projects, people, optional, plan, run, done | `127.0.0.1:…` | Installer wizard | Installing admin | Yes (2) |
| Operations | Operations: status, alarms, tiles, dashboard sections | /ops, /ops/:section | Shell + column | Everyone, filtered by access | Yes |
| Knowledge | Knowledge: search, documents, datasheets and parts, agent memory, graph | /knowledge, /knowledge/:tab | Shell + list | Everyone, filtered by access | Yes |
| Agents | Agents and tools: live statuses, queues, catalogue, Try it | /agents, /agents/:agent, /agents/tools/:tool | Shell + list | Everyone, filtered by access | Yes |
| Project | Memory: long-term, recent activity, changes | /p/:id/memory, /p/:id/memory/recent, /p/:id/memory/changes | Shell + list | Assigned (switching: contributors and admins) | Yes (2) |

Files have two more screens: \*\*Files\*\* (\`/p/:id/files\`, every file in the project and its releases, by kind) and the \*\*File viewer\*\* (\`/p/:id/files/:path\`, full screen, any format), which is the same viewer that opens in place inside a chat. The nineteen skills share one Focus mode layout in three variants: **stepped** (most skills), **conversational** (Intent builder, Question answer) and **checklist on a picture** (Bench setup, Bring-up run, Incoming inspection).

## Sign-in and first run

Signing in is one field and one button; everything after it adapts to what the person already has, so a returning user lands on Home in two steps and a new one is never shown an empty screen.

**Our own pages, not Cognito's.** Every sign-in screen is trace's, built with the same shadcn parts as the app. Cognito's hosted pages and domain are never shown. The pages talk to the user pool through its API: the choice-based sign-in flow (`InitiateAuth` with `USER_AUTH`, then `RespondToAuthChallenge`) for passkeys, email codes and passwords; `ConfirmForgotPassword` for resets; and the WebAuthn registration calls for adding a passkey. Tokens are held in memory and refreshed with the refresh token, which is kept in a secure, HTTP-only cookie set by trace's API, never in browser storage.

One consequence for the build: the `tracectl login` command uses Cognito's hosted domain today (authorisation code with PKCE). It should move to the same pages: the command opens trace's own sign-in page with a one-time code, and the page hands the session back to the command's local callback. That keeps one sign-in look everywhere.

**Sign in.** A centred card on a plain background: the trace wordmark, "Sign in to trace", an email field and Continue. After Continue, the card offers whatever this person has set up, best first: a passkey, a code to their authenticator app, or their password. No sign-up link, because trace is invitation only, and the card says so in one quiet line ("Ask an admin on your team for an invitation").

**Second factor or email code.** Six single-digit boxes (shadcn `InputOTP`) that accept a paste, with "Send a new code" counting down from 30 seconds.

**Accepting an invitation.** The invitation email links to a card that already shows the person's email and who invited them. They choose how to sign in: a passkey (recommended, "nothing to remember and it cannot be phished"), or a password with an authenticator app. Then they are signed in.

**No access yet.** A signed-in person with no account class, or a class but no project, sees one card explaining which, naming the admins who can fix it, with a Copy request button that puts a ready-made message on the clipboard. They never see an empty Home.

**First run, by role.**

- **The installing admin, no projects yet:** Home shows one card, "Start your first project", with two choices: from an idea (opens the Intent builder) or from an existing KiCad design (opens Design import). trace recommends one based on whether the chosen repository already holds a KiCad project.
- **A contributor added to an existing project:** Home opens with that project and a three-line welcome: what stage it is in, what the person can do here, and the one thing waiting on them, if any. A Show me around link runs a four-stop tour (the next step card, the stage rail, Ask trace, the bell). It is offered once and never forced.
- **A reviewer (and anyone with a Guest account, who can only review):** the same, worded for reading: "You can read everything and comment at gates. You cannot change the design." Buttons that change things are not shown to reviewers at all, rather than shown disabled.

**Session behaviour.** Tokens refresh quietly in the background. When a refresh fails, a non-blocking banner says "Your session has ended. Sign in again to keep working", and any unsent text or form input stays where it was.

## Home: what needs you

Home is a single column: a one-line greeting, then three parts in this order: what is waiting on you, your projects at a glance, and what trace is doing for you right now. A person who reads only the first line knows what to do next.

**1. The greeting line.** "Good morning, Marc. 2 things need you; 3 are running." It is the whole page in one sentence, and it changes live.

**2. Needs you.** A list of cards, one per item, oldest and most blocking first. Only the four kinds that earn a notification ever appear here:

| Kind | Example summary | Primary action | Mark |
| --- | --- | --- | --- |
| Gate ready | "Soil sensor: the schematic gate is ready. All 6 criteria met; trace recommends signing." | Review and sign | Accent dot |
| Question blocking work | "The Analog specialist needs the sensor's supply range to size the regulator. It recommends 2.7 to 3.6 V, from the datasheet." | Answer | Accent dot |
| Money about to be spent | "Order for 10 boards is ready: about US$184. Two prices changed since sign-off." | Review order | Accent dot |
| Agent stuck | "Routing stopped: 3 nets cannot fit between U4's pins. trace suggests moving U4 2 mm left." | See options | Amber dot |

Each card shows the project and stage as small text above the summary, the summary itself, how long it has waited, and one primary button. A question with a clear recommendation shows the recommended answer as its own button ("Use 2.7 to 3.6 V"), with "Other answer" beside it, so most questions are answered from Home in one tap. When nothing needs the person, the list is replaced by one line: "Nothing needs you. trace will tell you when something does."

**3. Projects.** One compact row per project the person is on, at most six before a See all. Each row shows the name and revision, a small stage rail (nine dots and the gates between, the current one ringed), and the next step in words ("Next: you sign the schematic gate" or "Next: trace is routing the board, about 20 minutes"). Whose move it is reads at a glance: an accent next step is yours, a neutral one is trace's or someone else's.

**4. Running now.** Long work across the person's projects, one line each: what it is, the current step, an estimate, and a fold with Pause, Cancel and Move up. Anything checked on a timer shows its Wait line here too ("Waiting for JLCPCB to confirm the order. Checked 2 minutes ago; next check in 13 minutes. Check now").

**What Home leaves out on purpose:** activity feeds, charts, recent files and recommendations to explore. Those live in the projects. Home is for acting.

**On a phone** the order is the same; cards take the full width, the stage rail shrinks to a progress bar with the stage's name, and Running now folds to one line ("3 running") that opens a drawer.

## Project page

The project's Overview answers three questions top to bottom: where is it, what is the one next step, and what is happening around it.

**Header.** The project name, its revision as a badge (Rev A), its template as quiet text (Board), and the people on it as small avatars. A menu on the right holds the rare actions: Raise a change, Start next revision, Export the record.

**The stage rail.** Nine stages (or fewer, by template) left to right, with a small diamond for each gate between them.

- A finished stage is a filled dot with a check; its gate diamond is filled and shows who signed it and when on hover.
- The current stage is an accent ring with its name under it and a thin progress line: "Capture · 4 of 6 criteria met".
- A stage reopened by a failure or a change carries a small return arrow and "Reopened: datasheet conflict found in Prove".
- Stages past the next gate are hollow and labelled "Queued". Hovering one says what trace has prepared for it and that it starts only when the gate is signed.
- Optional stages after acceptance (Certify, Produce, Sustain) appear after a short gap, only when the project's template turns them on.

Tapping any stage opens that stage's page: what happened, its gate record, and its evidence.

**The next step card.** The largest thing on the page, and there is only ever one. It names the action, who it belongs to, why it is next, and trace's recommendation where there is a decision.

| Project state | The card says | Button |
| --- | --- | --- |
| A person's task is open | "Finish the schematic: 3 draft notes and 2 checker findings left on the power sheet." | Continue (opens Focus mode at the right step) |
| The gate is ready | "The schematic gate is ready. All 6 criteria met, 1 waiver taken. trace recommends signing." | Review and sign |
| trace is working | "trace is checking every part against its datasheet. Step 3 of 5, about 6 minutes." | Watch (opens the run); Pause in its menu |
| Waiting on someone else | "Waiting for Priya to answer which connector to use. Asked 2 days ago." | Remind (admins), or Answer it for her |
| Waiting on outside | "Waiting for JLCPCB to ship. Checked 2 hours ago; next check in 4 hours." | Check now; and "Meanwhile: 3 fab-wait tasks" |
| Something failed | "The power test failed on the bench. This reopens Capture as Rev B." | See what failed |

A reviewer sees the same card in reading form ("The schematic gate is waiting for an admin to sign") with Read the evidence as its button.

**Around it.** Under the card, three short lists, each with a count and a fold:

- **Waiting on people:** each open question, gate and change request, with who it waits on and for how long, oldest first.
- **trace is doing:** live jobs for this project, each with its current step and controls. A job one specialist asked another for reads "Asked by the Thermal specialist: …"; while it is queued, Decline (with a reason in one line) sits under it for contributors and admins.
- **Recently:** the last five things that changed the record (a gate signed, a run finished, a requirement edited), each one tap from its detail.

**The firmware track** shows as a thin second line under the stage rail when the template has one, with its own small status per stage ("Pin plan agreed", "Builds clean, 82% of flash"). It has no diamonds because it adds criteria to the hardware gates rather than having its own.

## Creating a project

New project is a six-step Focus mode flow for admins, and it ends with a working project, its repository onboarded and its people invited, opening straight into the first task. Every step has defaults, so a person can create a project by filling in a name and pressing Continue five times.

| Step | Asks for | Defaults and recommendations | Required |
| --- | --- | --- | --- |
| 1. About | Name; short description (one or two sentences, shown on Home and in notifications); icon | An icon picked from the name (from a set of electronics glyphs: chip, antenna, battery, motor, sensor, board, FPGA, plug) with a colour from 8 theme-safe colours; or upload a square image | Name |
| 2. How it starts | From an idea (opens Intent builder) or from an existing KiCad design (opens Design import); the template: Board, FPGA, Firmware or Mixed | trace recommends a template from the answer and the repository's contents, with why ("Found a KiCad project and firmware: Mixed") | Yes |
| 3. Repository | A new repository (owner and name) or an existing one; its default branch | A new private repository named from the project; `main` | Yes |
| 4. People | Who is on the project and what each may do | The creator and every admin, shown locked; others added by name or invited by email | No |
| 5. Build and budget | Build quantity per run; target unit cost; budget per revision; optional later stages (Certify, Produce, Sustain); the fab and assembler | 10 boards; no budget; later stages off; JLCPCB | No |
| 6. Review | Nothing | The whole set in plain words, what will happen, and how long it takes | – |

**People and their permissions (step 4).** A table of people with an Add person field that searches existing people and accepts a new email. For each person:

- **Their part on this project:** Contributor (can change the design, answer questions, run tools) or Reviewer (reads everything, comments at gates, changes nothing). Each choice is explained in one line beside it.
- **Ceiling from their account:** a person whose account class is Guest can only be a Reviewer; admins are always on every project, can sign gates and approve spend, and are listed locked with "Admin: every project".
- **Notifications for this project:** Normal, or only gates and spend, preset from their own preferences.
- New emails are invited as part of creating the project; the invitation names the project and the person who invited them.

**Advanced (folded under step 3):** this project's own agent token, so its agents can reach only its repository (recommended when projects belong to different teams); how long its agents' memory keeps short-term events (30 days); and whether to open the onboarding pull request and apply repository settings (both on).

**Creating.** Create shows the work as Run lines on the review screen: create or connect the repository, open the onboarding pull request, set up the project's agent, knowledge base and build runner, invite people. Most of it takes under a minute; anything that waits (the onboarding pull request's checks) shows its Wait line. When the project is usable, Open project takes the person to its first task: the Intent builder, or Design import.

**Changing it later.** Name, description, icon, people and their parts, build quantity, budget and later stages are all editable in the project's Settings by admins; changing the template or repository is not, because the record depends on them, and Settings says so.

## Focus mode: guided skills

Every task a person does in trace opens in Focus mode, one layout shared by all nineteen skills: steps on the left, the work in the middle, trace on the right, and the quality bar along the bottom with Submit.

**The four regions (desktop).**

1. **Steps (left, 240 px).** The skill's steps as a vertical stepper: done steps ticked, the current one in the accent, later ones plain. Any done step can be revisited. Above them, the skill's name and the stage it belongs to; below them, "Draft saved 2 seconds ago".
2. **The work (centre).** It always opens with the picture for the step (the sheet, the board, the block diagram, the pin map, the bench wiring view), and the step's content under or beside it: the items to resolve, each as a summary row that opens its detail. Findings on the picture and rows in the list are linked: tapping either highlights the other.
3. **trace (right, 380 px).** A CopilotKit chat scoped to this step. It opens with trace's summary of the step and its recommendation where there is a choice. The person can ask anything ("why this regulator?", "show me the datasheet page"), and trace answers with cards and pictures, not only text. It folds away to a button for people who want the room.
4. **Quality bar (bottom, sticky).** The skill's checks as a row of short items, each Met, Not met or Waived, coming live from the checker tool. "4 of 6 met" on the left, Submit on the right. Submit is disabled until every check is met or waived; hovering it lists exactly what is missing, and each missing item jumps to where it is fixed.

**Three variants of the same layout.**

| Variant | Used by | What changes |
| --- | --- | --- |
| Stepped | Requirements review, Architecture choice, Schematic finish, Pin plan review, Waiver, Change request, Board setup, Placement adjust, Gate signing, Release review, Order submit, Design import, Certification run, Production release | As described above |
| Conversational | Intent builder, Question answer | The chat moves to the centre and becomes the work. The right panel shows what is being built: the draft intent statements, the topic checklist and the open questions, updating live from the agent's shared state |
| Checklist on a picture | Bench setup, Bring-up run, Incoming inspection | The picture fills the centre and the steps become a checklist beside it, ticked by the person (a wire connected) or by trace (an instrument answered). A live readout panel shows the instruments' values against their limits. A large Stop button is always visible during powered steps |

**Pushes from KiCad.** In skills where the person edits in KiCad (Schematic finish, Placement adjust, Board setup), the centre shows a quiet line: "Edit in KiCad and push. trace re-checks every push." When a push lands, the picture refreshes in place, fixed findings fade out, new ones fade in, and a toast says what changed ("Push abc123: 2 findings fixed, 1 new").

**Changes from trace's draft.** Where trace drafted the work (the schematic, the placement), each difference the person made appears as a row asking for its one-line reason, pre-filled with trace's best guess for the person to confirm or rewrite.

**Leaving and returning.** Close returns to where the person was. The project's next step card then says "Continue: Schematic finish, step 4 of 6". Nothing is lost and nothing is submitted until Submit.

**On a phone.** Steps collapse to "Step 3 of 6" at the top with a drawer for the list. trace becomes a floating button that opens a full-height drawer. The quality bar becomes a sticky footer: "4 of 6 met · Submit", tapping the count opens the list. Tasks that need KiCad say so on the phone and offer to send the person a link for their desktop; reading, answering, waiving and signing all work on the phone.

## Gates and signing

A gate is the Gate signing skill in Focus mode, and its one job is to make the signer open the evidence before the Sign button wakes up. One admin's signature passes it; nobody else's can.

**What the signer sees, top to bottom.**

1. **The recommendation.** "trace recommends signing. All 6 criteria are met; one waiver was taken, rated degraded, and is caught on the bench." With the Decision card's "What it gives up" and the alternative (return the stage) folded below.
2. **Criteria.** One row per criterion: its words, its status from the checker (Met, Not met, Waived) and an Open evidence button. Opening the evidence shows it in a side sheet (the ERC report on the sheet, the coverage row, the stock check), and the row then gets a small "Opened" tick. The row cannot be ticked any other way.
3. **Waivers taken in this stage.** Each with its reason, risk, severity and where it is caught instead, and an Acknowledge checkbox.
4. **Cost and time** where the gate commits money or time ("Next: Prove, forecast 2 days of agent time, about US$11 of cloud use"; at the order gate, the order's total and any price change since sign-off).
5. **Notes.** An optional field for concerns that do not block, saved with the gate record or raised as an issue.
6. **Sign or return.** Sign is the accent button and stays disabled until every criterion is met or waived, every piece of evidence opened and every waiver acknowledged; its tooltip lists what is still missing. Return opens a field that must say what has to change.

**Signing.** Sign opens a small confirmation dialog that restates the act in a sentence ("You are signing the schematic gate for Soil sensor Rev A. Layout work starts as soon as you sign.") with Sign and Cancel. Passkey or second-factor confirmation is asked again for the release and order gates, the two that commit money. After signing, the gate diamond fills on the stage rail, the queued work starts, and a toast shows what started.

**What non-signers see.** Contributors and reviewers can open the gate and all its evidence, and can leave notes. In place of Sign they see "Waiting for an admin to sign" with the admins' names.

**A gate record afterwards** reads as a receipt: who signed, when, every criterion with its evidence link, the waivers acknowledged and the notes. It lives under Decisions and on the stage rail.

## Chat with trace

There is one chat, Ask trace, and it appears in three places: docked beside any screen, inside Focus mode, and in a run's page as the agent's own log. In all three it is the same CopilotKit chat, restyled with shadcn, reading the same AG-UI events.

**What it knows.** Every screen tells the agent where the person is through `useAgentContext`: the project, revision, stage, tab, and the item selected or in view. A strip above the input shows that context as removable chips ("Soil sensor · Power sheet · Finding 2"), so the person can see what trace will look at and drop what they do not want.

**What a reply looks like.** Every reply starts with a one or two sentence answer in plain words. The detail follows in folds or cards. trace's replies are checked by the writing check before they reach the screen, and technical terms are underlined with their glossary line on hover or tap.

**Markdown, rendered properly.** Every message, from trace or from the person, renders as markdown with a renderer that copes with text still streaming in (half-finished tables and code blocks do not flicker or break).

- GitHub-flavoured markdown: headings, bold and italic, lists, task lists, tables (scrolling sideways inside their own frame on a phone), block quotes, links and images.
- Code blocks with syntax highlighting for the languages trace uses (C, C++, Rust, Python, TypeScript, Verilog, SPICE, KiCad's S-expressions, shell), a language label, and a Copy button.
- Formulas typeset with KaTeX, inline and as blocks, because component maths lives in chat ("R1 = (Vout / Vref − 1) × R2").
- Mermaid diagrams drawn as pictures, with "Show source" beside them.
- Links to anything in the record (a requirement, a run, a part, a file) become chips that open in place: a requirement opens its side sheet, a run its card, a file its viewer.
- Raw HTML is never rendered, only shown as text, and every link to outside trace shows its domain.

**Interface parts inside the chat.** Where a tool or a question has a renderer, the conversation shows a part, not a paragraph:

| Part | Comes from | Shows |
| --- | --- | --- |
| Decision card | `useHumanInTheLoop` (an agent's question or any decision) | The recommendation, why, what it gives up, alternatives; buttons to choose; "Your reason" when not the recommendation |
| Run card | `ACTIVITY_*` and `STEP_*` events | The run's current step, progress and estimate; Pause, Cancel; turns into a result summary when done |
| Plot card | `useRenderTool` on simulation and measurement tools | The plot with its limit line and margin; tap to open the run |
| Findings card | `useRenderTool` on check tools (ERC, DRC, datasheet limits) | Count by severity, the first three findings, the thumbnail with markers; tap to open on the sheet or board |
| Part card | `useRenderTool` on parts tools | Part, stock for the build quantity, price, lifecycle, datasheet link, alternatives |
| File card | Any tool that writes or reads a file | The file's inline viewer (see File viewers) |
| Tool row | Any other tool call | One quiet line ("Read 3 datasheet pages"), folded, with arguments and result inside |
| Hand-off | `SUBAGENT_*` events, or a recorded hand-off between specialists | "Handed to the Analog specialist", with its steps nested and folded; for a recorded hand-off, "The Thermal specialist asked the Analog and mixed-signal: …" with the request, the answer and where it stands |

**Questions from agents.** When an agent asks a person something, the question appears in three places at once and is answered once: the chat of whoever is in that project, the Needs you list on Home, and the Inbox. The question shows what it blocks, what the agent already read (as source chips), and its options with the recommended one first. Answering anywhere answers everywhere, and the agent continues.

**Conversations are part of the record.** Each project keeps its chats as threads, named by what they were about, listed in the chat panel's history. A message can be pinned to a requirement or a decision so it is found from there. Decisions made in chat are written to the record with the chat linked as their source.

**History is kept.** Every thread is stored with the project, never only in the browser, so a conversation is there on any device and after signing out. Opening Ask trace returns to the last thread on this project, scrolled to where the person left it, with earlier messages loading as they scroll up. The chat panel's history list shows threads newest first, searchable by their words.

**Up and down recall what you sent.** In the message box, the Up arrow brings back the person's previous message, and pressing it again goes further back; Down moves forward again and, past the newest, returns the unsent draft exactly as it was. It works like a terminal's command history:

- Up recalls only when the cursor is on the first line of the box (or the box is empty), and Down only when it is on the last line, so arrows still move the cursor inside a long, multi-line message.
- The recalled list is the person's own sent messages, newest first, across all their threads on this project, without duplicates in a row. It survives reloads and devices because it comes from the stored history.
- A recalled message can be edited before sending; editing it never changes the original.
- Escape leaves recall and restores the draft. Enter sends; Shift+Enter adds a line.
- On a phone, where there are no arrow keys, a small history button beside the box opens the same list to pick from.

**Hearing the conversation.** Any reply can be read aloud with Amazon Polly, so a person at the bench can listen with their hands busy.

- **Play on a message:** a speaker button on every reply reads it from the start; the word being spoken is lightly highlighted, and tapping any sentence jumps there.
- **Read replies aloud:** a toggle in the chat header reads each new reply as it arrives, starting with its summary. Questions and decisions are read with their recommendation and options ("trace recommends 4.2 amps, from the motor datasheet. Say or tap: use 4.2 amps, or other answer.").
- **What is spoken:** text as written, with terms said in full ("the parts list", not "B-O-M"), units spoken ("4.2 amps"), formulas read in words, and long tables, code and file previews replaced by a short line ("A table of 12 parts follows on screen").
- **Voice selection:** in the chat header and in the profile, the person picks a voice from Polly's neural and generative voices for their language, each with a Preview button, and a speed from 0.75× to 1.5×. The choice follows them to every device.
- **Controls:** a small player bar while speaking, with Pause, Stop, Skip to next reply and speed. Speech stops when the person starts typing or speaking.

**Dictating instructions.** A microphone button in the message box (and the shortcut ⌘ Shift Space) lets the person speak instead of type, using Amazon Transcribe streaming.

- **Hold or tap:** hold to talk and release to stop, or tap once to start and tap again to stop. A level meter and "Listening…" show the mic is live; the mic is never on without that showing.
- **Words appear as they are spoken,** in the message box, so the person can correct them before sending. Dictation never sends by itself unless the person turns on "Send when I stop talking" in their profile.
- **It knows trace's words:** each project's part numbers, reference designators, net names and requirement ids are passed to Transcribe as a custom vocabulary, so "U four" becomes U4 and "R one four" becomes R14.
- **Spoken commands** for hands-free work at the bench: "send", "cancel", "read that again", "stop". Anything that commits (signing, approving spend) still needs a tap.
- **Privacy:** audio streams only while the mic is live and is not stored; only the text the person sends is kept. The browser asks for microphone permission once, and the profile shows how to revoke it.
- **Everywhere there is a message box:** Ask trace, the conversational skills, and Question answer. In the Bring-up run, dictated notes are attached to the current step.

**Controls.** Stop while trace is replying; Retry on any reply; Copy as markdown; a thumbs down that asks what was wrong. Attaching a file (a datasheet, a photo of a board, a spec) adds it to the project's knowledge base after a confirmation.

**Placement.** On a desktop the panel docks on the right at 380 px, can widen to 560 px, and stays open across screens. On a tablet it slides over the content. On a phone it is the Ask tab, full screen, with the context chips at the top.

## Visuals

The five visuals the journey specifies (traceability, block diagram, findings overlay, run plots, bench wiring) all live in one shared Canvas frame, so they pan, zoom, select and comment the same way.

**The Canvas frame.** A full-width area with a slim toolbar: zoom, fit, layers (for boards: top, bottom, each copper layer, silkscreen), a filter (stage, kind, status), Compare (with an earlier revision or another option), and Ask about this. The selected item's detail opens in a side sheet so the picture stays in view. Every Canvas has a small version in summaries (a thumbnail with its markers), and the full version behind it.

| Visual | Where it lives | What a person does there |
| --- | --- | --- |
| Traceability view | Requirements tab; every gate | Follows a requirement from intent line to evidence; a failure colours its whole chain back to the intent; filters to one status |
| Block diagram | Design tab; Architecture choice | Compares options side by side with the layout held still; taps a block for its part, prices and alternatives |
| Findings overlay | Design tab (sheets, board); Schematic finish; Placement adjust; gates | Taps a numbered marker or list row to zoom to it; red blocks the gate, amber must be fixed or waived, grey is waived |
| Run plots | Evidence tab; run pages; chat | Reads the verdict and the margin against the limit line; overlays the previous revision |
| Bench wiring view | Build tab; Bench setup; Bring-up run | Ticks each wire as connected; taps a point to see it on the board render |

**Asking for a picture.** "Show me the power sheet" or "render the bottom side" in chat produces the picture as a card. Slow pictures (photographic renders, turntables) show a Run card with an estimate first, then the image when it arrives, and are kept with the run that made them.

**Severity colours** are the only colours in the visuals besides the accent: red (blocks the gate), amber (fix or waive), grey (waived), green (verified). Each also carries its own marker shape and word.

## File viewers

Every file trace makes or reads opens in the app without downloading it, through one File viewer that comes in three sizes: a card inside a chat, a side sheet, and a full-screen page with its own address. The same component draws all three, so a file looks the same wherever it appears.

**The three sizes.**

1. **In chat (card).** A compact preview: the first page, a thumbnail, the first rows or the first lines, with the file's name, kind and size. Expand opens it larger in place; Open opens the full page.
2. **Side sheet.** Opened from any list or link without leaving the screen, wide enough to read and zoom, with the same toolbar as the full page.
3. **Full page.** `/p/:id/files/:path`, the whole screen, shareable by link. Pop out opens it in its own window without the app shell, for a second monitor beside KiCad or the bench.

**One toolbar for every format:** name, kind, revision and commit; Download; Copy link; Versions (every earlier version of this file, with Compare); Ask about this file (opens chat with the file as context); and the format's own controls (layers, page, zoom, columns).

| Kind | Files | In chat | Full viewer | Built with |
| --- | --- | --- | --- | --- |
| Schematic | `.kicad_sch` | Sheet thumbnail with finding markers | Pan and zoom across sheets, hover a net to highlight it, tap a symbol for its part and datasheet, findings overlay | KiCanvas, with trace's overlay layer |
| Board | `.kicad_pcb` | Top-side thumbnail | Layers on and off, highlight a net, measure, findings overlay, top and bottom flip | KiCanvas, with trace's overlay layer |
| Fabrication | Gerbers, drill files, the JLCPCB zip | Composite board image | Each layer as an image, stacked or alone, the drill map, the zip's contents listed | tracespace (Gerber and drill rendering) |
| 3D models | `.step`, `.stl`, `.glb` | Still image | Orbit, section, explode; the board in its enclosure with clashes marked | three.js, with an OpenCascade build for STEP |
| Renders | `.png`, `.jpg`, `.webp`, `.mp4` turntables | The image or a playing loop | Zoom to pixel, compare two side by side with a slider | Native image and video |
| Drawings | `.svg` | The drawing | Pan and zoom; text selectable | Native SVG, sanitised |
| Documents | `.pdf` (datasheets, lab reports, specs) | First page, or the cited page | Pages, search, outline, jump to a cited page with the cited table highlighted | PDF.js |
| Tables | Parts lists, placement files, `.csv`, `.tsv` | First 5 rows and the row count | The Data table: sort, search, filter, resize, choose and reorder columns; a parts list links each line to its part | TanStack Table |
| Waveforms | `.vcd`, simulation results | The plot with its limit line | Signal lanes, cursors, decoded bus rows, measurements against limits | shadcn Chart, and a waveform view drawn with SVG |
| Timing diagrams | WaveDrom JSON | The diagram | The diagram, measured against spec side by side | WaveDrom |
| Code and text | C, C++, Rust, Python, TypeScript, Verilog, SPICE netlists, routing files, `.json`, `.yaml`, `.toml`, logs | First 12 lines, highlighted | Highlighted, line numbers, search, wrap, follow a live log | Shiki |
| Markdown | `.md` (rules, notes, docs) | Rendered, first section | Rendered with a contents list; Show source | The same markdown renderer as chat |
| Firmware images | `.elf`, `.hex`, `.bin`, `.map` | Size against flash and RAM | Section sizes, the largest symbols, change since the last build | trace's `firmware.size` output |
| Archives | `.zip`, `.tar.gz` | The file list | Browse inside and open any file in its own viewer | Unpacked on the server |
| Anything else | Unknown kinds | Name, size, Download | The same | None |

**Comparing versions.** Text and code compare line by line. Parts lists compare row by row (added, removed, changed quantity or price). Schematics, boards and images compare as two panes locked together, with a slider and a difference overlay.

**Files screen.** `/p/:id/files` lists every file in the project grouped by kind (design, fabrication, evidence, firmware, documents), with the release each belongs to, newest first. A release's files are frozen and marked so.

**Speed and safety.** Each viewer loads only when its kind first appears, so the app stays light. Large files stream (a 200-page datasheet shows page 1 at once). Files arrive through short-lived signed links from the API's existing artifact read, and nothing in a file is ever run: scripts in SVG and HTML are stripped, and markdown never renders raw HTML.

## Runs, jobs and waits

Anything that takes time shows three things at once, everywhere it appears: what it is doing now, how long it will likely take, and what the person can do about it.

**The Run line** (used on Home, the project page, Focus mode and chat):

- A small spinner, the run's name in plain words ("Routing the board"), and the current step ("Stage 1 of 2: the dense core near U4").
- A thin progress bar when the work has a known size; otherwise elapsed time and the typical time for this kind of run on this project ("12 min so far, usually 20").
- Where it runs, in quiet text when it matters ("on a graphics card").
- A menu with Pause, Cancel and Move up the queue. Cancel asks once, stops within seconds, and then says what was kept ("Stage 1 kept: 48 nets routed and locked").

**The run page** (`/p/:id/runs/:run`) is the Run line at full size: the steps as a timeline with each step's duration, the agent's own log as a chat thread (tool rows, hand-offs to specialists, pictures it made), and the result at the top once it finishes: the verdict in one sentence, the plots, the findings and the files.

**The Wait line** is the one pattern for anything trace checks on a timer:

> Waiting for JLCPCB to confirm the order. Checked 2 minutes ago; next check in 13 minutes. **Check now**

The countdown ticks live. When checks slow down because nothing has changed, the line says so ("Checking less often while nothing changes: next in 2 hours"). Check now runs the check at once and shows a spinner on the line until it answers.

**The live status dot** in the top bar is the one sign of the app's own connection: green "Live", amber "Reconnecting" with the time since the last update, grey "Offline". While not live, every screen keeps what it had and says "Showing what was true at 10:42", and nothing the person types is lost. When the connection returns, the screen catches up without a reload.

**Queued work.** Work trace has prepared for a stage that has not opened yet shows as "Queued: starts when the schematic gate is signed", never as running.

## Admin

Admin is four plain screens for admins only, each a view of something trace already holds: people and access, the agents' instructions, the installation's health, and usage across projects.

**People and access.** A table of people: name and email, account class (Admin, User, Guest) as a dropdown, the projects they are on as chips showing their part on each ("Soil sensor · Contributor", "Motor driver · Reviewer"), last seen. The class is a ceiling: a User can be a Contributor or a Reviewer on each project, a Guest only a Reviewer, and an Admin is on every project. Invite opens a short sheet: email, class, and for each project chosen the part, each explained in one line ("Contributor: changes the design, answers questions, runs tools"; "Reviewer: reads everything and comments at gates"). A person's row opens their history from the assignment log. Changing someone to Admin asks for confirmation and says what it grants (every project, signing every gate). A person cannot remove their own admin class.

**Agent instructions.** Every instruction and system prompt the agents receive, managed per installation and per project; specified in full in Agent instructions and system prompts below.

**Installation.** One health list, each line a Wait line or a status: the stack deployed, the GitHub connection authorised, each project's build runner, the graphics card image built, the knowledge bases, the live connection. Anything not healthy says what is wrong and the one thing to do about it. Below it, **Optional keys**: Nexar, Mouser and DigiKey, each marked "Optional: parts search works without it; adds live stock and prices from this distributor". A key is entered once, shown only as its last four characters, and can be replaced or removed.

**Usage and cost.** Spend across projects for the month: cloud use (agents, graphics card and CPU jobs) and recorded orders, by project, with each project's budget where one is set. Each project row opens that project's Cost and time tab.

## Agent instructions and system prompts

Every word trace sends a model, from each specialist's role to the system prompt, can be read in the app, and the parts trace allows to change can be changed there, previewed in full, and reverted. The screen sits in two places with one layout: Admin › Agent instructions for the whole installation, and a project's Settings › Agent instructions for that project.

**How trace builds a prompt, as the screen shows it.** Each prompt is assembled from catalog entries, each with a stable name (`specialist.ams.role`). An entry is one of two kinds:

- **Editable:** the role, workflow, what counts as done, escalation wording, reporting style, the worker's task, the router's guidance, render and cloud worker instructions.
- **Locked:** the guardrails (never print tokens; never approve, merge or deploy), the rules that treat pasted text as data, and every output format trace's code reads. Locked entries are shown with a lock and can be read but never changed. Every editable entry names the locked entries that always follow it, so a change can never drop a guardrail or have the last word over one.

Three layers decide each entry's text; the most specific one with a usable change wins:

| Layer | Who changes it | Where it is kept | How a change takes effect |
| --- | --- | --- | --- |
| trace's default | Nobody in the app; it ships with trace | trace's code | Always present underneath |
| Installation | Admins | trace's installation store | At once, for every project's next job |
| Project | Contributors and admins on that project | The project's repository | Through a pull request that a person reviews, because trace's settings are protected in the repository; agents use it once merged |

**The screen.**

1. **Scope:** Installation, or a project picked from the person's projects.
2. **Catalog (left):** entries grouped by the prompt they belong to: each specialist (Role, Workflow, Done, Escalation), what all specialists share, the worker, delegation, the router, renders, the cloud worker, the memory block and the system prompt. Each shows which layer is in force (Default, Installation v1, Project v2) or a lock. Filters: Editable only, Changed only, and search by name or words.
3. **Entry (centre):** its description and name, the layer in force with who changed it and when, then a markdown editor with:
   - **Insert variable:** the variables this entry may use (`{{repository}}`, `{{branch}}`, `{{title}}`…), each explained; unknown variables are flagged as the person types.
   - **Live checks:** declared variables only, and within the length limit (16,000 characters).
   - **Always follows this (locked):** the locked entries that come after it, shown read-only with why.
   - **Compare with** the layer below or any earlier version, as a line-by-line difference.
   - **Ask trace to improve it:** trace suggests a rewrite as a difference to accept or discard.
   - **Save** needs a one-line reason. At project scope it says "Opens a pull request for review" and the entry then shows "Pending: v3 in pull request #31" until merged. **Reset** returns to the layer below; **Revert** restores any earlier version. Both need a reason too.
4. **History:** a Data table of every version: layer, who (as "You" or the person's name where the app knows it), when, reason, with Compare and Revert.
5. **Preview (right):** the whole prompt one agent would receive for one kind of job (a task, a failing check, a merge conflict, an issue), assembled from the layers in force, each part labelled with its entry name and layer, locked parts greyed. Copy prompt copies it. Under it: how many runs used this entry recently, linking to them.

**System prompts.** What trace adds to Claude Code's system prompt is two locked entries: running unattended and never printing tokens, and the project's notes, quoted from the repository's CLAUDE.md. The screen shows both; the notes are changed by editing CLAUDE.md, which the screen opens in the File viewer with a link to change it in the repository.

**When a change isn't used.** trace skips an override that targets a locked entry, an entry that no longer exists, or one that uses a variable the entry no longer has, and falls back to the layer below. The screen shows each as a warning banner naming the entry, the reason and a Fix button that opens it.

**Every run records what it used.** A run page lists the entries, layers and versions its agent received (never the text), so "why did the agent do that?" can be traced to the exact wording.

**Who sees and does what.** Anyone with a class can read the catalog and the installation's instructions; a project's instructions need access to the project. Admins change installation instructions. Contributors and admins on a project change its instructions. History is hidden from reviewers. Locked parts change for nobody.

**Reached from:** Admin, a project's Settings, each agent on Agents and tools ("Instructions in force"), and a run page's list of what it used.

## Operations

Operations (`/ops`) shows how trace itself is running: its agents, job queues, build runners, sign-in and API, knowledge bases and cloud spend. It is drawn from the CloudWatch dashboards the installer already creates, and every person sees only the metrics their access allows.

**Where the numbers come from.** trace's API reads each listed CloudWatch dashboard's definition (`GetDashboard`) and the data behind its widgets (`GetMetricData`), and the app draws the widgets as shadcn charts in trace's own look. CloudWatch stays the source of truth; Operations is a permitted view of it, not a copy. An admin with AWS console access gets Open in CloudWatch on every widget.

**Who sees what.**

| Person | Sees |
| --- | --- |
| Admin | Everything: every project, plus the installation-wide metrics (graphics card and CPU queues, build runners, the API, sign-in, account spend), alarms, and links to logs and traces |
| Contributor | Their projects only: agent runs, job waits and builds for those projects, and installation-wide health as a single status line ("Job queues healthy") without numbers from other projects |
| Reviewer | Their projects' health summary and run counts; no cost, logs or traces |

The filtering is done by trace's API on every request, using the same project assignments as the rest of the app: each widget's metrics are matched to projects through the dimensions and tags trace puts on every resource (one agent runtime, memory, knowledge base and runner per project). A widget that mixes projects is split per project for non-admins, and a widget that cannot be attributed to a project is shown to admins only.

**The screen, top to bottom.**

1. **The status line:** one sentence on how things are ("All systems normal. 2 jobs waiting on a graphics card, oldest 4 minutes."), turning amber or red with the reason when an alarm fires.
2. **Controls:** time range (1 hour, 24 hours, 7 days, 30 days, custom), a project filter limited to the person's projects, and the Wait line for refreshes ("Updated 40 seconds ago; next update in 20 seconds. Refresh now"). Alarm state changes arrive as events and update at once; metric values refresh on the shown interval, slowing down when the tab is not visible.
3. **Summary tiles:** five numbers, each with a sparkline, its change against the previous period and a status word. Agent runs (count and success rate), Median run time, Jobs waiting (and the oldest wait), Build failures, Cloud spend this month (admins only).
4. **Alarms:** CloudWatch alarms in alarm or insufficient-data state that the person may see, each with a summary in plain words, when it started, and what to do; summary first, the alarm's metric and threshold behind it.
5. **Sections,** as tabs, one per dashboard: Agents (runs, steps, tool errors, model use and latency per specialist), Jobs (graphics card and CPU queue depth, wait, run time, Spot interruptions), Builds (runner jobs, durations, failures by repository), API and sign-in (requests, errors, latency, sign-ins and failed sign-ins for admins), Knowledge bases (syncs, documents, failures), Cost (by project and service, against budgets).

**Following a number to its cause.** Tapping a point on a chart opens a side sheet for that moment: the trace runs that made it (from the record), and for admins the matching CloudWatch Logs Insights query and traces. "Why did build failures jump on Tuesday?" in Ask trace answers with the same charts as cards.

**Inside a project.** The project's Evidence tab links to Operations already filtered to that project, and admins see the same sections under the project's Cost and time tab.

**Choosing the dashboards.** Admin › Installation lists the account's CloudWatch dashboards that trace created (and any others an admin adds by name), with, for each widget, who may see it: Admins, Project members, or Everyone (health only). New widgets added in CloudWatch appear in Operations as admin-only until an admin opens them up.

**On a phone** the status line and alarms come first, the tiles stack two by two, and each section's charts scroll sideways one at a time.

## Agents and tools

Agents and tools (`/agents`) shows every agent and every tool trace has, what each is doing right now, and whether it can work, so a person never has to guess why something is slow or unavailable. It updates live from the same events as the rest of the app.

**Agents.** One row per agent: the six specialists (Verification, Implementation, Analog and mixed-signal, EMC, Rendering, Thermal) and the Worker that makes code changes for them.

| Column | Shows |
| --- | --- |
| Status | Working, Idle, Queued, Waiting on a person, Stuck, or Unavailable, each with its icon and word |
| Now | What it is doing in plain words and for which project ("Routing the Soil sensor board, stage 1 of 2"), as a Run line with Pause and Cancel for people allowed to |
| Queue | Jobs waiting for it, oldest first, with Move up |
| Today | Runs, success rate and median time, from Operations |
| Instructions | Which layer of its instructions is in force (trace's default, the installation's, the project's), linking to Admin › Agent instructions for admins |

Opening an agent shows its recent runs, the questions it is waiting on, the tools it used most, and, for a stuck agent, why it stopped and trace's recommendation for getting it moving.

**Tools.** The catalogue of trace's tools, grouped by family as people think of them: design files (KiCad), calculators, simulation (SPICE, mixed-signal, digital), protocols and timing, datasheets and parts, verification, FPGA, firmware, layout and routing, rendering, EMC, thermal, bench instruments (hardware in the loop), knowledge and memory. Each tool shows:

- its name in plain words and its tool name in mono ("Check parts against the build quantity · `parts.bom_check`"), with its one-line description;
- **where it runs:** on the project's agent, on a graphics card, on a CPU job, or only on the bench machine;
- **status:** Ready; Busy (with the queue wait); Needs setup (with the one thing to do, such as "Add a Nexar key for live stock" or "Graphics card image still building, about 25 minutes"); Unavailable (with why); or Bench only ("Runs on a machine with hardware allowed; not from the web");
- **last used** and its error rate over the selected period;
- a **Try it** button for read-only tools, which runs it on the person's project from a short form built from the tool's own input description and shows the result in its viewer.

**Only what the person may see and use.** The catalogue comes from the API's tool list, which already leaves out bench tools and tools hidden from the API. Reviewers see agents' statuses and the catalogue but no Try it and no controls; contributors can try read-only tools and pause or cancel work on their projects; admins can do everything, on every project. Status for another project's work shows only as "Busy" with the wait, never what the other project is doing.

**Hand-offs between agents.** Specialists consult each other only through recorded hand-offs, and they are listed here: who asked whom, the question, and where it stands (Requested, Queued, Working on it, Answered, Could not answer, Declined, Not answered), open ones first. Unfolded, a hand-off shows what it blocks, its evidence, the asker's recommended answer, what a good answer contains, and the answer with its evidence and confidence. A pending one has Decline for contributors and admins: the reason is required, one line, and the asking specialist reads it. A run page shows the hand-off its job answers, or the ones it raised, the same way.

**Where else it appears.** The project page's "trace is doing" list links here filtered to that project. In chat, every tool row and hand-off links to the tool or agent. In Operations, the Agents tab charts the same agents over time; this page is the live view.

## Knowledge

Knowledge (`/knowledge`) is where a person explores everything trace's agents know and draw on: each project's knowledge base, the datasheet and parts library shared by every project, and what the agents remember. It shows only entries from projects the person is on, and only those relevant to what they are looking for.

**Three kinds of knowledge, one search.**

| Tab | What it holds | Comes from |
| --- | --- | --- |
| Documents | Each project's knowledge base: its specs, notes, rules, design docs and anything attached in chat | The project's Bedrock knowledge base (`kb.search`, `kb.sync`) |
| Datasheets and parts | The shared library: every datasheet with its pages and extracted tables, and the parts database with stock, prices and lifecycle | trace's central library (this replaces a separate Library screen; the Library rows in the inventory live here) |
| Agent memory | What each project's agents remember: facts, decisions, the person's answers, preferences, summaries of past work | Each project's agent memory (`memory.list`, `memory.recall`) |

**Search first.** The page opens on one search box with the scope beside it: This project (when arriving from a project), All my projects, or Shared library. Results are ranked by relevance and cut off below a relevance threshold, so a search returns a short list of strong matches rather than everything that mentions a word; "Show weaker matches" opens the rest. Each result shows a summary line, the source (document and page, datasheet and page, or the memory and when it was made), the project it belongs to, and the matching passage with the words highlighted. Ask trace can answer from the same results, and its answer cites them as chips.

**Browsing.** Without a search, each tab lists its entries by project and kind, newest first, with filters for kind, project, date and status. Opening an entry shows it in the File viewer (documents and datasheets, at the cited page) or as a memory card (the memory's text, which agent made it, when, from which conversation or run, and what has used it since).

**Only what is permitted.**

- Entries come back only from projects the person is assigned to, checked by trace's API on every request; admins see every project. The shared library is open to everyone signed in, because it holds only public datasheets and parts data.
- A person cannot tell that another project's entries exist: counts, filters and "no results" are worked out after the access filter, never before.
- Agent memory that came from someone's private chat thread is shown only to that person and to admins.
- Distributor data bought under a key (Nexar, Mouser, DigiKey) is shown as trace already shows it in parts results, never as raw provider responses.

**Only what is relevant.** Inactive memories (ones a person switched off, or that trace marked superseded) are hidden unless "Include inactive" is on, and then shown greyed with why they were switched off. Documents removed from a project's repository disappear at the next sync. Each tab shows its own Wait line for syncs ("Knowledge base last synced 12 minutes ago; syncs on every push. Sync now").

**Changing what the agents know.**

- Contributors and admins can switch a memory off or back on, with a one-line reason, which is kept. Switching off is the safe way to correct an agent that keeps using an outdated fact; it is never deleted here.
- Adding a document is done by adding it to the project's repository or attaching it in chat (which asks first); the knowledge base syncs on the next push.
- Reviewers can search and read; they cannot change anything.

**On a phone** the search box leads, results are full-width cards, and opening one opens its viewer in a drawer at the cited page.

### Graph view

Knowledge's Graph tab (`/knowledge/graph`) draws what trace knows as a network, so a person can start from one thing and see everything it touches: the intent behind a requirement, the parts and blocks that serve it, the datasheet pages and memories that shaped it, and the runs that prove or fail it.

**What is in the graph.** Every item is a node with its own shape and colour, and every relationship a labelled link.

| Node | Shape | Comes from |
| --- | --- | --- |
| Intent statement | Rounded rectangle | The intent |
| Requirement | Circle | The requirements table |
| Block | Square | The architecture record |
| Part | Hexagon | The parts library and each project's parts list |
| Datasheet page | Folded page | The shared datasheet library |
| Run or evidence | Diamond | Runs and test results |
| Decision or waiver | Triangle | Gate records, waivers, change requests, answered questions |
| Memory | Small dotted circle | Long-term agent memory |
| Document | Lined rectangle | The project's knowledge base |
| Person | Initials | Who made a decision or answered a question |

| Link | Meaning | Source today |
| --- | --- | --- |
| derived from | A requirement comes from an intent line | Needs building: the planned link from each requirement to its intent line |
| serves, uses | A block serves a requirement; a block uses a part | Needs building: the architecture record |
| proves, fails | A run's result against a requirement | Exists: test items and results |
| cites | A memory, decision or finding points at a datasheet page | Partly: findings cite pages today; memories and decisions need their citations stored |
| decided in, waives | A decision chose or waived something | Needs building: gate and waiver records |
| learned from | A memory came from a session, run or chat | Exists: each memory's source session |
| related by meaning | Two items read alike (shown dashed) | Computed from the knowledge base's own similarity search, above a threshold |

**Exploring.**

- **Start from anything:** type in "Start from…" (a requirement, part, run, file, memory or person), or press Show in graph on any item elsewhere in the app. The focus item sits in the middle with an accent ring.
- **Depth:** 1, 2 or 3 links out (2 by default). Tapping a node selects it; Expand adds its own links.
- **Filter:** by node kind and link kind; "Related by meaning" can be switched off to see only recorded links.
- **Failing chains:** with "Show failing chains" on, a failing run colours its whole chain red back to the intent, as in the traceability view.
- **How is this connected to…:** pick a second item and the graph highlights the shortest path between them, listed in words beside it ("Bench range test → R-006 → Antenna block → u.FL connector").
- **Side sheet:** the selected item's summary, its details, its links grouped by kind, and Open (the run, the part, the file in its viewer). Hovering a node shows a one-line summary.
- **Staying readable:** at most about 150 items are drawn at once; beyond that, items of one kind gather into a dashed group ("+12 more parts") that opens on tap. A mini-map shows where the view is. Pin layout stops items moving once the person has arranged them.
- **Ask trace about this view:** trace explains the visible connections in words, with the items as chips.

**Only what is permitted.** The graph is assembled by trace's API after the access check, from projects the person is on and the shared library. A part or datasheet shared with another project shows only the person's own projects' links; items from other projects are never drawn, grouped or counted. Personal preferences in memory appear only to their owner.

**Accessible by design.** A List switch shows the same neighbourhood as a Data table (item, kind, link, linked to, status), which is also what screen readers get. Keyboard: Tab moves between items in order of distance from the focus, Enter opens, E expands, Escape closes the sheet. Shapes and words, not colour alone, tell kinds and statuses apart. On a phone the List view opens first, with the graph one tap away.

**Built with** Cytoscape.js and its force-directed layout, drawn in the app's theme tokens so it follows light and dark mode; the API adds a graph read that returns nodes and links around a focus, already filtered by access.

## Memory

Each project has a Memory tab (`/p/:id/memory`) where people see and manage what its agents remember, in two layers: recent activity, which expires on its own, and long-term memories, which people can switch off and on. The screen does only what trace's memory supports today and names the gaps rather than faking them.

**The two layers, as trace keeps them.**

| Layer | What it holds | How long | What a person can do |
| --- | --- | --- | --- |
| Recent activity (short-term) | Events per agent and per session: what was asked, what came of it, key tool results | The project's retention period: 30 days by default, 3 to 365 days set by an admin | Read it, follow it to the conversation or run; it expires on its own |
| Long-term memories | Extracted automatically a few minutes after each session, as Facts about the project, Preferences for how it wants things done, and one Summary per session; each person also has Preferences of their own | Kept until switched off; never edited or deleted | Search by meaning, read where each came from, switch one off with a reason, switch it back on |

**Long-term (the default view).**

- A summary line: "Soil sensor's agents remember 214 things long term and 1,320 recent events. Recent events are kept for 30 days."
- A search box that finds memories by meaning ("output capacitor" finds "must be at least 2.2 µF"), using the same recall the agents use.
- A Data table of memories: the memory in words, its kind, the agent, where it was learned (a chat, a run, a session, a settings change, each a link), when, and its status. Filters for kind, agent and status; Active is the default status filter, with "Include switched off" one click away.
- A side sheet for one memory: its full text, where it came from, when it was learned, and its history of switches with reasons.
- **Switch off:** asks "Why should the agents stop using this?" (required), then takes effect from the agents' next step. It never deletes the memory. Switch back on restores it. Several can be switched off at once by selecting rows.
- **Correcting a memory:** memories cannot be rewritten, so the sheet offers "Correct it instead", which switches the wrong one off and opens Question answer to write the correction as a project rule, or Change request when it changes a requirement. The correction then lasts and is traceable.
- A note under the table: "Memories are what the agents extracted; they may be stale." Memories waiting to be extracted show as a Wait line ("3 sessions finished in the last 10 minutes; their memories appear once extracted").

**Recent activity.** Sessions grouped by day, newest first, each with its agent, who or what started it (a person in chat, a push, a gate), a two-line summary, and "Expires in 29 days". Opening a session lists its events in plain words (Asked, Tool, Result, Answer) with a link to the conversation or run, and shows which long-term memories it produced. Filters: agent, date range and words. A side card states the retention period, with Change for admins in the project's Settings.

**Changes.** The log of every switch off and on: the memory, the reason, when, and who as "You" or "Someone on the project", because trace records only a fingerprint of the person, never their name.

**Who sees and does what.**

| Person | Long-term | Recent activity | Switch off and on |
| --- | --- | --- | --- |
| Admin | Every project's agents' memories | All sessions | Any memory on any project |
| Contributor | Their projects' agents' memories, and their own preferences | Their projects' sessions | Agents' memories on their projects; their own preferences |
| Reviewer | Their projects' agents' memories | Their projects' sessions | No |

A person's own preferences are shown only to them. Another person's preferences never appear, not even as a count.

**Where else memory appears.** Knowledge's Agent memory tab searches the same long-term memories across a person's projects and links here to manage them. In chat, when trace says it is relying on a memory, the memory is a chip that opens its sheet with Switch off. Admin › Installation shows each project's retention period and whether memory is turned on.

**What needs building for this screen.**

- **Used by:** which runs recalled a memory. trace does not record recalls today; without it the sheet shows where a memory came from but not where it was used.
- **Forgetting recent activity:** short-term events cannot be switched off or deleted one at a time today; the screen says so and relies on expiry. A "Forget this session" action would need event deletion in trace's memory code.
- **Changing retention from the app:** the period is set when the project's memory is created; changing it means a project settings update through the stack, which the app should run as a tracked job with a Run line.

## The installer

The installer asks for two things, AWS credentials and a GitHub token, and makes every other choice for the person with a sensible default they can open and change. It is the same shadcn look as the app, served from the person's own machine by `tracectl install`.

**Layout.** A centred column, 640 px wide, with a step indicator at the top (seven dots) and Back and Continue at the foot. Each step checks its answer before Continue wakes up, and says in one line what it checked ("Signed in to account 1234 5678 9012 as marc. Bedrock AgentCore and Claude are available in ap-southeast-2.").

| Step | Asks for | Defaults it fills in | Required |
| --- | --- | --- | --- |
| 1. Welcome | Nothing | Explains the two things needed and the 20 to 40 minutes it takes | – |
| 2. GitHub | The token | Reads the token's owner and the repositories it can reach | Yes |
| 3. AWS | A profile (single sign-on works) or access keys, and the region | Confirms the account number back to the person | Yes |
| 4. Projects | Which repositories trace runs | Onboard each one and apply its settings, both on | At least one |
| 5. People | The first admin's email | Others can be invited later from the app | Yes |
| 6. Optional | Distributor keys; Advanced settings | Model, graphics card and CPU jobs on, knowledge base on, observability on, data kept | No |
| 7. Review | Nothing | The plan as a list, in plain words, with what it will cost to run idle | – |

**Advanced settings** sit behind one fold in step 6, grouped as Agents, Graphics card and CPU jobs, Builds, Knowledge and Monitoring. Each setting shows its default and one line on why it is the default, and each group has Reset to defaults.

**Running.** After Install, the column becomes the run: each step of the plan as a row with its state (waiting, running, done, skipped, failed) and its current detail streaming under it. The one step that may need the person, authorising the AWS connection to GitHub, shows a large card with the link to open, what to click there, and a Wait line ("Checking every 15 seconds; next check in 9 seconds"). A failed step says what went wrong and that running the installer again picks up where it stopped.

**Done.** A summary card: what was created, the app's address with Open trace, and the invitation sent to the first admin. The graphics card image keeps building after the installer closes, and the card says so with an estimate.

## Notifications

trace notifies a person about four things only, and every notification is the same item that sits on Home, so acting on it in one place clears it everywhere.

- **Where they appear:** the bell's popover (the latest ten, with View all), the Inbox (`/inbox`, the phone's fourth tab), and by email for anything left unanswered for an hour. Browser and phone push are off until the person turns them on from their profile.
- **What each says:** the project and stage, a one-sentence summary, and the action as a button. A gate notification: "Soil sensor Rev A: the schematic gate is ready to sign. trace recommends signing." \[Review and sign\].
- **Who gets them:** gates and spend go to admins on the project; questions go to the person the agent asked, or the project's users if it asked no one; stuck agents go to whoever started the work.
- **Toasts** (shadcn Sonner) are not notifications. They confirm the person's own actions ("Gate signed. Layout started.") and report live changes on the screen they are looking at. They vanish on their own and are never the only place something is said.
- **Quiet hours** and per-kind channels (in app, email, push) are set in the profile. Spend notifications cannot be turned off for admins.

## Preferences

Everything a person can set for themselves lives on one Preferences screen (`/me`), in nine groups, and every choice is stored with the person rather than the browser, so it follows them to every device.

**How the screen works.** A short list of groups on the left (a `Select` on phones) and the group's settings on the right, each with its name, a one-line explanation and its control. Changes apply the moment they are made, with a quiet "Saved" beside the control; there is no Save button. Each group has Reset to defaults. A setting an admin has fixed for everyone shows locked, with the reason ("Your team requires a passkey"). Search at the top finds any setting by name, and ⌘K finds them too.

| Group | Setting | Choices | Default |
| --- | --- | --- | --- |
| Profile | Name and photo | Text; image | From the invitation |
| Profile | Time zone | Any | The browser's |
| Profile | Language of the app | English first; others as translated | The browser's, else English |
| Sign-in and security | Passkeys | Add, rename, remove | The one made at invitation |
| Sign-in and security | Password and authenticator app | Set, change, remove | As set at invitation |
| Sign-in and security | Where you are signed in | Each browser and `tracectl login` session, with Sign out | – |
| Notifications | Each of the four kinds (gate ready, question, spend, agent stuck) | In app, email, push, each on or off | In app and email on; push off |
| Notifications | Email when unanswered for | Never, 15 min, 1 h, 4 h, next morning | 1 h |
| Notifications | Quiet hours | A daily window and days | Off |
| Notifications | Per project | Normal, or only gates and spend | Normal |
| Voice | Voice | Polly's neural and generative voices for the language, each with Preview | A neural voice in the person's language |
| Voice | Speaking speed | 0.75× to 1.5× | 1× |
| Voice | Read replies aloud | Off, summary only, whole reply | Off |
| Voice | Dictation language | Transcribe's languages | The app's language |
| Voice | Microphone | Hold to talk, or tap to start and stop; which microphone | Hold to talk; the system's |
| Voice | Send when I stop talking | On, off | Off |
| Voice | Spoken commands (send, cancel, stop, read again) | On, off | On |
| Chat | Open Ask trace on wide screens | Always docked, or only when asked | Only when asked |
| Chat | Enter key | Enter sends and Shift+Enter adds a line, or ⌘Enter sends | Enter sends |
| Chat | Up and down recall sent messages | On, off | On |
| Chat | Tool rows | Folded, open | Folded |
| Chat | Show reasoning | Hidden, folded | Hidden |
| Chat | Explain technical terms | Underline every time, first time in a conversation, never | First time |
| Chat | Recommendations | Short (option and why), full (with trade-off and alternatives open) | Short |
| Display | Theme | System, light, dark | System |
| Display | Density | Comfortable, compact | Comfortable |
| Display | Text size | 90% to 125% | 100% |
| Display | Motion | Follow the system, reduced, full | Follow the system |
| Display | Status colours | Standard, high-contrast | Standard |
| Formats | Dates and times | Format; 12 or 24 hour; first day of the week | From the language and region |
| Formats | Board dimensions | Millimetres, mils, inches | Millimetres |
| Formats | Currency for costs | Any; converted at the day's rate, with the original shown on hover | US dollars, as JLCPCB quotes |
| Formats | Number style | Engineering prefixes (4.7 kΩ), or plain | Engineering prefixes |
| Work | Home page | Pin and order projects; hide finished ones | Most recent first |
| Work | Start screen | Home, or the last project | Home |
| Work | Show the tour again | Button | – |
| Work | Keyboard shortcuts | View and change | As listed under ? |
| Work | Bench mode on this device | On makes Bring-up screens large-print with a big Stop | Off |
| Your data | Chat history | Keep, or delete my threads older than 30, 90 or 365 days | Keep |
| Your data | Download my data | A file of my preferences, messages and decisions | – |

What Preferences does not hold: anything that changes a project (template, build quantity, budget, rules) is in that project's Settings, and access is set by admins. Settings that only make sense on one device (the microphone, Bench mode) are kept per device and say so.

## Responsive layout and accessibility

The app works from a 360 px phone to a 2560 px monitor using Tailwind's standard breakpoints, and everything a person decides (answering, waiving, signing, approving spend) can be done on a phone.

| Width | Breakpoint | Navigation | Ask trace | Focus mode | Side sheets |
| --- | --- | --- | --- | --- | --- |
| Under 768 px | base, `sm` | Bottom tab bar (Home, Projects, Ask, Inbox) | Full-screen tab | Steps in a drawer; quality bar as sticky footer | Bottom drawers (shadcn `Drawer`) |
| 768 to 1279 px | `md`, `lg` | Left rail as icons, labels on hover | Slides over the content | Steps as icons; trace as an overlay | Right sheets, 480 px |
| 1280 px and over | `xl`, `2xl` | Left rail with labels, collapsible | Docked on the right, 380 to 560 px | All four regions side by side | Right sheets, 560 px |

On every width: the reading column stays at most 960 px; tables become stacked cards under 640 px (each row a card with its first column as the title); Canvas visuals keep pinch and two-finger pan on touch; tap targets are at least 44 by 44 px.

**Accessibility,** to WCAG 2.2 level AA:

- Everything works from the keyboard, with a visible focus ring (shadcn's ring token). Focus mode traps focus inside itself; Escape leaves it. Shortcuts: ⌘K search, ⌘J Ask trace, G then H for Home; each listed under ? .
- Text and controls meet 4.5 to 1 contrast in both themes; status always pairs colour with an icon and a word.
- Live regions announce what changes without being asked: a run finishing, a gate becoming ready, a streamed reply ending (announced once when complete, not word by word).
- Pictures have text equivalents: every finding marker has its list row, every plot its verdict sentence and a data table on request, the stage rail reads as "Stage 3 of 9, Capture, 4 of 6 criteria met".
- Motion is limited to fades and slides under 200 ms, and turned off when the system asks for reduced motion.
- Light and dark themes both ship, following the system setting by default.

## Design tokens and components

trace keeps shadcn's neutral theme as it ships and adds five tokens: one accent and four statuses. Everything else is shadcn's defaults, so upgrading shadcn stays easy.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--primary` (accent) | `oklch(0.55 0.17 255)` | `oklch(0.72 0.14 255)` | Your move: primary buttons, the current stage, items waiting on you, focus ring |
| `--verified` | `oklch(0.60 0.14 150)` | `oklch(0.72 0.14 150)` | Met, verified, passed |
| `--warning` | `oklch(0.75 0.15 75)` | `oklch(0.80 0.14 75)` | Fix or waive; agent stuck |
| `--destructive` (shadcn's) | `oklch(0.577 0.245 27.3)` | `oklch(0.704 0.191 22.2)` | Failing; blocks the gate; Stop |
| `--waived` | `oklch(0.556 0 0)` | `oklch(0.708 0 0)` | Waived, untested, queued |

Type: Geist Sans for text and Geist Mono for part numbers, nets, run ids and code. Sizes from Tailwind's scale: 14 px body, 13 px secondary, 12 px labels, 18 and 24 px headings, 30 px only for the greeting line. Spacing on Tailwind's 4 px steps; cards use 16 px padding on phones and 24 px from `md`. Radius stays at shadcn's 0.625 rem.

**trace's own components, and the shadcn parts they are made of:**

| trace component | Made of | Used on |
| --- | --- | --- |
| Stage rail | Custom SVG, `Tooltip`, `HoverCard` | Project, Home rows, phone header |
| Next step card | `Card`, `Button`, `Badge` | Project |
| Needs-you card | `Card`, `Button`, `Badge` | Home, Inbox |
| Decision card | `Card`, `RadioGroup`, `Collapsible`, `Textarea`, `Badge` | Chat, skills, gates, questions |
| Evidence chip | `Badge`, `HoverCard`, opens a `Sheet` | Everywhere evidence is cited |
| Quality bar | `Progress`, `Tooltip`, `Button` | Focus mode |
| Stepper | `Sidebar` group in Focus mode, `Drawer` on phones | Focus mode |
| Run line | `Progress`, `DropdownMenu`, `AlertDialog` for Cancel | Home, project, chat, runs |
| Wait line | `Button`, live countdown text | Wherever trace waits on a timer |
| Criteria list | `Table`, `Checkbox`, `Sheet` | Gates |
| Glossary term | `HoverCard` (desktop), `Popover` (touch) | All text |
| Canvas frame | `ToggleGroup`, `Slider`, `Sheet`, `Tabs` | Visuals and file viewers |
| File viewer | `Card` (chat), `Sheet`, full page; `Tabs`, `ScrollArea` | Chat, Files, everywhere a file is linked |
| Status badge | `Badge` with a lucide icon | Everywhere |
| Live status dot | `Tooltip` | Top bar |
| Data table | TanStack Table with shadcn Table, Input, DropdownMenu (Columns), Popover (Filter), Badge (filter chips) | Every table |

Other shadcn parts used as they come: `Sidebar`, `Breadcrumb`, `Command` (⌘K), `Dialog`, `AlertDialog`, `Sheet`, `Drawer`, `Tabs`, `Table`, `Form` with `Input`, `Select`, `Textarea`, `Switch`, `InputOTP`, `Avatar`, `Skeleton`, `Sonner`, `Chart`, `ScrollArea`, `Separator`, `Resizable` (chat panel width).

**Every table works the same way.** All tables in trace, from requirements and runs to parts lists, people, Operations alarms and the File viewer's CSV view, are one Data table component built on TanStack Table and drawn with shadcn's `Table`, so every table can be:

- **Ordered:** click a column header to sort ascending, again for descending, again to clear; Shift-click adds a second sort. The sort shows as an arrow and is announced to screen readers.
- **Searched:** a search box above the table matches across every visible column, highlighting the matched words, with the count of matches ("12 of 240 rows").
- **Filtered:** a Filter button opens per-column filters fitted to the column's kind: a pick-list for status, class or stage; a range for numbers and dates; text contains for names. Active filters show as removable chips above the table, with Clear all.
- **Resized:** drag the edge of any column header to change its width; double-click the edge to fit the content. Widths have a sensible minimum so nothing collapses.
- **Shown or hidden:** a Columns menu lists every column with a checkbox, plus Reset to default. The first column (what the row is) cannot be hidden.
- **Reordered by column:** drag a header to move a column.

Each person's choices (sort, filters, widths, visible columns, order) are kept per table with their Preferences, so a table looks the same on their next visit and on another device; a Reset view button returns it to the default. Filters and sort are also written into the page's address, so a link shares the exact view. Large tables load page by page and keep the header and first column fixed while scrolling. On a phone, a table becomes stacked cards, and the same sort, search, filter and column choices apply to what each card shows.

**Light, dark and system.** All three ship, and every token in the table above has a light and a dark value.

- **Choosing:** System (follows the device and switches with it, the default), Light or Dark, from the person's menu in one click and from Preferences › Display. The choice is stored with the person and applies on every device, except that System always follows the device in hand.
- **No flash:** a few lines in the page head read the stored choice and set the theme class before anything paints, so a dark-mode user never sees a white flash on load. The app uses Tailwind's `dark` variant on that class, as shadcn's Vite setup does.
- **Everything follows the theme:** charts and run plots, the stage rail, the findings overlay, the traceability view and bench wiring view, code highlighting (a light and a dark Shiki theme), markdown, Operations charts, and the sign-in pages and installer. Schematic and board viewers switch between a light and a dark KiCad colour scheme.
- **What stays as it is:** photographic renders, board photos and datasheet pages are shown as made, on a neutral frame, because recolouring them would misrepresent the evidence.
- **Checked in both:** every status colour, chart series and severity marker meets contrast in both themes, and the design canvas shows Home and the gate in dark mode as the reference.

## Empty, loading, error and offline states

Every screen is designed in five states, and none of them is a blank page or a bare spinner.

| State | Rule | Example |
| --- | --- | --- |
| Loading | Skeletons in the shape of the content, shown only after 150 ms so fast loads never flash; data already held shows at once and updates in place | The project page draws its header and stage rail from cache while the lists load |
| Empty | One sentence on why it is empty and, where there is one, the action that fills it | "No runs yet. trace starts the first when the requirements baseline is signed." |
| Partial | What arrived is shown; what did not says so in its own place, with Try again | "Prices could not be loaded from LCSC. Last known prices from 2 hours ago are shown." |
| Error | What happened, in plain words; whether anything was lost; the one thing to do. Technical detail behind a fold, with a Copy for support | "Could not save the waiver: the connection dropped. Your text is kept. Try again." |
| Offline | The screen keeps what it had and says when it was true; actions that need the connection wait and send when it returns, marked "Will send when back online"; signing and spending are refused offline, with the reason | "Showing what was true at 10:42. Reconnecting." |

**No access** inside the app is never an error page: a person following a link to a project they are not on sees "This page doesn't exist, or isn't shared with you" and how to ask an admin, the same words whether the project exists or not, so they cannot tell it exists, matching how the API hides projects today.

## Decisions before building

Twelve choices need an answer before the build starts; each has trace's recommendation first.

| Decision | Recommendation | Why | Alternative not recommended |
| --- | --- | --- | --- |
| How the app is hosted | A static single-page app on S3 and CloudFront, added to the existing CDK stack | No server to run; deploys with the stack; stays inside AWS | Next.js on a server: server rendering buys little behind a sign-in, and adds a service to run |
| Where CopilotKit's runtime runs | A small Lambda with response streaming, behind the same CloudFront address, registering each trace agent as an AG-UI `HttpAgent` | One place checks the person's token and project access before any agent sees a message | Browser talks to agents directly: every agent endpoint would need its own access checks |
| How agents speak AG-UI | Add an AG-UI stream to trace's agent runtime, mapping its job steps, tool calls and questions onto AG-UI events | The interface reacts to typed events; questions become `useHumanInTheLoop` cards | Parse agent text in the browser: fragile, and loses the summary-first structure |
| The one live connection | AWS AppSync Events (managed WebSocket channels, one per project, Cognito tokens accepted) | Managed fan-out with no servers; the API publishes record changes as they happen | API Gateway WebSockets: more to build (connection table, fan-out) for the same result |
| Our own sign-in's backend | A small sign-in endpoint on the same address that calls Cognito's API and keeps the refresh token in an HTTP-only cookie; `tracectl login` moves to the same pages | Our look everywhere, passkeys included, with tokens out of browser storage | Pages calling Cognito from the browser alone: works, but the refresh token would have to live in browser storage |
| Creating projects from the app | Add project onboarding to the API, admins only, reusing the installer's onboarding code | "Start your first project" can finish in the app | Keep it in the installer: every new project would mean re-running it |
| The app's address | CloudFront's own address by default; a custom domain as an optional installer setting | Install stays two inputs | A domain required at install: adds DNS and certificates to the install |
| Email notifications | Amazon SES, set up as an optional installer step; in-app only until it is | Email needs a verified sender, which a light install should not require | Email through Cognito's own sender: limited volume and wording |
| Phone experience | The responsive web app, installable to the home screen, with web push | One codebase; every decision already works on a phone | Native apps: more to build and release for little gain |
| How voice reaches AWS | trace's API makes Polly speech for a message and voice (kept in S3 so a replay costs nothing), and hands the browser a short-lived signed address for a Transcribe streaming session | No AWS keys in the browser; the same voices and accuracy in every browser; custom vocabulary per project | The browser's own speech features: free, but voices and accuracy differ by browser, and some send audio outside AWS |
| How Operations uses CloudWatch | trace's API reads each CloudWatch dashboard's definition and the metric data behind it, filters both by the person's access, and the app draws the widgets with shadcn charts | Same look as the app; access per widget and per project, not per dashboard; no second sign-in | Embedding CloudWatch's shared dashboards: a different look, all-or-nothing access per dashboard, and a separate sign-in |
| Permissions per project (decided 27 Oct: per-project parts) | Keep the account class (admin, user, guest) and add a part per project assignment, Contributor or Reviewer, capped by the class; the API checks both | Lets one person contribute to one project and review another, which the create flow asks for; today an assignment always carries the class's full rights | Class only: simpler, but a user is a contributor everywhere they are added |
| Drawing the knowledge graph | Cytoscape.js with a force-directed layout, fed by a new API read that returns the neighbourhood of a focus item, filtered by access | Mature, handles thousands of items, has the layouts, grouping and path-finding the view needs | React Flow: excellent for hand-arranged diagrams, weaker at automatic network layout and large graphs |

Not yet decided and worth a conversation: whether reviewers may comment in chat or only at gates, and whether a project's chats are visible to everyone on the project (recommended) or only to their author.

## Screens

Every screen drawn for review, in canvas order. Desktop screens are 1440 px wide; phone screens are 390 px, shown at 2×.

### Sign in (our own pages)

![Sign in (our own pages)](ui/screens/SignIn.png)

Source: [`SignIn.dc.html`](ui/source/SignIn.dc.html)

### Home: what needs you

![Home: what needs you](ui/screens/Main.png)

Source: [`Main.dc.html`](ui/source/Main.dc.html)

### Home, dark mode

![Home, dark mode](ui/screens/HomeDark.png)

Source: [`HomeDark.dc.html`](ui/source/HomeDark.dc.html)

### Project overview

![Project overview](ui/screens/Project.png)

Source: [`Project.dc.html`](ui/source/Project.dc.html)

### New project: name, description, icon

![New project: name, description, icon](ui/screens/NewProjectBasics.png)

Source: [`NewProjectBasics.dc.html`](ui/source/NewProjectBasics.dc.html)

### New project: people and access

![New project: people and access](ui/screens/NewProject.png)

Source: [`NewProject.dc.html`](ui/source/NewProject.dc.html)

### Focus mode: Schematic finish

![Focus mode: Schematic finish](ui/screens/Focus.png)

Source: [`Focus.dc.html`](ui/source/Focus.dc.html)

### Focus mode: Intent builder

![Focus mode: Intent builder](ui/screens/Intent.png)

Source: [`Intent.dc.html`](ui/source/Intent.dc.html)

### Gate signing

![Gate signing](ui/screens/Gate.png)

Source: [`Gate.dc.html`](ui/source/Gate.dc.html)

### Gate signing, dark mode

![Gate signing, dark mode](ui/screens/GateDark.png)

Source: [`GateDark.dc.html`](ui/source/GateDark.dc.html)

### Ask trace over Requirements

![Ask trace over Requirements](ui/screens/Chat.png)

Source: [`Chat.dc.html`](ui/source/Chat.dc.html)

### Live run

![Live run](ui/screens/Run.png)

Source: [`Run.dc.html`](ui/source/Run.dc.html)

### File viewer (full page)

![File viewer (full page)](ui/screens/FileViewer.png)

Source: [`FileViewer.dc.html`](ui/source/FileViewer.dc.html)

### Knowledge

![Knowledge](ui/screens/Knowledge.png)

Source: [`Knowledge.dc.html`](ui/source/Knowledge.dc.html)

### Memory: long-term

![Memory: long-term](ui/screens/Memory.png)

Source: [`Memory.dc.html`](ui/source/Memory.dc.html)

### Memory: recent activity

![Memory: recent activity](ui/screens/MemoryRecent.png)

Source: [`MemoryRecent.dc.html`](ui/source/MemoryRecent.dc.html)

### Knowledge: graph view

![Knowledge: graph view](ui/screens/KnowledgeGraph.png)

Source: [`KnowledgeGraph.dc.html`](ui/source/KnowledgeGraph.dc.html)

### Agents and tools

![Agents and tools](ui/screens/Agents.png)

Source: [`Agents.dc.html`](ui/source/Agents.dc.html)

### Operations (from CloudWatch)

![Operations (from CloudWatch)](ui/screens/Operations.png)

Source: [`Operations.dc.html`](ui/source/Operations.dc.html)

### Fabricate: order sheet

![Fabricate: order sheet](ui/screens/Order.png)

Source: [`Order.dc.html`](ui/source/Order.dc.html)

### Admin: people and access

![Admin: people and access](ui/screens/People.png)

Source: [`People.dc.html`](ui/source/People.dc.html)

### Admin: agent instructions and system prompts

![Admin: agent instructions and system prompts](ui/screens/Prompts.png)

Source: [`Prompts.dc.html`](ui/source/Prompts.dc.html)

### Installer: running the plan

![Installer: running the plan](ui/screens/Installer.png)

Source: [`Installer.dc.html`](ui/source/Installer.dc.html)

### Preferences

![Preferences](ui/screens/Preferences.png)

Source: [`Preferences.dc.html`](ui/source/Preferences.dc.html)

### Phone: Home

![Phone: Home](ui/screens/PhoneHome.png)

Source: [`PhoneHome.dc.html`](ui/source/PhoneHome.dc.html)

### Phone: gate signing

![Phone: gate signing](ui/screens/PhoneGate.png)

Source: [`PhoneGate.dc.html`](ui/source/PhoneGate.dc.html)

### Phone: Ask trace

![Phone: Ask trace](ui/screens/PhoneAsk.png)

Source: [`PhoneAsk.dc.html`](ui/source/PhoneAsk.dc.html)
