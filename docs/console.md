# Support Console

The WPF desktop application support staff use: sign in, pick a client's
cabinet, read its health, and run approved actions — instead of taking a
remote desktop session into a clinic's machine.

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
                      ├── CabinetListViewModel      (left pane)
                      ├── MachineTabViewModel       (8 collapsible sections)
                      ├── CabinetTabViewModel       (honest empty state)
                      ├── AuditTabViewModel         (Supervisor only)
                      ├── FleetTabViewModel         (aggregate health)
                      └── ApprovalsViewModel        (Tier 2 and above)
                      │
                      └── IApiClient ──► the support server
```

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

The Machine tab has all eight sections the design calls for. Every one of
them is filled from real data, with two exceptions that are deliberate
rather than missing:

| Section | Source |
| --- | --- |
| Overview, Performance, Disk | The latest heartbeat, plus the inventory in force |
| Services, Network, System, Windows Update | The inventory tier |
| Event Logs | On request, via the "View event logs" action |
| The per-process list, inside Performance | On request, via the "View process list" action |

Event logs and process lists are large, change constantly, and are read
for one cabinet at a time by somebody already looking at it. Sending them
from seven thousand cabinets every five minutes would dominate storage
while being read for a handful. So they travel on an action rather than
on a check-in, and the section says which action fetches it rather than
drawing an empty panel.

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

72 tests. They drive the real `ApiClient` against the real server hosted
in-process — the real pipeline, the real authorization policies, the real
403 wording that the login screen has to tell apart from a lockout. A
hand-written fake HTTP handler would only ever prove that the client
agrees with whatever was believed about the server while writing it,
which is exactly the belief most likely to be wrong.

Covered end to end: the three distinguishable sign-in failures, the
forced password change, section availability for a cabinet that has
never checked in, SMART counters staying absent rather than becoming
zero, a rising reallocated-sector trend, action submission and refusal,
the four-eyes rule from both sides, role refusals on audit and
approvals, bounded history windows, and an expired token returning the
user to sign-in.

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
