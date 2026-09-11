using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using Microsoft.AspNetCore.Mvc;

namespace CabinetPlatform.Server.Controllers;

[ApiController]
[Produces("application/json")]
public abstract class SupportControllerBase : ControllerBase
{
    /// <summary>
    /// The caller, resolved from the signed token. Throws rather than returning
    /// null: an action reachable without an authenticated user should have been
    /// stopped by its policy, and a controller quietly coping with a missing
    /// principal is how an authorization hole hides.
    /// </summary>
    protected CurrentUser CurrentUser =>
        User.GetCurrentUser()
        ?? throw new InvalidOperationException(
            "No authenticated support user on a request that requires one.");

    /// <summary>Maps a refusal to a status code without leaking internals.</summary>
    protected ActionResult Problem(OperationResult result)
    {
        string detail = result.Reason ?? "The request could not be completed.";

        return result.Failure switch
        {
            OperationFailure.NotFound => Problem(detail, statusCode: StatusCodes.Status404NotFound,
                title: "Not found"),
            OperationFailure.Forbidden => Problem(detail, statusCode: StatusCodes.Status403Forbidden,
                title: "Forbidden"),
            OperationFailure.Conflict => Problem(detail, statusCode: StatusCodes.Status409Conflict,
                title: "Conflict"),
            _ => Problem(detail, statusCode: StatusCodes.Status400BadRequest, title: "Invalid request")
        };
    }
}
