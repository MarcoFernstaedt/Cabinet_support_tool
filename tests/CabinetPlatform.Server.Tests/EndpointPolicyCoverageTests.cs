using System.Reflection;
using CabinetPlatform.Server.Controllers;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace CabinetPlatform.Server.Tests;

/// <summary>
/// The test that catches the endpoint someone forgets to protect.
///
/// The fallback policy already denies, so a forgotten attribute fails closed
/// at runtime rather than opening a hole. These tests catch it earlier, at the
/// point where it is cheap to fix, and — more importantly — they make adding a
/// new anonymous endpoint a deliberate act that has to be written down here.
/// </summary>
public sealed class EndpointPolicyCoverageTests
{
    /// <summary>
    /// The complete set of endpoints permitted to be reachable without
    /// authentication. Adding to this list is the only way to add an anonymous
    /// endpoint, and doing so should require an argument in code review.
    /// </summary>
    private static readonly HashSet<string> DeliberatelyAnonymous = new()
    {
        // Login must be reachable by definition; it is rate-limited per IP and
        // backed by per-account lockout instead.
        $"{nameof(AuthController)}.{nameof(AuthController.Login)}"
    };

    public static TheoryData<string> AllActions()
    {
        var data = new TheoryData<string>();

        foreach ((Type controller, MethodInfo action) in EnumerateActions())
        {
            data.Add($"{controller.Name}.{action.Name}");
        }

        return data;
    }

    [Fact]
    public void Every_controller_action_declares_an_explicit_policy_or_is_deliberately_anonymous()
    {
        var offenders = new List<string>();

        foreach ((Type controller, MethodInfo action) in EnumerateActions())
        {
            string name = $"{controller.Name}.{action.Name}";

            bool anonymous = action.GetCustomAttribute<AllowAnonymousAttribute>() is not null;

            AuthorizeAttribute? authorize = action.GetCustomAttribute<AuthorizeAttribute>();

            if (anonymous)
            {
                if (!DeliberatelyAnonymous.Contains(name))
                {
                    offenders.Add($"{name} is [AllowAnonymous] but is not on the reviewed list.");
                }

                continue;
            }

            if (authorize is null)
            {
                offenders.Add($"{name} has no [Authorize] attribute.");
                continue;
            }

            if (string.IsNullOrWhiteSpace(authorize.Policy))
            {
                offenders.Add($"{name} has [Authorize] but names no policy.");
                continue;
            }

            if (!AuthorizationPolicies.All.Contains(authorize.Policy))
            {
                offenders.Add($"{name} names unknown policy '{authorize.Policy}'.");
            }
        }

        Assert.True(offenders.Count == 0,
            "Endpoints without an explicit, known authorization policy:" +
            Environment.NewLine + string.Join(Environment.NewLine, offenders));
    }

    [Fact]
    public void The_anonymous_allow_list_matches_what_is_actually_anonymous()
    {
        HashSet<string> actual = EnumerateActions()
            .Where(x => x.Action.GetCustomAttribute<AllowAnonymousAttribute>() is not null)
            .Select(x => $"{x.Controller.Name}.{x.Action.Name}")
            .ToHashSet();

        // Fails in both directions: an endpoint that quietly became anonymous,
        // and a listed exemption that no longer exists and should be removed.
        Assert.Equal(DeliberatelyAnonymous.OrderBy(x => x), actual.OrderBy(x => x));
    }

    [Theory]
    [MemberData(nameof(AllActions))]
    public void Action_is_covered_by_the_policy_audit(string actionName)
    {
        // Present so the suite reports one result per endpoint: a reviewer can
        // see at a glance that a newly added route was actually examined.
        Assert.False(string.IsNullOrWhiteSpace(actionName));
    }

    private static IEnumerable<(Type Controller, MethodInfo Action)> EnumerateActions()
    {
        IEnumerable<Type> controllers = typeof(SupportControllerBase).Assembly
            .GetTypes()
            .Where(t => t is { IsAbstract: false, IsClass: true } &&
                        typeof(ControllerBase).IsAssignableFrom(t));

        foreach (Type controller in controllers.OrderBy(t => t.Name))
        {
            IEnumerable<MethodInfo> actions = controller
                .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
                .Where(m => !m.IsSpecialName &&
                            m.GetCustomAttribute<NonActionAttribute>() is null);

            foreach (MethodInfo action in actions.OrderBy(m => m.Name))
            {
                yield return (controller, action);
            }
        }
    }
}
