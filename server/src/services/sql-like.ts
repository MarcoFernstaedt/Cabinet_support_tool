// A search text as a LIKE pattern for SQL Server: the wildcards `%`, `_`, `[` and the escape character itself are matched literally.
// Use it with `LIKE @pattern ESCAPE '\'` (the database collation is case-insensitive, so this replaces PostgreSQL's ILIKE).
export function likeContains(text: string): string {
  return "%" + text.replace(/[\\%_[]/g, m => "\\" + m) + "%";
}
