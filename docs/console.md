# Support Console

> **Historical WPF documentation only.** This page describes the retired desktop delivery path and its old authorization assumptions. It is not the target architecture, staff access policy, release gate or a fallback Console. For current scope and authority requirements see [web-only delivery plan](web-only-delivery-plan.md), [architecture](architecture.md) and [release gates](readiness.md). Do not use this page to authorize broad cabinet access or controlled changes.

The WPF desktop application support staff use: sign in, find a cabinet,
read its health, and run approved actions — instead of taking a remote
desktop session into a clinic's machine.

Any signed-in rep may reach any cabinet at any time. There is no case
scoping, no open-ticket requirement to look, and no per-rep cabinet
assignment: a rep taking a call about a cabinet has no way to know in
advance which one it will be. What replaces scoping is the audit trail —
viewing needs no reason, but every *action* requires a reason and a
ticket reference, and every action and every refusal writes a row.

## Projects

| Project | Target | Purpose |
| --- | --- | --- |
| `CabinetPlatform.Console.Core` | `net8.0` | Every ViewModel, the API client, and all presentation logic. No WPF reference. |
| `CabinetPlatform.Console` | `net8.0-windows` | The WPF shell: windows, XAML, converters, DI wiring. |
| `CabinetPlatform.Console.Core.Tests` | `net8.0` | Drives the real API client against the real server, hosted in-process. |

The split is load-bearing rather than tidy. A ViewModel in `Core` cannot
reach for a `Window`, a `Dispatcher` or a `MessageBox`, because none of
those types are on its compile path — so "no business logic in
code-behind" is a property of the build rather than a rule people
remember. It also means the whole logic layer is testable on any
platform, which is why the unhappy paths in this client are covered at
all.

## Building and running

```
dotnet build CabinetPlatform.sln
dotnet test  CabinetPlatform.sln
```

The WPF project needs the Windows Desktop SDK. Any Windows machine has
it, and so does the official .NET SDK on Linux and macOS when
`EnableWindowsTargeting` is set, which this project sets. Some
distribution-packaged SDKs — Ubuntu's `dotnet-sdk-8.0` among them — are
source-built with the Windows Desktop SDK stripped out, and on those the
Console project cannot be evaluated at all. The `Core`, `Contracts`,
`Server` and both test projects build and test anywhere:

```
dotnet test tests/CabinetPlatform.Console.Core.Tests
dotnet test tests/CabinetPlatform.Server.Tests
```

Point the console at a server with `Api:BaseAddress` in
`appsettings.json`, or with the environment variable
`MASHURA_CONSOLE_Api__BaseAddress`. There is no UI for editing it: a
support tool whose operator can aim it at an arbitrary host is a
credential-harvesting target.

## Architecture

```
LoginWindow ──► ShellViewModel ──► MainWindow
                      │
                      ├── CabinetFinderViewModel    (search, clients, hierarchy, recent)
                      ├── CabinetListViewModel      (left pane)
                      ├── MachineTabViewModel       (9 collapsible sections)
                      ├── CabinetTabViewModel       (honest empty state)
                      ├── AuditTabViewModel         (any signed-in rep)
                      ├── FleetTabViewModel         (aggregate health)
                      └── ApprovalsViewModel        (any signed-in rep)
                      │
                      └── IApiClient ──► the support server
```

Approvals and Audit are open to every rep. The four-eyes rule is about
separation of people, not rank, so any authenticated rep may approve
another's request — and none may approve their own.

`IApiClient` is the only place in the console that speaks HTTP: one typed
method per endpoint, returning Contracts types. No ViewModel builds a
URL, sets a header, or reads a status code. That is what lets the
behaviour on 401, 403, 429 and an unreachable server be written once
instead of reinvented per screen with slightly different bugs.

Every asynchronous screen derives from `ObservableViewModelBase`, which
owns `IsLoading`, `ErrorMessage` and cancellation. Each load supersedes
the one before it, and navigating away cancels what is in flight — so a
slow response for the cabinet the user just left cannot land on the one
they are now looking at.

## Security posture

- **The console displays what the server allows and nothing more.**
  Greying a control out for an unauthorised user is a usability
  courtesy. The server re-resolves the principal on every request and
  refuses regardless of what the UI drew. `ApprovalsTests` asserts this
  directly: it bypasses the greyed button and calls the API, and the
  server still refuses self-approval.
- **No free-text command, script or query box exists anywhere.** Action
  parameters come from the row the user selected, every key is one the
  server's catalogue named, and the server checks each value against its
  own allow-list before an agent sees it. A test walks the markup and
  fails if any text input is even *described* in those terms.
- **No credential reaches disk.** The token lives in `SessionStore`, in
  memory, and is dropped on sign-out and on window close. There is no
  remember-me. Password fields are cleared the moment the server
  answers, on failure as well as success.
- **No hardware actuation.** There is no drawer, lock or cubie control,
  and the Cabinet tab says so in as many words, because a tab about
  drawers is exactly where somebody would look for a button to open one.
  The three reserved action names exist on the server and are refused
  there; the console does not offer them, so there is no control whose
  only protection is the server saying no.
- **The cabinet is confirmed before any action runs.** Every action
  dialog restates the whole path — client, site, department, cabinet,
  role and serial — and will not enable its submit button until the
  operator ticks a box confirming it is the right one. Cancelling and
  submitting without confirming are treated identically. Where the name
  is shared with another cabinet in the result the rep came from, the
  dialog says so in words in its warnings list, not only with an icon.

## Finding a cabinet

Picking the wrong cabinet is the most likely serious operator error this
product has, so identification gets more attention than anything else in
the UI.

- **A search box is reachable from anywhere.** It is docked at the top of
  the main window, outside any tab, with `Ctrl+F` bound at window level
  and an access key on its label. A rep on a call does not navigate to
  search; it is already there.
- **One term matches across everything a caller might say.** Client name,
  site, department, cabinet name, serial number, or the cabinet id
  itself — partial and case-insensitive. Callers identify their cabinet
  by whichever of those they can see, and asking them to pick the right
  field is asking them to know the data model.
- **Nothing is ever identified by a bare hostname.** Every row in every
  result, list, tree, dialog and confirmation carries the full path.
  `CabinetIdentity` renders it, so there is one spelling of it rather
  than one per screen.
- **Duplicate names are called out in words.** When two rows in a result
  share a name, each is marked with a visible marker *and* the row's
  screen-reader sentence says so, and a banner above the grid explains
  it. A colour or an icon alone fails for a rep using a screen reader and
  for one glancing at a grid — the two people most likely to pick the
  wrong row. The warning is only applied when it is true, because marking
  every row would train reps to ignore it.
- **Browsing, as well as searching.** A client list and a per-client tree
  of sites and cabinets, with each site's sync cabinet listed first — a
  site that misbehaves as a whole is usually its sync cabinet, and a rep
  should not have to find it among twenty rows.
- **A recent list, per rep, held by the server.** It follows a rep
  between machines and survives a client restart mid-call. Opening a
  cabinet's detail is what records it, so the list reflects what was
  actually looked at rather than what was clicked.
- **The detail header is persistent.** The Machine tab's path header sits
  outside the scroll region, so scrolling to the Services section cannot
  leave a rep acting on a cabinet whose name has scrolled off the top.

`CabinetFinderTests` covers this end to end against the real server: the
whole path on every row, the duplicate warning in words and on the row,
its absence when names are unique, an empty result that says so rather
than showing a blank grid, an empty search box that invites a term
instead, the recent list, and the sync-first hierarchy.

## Accessibility

Treated as functional requirements. What is in place:

- `AutomationProperties.Name` on every interactive control and every
  data column header. Column headers get it from one shared style, and
  grid rows get a whole-row sentence, so arrowing down the cabinet list
  reads the state of a cabinet rather than making the user traverse nine
  columns to assemble it.
- **No information carried by colour alone.** Every status is a
  `StatusPresentation`: a word, a distinct shape, and a severity the
  theme may colour. The severity colour is the third, redundant channel.
  Under a high-contrast theme the whole palette collapses to system
  colours and the design still reads — which is the test of whether it
  ever depended on colour.
- **Screen-reader announcements for every async result.** One live
  region at the bottom of the main window, fed through
  `ILiveRegionAnnouncer`. The WPF implementation raises the UIA
  `LiveRegionChanged` event, without which a live region is correct in
  markup and silent in practice.
- **Tables, not charts.** SMART trends are grids, and each series states
  its direction in words ("Rising, from 0 to 48"). There is no
  chart-only view anywhere.
- **Confirmation dialogs place initial focus on Cancel**, and the
  confirm button is never `IsDefault` — so a Return keystroke the user
  was already pressing cannot become consent for a reboot. A test
  asserts both, per dialog.
- **System high-contrast themes are respected**, and the palette swaps
  live when the user toggles it rather than needing a restart.

Not yet done: none of this has been exercised against a real screen
reader. The tests pin down the markup contract — names present, colour
never load-bearing, focus placed — but they cannot tell you that NVDA
reads the Machine tab in a sensible order. That pass is still owed.

## Honest gaps

The Machine tab has all nine sections the design calls for. Every one of
them is filled from real data, with two exceptions that are deliberate
rather than missing:

| Section | Source |
| --- | --- |
| Overview, Performance, Disk | The latest heartbeat, plus the inventory in force |
| Services, Network, System, Windows Update | The inventory tier |
| Event Logs | On request, via "Run an event log view" |
| Processes | On request, via "Get process list" |

Event logs and process lists are large, change constantly, and are read
for one cabinet at a time by somebody already looking at it. Sending them
from seven thousand cabinets every five minutes would dominate storage
while being read for a handful. So they travel on an action rather than
on a check-in, and the section says which action fetches it rather than
drawing an empty panel. Event logs in particular are never stored at all:
they are read, shown to the rep who asked, and not retained.

Three sections do more than display:

- **Processes** lists what is running on demand, with a filter, and turns
  a selected row into the parameters for `KillProcess` — a process id
  *and* the name the rep saw against it, which the agent re-checks before
  killing anything. It never offers a critical Windows process as a
  target.
- **Services** has a preset filter for auto-start services that are
  currently stopped, which is the shape of most "the cabinet is up but
  nothing works" calls, and a start-type control offering only the four
  types it is safe to set. Boot and System are absent rather than
  disabled.
- **Event Logs** selects a named view a Supervisor defined on the server
  and a time window, and shows the result in a grid. The console never
  composes a filter; it names one.

That distinction is the whole reason `SectionAvailability` exists, and
its kinds name the several different reasons a panel can be empty:

| Kind | Meaning |
| --- | --- |
| `Available` | Data is present |
| `NoCheckIn` | The cabinet has never reported. A newly approved cabinet sits here |
| `NoInventoryYet` | It has heartbeated but its slower inventory tier has not run |
| `CollectorFailed` | The agent tried and said why it could not |
| `Empty` | Collected, and the machine genuinely has none of that thing |
| `OnDemandOnly` | Fetched by an explicit action, not by routine telemetry |

Three ways to handle an empty panel were available, and two of them are
worse:

- Omitting the section would teach support staff that the platform does
  not do event logs, which is a worse outcome than a panel saying which
  action fetches them.
- Filling it with plausible values would look better for the length of a
  demo and cost far more afterwards. Somebody screenshots it into a
  design review, somebody else builds a threshold on it, and the first
  real reading has to fight the fake one for credibility.
- Saying why the panel is empty costs nothing and sends nobody to check a
  cabinet for a fault that is not there.

The same reasoning governs the Cabinet tab, which is empty because sensor
and drawer discovery is unfinished.

Two distinctions the code is careful about, because conflating them is
how a tool like this misleads:

- **Absent is not zero.** A drive that does not report reallocated
  sectors renders "Not reported", never "0" — which would be a clean
  bill of health invented by the formatter. A SATA spinner and an NVMe
  module report disjoint attribute sets, so this is the common case, not
  the corner case.
- **Unknown is not safe.** When the last check-in could not determine
  whether anyone is logged on, the reboot dialog says so and treats it
  as unsafe, rather than reading it as "nobody is there".

## Verification

102 tests. They drive the real `ApiClient` against the real server hosted
in-process — the real pipeline, the real authorization policies, the real
403 wording that the login screen has to tell apart from a lockout. A
hand-written fake HTTP handler would only ever prove that the client
agrees with whatever was believed about the server while writing it,
which is exactly the belief most likely to be wrong.

Covered end to end: the three distinguishable sign-in failures, the
forced password change, section availability for a cabinet that has
never checked in, SMART counters staying absent rather than becoming
zero, a rising reallocated-sector trend, action submission and refusal,
the four-eyes rule from both sides, bounded history windows, an expired
token returning the user to sign-in, and the whole of cabinet
identification described above.

`XamlContractTests` reads the markup as XML and checks it against the
Core assembly by reflection: every binding path root, every resource
key, every bound command, an accessible name on every interactive
control, the accessible `DataGrid` style everywhere, Cancel holding
focus in every dialog, and no text input described as a command or a
query. A XAML binding to a property that does not exist is not a build
error — it fails silently and the control renders blank, which on a
support tool looks exactly like a cabinet with nothing to report. These
tests were verified to fail when those mistakes are introduced
deliberately.

What the tests cannot do is run the window. The Machine tab has not been
rendered, so layout, visual states and screen-reader reading order are
unverified. That is the gap between this and a demo anyone should trust.

## Defects found while building this

One in the server, three in the console. All four were found by the
console's own tests rather than by reading the code.

In the server — the only change made outside the console:

- `GET /api/cabinets/{id}/latest` threw on every cabinet that had ever
  reported a drive. Its per-drive SMART query used
  `GroupBy().Select(g => g.First())`, which no relational provider can
  translate. Rewritten as a correlated max, with a same-instant tie
  broken in favour of the as-sampled reading over a retention roll-up.
  The Disk section could not render at all until this was fixed. The
  server's own suite passes before and after, because nothing in it
  requested `/latest` for a cabinet that had SMART data.

In the console:

- The approvals view cleared its own error message when it reloaded after
  a conflict, so a request somebody else had just decided vanished from
  the queue with no explanation. `RestoreError` now puts the message back
  after the reload, without announcing it twice.
- A cancelled request was reported to the user as `HTTP 499`. Cancelling
  mid-flight can return a response rather than throwing, so the client
  now checks the token after the call and treats a 499 arriving on an
  uncancelled token as a lost connection rather than a refusal. Someone
  who navigates away has not encountered an error.
- Two loads were started from event handlers and discarded — the SMART
  trend and the cabinet-selection detail load. Both are now awaited or
  held as observable tasks, so a caller can know when the tab has
  finished loading and an exception inside one cannot go unnoticed.
