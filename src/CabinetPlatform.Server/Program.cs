using Serilog;

var builder = WebApplication.CreateBuilder(args);

// Structured logging is configured before anything else runs: the server is
// the component that makes every authorization decision, and a decision that
// is not logged did not happen as far as an auditor is concerned.
builder.Services.AddSerilog((services, configuration) => configuration
    .ReadFrom.Configuration(builder.Configuration)
    .ReadFrom.Services(services));

builder.Services.AddControllers();

var app = builder.Build();

app.UseSerilogRequestLogging();
app.MapControllers();

app.Run();
