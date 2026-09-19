using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace CabinetPlatform.Server.Security;

/// <summary>Bounds result bodies before MVC deserializes them, including chunked requests.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class BoundedActionResultBodyAttribute : Attribute, IAsyncResourceFilter
{
    public const int MaximumBytes = 4 * 1024 * 1024;

    public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
    {
        var request = context.HttpContext.Request;
        if (request.ContentLength > MaximumBytes)
        {
            context.Result = new StatusCodeResult(StatusCodes.Status413PayloadTooLarge);
            return;
        }
        var original = request.Body;
        using var bounded = new MemoryStream();
        var buffer = new byte[64 * 1024];
        while (true)
        {
            // Read at most one byte beyond the ceiling, never buffer an unbounded
            // body and never rely on a caller-supplied Content-Length header.
            var read = await original.ReadAsync(buffer.AsMemory(0,
                (int)Math.Min(buffer.Length, MaximumBytes - bounded.Length + 1)), context.HttpContext.RequestAborted);
            if (read == 0) break;
            if (bounded.Length + read > MaximumBytes)
            {
                context.Result = new StatusCodeResult(StatusCodes.Status413PayloadTooLarge);
                return;
            }
            await bounded.WriteAsync(buffer.AsMemory(0, read), context.HttpContext.RequestAborted);
        }
        bounded.Position = 0;
        request.Body = bounded;
        try { await next(); }
        finally { request.Body = original; }
    }
}
