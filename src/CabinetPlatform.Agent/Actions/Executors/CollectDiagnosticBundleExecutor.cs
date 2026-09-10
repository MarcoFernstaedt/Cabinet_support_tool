using System.IO.Compression;
using System.Text.Json;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Actions.Executors;

/// <summary>
/// Zips the agent's recent logs and a fresh payload snapshot for support review.
/// </summary>
/// <remarks>
/// <para>
/// The bundle contains the agent's own logs and the same diagnostic data a
/// check-in carries. It does not sweep the machine: no user documents, no
/// clinical data, no dispensing records, and nothing from the cabinet
/// application's own data store.
/// </para>
/// <para>
/// No biometric data is read, stored or included, here or anywhere else in the
/// agent.
/// </para>
/// </remarks>
public sealed class CollectDiagnosticBundleExecutor : IActionExecutor
{
    private static readonly string[] PermittedParameters = { ActionParameters.BundleNote };

    /// <summary>Log files older than this are not worth bundling.</summary>
    private static readonly TimeSpan LogWindow = TimeSpan.FromDays(7);

    /// <summary>
    /// Keeps a bundle from growing without bound on a cabinet whose logs have
    /// been rolling for months.
    /// </summary>
    private const long MaximumLogBytes = 32L * 1024L * 1024L;

    private readonly CheckInBuilder _checkInBuilder;
    private readonly IClock _clock;
    private readonly AgentOptions _options;
    private readonly ILogger<CollectDiagnosticBundleExecutor> _logger;

    public CollectDiagnosticBundleExecutor(
        CheckInBuilder checkInBuilder,
        IClock clock,
        IOptions<AgentOptions> options,
        ILogger<CollectDiagnosticBundleExecutor> logger)
    {
        _checkInBuilder = checkInBuilder;
        _clock = clock;
        _options = options.Value;
        _logger = logger;
    }

    public ActionName Action => ActionName.CollectDiagnosticBundle;

    public async Task<ActionOutcome> ExecuteAsync(ActionRequestDto request, CancellationToken cancellationToken)
    {
        if (!ActionParameters.TryValidateNoUnknownParameters(request, PermittedParameters, out var unknownFailure))
        {
            return ActionOutcome.Denied(unknownFailure);
        }

        var bundleDirectory = Path.GetFullPath(_options.Actions.DiagnosticBundleDirectory);
        Directory.CreateDirectory(bundleDirectory);

        var bundlePath = Path.Combine(
            bundleDirectory,
            $"diagnostics-{_clock.UtcNow:yyyyMMddTHHmmssZ}-{request.Id:N}.zip");

        try
        {
            var payload = await _checkInBuilder.BuildAsync(cancellationToken).ConfigureAwait(false);

            using (var archive = ZipFile.Open(bundlePath, ZipArchiveMode.Create))
            {
                WriteSnapshot(archive, payload);
                WriteManifest(archive, request, payload.SectionErrors.Count);

                var logCount = WriteLogs(archive);

                _logger.LogInformation(
                    "Diagnostic bundle written to {BundlePath} with {LogCount} log file(s).",
                    bundlePath,
                    logCount);
            }

            var sizeBytes = new FileInfo(bundlePath).Length;

            return ActionOutcome.Succeeded(
                $"A diagnostic bundle was written to {bundlePath} ({sizeBytes / 1024} KB). " +
                "It contains the agent's own logs and a check-in snapshot, and no clinical or user data.");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            TryDeletePartialBundle(bundlePath);
            throw;
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "The diagnostic bundle could not be written.");
            TryDeletePartialBundle(bundlePath);

            return ActionOutcome.Failed($"The diagnostic bundle could not be written. {e.Message}");
        }
    }

    private static void WriteSnapshot(ZipArchive archive, Contracts.Telemetry.CheckInPayload payload)
    {
        var entry = archive.CreateEntry("checkin-snapshot.json", CompressionLevel.Optimal);
        using var stream = entry.Open();
        JsonSerializer.Serialize(stream, payload, AgentJson.SerializerOptions);
    }

    private void WriteManifest(ZipArchive archive, ActionRequestDto request, int sectionErrorCount)
    {
        var manifest = new
        {
            CollectedAtUtc = _clock.UtcNow,
            AgentVersion = CheckInBuilder.AgentVersion,
            RequestId = request.Id,
            request.RequestedByUserId,
            request.Reason,
            request.TicketReference,
            Note = request.Parameters.TryGetValue(ActionParameters.BundleNote, out var note) ? note : null,
            SectionErrorCount = sectionErrorCount,
            Contents = "The agent's rolling logs and one check-in snapshot. No clinical, user or biometric data.",
        };

        var entry = archive.CreateEntry("manifest.json", CompressionLevel.Optimal);
        using var stream = entry.Open();
        JsonSerializer.Serialize(stream, manifest, AgentJson.SerializerOptions);
    }

    private int WriteLogs(ZipArchive archive)
    {
        var logDirectory = Path.GetFullPath(_options.LogDirectory);
        if (!Directory.Exists(logDirectory))
        {
            return 0;
        }

        var cutoff = _clock.UtcNow - LogWindow;
        var written = 0;
        var bytesWritten = 0L;

        var logs = new DirectoryInfo(logDirectory)
            .GetFiles("*.log")
            .Where(file => file.LastWriteTimeUtc >= cutoff)
            // Newest first, so the size cap drops the least relevant logs.
            .OrderByDescending(file => file.LastWriteTimeUtc);

        foreach (var log in logs)
        {
            if (bytesWritten + log.Length > MaximumLogBytes)
            {
                continue;
            }

            try
            {
                // The agent holds its own log file open, so it is copied
                // through a read-share stream rather than by path.
                var entry = archive.CreateEntry($"logs/{log.Name}", CompressionLevel.Optimal);

                using var source = new FileStream(
                    log.FullName,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete);

                using var destination = entry.Open();
                source.CopyTo(destination);

                bytesWritten += log.Length;
                written++;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                _logger.LogDebug(e, "Log file {LogName} could not be added to the bundle.", log.Name);
            }
        }

        return written;
    }

    private void TryDeletePartialBundle(string bundlePath)
    {
        try
        {
            if (File.Exists(bundlePath))
            {
                File.Delete(bundlePath);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _logger.LogDebug(e, "A partial bundle at {BundlePath} could not be removed.", bundlePath);
        }
    }
}
