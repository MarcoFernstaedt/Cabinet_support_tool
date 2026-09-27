using CabinetPlatform.Agent.Actions;
using CabinetPlatform.Agent.Actions.Executors;
using CabinetPlatform.Agent.Collectors;
using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Identity;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Platform.Wmi;
using CabinetPlatform.Agent.Transport;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent;

/// <summary>
/// Composes the agent.
/// </summary>
/// <remarks>
/// Everything is registered here and resolved through the container. There is
/// no static state and no service locator, which is what lets a collector or an
/// executor be constructed in a test with fixtures in place of WMI.
/// </remarks>
public static class AgentServiceRegistration
{
    public static IServiceCollection AddCabinetAgent(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddOptions<AgentOptions>()
            .Bind(configuration.GetSection(AgentOptions.SectionName))
            .ValidateOnStart();

        services.TryAddEnumerable(
            ServiceDescriptor.Singleton<IValidateOptions<AgentOptions>, AgentOptionsValidator>());

        AddPlatform(services);
        AddIdentity(services);
        AddCollectors(services);
        AddTransport(services, configuration);
        AddActions(services);
        services.AddSingleton<Connectivity.IConnectivityProbe, Connectivity.ConnectivityProbe>();
        services.AddHostedService<Connectivity.ConnectivityWorker>();

        return services;
    }

    /// <summary>
    /// The Windows-facing edges. Each is an interface so that everything above
    /// it can be tested without Windows.
    /// </summary>
    private static void AddPlatform(IServiceCollection services)
    {
        services.AddSingleton<IClock, SystemClock>();
        services.AddSingleton<IWmiRepository, WmiRepository>();
        services.AddSingleton<SmartReader>();
        services.AddSingleton<IRegistryReader, RegistryReader>();
        services.AddSingleton<IProcessProvider, ProcessProvider>();
        services.AddSingleton<IEventLogReader, Platform.EventLogReader>();
        services.AddSingleton<IWindowsUpdateGateway, WindowsUpdateGateway>();
        services.AddSingleton<INetworkInterfaceProvider, NetworkInterfaceProvider>();
        services.AddSingleton<IServiceControlGateway, ServiceControlGateway>();
        services.AddSingleton<INativeSystemGateway, NativeSystemGateway>();
        services.AddSingleton<IScheduledUpdateWriter, ScheduledUpdateWriter>();
        services.AddSingleton<IProcessControlGateway, ProcessControlGateway>();
        services.AddSingleton<IFirewallGateway, WindowsFirewallGateway>();
        services.AddSingleton<FirewallReader>();
        services.AddSingleton<INetworkConfigurationGateway, NetworkConfigurationGateway>();
        services.AddSingleton<INetworkRollbackStore, FileNetworkRollbackStore>();
        services.AddSingleton<IServerReachabilityProbe, ServerReachabilityProbe>();
    }

    private static void AddIdentity(IServiceCollection services)
    {
        services.AddSingleton<IAgentStateStore, FileAgentStateStore>();
        services.AddSingleton<IMachineIdentityProvider, MachineIdentityProvider>();
    }

    private static void AddCollectors(IServiceCollection services)
    {
        services.AddSingleton<InstalledSoftwareReader>();
        services.AddSingleton<LogonSessionReader>();
        services.AddSingleton<CheckInBuilder>();

        // Registered in the order they run, which is also the order their
        // sections appear to whoever reads a payload.
        services.AddSingleton<ICollector, SystemCollector>();
        // Registered concretely as well: the on-demand executors take the
        // collector itself, and both must be the same instance so a sampled
        // baseline is not thrown away between them.
        services.AddSingleton<PerformanceCollector>();
        services.AddSingleton<ICollector>(sp => sp.GetRequiredService<PerformanceCollector>());
        services.AddSingleton<EventLogCollector>();
        services.AddSingleton<ICollector, ServiceCollector>();
        services.AddSingleton<ICollector, DiskCollector>();
        services.AddSingleton<ICollector, WindowsUpdateCollector>();
        services.AddSingleton<ICollector, NetworkCollector>();
    }

    private static void AddTransport(IServiceCollection services, IConfiguration configuration)
    {
        var options = configuration.GetSection(AgentOptions.SectionName).Get<AgentOptions>() ?? new AgentOptions();
        var baseAddress = Uri.TryCreate(options.ServerBaseUrl, UriKind.Absolute, out var uri)
            ? uri
            : null;

        if (options.OfficeEnrollmentFile is not null)
        {
            services.AddSingleton<IAgentCredentialProvider, OfficeAgentCredentialProvider>();
            services.AddHttpClient(OfficeAgentCredentialProvider.HttpClientName, client =>
            {
                client.BaseAddress = baseAddress;
                client.Timeout = TimeSpan.FromSeconds(20);
            }).RedactLoggedHeaders(_ => true)
                .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
        }
        else
        {
            services.AddSingleton<IAgentCredentialProvider, EnvironmentAgentCredentialProvider>();
        }
        services.AddTransient<AgentAuthenticationHandler>();

        services.AddHttpClient(AgentHttpClients.Server, client =>
        {
            if (baseAddress is not null)
            {
                client.BaseAddress = baseAddress;
            }

            // Long enough for a large payload on a slow clinic link, short
            // enough that a black-holed connection does not stall the tick.
            client.Timeout = TimeSpan.FromSeconds(100);
            client.DefaultRequestHeaders.UserAgent.ParseAdd(
                $"CabinetPlatform.Agent/{CheckInBuilder.AgentVersion}");
        }).RedactLoggedHeaders(_ => true)
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false })
            .AddHttpMessageHandler<AgentAuthenticationHandler>();

        services.AddHttpClient(AgentHttpClients.Probe, client =>
        {
            if (baseAddress is not null)
            {
                client.BaseAddress = baseAddress;
            }

            client.Timeout = TimeSpan.FromSeconds(options.Collection.ServerReachabilityTimeoutSeconds);
        });

        services.AddSingleton<IPayloadBuffer, FilePayloadBuffer>();
        services.AddSingleton<IServerClient, ServerClient>();
        services.AddSingleton<RegistrationService>();
    }

    /// <summary>
    /// Registers one executor per action.
    /// </summary>
    /// <remarks>
    /// This list is the agent's entire capability surface. An action absent
    /// from it is denied at run time; there is no generic executor to fall
    /// through to. Nothing here actuates cabinet hardware.
    /// </remarks>
    private static void AddActions(IServiceCollection services)
    {
        services.AddSingleton<ServiceNameAllowList>();
        services.AddSingleton<ProcessTargetPolicy>();
        services.AddSingleton<ActionExecutorRegistry>();
        services.AddSingleton<ActionDispatcher>();
        services.AddSingleton<ScheduledUpdateRunner>();

        // Fixed observation executors in the shipping monitoring composition.
        services.AddSingleton<IActionExecutor, GetScheduledUpdatesExecutor>();
        services.AddSingleton<IActionExecutor, CollectEventLogsExecutor>();
        services.AddSingleton<IActionExecutor, RunEventLogViewExecutor>();
        services.AddSingleton<IActionExecutor, GetProcessListExecutor>();
        services.AddSingleton<IActionExecutor, InspectFirewallExecutor>();

#if LEGACY_MAINTENANCE_TESTS
        // Historical safety regression composition. Never enabled by appsettings.
        services.AddSingleton<IActionExecutor, ScanForUpdatesExecutor>();
        services.AddSingleton<IActionExecutor, ScheduleUpdatesExecutor>();
        services.AddSingleton<IActionExecutor, InstallUpdatesNowExecutor>();
        services.AddSingleton<IActionExecutor, CancelScheduledUpdatesExecutor>();
        services.AddSingleton<IActionExecutor, CollectDiagnosticBundleExecutor>();

        // Process management
        services.AddSingleton<IActionExecutor, KillProcessExecutor>();
        services.AddSingleton<IActionExecutor, KillProcessByNameExecutor>();
        services.AddSingleton<IActionExecutor, RestartApplicationExecutor>();

        // Services
        services.AddSingleton<IActionExecutor, RestartServiceExecutor>();
        services.AddSingleton<IActionExecutor, StartServiceExecutor>();
        services.AddSingleton<IActionExecutor, StopServiceExecutor>();
        services.AddSingleton<IActionExecutor, SetServiceStartTypeExecutor>();

        // Machine state
        services.AddSingleton<IActionExecutor, RebootMachineExecutor>();

        // Network probes
        services.AddSingleton<IActionExecutor, FlushDnsCacheExecutor>();
        services.AddSingleton<IActionExecutor, RenewDhcpLeaseExecutor>();
        services.AddSingleton<IActionExecutor, PingHostExecutor>();
        services.AddSingleton<IActionExecutor, TraceRouteExecutor>();
        services.AddSingleton<IActionExecutor, TestPortConnectivityExecutor>();
        services.AddSingleton<IActionExecutor, PingCabinetExecutor>();
        services.AddSingleton<IActionExecutor, TestCabinetPortExecutor>();
        services.AddSingleton<IActionExecutor, TraceRouteToCabinetExecutor>();

        // Network configuration, all under confirm-or-revert
        services.AddSingleton<IActionExecutor, SetDnsServersExecutor>();
        services.AddSingleton<IActionExecutor, SetStaticIpAddressExecutor>();
        services.AddSingleton<IActionExecutor, SetAdapterToDhcpExecutor>();
#endif

        // Deliberately absent: OpenDrawer, UnlockLock and OpenCubie. There is
        // no executor for any of them, which is the agent's own half of the
        // guarantee that this platform does not actuate cabinet hardware. The
        // server refuses them before dispatch; an agent that somehow received
        // one would deny it for want of an implementation. Do not add one here.
    }
}
