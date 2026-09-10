using System.Text.Json;
using CabinetPlatform.Agent;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Transport;
using Microsoft.Extensions.Options;
using Serilog;

var builder = Host.CreateApplicationBuilder(args);

// Lets the same executable run as a Windows Service under LocalSystem with no
// interactive session, and as a console application for diagnosis. The service
// name here must match the one used by sc create; see docs/agent-install.md.
builder.Services.AddWindowsService(options => options.ServiceName = "CabinetPlatformAgent");

// Structured logging is configured before anything else runs, so nothing the
// agent does is unlogged. Sinks and levels come from configuration.
builder.Services.AddSerilog((services, configuration) => configuration
    .ReadFrom.Configuration(builder.Configuration)
    .ReadFrom.Services(services));

builder.Services.AddCabinetAgent(builder.Configuration);

// --collect-once runs every collector and prints the payload it would send,
// then exits. It is how the collectors are verified against a real cabinet's
// hardware, and it makes no network call and changes nothing on the machine.
if (args.Contains("--collect-once", StringComparer.OrdinalIgnoreCase))
{
    await RunCollectOnceAsync(builder).ConfigureAwait(false);
    return;
}

builder.Services.AddHostedService<Worker>();

builder.Build().Run();

static async Task RunCollectOnceAsync(HostApplicationBuilder builder)
{
    using var host = builder.Build();

    var logger = host.Services.GetRequiredService<ILogger<Program>>();
    var checkInBuilder = host.Services.GetRequiredService<CheckInBuilder>();

    logger.LogInformation("Running a single collection pass. Nothing will be sent to the server.");

    using var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(10));
    var payload = await checkInBuilder.BuildAsync(cancellation.Token).ConfigureAwait(false);

    var json = JsonSerializer.Serialize(
        payload,
        new JsonSerializerOptions(AgentJson.SerializerOptions) { WriteIndented = true });

    Console.WriteLine(json);

    if (payload.SectionErrors.Count > 0)
    {
        // Written to stderr so a redirected stdout stays valid JSON.
        Console.Error.WriteLine();
        Console.Error.WriteLine($"{payload.SectionErrors.Count} section(s) failed to collect:");

        foreach (var error in payload.SectionErrors)
        {
            Console.Error.WriteLine($"  {error.Key}: {error.Value}");
        }
    }
}

/// <summary>
/// Named so that <c>ILogger&lt;Program&gt;</c> resolves in the top-level
/// statements above.
/// </summary>
public partial class Program
{
    private protected Program()
    {
    }
}
