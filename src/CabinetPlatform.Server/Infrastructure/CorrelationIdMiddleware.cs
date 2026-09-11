using Serilog.Context;

namespace CabinetPlatform.Server.Infrastructure;

/// <summary>
/// Gives every request a correlation id, echoes it back on the response, and
/// pushes it onto the Serilog context so every log line and every audit record
/// written during the request carries the same handle.
///
/// An inbound id is accepted so a trace can span the console, this server and
/// a load balancer — but it is length-capped and sanitised first, because it
/// ends up in log output and an unbounded caller-supplied string in a log is
/// how log injection works.
/// </summary>
public sealed class CorrelationIdMiddleware
{
    public const string HeaderName = "X-Correlation-Id";
    private const int MaxLength = 64;

    private readonly RequestDelegate _next;

    public CorrelationIdMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext context)
    {
        string correlationId = Resolve(context);

        context.TraceIdentifier = correlationId;
        context.Response.Headers[HeaderName] = correlationId;

        using (LogContext.PushProperty("CorrelationId", correlationId))
        {
            await _next(context);
        }
    }

    private static string Resolve(HttpContext context)
    {
        if (context.Request.Headers.TryGetValue(HeaderName, out var supplied) &&
            supplied.Count == 1 &&
            !string.IsNullOrWhiteSpace(supplied[0]))
        {
            string candidate = supplied[0]!.Trim();

            if (candidate.Length <= MaxLength && candidate.All(IsSafe))
            {
                return candidate;
            }
        }

        return context.TraceIdentifier;
    }

    private static bool IsSafe(char c) =>
        char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or ':' or '.';
}
