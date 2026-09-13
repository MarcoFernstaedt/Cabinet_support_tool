using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Tests.Platform;
using CabinetPlatform.Agent.Tests.TestSupport;
using CabinetPlatform.Agent.Transport;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Logging.Abstractions;

namespace CabinetPlatform.Agent.Tests;

public sealed class RegistrationSafetyTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Invalid_approval_identity_cannot_reuse_a_stale_cabinet_after_restart(bool emptyId)
    {
        var state = new InMemoryAgentStateStore(new AgentState
        {
            CabinetId = Guid.NewGuid(), RegistrationStatus = RegistrationStatus.Pending
        });
        var client = new RegistrationClient(new RegistrationResponse
        {
            Status = RegistrationStatus.Approved, CabinetId = emptyId ? Guid.Empty : null, RetryAfterSeconds = 60
        });
        Assert.False(await Service(client, state).EnsureRegisteredAsync(CancellationToken.None));
        Assert.False(state.Load().IsApproved);
        Assert.Null(state.Load().CabinetId);
        Assert.False(await Service(client, state).EnsureRegisteredAsync(CancellationToken.None));
        Assert.Equal(2, client.Calls);
    }

    [Fact]
    public void Empty_checkin_identity_cannot_activate_a_pending_agent()
    {
        var state = new InMemoryAgentStateStore(new AgentState());
        var client = new RegistrationClient(new RegistrationResponse { Status = RegistrationStatus.Pending, RetryAfterSeconds = 60 });
        Service(client, state).RecordApproval(Guid.Empty);
        Assert.False(state.Load().IsApproved);
        Assert.Null(state.Load().CabinetId);
    }

    [Fact]
    public async Task Empty_identity_in_persisted_approval_is_revalidated_instead_of_trusted()
    {
        var state = new InMemoryAgentStateStore(new AgentState { CabinetId = Guid.Empty, RegistrationStatus = RegistrationStatus.Approved });
        var client = new RegistrationClient(new RegistrationResponse { Status = RegistrationStatus.Pending, RetryAfterSeconds = 60 });
        Assert.False(await Service(client, state).EnsureRegisteredAsync(CancellationToken.None));
        Assert.Equal(1, client.Calls);
        Assert.Null(state.Load().CabinetId);
    }

    private static RegistrationService Service(RegistrationClient client, InMemoryAgentStateStore state) =>
        new(client, state, new Identity(), new FakeWmiRepository(), new FixedClock(DateTimeOffset.UtcNow),
            NullLogger<RegistrationService>.Instance);

    private sealed class Identity : IMachineIdentityProvider
    {
        public string GetMachineId() => "registration-test-machine";
    }

    private sealed class RegistrationClient(RegistrationResponse response) : IServerClient
    {
        public int Calls;
        public Task<RegistrationResponse?> RegisterAsync(RegistrationRequest request, CancellationToken token)
        {
            Calls++;
            return Task.FromResult<RegistrationResponse?>(response);
        }
        public Task<CheckInResult> CheckInAsync(CheckInPayload payload, CheckInTier tier, CancellationToken token) => throw new NotSupportedException();
        public Task<IReadOnlyList<ActionRequestDto>> GetPendingActionsAsync(Guid cabinet, CancellationToken token) => throw new NotSupportedException();
        public Task<bool> ReportActionResultAsync(ActionResultDto result, CancellationToken token) => throw new NotSupportedException();
    }
}
