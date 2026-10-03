using System.Text.Json.Serialization;

namespace CabinetPlatform.Contracts.Audit;

/// <summary>
/// The closed catalog of things this platform writes an audit record about.
/// </summary>
/// <remarks>
/// <para>
/// Audit events are named, never described, for the same reason actions are: a
/// compliance reviewer filtering the trail years from now needs a value that
/// means one thing, not prose that has drifted across releases. The name is
/// what travels on the wire and what is stored, so renumbering this enum
/// changes nothing that has already been written.
/// </para>
/// <para>
/// <see cref="AuditEntryDto.Action"/> stays separate and stays an
/// <see cref="Actions.ActionName"/>: it says which catalog action a record
/// concerns, and is null for the many records that concern none.
/// </para>
/// </remarks>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AuditEvent
{
    /// <summary>A support user signed in.</summary>
    Login = 1,

    /// <summary>A support user signed out.</summary>
    Logout = 2,

    /// <summary>A support user changed their own password.</summary>
    ChangePassword = 3,

    /// <summary>A caller read their own identity.</summary>
    ViewSelf = 4,

    /// <summary>An agent announced itself to the registration queue.</summary>
    AgentRegister = 10,

    /// <summary>An agent submitted a check-in.</summary>
    AgentCheckIn = 11,

    /// <summary>An agent collected its approved actions.</summary>
    AgentCollectActions = 12,

    /// <summary>An agent reported an action's outcome.</summary>
    AgentReportResult = 13,

    /// <summary>The cabinet list was read.</summary>
    ListCabinets = 20,

    /// <summary>One cabinet's latest state was read.</summary>
    ViewCabinetLatest = 21,

    /// <summary>One cabinet's check-in history was read.</summary>
    ViewCabinetHistory = 22,

    /// <summary>One cabinet's SMART history was read.</summary>
    ViewSmartHistory = 23,

    /// <summary>The fleet health summary was read.</summary>
    ViewFleetHealth = 24,

    /// <summary>One cabinet's stored inventory was read.</summary>
    ViewCabinetInventory = 25,

    /// <summary>The site list was read.</summary>
    ListSites = 26,

    /// <summary>A cabinet's role within its site was changed.</summary>
    SetCabinetRole = 27,

    /// <summary>A site's sync cabinet was assigned or cleared.</summary>
    SetSiteSyncCabinet = 28,

    /// <summary>A supervisor changed a cabinet's friendly label.</summary>
    RenameCabinet = 29,

    /// <summary>The pending registration queue was read.</summary>
    ListPendingRegistrations = 30,

    /// <summary>A pending agent was admitted as a cabinet.</summary>
    ApproveRegistration = 31,

    /// <summary>A pending agent was refused.</summary>
    RejectRegistration = 32,

    /// <summary>A supervisor withdrew a cabinet from active service.</summary>
    RetireCabinet = 33,

    /// <summary>The user list was read.</summary>
    ListUsers = 40,

    /// <summary>A support user was created.</summary>
    CreateUser = 41,

    /// <summary>A support user's role, activity or lockout was changed.</summary>
    UpdateUser = 42,

    /// <summary>Elevated database access was granted to a user.</summary>
    GrantElevatedSql = 43,

    /// <summary>Elevated database access was withdrawn from a user.</summary>
    RevokeElevatedSql = 44,

    /// <summary>Every refresh token held by a user was force-revoked.</summary>
    RevokeUserSessions = 45,

    /// <summary>A refresh token was exchanged for a new access token.</summary>
    RefreshToken = 46,

    /// <summary>
    /// A consumed refresh token was presented again. The whole chain is revoked
    /// and this is written, because it is either a bug or a theft.
    /// </summary>
    RefreshTokenReuse = 47,

    /// <summary>The action catalog was read.</summary>
    ViewActionCatalog = 50,

    /// <summary>An action was requested on a cabinet.</summary>
    RequestAction = 51,

    /// <summary>The action list was read.</summary>
    ListActions = 52,

    /// <summary>The list of actions awaiting this caller's approval was read.</summary>
    ListPendingApproval = 53,

    /// <summary>An action was approved.</summary>
    ApproveAction = 54,

    /// <summary>An action was refused.</summary>
    DenyAction = 55,

    /// <summary>An action passed its expiry without being collected.</summary>
    ExpireAction = 56,

    /// <summary>A batch of actions was requested across several cabinets.</summary>
    RequestBatchAction = 60,

    /// <summary>A batch was approved and expanded into individual requests.</summary>
    ApproveBatchAction = 61,

    /// <summary>A batch was refused. Nothing was expanded or dispatched.</summary>
    DenyBatchAction = 62,

    /// <summary>One cabinet in a batch was skipped rather than dispatched to.</summary>
    BatchTargetSkipped = 63,

    /// <summary>A batch list or one batch was read.</summary>
    ViewBatchAction = 64,

    /// <summary>
    /// A cabinet-to-cabinet probe was requested against a target at the same
    /// site as its source.
    /// </summary>
    CabinetLinkTest = 70,

    /// <summary>
    /// A cabinet-to-cabinet probe was requested against a target at a different
    /// site of the same client. Audited distinctly from the same-site case.
    /// </summary>
    CrossSiteCabinetLinkTest = 71,

    /// <summary>
    /// A cabinet-to-cabinet probe named a target belonging to another client
    /// and was refused. A rep must never probe one client's network from
    /// another client's cabinet.
    /// </summary>
    CrossClientCabinetLinkTestRejected = 72,

    /// <summary>The audit trail was read.</summary>
    ViewAudit = 80,

    /// <summary>A retention sweep ran.</summary>
    RetentionSweep = 90,

    /// <summary>The first Supervisor account was seeded into an empty user table.</summary>
    SeedSupervisor = 91,

    /// <summary>
    /// A request was refused inside the authorization middleware, before any
    /// controller ran.
    /// </summary>
    AuthorizationDenied = 92,

    /// <summary>
    /// A cabinet's reported system clock differs materially from the server's.
    /// Drift breaks both site synchronisation and audit ordering.
    /// </summary>
    CabinetClockDrift = 93,

    /// <summary>The cabinet search was run.</summary>
    SearchCabinets = 100,

    /// <summary>The client list was read for the hierarchy browser.</summary>
    ListClients = 101,

    /// <summary>One client's site-and-cabinet hierarchy was read.</summary>
    ViewClientHierarchy = 102,

    /// <summary>A rep's recently-viewed cabinet list was read.</summary>
    ViewRecentCabinets = 103,

    /// <summary>The event log view list was read.</summary>
    ListEventLogViews = 110,

    /// <summary>A Supervisor defined a new event log view.</summary>
    CreateEventLogView = 111,

    /// <summary>A Supervisor edited an event log view shared by everyone.</summary>
    UpdateEventLogView = 112,

    /// <summary>A Supervisor retired an event log view.</summary>
    RetireEventLogView = 113,

    /// <summary>An event log view was run against a cabinet.</summary>
    RunEventLogView = 114,

    /// <summary>
    /// A cabinet reported what an update install actually did, as distinct from
    /// the fact that one was scheduled.
    /// </summary>
    UpdateInstallOutcome = 120,

    /// <summary>The reserved hardware-actuation grant was given to a user.</summary>
    GrantHardwareActuation = 130,

    /// <summary>The reserved hardware-actuation grant was withdrawn from a user.</summary>
    RevokeHardwareActuation = 131,

    /// <summary>
    /// A reserved hardware-actuation action was requested and refused.
    /// </summary>
    /// <remarks>
    /// Its own event rather than a generic denial, because "did anybody ever
    /// try to open a drawer from the support console" is a question a regulator
    /// may ask, and it must be answerable with one filter rather than by
    /// reading denial text.
    /// </remarks>
    HardwareActuationRefused = 132,

    /// <summary>A supervisor changed approved connectivity targets.</summary>
    ConfigureConnectivity = 140,
    /// <summary>A support user read connectivity evidence.</summary>
    ViewConnectivity = 141,
    /// <summary>A support user acknowledged a connectivity incident.</summary>
    AcknowledgeConnectivityAlert = 142,
    /// <summary>A support user resolved a connectivity workflow annotation.</summary>
    ResolveConnectivityAlert = 143,
    /// <summary>A Supervisor requested a bounded office device grant renewal.</summary>
    RenewOfficeDevice = 144,
    /// <summary>A Supervisor reserved an uncredentialed successor identity.</summary>
    ReserveSuccessorIdentity = 145,
    /// <summary>A Supervisor recorded non-activating successor issuance intent.</summary>
    RecordSuccessorIssuanceIntent = 146,
    /// <summary>A Supervisor gave one user read access to one cabinet.</summary>
    GrantCabinetRead = 147,
    /// <summary>A Supervisor withdrew one user's read access to one cabinet.</summary>
    RevokeCabinetRead = 148,
}
