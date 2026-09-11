namespace CabinetPlatform.Contracts.Common;

/// <summary>
/// One page of a list response.
/// </summary>
/// <remarks>
/// Every list endpoint in this API is paged. There is no endpoint that returns
/// an unbounded collection: at seven thousand cabinets one would fall over, and
/// the failure would arrive as a timeout on a support call rather than as a
/// design review.
/// </remarks>
/// <typeparam name="T">The row type this page carries.</typeparam>
public sealed record PagedResult<T>
{
    /// <summary>The rows on this page, in the order the endpoint defines.</summary>
    public IReadOnlyList<T> Items { get; init; } = Array.Empty<T>();

    /// <summary>One-based page number this result answers.</summary>
    public required int Page { get; init; }

    /// <summary>Rows per page, after the server's clamp.</summary>
    public required int PageSize { get; init; }

    /// <summary>Total rows matching the query across every page.</summary>
    public required int TotalCount { get; init; }

    /// <summary>Number of pages the query spans.</summary>
    public int TotalPages => PageSize <= 0 ? 0 : (int)Math.Ceiling(TotalCount / (double)PageSize);

    /// <summary>Whether a further page exists after this one.</summary>
    public bool HasMore => Page < TotalPages;

    /// <summary>Builds a page from its rows and the query that produced them.</summary>
    /// <param name="items">Rows on this page.</param>
    /// <param name="page">One-based page number.</param>
    /// <param name="pageSize">Rows per page.</param>
    /// <param name="totalCount">Total matching rows.</param>
    public static PagedResult<T> Create(IReadOnlyList<T> items, int page, int pageSize, int totalCount) =>
        new() { Items = items, Page = page, PageSize = pageSize, TotalCount = totalCount };
}

/// <summary>
/// The paging half of every list query, with the guard rails applied on the way
/// in rather than trusted from the caller.
/// </summary>
/// <remarks>
/// The clamps live in the init accessors so that a page size of one million is
/// silently reduced to <see cref="MaxPageSize"/> at the point of binding — the
/// server never sees an unclamped value, and no endpoint has to remember to
/// apply the limit itself.
/// </remarks>
public record PagedQuery
{
    /// <summary>Rows per page when the caller does not ask for a size.</summary>
    public const int DefaultPageSize = 50;

    /// <summary>The largest page any endpoint will serve.</summary>
    public const int MaxPageSize = 200;

    private readonly int _page = 1;
    private readonly int _pageSize = DefaultPageSize;

    /// <summary>One-based page number. Anything below one reads as the first page.</summary>
    public int Page
    {
        get => _page;
        init => _page = value < 1 ? 1 : value;
    }

    /// <summary>Rows per page, clamped to <see cref="MaxPageSize"/>.</summary>
    public int PageSize
    {
        get => _pageSize;
        init => _pageSize = value switch
        {
            < 1 => DefaultPageSize,
            > MaxPageSize => MaxPageSize,
            _ => value,
        };
    }

    /// <summary>Rows to skip to reach this page.</summary>
    public int Skip => (Page - 1) * PageSize;
}

/// <summary>
/// A bounded time window over a history endpoint.
/// </summary>
/// <remarks>
/// Both bounds are optional, but an endpoint that serves two years of readings
/// applies its own ceiling to an unbounded request rather than attempting it.
/// </remarks>
public record HistoryQuery : PagedQuery
{
    /// <summary>Inclusive lower bound, or <see langword="null"/> for no lower bound.</summary>
    public DateTimeOffset? FromUtc { get; init; }

    /// <summary>Exclusive upper bound, or <see langword="null"/> for no upper bound.</summary>
    public DateTimeOffset? ToUtc { get; init; }
}
