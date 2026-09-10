using Serilog;

var builder = Host.CreateApplicationBuilder(args);

// Structured logging is configured before anything else runs, so nothing the
// agent does is unlogged. Sinks and levels come from configuration.
builder.Services.AddSerilog((services, configuration) => configuration
    .ReadFrom.Configuration(builder.Configuration)
    .ReadFrom.Services(services));

builder.Build().Run();
