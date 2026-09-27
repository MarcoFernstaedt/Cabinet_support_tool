using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Actions;
using CabinetPlatform.Server.Hardware;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.BackgroundServices;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Infrastructure;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using System.Text.Json.Serialization;
using Serilog;

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);

// A generated, operator-owned companion file configures the bounded office lab.
// Environment and command-line overrides retain their usual higher precedence.
// No reload: revocation is an explicit, supervised server restart.
builder.Configuration.AddJsonFile("office-enrollment.json", optional: true, reloadOnChange: false)
    .AddEnvironmentVariables().AddCommandLine(args);

// Structured logging from the first line, so a failure during startup is as
// readable as one during a request. Console-only by default: the server keeps
// no local files on the request path, which is what lets several instances run
// behind a load balancer unchanged.
builder.Host.UseSerilog((context, services, configuration) => configuration
    .ReadFrom.Configuration(context.Configuration)
    .ReadFrom.Services(services)
    .Enrich.FromLogContext()
    .Enrich.WithProperty("Application", "CabinetPlatform.Server")
    .WriteTo.Console(outputTemplate:
        "[{Timestamp:HH:mm:ss} {Level:u3}] {CorrelationId} {Message:lj}{NewLine}{Exception}"));

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddHttpContextAccessor();

// --- Configuration -------------------------------------------------------
builder.Services.Configure<PasswordOptions>(
    builder.Configuration.GetSection(PasswordOptions.SectionName));
builder.Services.Configure<JwtOptions>(
    builder.Configuration.GetSection(JwtOptions.SectionName));
builder.Services.Configure<AgentAuthOptions>(
    builder.Configuration.GetSection(AgentAuthOptions.SectionName));
builder.Services.Configure<LoginSecurityOptions>(
    builder.Configuration.GetSection(LoginSecurityOptions.SectionName));
builder.Services.Configure<AgentIngestOptions>(
    builder.Configuration.GetSection(AgentIngestOptions.SectionName));
builder.Services.Configure<ActionOptions>(
    builder.Configuration.GetSection(ActionOptions.SectionName));
builder.Services.Configure<RetentionOptions>(
    builder.Configuration.GetSection(RetentionOptions.SectionName));
builder.Services.Configure<SeedOptions>(
    builder.Configuration.GetSection(SeedOptions.SectionName));
builder.Services.Configure<QueryLimitsOptions>(
    builder.Configuration.GetSection(QueryLimitsOptions.SectionName));
builder.Services.Configure<ServiceAllowListOptions>(
    builder.Configuration.GetSection(ServiceAllowListOptions.SectionName));
builder.Services.Configure<ProcessControlOptions>(
    builder.Configuration.GetSection(ProcessControlOptions.SectionName));

// --- Persistence ---------------------------------------------------------
// SQLite is fine for local development. PostgreSQL is required before any
// multi-site deployment: at seven thousand cabinets the heartbeat and SMART
// tables reach volumes SQLite cannot serve, and its single-writer lock is the
// wrong shape for twenty concurrent reps besides.
//
// Every query in this codebase is LINQ with no provider-specific SQL, so the
// choice really is just this switch and a connection string. Migrations are the
// one thing that cannot be shared — column types differ — so there is one set
// per provider, each scaffolded from its own context subclass.
string provider = builder.Configuration["Database:Provider"] ?? "Sqlite";
string connectionString = builder.Configuration.GetConnectionString("SupportDatabase")
                          ?? "Data Source=cabinet-support.db";

switch (provider.ToLowerInvariant())
{
    case "postgresql":
    case "postgres":
    case "npgsql":
        builder.Services.AddDbContext<PostgresSupportDbContext>(options =>
            options.UseNpgsql(connectionString));
        builder.Services.AddScoped<SupportDbContext>(
            sp => sp.GetRequiredService<PostgresSupportDbContext>());
        break;

    case "sqlite":
        builder.Services.AddDbContext<SqliteSupportDbContext>(options =>
            options.UseSqlite(connectionString));
        builder.Services.AddScoped<SupportDbContext>(
            sp => sp.GetRequiredService<SqliteSupportDbContext>());
        break;

    default:
        // An unrecognised provider is a startup failure, not a silent fallback
        // to the development database.
        throw new InvalidOperationException(
            $"Database:Provider '{provider}' is not supported. Use Sqlite or PostgreSql.");
}

// --- Domain services -----------------------------------------------------
builder.Services.AddSingleton<IPasswordHasher, Pbkdf2PasswordHasher>();
builder.Services.AddSingleton<IJwtTokenService, JwtTokenService>();
builder.Services.Configure<OfficeEnrollmentOptions>(builder.Configuration.GetSection("OfficeEnrollment"));
builder.Services.AddSingleton<OfficeEnrollmentStore>();
builder.Services.AddSingleton<IAgentAuthenticator>(sp =>
    sp.GetRequiredService<OfficeEnrollmentStore>().Enabled
        ? new OfficeAgentAuthenticator(sp.GetRequiredService<OfficeEnrollmentStore>(),
            sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<AgentAuthOptions>>())
        : new SharedSecretAgentAuthenticator(
            sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<AgentAuthOptions>>()));
builder.Services.AddSingleton<IServiceAllowList, ServiceAllowList>();
builder.Services.AddSingleton<IProcessAllowList, ProcessAllowList>();
builder.Services.AddSingleton<IHardwareController, NullHardwareAdapter>();
builder.Services.AddSingleton<IDrawerController>(sp => sp.GetRequiredService<IHardwareController>());
builder.Services.AddSingleton<ILockController>(sp => sp.GetRequiredService<IHardwareController>());
builder.Services.AddSingleton<ICubieController>(sp => sp.GetRequiredService<IHardwareController>());
builder.Services.AddSingleton<ISensorReader>(sp => sp.GetRequiredService<IHardwareController>());
builder.Services.AddScoped<IAuditService, AuditService>();
builder.Services.AddScoped<IActionParameterValidator, ActionParameterValidator>();
builder.Services.AddScoped<IActionRequestService, ActionRequestService>();
builder.Services.AddScoped<ICheckInIngestService, CheckInIngestService>();
builder.Services.AddScoped<IUserAuthenticationService, UserAuthenticationService>();
builder.Services.AddScoped<IRefreshTokenService, RefreshTokenService>();
builder.Services.AddScoped<ICabinetProjection, CabinetProjection>();
builder.Services.AddScoped<ICabinetClock, CabinetClock>();
builder.Services.AddScoped<IEventLogViewService, EventLogViewService>();
builder.Services.AddScoped<ICabinetSearchService, CabinetSearchService>();
builder.Services.AddScoped<DatabaseSeeder>();

builder.Services.AddHostedService<RetentionService>();
builder.Services.AddHostedService<ActionExpiryService>();

// --- Authentication ------------------------------------------------------
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer()
    .AddScheme<AgentAuthenticationSchemeOptions, AgentAuthenticationHandler>(
        AgentAuthenticationHandler.SchemeName, _ => { });

// --- Authorization -------------------------------------------------------
builder.Services.AddSingleton<IAuthorizationHandler, MinimumRoleHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, PasswordNotExpiredHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, ElevatedSqlHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, HardwareActuationHandler>();

// Denials that happen in the authorization middleware — before any controller
// runs — are recorded here. Otherwise the requests that never reach an
// endpoint would be exactly the ones leaving no trace.
builder.Services.AddSingleton<IAuthorizationMiddlewareResultHandler,
    AuditingAuthorizationResultHandler>();

builder.Services.AddAuthorizationBuilder()
    // Default deny. An endpoint that forgets its policy fails closed rather
    // than quietly serving whoever asks.
    .SetFallbackPolicy(new AuthorizationPolicyBuilder()
        .RequireAssertion(_ => false)
        .Build())
    .AddPolicy(AuthorizationPolicies.RequireAuthenticatedUser, policy => policy
        .AddAuthenticationSchemes(JwtBearerDefaults.AuthenticationScheme)
        .RequireAuthenticatedUser())
    // Every cabinet and Windows operation. Reps work any cabinet at any time,
    // so the threshold is Tier 1 — but the requirement is still here and still
    // evaluated, because the day one of these is tightened it should be a
    // change to a value rather than the introduction of a mechanism.
    .AddPolicy(AuthorizationPolicies.RequireSupportUser, policy => policy
        .AddAuthenticationSchemes(JwtBearerDefaults.AuthenticationScheme)
        .RequireAuthenticatedUser()
        .AddRequirements(new MinimumRoleRequirement(Role.Tier1))
        .AddRequirements(new PasswordNotExpiredRequirement()))
    .AddPolicy(AuthorizationPolicies.RequireSupervisor, policy => policy
        .AddAuthenticationSchemes(JwtBearerDefaults.AuthenticationScheme)
        .RequireAuthenticatedUser()
        .AddRequirements(new MinimumRoleRequirement(Role.Supervisor))
        .AddRequirements(new PasswordNotExpiredRequirement()))
    // The two standalone grants. Neither is a role and neither is implied by
    // one: a Supervisor without the grant does not hold it, which is the whole
    // reason they are separate columns.
    .AddPolicy(AuthorizationPolicies.RequireElevatedSql, policy => policy
        .AddAuthenticationSchemes(JwtBearerDefaults.AuthenticationScheme)
        .RequireAuthenticatedUser()
        .AddRequirements(new MinimumRoleRequirement(Role.Tier1))
        .AddRequirements(new ElevatedSqlRequirement())
        .AddRequirements(new PasswordNotExpiredRequirement()))
    .AddPolicy(AuthorizationPolicies.RequireHardwareActuation, policy => policy
        .AddAuthenticationSchemes(JwtBearerDefaults.AuthenticationScheme)
        .RequireAuthenticatedUser()
        .AddRequirements(new MinimumRoleRequirement(Role.Tier1))
        .AddRequirements(new HardwareActuationRequirement())
        .AddRequirements(new PasswordNotExpiredRequirement()))
    .AddPolicy(AuthorizationPolicies.RequireAgent, policy => policy
        .AddAuthenticationSchemes(AgentAuthenticationHandler.SchemeName)
        .RequireAuthenticatedUser()
        .RequireClaim(AgentAuthenticationHandler.MachineIdClaimType));

// --- Resilience ----------------------------------------------------------
// Validation parameters come from the same service that issues tokens, so the
// issuer, audience and key can never drift apart between the two halves.
builder.Services
    .AddOptions<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme)
    .Configure<IJwtTokenService>((options, tokens) =>
    {
        options.TokenValidationParameters = tokens.BuildValidationParameters();
        options.MapInboundClaims = false;
        options.Events = new JwtBearerEvents
        {
            OnTokenValidated = async context =>
            {
                var principal = context.Principal;
                if (!Guid.TryParse(principal?.FindFirst(SupportClaims.UserId)?.Value, out var userId) ||
                    !Guid.TryParse(principal?.FindFirst("security_stamp")?.Value, out var stamp))
                {
                    context.Fail("The session has ended.");
                    return;
                }

                var db = context.HttpContext.RequestServices.GetRequiredService<SupportDbContext>();
                var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == userId,
                    context.HttpContext.RequestAborted);
                if (user is null || !user.IsActive || user.SecurityStamp != stamp ||
                    principal?.FindFirst(SupportClaims.Role)?.Value != user.Role.ToString() ||
                    principal?.FindFirst(SupportClaims.ElevatedSql)?.Value != (user.HasElevatedSql ? "true" : "false") ||
                    principal?.FindFirst(SupportClaims.HardwareActuation)?.Value != (user.HasHardwareActuation ? "true" : "false") ||
                    principal?.FindFirst(SupportClaims.MustChangePassword)?.Value != (user.MustChangePassword ? "true" : "false"))
                {
                    context.Fail("The session has ended.");
                }
            }
        };
    });

// --- Resilience ----------------------------------------------------------
// Limits are read straight from configuration rather than from a second
// service provider, which would quietly duplicate every singleton.
builder.Services.AddRateLimiter(options => RateLimitPolicies.Configure(
    options,
    builder.Configuration.GetSection(LoginSecurityOptions.SectionName).Get<LoginSecurityOptions>()
        ?? new LoginSecurityOptions(),
    builder.Configuration.GetSection(AgentIngestOptions.SectionName).Get<AgentIngestOptions>()
        ?? new AgentIngestOptions()));

builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();

builder.Services.AddHealthChecks()
    .AddDbContextCheck<SupportDbContext>("database");

builder.Services
    .AddControllers()
    .AddJsonOptions(options =>
    {
        // The wire convention is defined once, in Contracts, so the agent,
        // this server and the console cannot drift apart.
        options.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter());
    });
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

WebApplication app = builder.Build();

// Never advertise a healthy office server if enrollment state is missing,
// corrupt or already owned by another process. Disabled mode touches no files.
_ = app.Services.GetRequiredService<OfficeEnrollmentStore>();

app.UseExceptionHandler();
app.UseMiddleware<CorrelationIdMiddleware>();
app.UseSerilogRequestLogging();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

// For a load balancer. Anonymous by design: a probe that needs a credential
// is a probe that reports the wrong thing when the credential expires.
app.MapHealthChecks("/health", new HealthCheckOptions
{
    ResponseWriter = async (context, report) =>
    {
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsJsonAsync(new
        {
            status = report.Status.ToString(),
            // Names and statuses only. A health probe is a public surface and
            // must not describe why a dependency is unhappy.
            checks = report.Entries.Select(e => new
            {
                name = e.Key,
                status = e.Value.Status.ToString()
            })
        });
    }
}).AllowAnonymous();

await InitialiseDatabaseAsync(app);

app.Run();

static async Task InitialiseDatabaseAsync(WebApplication app)
{
    using IServiceScope scope = app.Services.CreateScope();

    var db = scope.ServiceProvider.GetRequiredService<SupportDbContext>();
    var seeder = scope.ServiceProvider.GetRequiredService<DatabaseSeeder>();
    var applied = (await db.Database.GetAppliedMigrationsAsync()).ToArray();
    // On a new database the user table does not exist yet. On a populated
    // legacy database, bootstrap settings are irrelevant and must not block it.
    if (applied.Length == 0 || !await db.Users.AnyAsync())
        seeder.ValidateBootstrapConfiguration();
    if ((await db.Database.GetPendingMigrationsAsync()).Any(m =>
            m.EndsWith("_CaseInsensitiveUsernames", StringComparison.Ordinal)) &&
        applied.Length != 0)
    {
        var names = await db.Users.AsNoTracking().Select(u => new { u.Id, u.Username }).ToListAsync();
        var collision = names.GroupBy(u => u.Username, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(g => g.Count() > 1);
        if (collision is not null)
            throw new InvalidOperationException("Case-equivalent staff usernames already exist: " +
                string.Join(", ", collision.Select(u => u.Id)) + ". Resolve them manually before migration.");
    }
    await db.Database.MigrateAsync();
    await seeder.SeedAsync();
}

/// <summary>
/// Exposed so the integration tests can host the real pipeline, policies and
/// all, rather than a reconstruction of it that could drift.
/// </summary>
public partial class Program;
