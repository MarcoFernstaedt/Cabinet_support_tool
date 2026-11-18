#if DEVELOPMENT_SSH_TRANSPORT
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Server;

internal static class DevelopmentSshTransport
{
    private const string Path = "/agent/v1/ssh-transport";
    private const int ChunkBytes = 16_384;

    internal static async Task RunAsync(AgentApiClient api, AgentConfig config, CancellationToken token)
    {
        if (config.DevelopmentSshTransportEnabled is not true || config.ReadOnlyMode)
            await Task.Delay(Timeout.InfiniteTimeSpan, token).ConfigureAwait(false);

        while (!token.IsCancellationRequested)
        {
            var claim = await api.SshTransportRequestAsync(HttpMethod.Post, Path + "/claim", null, "ssh-transport-claim", token).ConfigureAwait(false);
            var id = claim.GetProperty("transportId");
            if (id.ValueKind != JsonValueKind.Null)
                await RelayAsync(api, id.GetGuid(), token).ConfigureAwait(false);
            await Task.Delay(TimeSpan.FromSeconds(2), token).ConfigureAwait(false);
        }
    }

    private static async Task RelayAsync(AgentApiClient api, Guid transportId, CancellationToken token)
    {
        string path = $"{Path}/{transportId:D}";
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        using var ssh = new TcpClient(AddressFamily.InterNetwork) { NoDelay = true };
        try
        {
            await ssh.ConnectAsync(IPAddress.Loopback, 22, stop.Token).ConfigureAwait(false);
            using NetworkStream socket = ssh.GetStream();
            Task upload = UploadAsync(api, path + "/data", socket, stop.Token);
            Task download = DownloadAsync(api, path + "/receive", socket, stop.Token);
            await Task.WhenAny(upload, download).ConfigureAwait(false);
            await stop.CancelAsync().ConfigureAwait(false);
            try { await Task.WhenAll(upload, download).ConfigureAwait(false); }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        }
        catch (AgentApiException e) when (e.Status == HttpStatusCode.NotFound) { }
        finally
        {
            ssh.Dispose();
            using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            try { await api.SshTransportRequestAsync(HttpMethod.Delete, path, null, "server-ack", cleanup.Token).ConfigureAwait(false); }
            catch (AgentApiException) { } // The platform also closes on lease expiry if the link is gone.
            catch (OperationCanceledException) when (cleanup.IsCancellationRequested) { }
        }
    }

    private static async Task UploadAsync(AgentApiClient api, string path, NetworkStream socket, CancellationToken token)
    {
        byte[] buffer = new byte[ChunkBytes];
        while (true)
        {
            int count = await socket.ReadAsync(buffer.AsMemory(), token).ConfigureAwait(false);
            if (count == 0) return;
            await api.SshTransportRequestAsync(HttpMethod.Post, path, Convert.ToBase64String(buffer, 0, count), "server-ack", token).ConfigureAwait(false);
        }
    }

    private static async Task DownloadAsync(AgentApiClient api, string path, NetworkStream socket, CancellationToken token)
    {
        byte[] buffer = new byte[ChunkBytes];
        while (!token.IsCancellationRequested)
        {
            var frame = await api.SshTransportRequestAsync(HttpMethod.Post, path, null, "ssh-transport-data", token).ConfigureAwait(false);
            string? data = frame.GetProperty("data").GetString();
            if (data is null || !Convert.TryFromBase64String(data, buffer, out int count))
                throw new IOException("Invalid SSH transport frame.");
            if (count > 0) await socket.WriteAsync(buffer.AsMemory(0, count), token).ConfigureAwait(false);
        }
    }
}
#endif
