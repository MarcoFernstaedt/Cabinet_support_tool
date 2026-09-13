using System.ComponentModel;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Contracts.Actions;

namespace CabinetPlatform.Agent.Tests.Actions;

public sealed class ProcessObservationTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Provider_retains_read_handle_identity_or_keeps_diagnostics_when_access_is_denied(bool denied)
    {
        var factory = new ReadFactory(denied);
        var provider = new ProcessProvider(factory);
        var snapshots = provider.GetProcesses(); // Observation only; never start or end a process.
        var current = Assert.Single(snapshots, p => p.Pid == Environment.ProcessId);
        Assert.NotNull(current.Name);
        if (denied) Assert.Null(current.SelectionIdentity);
        else
        {
            Assert.Equal(Environment.ProcessId, current.SelectionIdentity!.ProcessId);
            Assert.Equal("ObservedApp", current.SelectionIdentity.ProcessName);
            Assert.Equal(133700000000000001, current.SelectionIdentity.CreationTimeFileTime);
            Assert.Equal(@"C:\Lab\ObservedApp.exe", current.SelectionIdentity.ExecutablePath);
        }
        Assert.NotEmpty(factory.Handles);
        Assert.All(factory.Handles, h => { Assert.Equal(1, h.ReadCount); Assert.True(h.Disposed); });
    }

    private sealed class ReadFactory(bool denied) : IProcessObservationHandleFactory
    {
        public List<ReadHandle> Handles { get; } = [];
        public IProcessObservationHandle OpenRead(int processId)
        {
            var handle = new ReadHandle(processId, denied);
            Handles.Add(handle);
            return handle;
        }
    }
    private sealed class ReadHandle(int pid, bool denied) : IProcessObservationHandle
    {
        public bool Disposed { get; private set; }
        public int ReadCount { get; private set; }
        public ProcessSelectionIdentity Identity
        {
            get
            {
                ReadCount++;
                if (denied) throw new Win32Exception(5);
                return new ProcessSelectionIdentity { ProcessId = pid, ProcessName = "ObservedApp",
                    CreationTimeFileTime = 133700000000000001, ExecutablePath = @"C:\Lab\ObservedApp.exe" };
            }
        }
        public void Dispose() => Disposed = true;
    }
}
