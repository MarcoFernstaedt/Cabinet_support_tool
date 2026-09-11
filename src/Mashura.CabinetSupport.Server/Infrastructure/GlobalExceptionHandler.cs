using Mashura.CabinetSupport.Server.Controllers;
using Mashura.CabinetSupport.Server.Data;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;

namespace Mashura.CabinetSupport.Server.Infrastructure;

/// <summary>
/// Turns any unhandled exception into a problem-details response.
///
/// The response carries a status, a generic title and the request's
/// correlation id — never a stack trace, a connection string, a SQL fragment
/// or a type name. The detail a developer needs goes to the log, where it is
/// reachable by that same correlation id; the client gets nothing it could use
/// to map the server's internals.
/// </summary>
public sealed class GlobalExceptionHandler : IExceptionHandler
{
    /// <summary>Nginx's client-closed-request code; not in the framework's list.</summary>
    private const int ClientClosedRequest = 499;

    private readonly ILogger<GlobalExceptionHandler> _logger;
    private readonly IProblemDetailsService _problemDetails;

    public GlobalExceptionHandler(
        ILogger<GlobalExceptionHandler> logger,
        IProblemDetailsService problemDetails)
    {
        _logger = logger;
        _problemDetails = problemDetails;
    }

    public async ValueTask<bool> TryHandleAsync(
        HttpContext context, Exception exception, CancellationToken ct)
    {
        (int status, string title, string detail) = Classify(exception);

        if (status >= StatusCodes.Status500InternalServerError)
        {
            _logger.LogError(exception,
                "Unhandled exception on {Method} {Path} (correlation {CorrelationId}).",
                context.Request.Method, context.Request.Path, context.TraceIdentifier);
        }
        else
        {
            _logger.LogWarning(exception,
                "Request rejected on {Method} {Path} (correlation {CorrelationId}).",
                context.Request.Method, context.Request.Path, context.TraceIdentifier);
        }

        if (context.Response.HasStarted)
        {
            // Too late to rewrite the response; the log line above is the
            // only record this failure gets.
            return false;
        }

        context.Response.StatusCode = status;

        return await _problemDetails.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = context,
            ProblemDetails = new ProblemDetails
            {
                Status = status,
                Title = title,
                Detail = detail,
                Instance = context.Request.Path,
                Extensions = { ["correlationId"] = context.TraceIdentifier }
            }
        });
    }

    /// <summary>
    /// Only exceptions this server raises on purpose get a specific message.
    /// Everything else is a flat 500 with no detail, because guessing at a
    /// friendly message for an unknown failure is how internals leak.
    /// </summary>
    private static (int Status, string Title, string Detail) Classify(Exception exception) =>
        exception switch
        {
            AgentMachineIdMismatchException => (
                StatusCodes.Status400BadRequest,
                "Invalid request",
                "The machine id in the request does not match the authenticated agent."),

            AuditImmutabilityException => (
                StatusCodes.Status500InternalServerError,
                "Server error",
                "The request was refused to protect the integrity of the audit trail."),

            BadHttpRequestException => (
                StatusCodes.Status400BadRequest,
                "Invalid request",
                "The request body could not be read."),

            OperationCanceledException => (
                ClientClosedRequest,
                "Request cancelled",
                "The request was cancelled."),

            _ => (
                StatusCodes.Status500InternalServerError,
                "Server error",
                "An unexpected error occurred. Quote the correlation id when reporting this.")
        };
}
