using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// A small late-bound wrapper over an IDispatch COM object.
/// </summary>
/// <remarks>
/// <para>
/// The Windows Update Agent is reached this way rather than through a WUApiLib
/// interop assembly. Late binding keeps the agent buildable and testable on a
/// machine without the WUA type library registered, and it means a Windows
/// build whose WUA surface differs slightly fails on one property rather than
/// failing to load the assembly at all.
/// </para>
/// <para>
/// This does not widen what the agent can do: every call site names a specific
/// documented member, and nothing here takes a member name from the server.
/// </para>
/// </remarks>
[SupportedOSPlatform("windows")]
public sealed class ComObject : IDisposable
{
    private object? _instance;
    private readonly bool _owned;

    private ComObject(object instance, bool owned)
    {
        _instance = instance;
        _owned = owned;
    }

    /// <summary>Creates a COM object from a ProgID.</summary>
    /// <returns>Null when the class is not registered on this machine.</returns>
    public static ComObject? CreateFromProgId(string progId)
    {
        var type = Type.GetTypeFromProgID(progId, throwOnError: false);
        if (type is null)
        {
            return null;
        }

        var instance = Activator.CreateInstance(type);
        return instance is null ? null : new ComObject(instance, owned: true);
    }

    /// <summary>Wraps a COM object returned by another call.</summary>
    private static ComObject? Wrap(object? value)
        => value is null ? null : new ComObject(value, owned: false);

    private object Instance => _instance
        ?? throw new ObjectDisposedException(nameof(ComObject));

    public ComObject? GetObject(string propertyName) => Wrap(GetValue(propertyName));

    public ComObject? InvokeObject(string methodName, params object?[] arguments)
        => Wrap(Invoke(methodName, arguments));

    public object? GetValue(string propertyName)
        => Instance.GetType().InvokeMember(
            propertyName,
            BindingFlags.GetProperty,
            binder: null,
            Instance,
            args: null,
            CultureInfo.InvariantCulture);

    public object? Invoke(string methodName, params object?[] arguments)
        => Instance.GetType().InvokeMember(
            methodName,
            BindingFlags.InvokeMethod,
            binder: null,
            Instance,
            arguments,
            CultureInfo.InvariantCulture);

    public void SetValue(string propertyName, object? value)
        => Instance.GetType().InvokeMember(
            propertyName,
            BindingFlags.SetProperty,
            binder: null,
            Instance,
            new[] { value },
            CultureInfo.InvariantCulture);

    public string? GetString(string propertyName)
    {
        var value = GetValue(propertyName);
        var text = value as string ?? value?.ToString();
        return string.IsNullOrWhiteSpace(text) ? null : text.Trim();
    }

    public int? GetInt32(string propertyName) => ConvertOrNull(GetValue(propertyName), Convert.ToInt32);

    public long? GetInt64(string propertyName) => ConvertOrNull(GetValue(propertyName), Convert.ToInt64);

    public bool? GetBoolean(string propertyName) => ConvertOrNull(GetValue(propertyName), Convert.ToBoolean);

    public DateTimeOffset? GetDateTime(string propertyName)
    {
        var value = GetValue(propertyName);
        return value switch
        {
            // WUA returns history dates already in UTC.
            DateTime dateTime => new DateTimeOffset(
                DateTime.SpecifyKind(dateTime, DateTimeKind.Utc),
                TimeSpan.Zero),
            DateTimeOffset dateTimeOffset => dateTimeOffset.ToUniversalTime(),
            _ => null,
        };
    }

    /// <summary>Enumerates an IDispatch collection exposing Count and Item.</summary>
    public IEnumerable<ComObject> EnumerateCollection()
    {
        var count = GetInt32("Count") ?? 0;

        for (var index = 0; index < count; index++)
        {
            var item = Instance.GetType().InvokeMember(
                "Item",
                BindingFlags.GetProperty,
                binder: null,
                Instance,
                new object[] { index },
                CultureInfo.InvariantCulture);

            if (item is not null)
            {
                yield return new ComObject(item, owned: false);
            }
        }
    }

    private static T? ConvertOrNull<T>(object? value, Func<object, T> convert)
        where T : struct
    {
        if (value is null)
        {
            return null;
        }

        try
        {
            return convert(value);
        }
        catch (Exception e) when (e is FormatException or InvalidCastException or OverflowException)
        {
            return null;
        }
    }

    public void Dispose()
    {
        var instance = Interlocked.Exchange(ref _instance, null);

        // Only the object this wrapper created is released here. Items handed
        // out by a collection are owned by their collection.
        if (_owned && instance is not null && Marshal.IsComObject(instance))
        {
            Marshal.FinalReleaseComObject(instance);
        }
    }
}
