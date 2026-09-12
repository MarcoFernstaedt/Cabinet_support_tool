namespace CabinetPlatform.Server.Hardware;

/// <summary>
/// Why a hardware read could not be served.
/// </summary>
/// <remarks>
/// There is no success case in this build. Every reading comes back
/// unavailable, from a single adapter that is honest about having no device
/// behind it, because inventing a plausible-looking drawer state would be worse
/// than returning nothing: somebody would eventually believe it.
/// </remarks>
public enum HardwareAvailability
{
    /// <summary>No hardware adapter is present on this deployment.</summary>
    NoAdapter = 0,

    /// <summary>An adapter is present but the device did not answer.</summary>
    DeviceNotResponding = 1,

    /// <summary>The reading is not supported by this cabinet model.</summary>
    NotSupported = 2,
}

/// <summary>
/// One hardware reading, or the reason there is not one.
/// </summary>
/// <typeparam name="T">What the reading would carry.</typeparam>
public sealed record HardwareReading<T>
{
    /// <summary>Whether a value was actually read.</summary>
    public required bool IsAvailable { get; init; }

    /// <summary>The value, when one was read.</summary>
    public T? Value { get; init; }

    /// <summary>Why there is no value.</summary>
    public HardwareAvailability? Unavailable { get; init; }

    /// <summary>One sentence a person reads.</summary>
    public required string Detail { get; init; }

    /// <summary>Builds an unavailable reading.</summary>
    /// <param name="reason">Why nothing could be read.</param>
    /// <param name="detail">One sentence a person reads.</param>
    public static HardwareReading<T> Unavailable_(HardwareAvailability reason, string detail) => new()
    {
        IsAvailable = false,
        Value = default,
        Unavailable = reason,
        Detail = detail,
    };
}

/// <summary>A drawer's observed state.</summary>
public sealed record DrawerState
{
    /// <summary>Which drawer, as the cabinet numbers them.</summary>
    public required int DrawerNumber { get; init; }

    /// <summary>Whether the drawer is open.</summary>
    public required bool IsOpen { get; init; }

    /// <summary>Whether the drawer is locked.</summary>
    public required bool IsLocked { get; init; }
}

/// <summary>A lock's observed state.</summary>
public sealed record LockState
{
    /// <summary>Which lock, as the cabinet numbers them.</summary>
    public required int LockNumber { get; init; }

    /// <summary>Whether the lock is engaged.</summary>
    public required bool IsEngaged { get; init; }
}

/// <summary>A cubie's observed state.</summary>
public sealed record CubieState
{
    /// <summary>Which cubie, as the cabinet numbers them.</summary>
    public required int CubieNumber { get; init; }

    /// <summary>Whether the cubie is open.</summary>
    public required bool IsOpen { get; init; }

    /// <summary>Whether the cubie is occupied.</summary>
    public required bool IsOccupied { get; init; }
}

/// <summary>A sensor reading.</summary>
public sealed record SensorValue
{
    /// <summary>Which sensor.</summary>
    public required string SensorName { get; init; }

    /// <summary>Its value.</summary>
    public required double Value { get; init; }

    /// <summary>The unit the value is in.</summary>
    public required string Unit { get; init; }
}

/// <summary>
/// Reads drawer state. Read-only, by design and not by omission.
/// </summary>
/// <remarks>
/// <para>
/// There is no <c>Open</c> method on this interface and there will not be one
/// added casually. Opening a drawer on a cabinet holding controlled substances
/// is a physical act with a chain-of-custody consequence; it needs a design
/// with an on-site confirmation, a second authoriser, and a regulatory review,
/// none of which exist yet.
/// </para>
/// <para>
/// The interface exists now so that the boundary is drawn before anybody needs
/// it, and so that the shape of a future actuation feature is constrained by
/// something already in the codebase rather than invented under deadline.
/// </para>
/// </remarks>
public interface IDrawerController
{
    /// <summary>Reads one drawer's state.</summary>
    /// <param name="drawerNumber">The drawer.</param>
    /// <param name="ct">Cancels the read.</param>
    Task<HardwareReading<DrawerState>> ReadDrawerAsync(int drawerNumber, CancellationToken ct);

    /// <summary>Reads every drawer's state.</summary>
    /// <param name="ct">Cancels the read.</param>
    Task<HardwareReading<IReadOnlyList<DrawerState>>> ReadAllDrawersAsync(CancellationToken ct);
}

/// <summary>Reads lock state. Read-only, for the reasons on <see cref="IDrawerController"/>.</summary>
public interface ILockController
{
    /// <summary>Reads one lock's state.</summary>
    /// <param name="lockNumber">The lock.</param>
    /// <param name="ct">Cancels the read.</param>
    Task<HardwareReading<LockState>> ReadLockAsync(int lockNumber, CancellationToken ct);

    /// <summary>Reads every lock's state.</summary>
    /// <param name="ct">Cancels the read.</param>
    Task<HardwareReading<IReadOnlyList<LockState>>> ReadAllLocksAsync(CancellationToken ct);
}

/// <summary>Reads cubie state. Read-only, for the reasons on <see cref="IDrawerController"/>.</summary>
public interface ICubieController
{
    /// <summary>Reads one cubie's state.</summary>
    /// <param name="cubieNumber">The cubie.</param>
    /// <param name="ct">Cancels the read.</param>
    Task<HardwareReading<CubieState>> ReadCubieAsync(int cubieNumber, CancellationToken ct);

    /// <summary>Reads every cubie's state.</summary>
    /// <param name="ct">Cancels the read.</param>
    Task<HardwareReading<IReadOnlyList<CubieState>>> ReadAllCubiesAsync(CancellationToken ct);
}

/// <summary>Reads cabinet sensors.</summary>
public interface ISensorReader
{
    /// <summary>Reads one sensor.</summary>
    /// <param name="sensorName">The sensor.</param>
    /// <param name="ct">Cancels the read.</param>
    Task<HardwareReading<SensorValue>> ReadSensorAsync(string sensorName, CancellationToken ct);

    /// <summary>Reads every sensor.</summary>
    /// <param name="ct">Cancels the read.</param>
    Task<HardwareReading<IReadOnlyList<SensorValue>>> ReadAllSensorsAsync(CancellationToken ct);
}

/// <summary>The four hardware interfaces together, so one adapter can serve them all.</summary>
public interface IHardwareController : IDrawerController, ILockController, ICubieController, ISensorReader
{
    /// <summary>What this adapter is, for a diagnostic read-out.</summary>
    string AdapterName { get; }
}

/// <summary>
/// The hardware adapter this build ships: one that has no hardware behind it
/// and says so.
/// </summary>
/// <remarks>
/// <para>
/// It is registered in dependency injection rather than left unregistered, so
/// that a component which takes <see cref="IDrawerController"/> resolves and
/// gets a truthful "unavailable" instead of failing to construct. That is the
/// difference between a scaffold and a gap: the wiring is exercised, the shape
/// is real, and the only thing missing is the device.
/// </para>
/// <para>
/// It returns unavailable. It does not throw, does not return an empty list
/// that reads as "no drawers", and does not return a fabricated state. Those
/// three would each, in their own way, let somebody believe a cabinet's
/// physical state is known when it is not.
/// </para>
/// </remarks>
public sealed class NullHardwareAdapter : IHardwareController
{
    private const string NoAdapter =
        "This deployment has no cabinet hardware adapter. Drawer, lock, cubie and sensor state " +
        "cannot be read, and this platform does not actuate cabinet hardware.";

    /// <inheritdoc />
    public string AdapterName => "None (no hardware adapter is installed)";

    /// <inheritdoc />
    public Task<HardwareReading<DrawerState>> ReadDrawerAsync(int drawerNumber, CancellationToken ct) =>
        Task.FromResult(HardwareReading<DrawerState>.Unavailable_(HardwareAvailability.NoAdapter, NoAdapter));

    /// <inheritdoc />
    public Task<HardwareReading<IReadOnlyList<DrawerState>>> ReadAllDrawersAsync(CancellationToken ct) =>
        Task.FromResult(HardwareReading<IReadOnlyList<DrawerState>>.Unavailable_(
            HardwareAvailability.NoAdapter, NoAdapter));

    /// <inheritdoc />
    public Task<HardwareReading<LockState>> ReadLockAsync(int lockNumber, CancellationToken ct) =>
        Task.FromResult(HardwareReading<LockState>.Unavailable_(HardwareAvailability.NoAdapter, NoAdapter));

    /// <inheritdoc />
    public Task<HardwareReading<IReadOnlyList<LockState>>> ReadAllLocksAsync(CancellationToken ct) =>
        Task.FromResult(HardwareReading<IReadOnlyList<LockState>>.Unavailable_(
            HardwareAvailability.NoAdapter, NoAdapter));

    /// <inheritdoc />
    public Task<HardwareReading<CubieState>> ReadCubieAsync(int cubieNumber, CancellationToken ct) =>
        Task.FromResult(HardwareReading<CubieState>.Unavailable_(HardwareAvailability.NoAdapter, NoAdapter));

    /// <inheritdoc />
    public Task<HardwareReading<IReadOnlyList<CubieState>>> ReadAllCubiesAsync(CancellationToken ct) =>
        Task.FromResult(HardwareReading<IReadOnlyList<CubieState>>.Unavailable_(
            HardwareAvailability.NoAdapter, NoAdapter));

    /// <inheritdoc />
    public Task<HardwareReading<SensorValue>> ReadSensorAsync(string sensorName, CancellationToken ct) =>
        Task.FromResult(HardwareReading<SensorValue>.Unavailable_(HardwareAvailability.NoAdapter, NoAdapter));

    /// <inheritdoc />
    public Task<HardwareReading<IReadOnlyList<SensorValue>>> ReadAllSensorsAsync(CancellationToken ct) =>
        Task.FromResult(HardwareReading<IReadOnlyList<SensorValue>>.Unavailable_(
            HardwareAvailability.NoAdapter, NoAdapter));
}
