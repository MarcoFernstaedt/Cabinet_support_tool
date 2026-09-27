# Native Console regressions

Run only after independent review, in a separate Windows process and isolated harness directory. Parent owns Windows execution. Do not attach to a running Console, provide credentials, copy production configuration into the harness, or deploy these artifacts.

```
CabinetPlatform.Console.NativeTests.exe
CabinetPlatform.Console.NativeTests.exe --lifecycle
CabinetPlatform.Console.NativeTests.exe --lifecycle-fail
```

Default mode retains the existing password-binding checks unchanged. It constructs a hidden compiled LoginWindow, types synthetic strings, and checks shared bindings, button enablement, clear and detach/reattach. It has no HTTP client or authentication submissions.

Lifecycle mode uses a harness-only App subclass. Its OnStartup override suppresses the automatic callback queued by Application's constructor. A single explicit invocation of the actual private StartAsync loop runs after that callback, and assertions require exactly one automatic callback and three session graphs. Reflection only invokes the loop and reads its provider; it does not replace or mutate any client.

The sole product testability seam is protected virtual App.CreateTransportHandler, whose shipping implementation still calls ApiClientOptions.CreateTransportHandler. The harness override returns a new HeldHandler for each graph. It has no forwarding handler, socket client, or network send path. The factory installs it while resolving LoginViewModel, before constructing or exposing LoginWindow. This applies to every graph, not a timer-time replacement. Invalid configuration or a failed factory fails startup rather than falling back to production transport. The timer verifies each visible login is the only visible LoginWindow and uses that graph's LoginViewModel and fresh handler. The timer drives synthetic acceptance, signout, expiry and cancel; it is not a safety boundary. Synthetic accepted-login state does not establish credential validation or server authorization.

The harness owns Dispatcher.Run. Its common Stop path stops the timer, requests Application shutdown and explicitly queues dispatcher shutdown in finally, after normal-priority application cleanup. Both success and failure use that path; unhandled dispatcher exceptions also fail the run. Failure is latched so a later continuation cannot change it to success. The --lifecycle-fail mode intentionally throws after the first synthetic graph check and must exit 1 without an external kill. It is a shutdown regression, not a passing lifecycle run.

Require default mode exit 0 and its final PASS summary. Require --lifecycle exit 0, all PASS lines and final stage=5. Require --lifecycle-fail exit 1, the exact synthetic forced-failure message, and the final summary with stage=0 and exit=1. A dispatcher timer bounds ordinary progress to 20 seconds; parent must retain a 30-second external process timeout because a blocked dispatcher cannot execute its own timer. Timeout is a failure, not acceptance.

Launch each child with a cleared environment, copying only Windows/WPF user-directory essentials (SystemRoot, WINDIR, TEMP, TMP, USERPROFILE, LOCALAPPDATA, APPDATA). Do not inherit MASHURA_CONSOLE_, DOTNET_, CORECLR_, COMPlus_, proxy or startup-hook settings. Refuse appsettings*.json in the harness directory. Use the self-contained executable, a dedicated working directory and redirected stdout/stderr. Kill only the child on timeout, never an existing Console. These controls supplement the code's non-network handler; process isolation alone is not a network sandbox.

Publish Console and harness from the same reviewed revision as Release, win-x64, self-contained. Compare Console, Console.Core and Contracts DLLs and verify complete SHA256 manifests before Windows execution. Only the separate production Console output receives the approved HTTPS appsettings.json overlay. Never launch CabinetPlatform.Console.exe from the harness directory.

Portable source contracts guard the three reviewed harness defects. They do not execute WPF. Portable SessionIsolationTests cover real LoginViewModel cancellation; the shared-history ShellTests regression uses authenticated in-process HTTP. The full Release suite has independently verified preexisting failures; do not widen product capabilities to change them.

Windows native exit/cleanup behavior, rendering, keyboard/accessibility and extended concurrency remain separate acceptance gates. Cross-compilation is not native execution evidence.
