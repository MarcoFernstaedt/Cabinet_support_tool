// In-process runner for the session tests on hosts where VSTest's localhost listener is forbidden.
// Discover every Fact and InlineData case in these classes so adding a case cannot silently skip it.
using System.Reflection;
using Cabinet.Agent.Core.Tests;

int count = 0;
foreach (var type in new[] { typeof(SessionTransportTests), typeof(LocalSessionsTests) })
foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
{
    var attributes = method.GetCustomAttributesData();
    bool fact = attributes.Any(a => a.AttributeType.FullName == "Xunit.FactAttribute");
    bool theory = attributes.Any(a => a.AttributeType.FullName == "Xunit.TheoryAttribute");
    if (!fact && !theory) continue;
    var cases = fact ? new[] { Array.Empty<object?>() } : attributes
        .Where(a => a.AttributeType.FullName == "Xunit.InlineDataAttribute")
        .Select(a => ((IReadOnlyCollection<CustomAttributeTypedArgument>)a.ConstructorArguments[0].Value!).Select(x => x.Value).ToArray()).ToArray();
    if (cases.Length == 0) throw new InvalidOperationException($"No cases for {method.Name}");
    foreach (var argsForCase in cases)
    {
        object instance = Activator.CreateInstance(type)!;
        try
        {
            if (method.Invoke(instance, argsForCase) is Task task) await task;
            Console.WriteLine($"PASS {type.Name}.{method.Name}");
            count++;
        }
        finally { if (instance is IDisposable disposable) disposable.Dispose(); }
    }
}
Console.WriteLine($"{count} passed");
