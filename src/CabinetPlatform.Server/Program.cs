using CabinetPlatform.Contracts.Enums;
using CabinetPlatform.Server.Actions;
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

// --- Persistence ---------------------------------------------------------
// SQLite today, PostgreSQL later. Every query in this codebase is LINQ with no
// provider-specific SQL, so the swap is a package and a connection string.
builder.Services.AddDbContext<SupportDbContext>(options =>
    options.UseSqlite(
        builder.Configuration.GetConnectionString("SupportDatabase")
        ?? "Data Source=cabinet-support.db"));

// --- Domain services -----------------------------------------------------
builder.Services.AddSingleton<IPasswordHasher, Pbkdf2PasswordHasher>();
builder.Services.AddSingleton<IJwtTokenService, JwtTokenService>();
builder.Services.AddSingleton<IAgentAuthenticator, SharedSecretAgentAuthenticator>();
builder.Services.AddSingleton<IServiceAllowList, ServiceAllowList>();
builder.Services.AddScoped<IAuditService, AuditService>();
builder.Services.AddScoped<IActionParameterValidator, ActionParameterValidator>();
builder.Services.AddScoped<IActionRequestService, ActionRequestService>();
builder.Services.AddScoped<ICheckInIngestService, CheckInIngestService>();
builder.Services.AddScoped<IUserAuthenticationService, UserAuthenticationService>();
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
    .AddPolicy(AuthorizationPolicies.RequireTier1, policy => policy
        .AddAuthenticationSchemes(JwtBearerDefaults.AuthenticationScheme)
        .RequireAuthenticatedUser()
        .AddRequirements(new MinimumRoleRequirement(UserRole.Tier1))
        .AddRequirements(new PasswordNotExpiredRequirement()))
    .AddPolicy(AuthorizationPolicies.RequireTier2, policy => policy
        .AddAuthenticationSchemes(JwtBearerDefaults.AuthenticationScheme)
        .RequireAuthenticatedUser()
        .AddRequirements(new MinimumRoleRequirement(UserRole.Tier2))
        .AddRequirements(new PasswordNotExpiredRequirement()))
    .AddPolicy(AuthorizationPolicies.RequireSupervisor, policy => policy
        .AddAuthenticationSchemes(JwtBearerDefaults.AuthenticationScheme)
        .RequireAuthenticatedUser()
        .AddRequirements(new MinimumRoleRequirement(UserRole.Supervisor))
        .AddRequirements(new PasswordNotExpiredRequirement()))
    .AddPolicy(AuthorizationPolicies.RequireElevatedSql, policy => policy
        .AddAuthenticationSchemes(JwtBearerDefaults.AuthenticationScheme)
        .RequireAuthenticatedUser()
        .AddRequirements(new MinimumRoleRequirement(UserRole.Tier2))
        .AddRequirements(new ElevatedSqlRequirement())
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
    await db.Database.MigrateAsync();

    var seeder = scope.ServiceProvider.GetRequiredService<DatabaseSeeder>();
    await seeder.SeedAsync();
}

/// <summary>
/// Exposed so the integration tests can host the real pipeline, policies and
/// all, rather than a reconstruction of it that could drift.
/// </summary>
public partial class Program;
