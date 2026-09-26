# Native Console regressions

Run only the reviewed synthetic harness in a separate Windows process. Do not attach to an existing Console, supply real credentials, or change a running application's configuration.

```
CabinetPlatform.Console.NativeTests.exe
CabinetPlatform.Console.NativeTests.exe --lifecycle
```

The default mode retains the original password-binding regression. It constructs the compiled LoginWindow without showing it, types synthetic values and checks shared bindings, command enablement, clear and detach/reattach.

The lifecycle mode shows synthetic login and shell windows in its own process and drives the actual private App.StartAsync loop. It replaces the resolved ApiClient's unused HTTP transport via test-only reflection before completing each synthetic login. The original HTTP client is disposed before any command or startup load; the replacement handler holds synthetic responses and has no network transport. No authentication command is submitted. Synthetic accepted-login state is injected, so this mode does not establish server authorization or actual credential validation.

It checks synchronous old-shell close and DataContext detachment, fresh provider/store/window/shell identity, cancellation of old HTTP work, delayed old-response isolation, expiry return to a fresh login with an explanation, and cancellation clearing the login before application shutdown. A dispatcher timer bounds ordinary progress to 20 seconds. Use an external 30-second process timeout as well: a blocked UI dispatcher cannot execute its own timeout. Require exit 0, all PASS lines and the final lifecycle stage 5. A build alone is not native execution evidence.

Portable SessionIsolationTests exercise actual LoginViewModel cancellation during response bodies and identity reads. ShellTests.Next_authorized_session_fetches_fresh_shared_history_without_reusing_old_state exercises real in-process authenticated HTTP authorization and confirms that authorized shared cabinet action history can legitimately appear after a fresh next-account fetch. Neither test deletes server history or promises per-user ownership of cabinet history.

Publish Console and harness from the same reviewed revision as Release, win-x64, self-contained. Compare CabinetPlatform.Console.dll and CabinetPlatform.Console.Core.dll between the two outputs. The Console additionally requires the approved HTTPS appsettings.json overlay; the native harness never uses that server for requests.

Windows execution, keyboard/rendering, concurrent race stress and independent review remain separate gates. The lifecycle mode has only been cross-compiled on Linux until a Windows result is attached.
