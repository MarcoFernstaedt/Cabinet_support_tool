using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using CabinetPlatform.Agent;
using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;

internal static class ExecutorProbe
{
    internal static async Task<int> RunAsync(string mode, EventLogViewDefinition definition)
    {
        if (!OperatingSystem.IsWindows()) { Emit(new { mode, blocked = "Windows required" }); return 2; }
        try
        {
            // Empty in-memory configuration only. Never build/start a host or resolve
            // credentials, transport, identity, registry or any other executor.
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddCabinetAgent(new ConfigurationBuilder().Build());
            if (mode.StartsWith("diagnostic", StringComparison.Ordinal))
            {
                // Probe-only seam: the product reader still owns enumeration and
                // classification; this wrapper observes only native failures.
                services.RemoveAll<IEventLogReader>();
                services.AddSingleton<IEventLogReader>(sp => new EventLogReader(
                    sp.GetRequiredService<ILogger<EventLogReader>>(),
                    new WindowsEventChannelGateway(), records: new DiagnosticRecords(mode)));
            }
            var descriptor = services.Single(d => d.ServiceType == typeof(IActionExecutor)
                && d.ImplementationType == typeof(RunEventLogViewExecutor));
            using var provider = services.BuildServiceProvider();
            var reader = provider.GetRequiredService<IEventLogReader>();
            var executor = (IActionExecutor)ActivatorUtilities.CreateInstance(provider, descriptor.ImplementationType!);
            foreach (var assembly in new[] { typeof(RunEventLogViewExecutor).Assembly,
                typeof(EventLogViewDefinition).Assembly, typeof(System.Diagnostics.Eventing.Reader.EventLogQuery).Assembly })
            {
                using var file = File.OpenRead(assembly.Location);
                Emit(new { mode, stage = "provenance", assembly = assembly.GetName().Name,
                    sha256 = Convert.ToHexString(SHA256.HashData(file)),
                    mvid = assembly.ManifestModule.ModuleVersionId,
                    version = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion });
            }
            Emit(new { mode, stage = "composition", reader = reader.GetType().FullName,
                executor = executor.GetType().FullName,
                recordsRegistered = services.Any(d => d.ServiceType == typeof(IEventRecordGateway)),
                channelsRegistered = services.Any(d => d.ServiceType == typeof(IEventChannelGateway)),
                isSystem = System.Security.Principal.WindowsIdentity.GetCurrent().IsSystem,
                runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription });
            if (mode is "executor-after-discovery" or "diagnostic-after-discovery")
            {
                var discovery = reader.DiscoverChannels(default);
                Emit(new { mode, stage = "preceding-discovery", status = discovery.Status.ToString(),
                    count = discovery.Channels.Count, discovery.Truncated });
            }
            var id = Guid.Parse("00000000-0000-0000-0000-000000000001");
            var request = new ActionRequestDto
            {
                Id = id, CabinetId = id, RequestedByUserId = id,
                RequestedUtc = DateTimeOffset.UtcNow, Reason = "Standalone read-only probe",
                Action = ActionName.RunEventLogView,
                Parameters = new Dictionary<string, string>
                {
                    [ActionParameterKeys.EventLogViewId] = id.ToString(),
                    [ActionParameterKeys.HoursOfHistory] = "1",
                    [ActionParameterKeys.EventLogViewDefinition] = JsonSerializer.Serialize(definition, AgentJson.SerializerOptions)
                }
            };
            request = JsonSerializer.Deserialize<ActionRequestDto>(
                JsonSerializer.Serialize(request, AgentJson.SerializerOptions), AgentJson.SerializerOptions)!;
            bool passed = true;
            // A second invocation retains the same DI singleton after the first
            // executor's discovery. It is not a fresh-process query-syntax test.
            for (int iteration = 1; iteration <= 2; iteration++)
            {
                var outcome = await executor.ExecuteAsync(request, default);
                var result = outcome.CollectedData is null ? null : JsonSerializer.Deserialize<EventLogViewResultDto>(
                    outcome.CollectedData, AgentJson.SerializerOptions);
                bool readable = outcome.Status == ActionStatus.Succeeded && result?.ChannelReads?.Count == 1
                    && result.ChannelReads.Single().Name == "System"
                    && result.ChannelReads.Single().Access == EventChannelAccess.Readable;
                passed &= readable;
                Emit(new { mode, stage = "executor-result", iteration, status = outcome.Status.ToString(), readable,
                    entries = result?.Entries.Count,
                    outcomes = result?.ChannelReads?.Select(c => new { c.Name, access = c.Access.ToString(), c.RecordsRead, c.Truncated }),
                    discoveryStatus = result?.ChannelDiscovery?.Status.ToString(),
                    discoveryCount = result?.ChannelDiscovery?.Channels.Count });
            }
            return passed ? 0 : 1;
        }
        catch (Exception e)
        {
            // Never print messages, stack traces, event contents, paths or identity.
            Emit(new { mode, stage = "executor-probe", exceptionType = e.GetType().FullName, hresult = $"0x{e.HResult:X8}" });
            return 1;
        }
    }

    private static void Emit(object value) => Console.WriteLine(JsonSerializer.Serialize(value));

    private sealed class DiagnosticRecords(string mode) : IEventRecordGateway
    {
        public IEnumerable<EventLogEntry> Read(string channel, EventLogViewDefinition definition, CancellationToken token)
        {
            using var iterator = new WindowsEventRecordGateway().Read(channel, definition, token).GetEnumerator();
            while (true)
            {
                bool next;
                try { next = iterator.MoveNext(); }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    Emit(new { mode, stage = "native-record-failure", exceptionType = e.GetType().FullName,
                        hresult = $"0x{e.HResult:X8}", win32ErrorCode = e is System.ComponentModel.Win32Exception w ? (int?)w.NativeErrorCode : null });
                    throw;
                }
                if (!next) yield break;
                yield return iterator.Current;
            }
        }
    }
}
