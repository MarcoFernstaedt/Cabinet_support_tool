// Reading a pasted list of clients and sites (F6.R4) into the rows the import takes. One line per site: the client, then the site,
// separated by a comma or a tab (a spreadsheet's copy). A field may be quoted to hold a comma ("Smith, Jones Clinic"), with "" for a
// quote inside it. A first line reading "client, site" is a heading and skipped; blank lines are skipped. Names are trimmed. This only
// shapes the list for a preview; the server checks every name against the contract and decides what exists.

export interface ImportLine { client: string; site: string }
export interface ParsedImport { rows: ImportLine[]; problems: { line: number; text: string }[] }

/** One line split into fields, by tabs when it has any (a spreadsheet's copy), else by commas outside quotes. */
export function splitLine(line: string): string[] {
  const sep = line.includes("\t") ? "\t" : ",";
  const fields: string[] = [];
  let field = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field.trim() === "") { field = ""; quoted = true; }
    else if (ch === sep) { fields.push(field.trim()); field = ""; }
    else field += ch;
  }
  fields.push(field.trim());
  return fields;
}

export function parseImport(text: string): ParsedImport {
  const rows: ImportLine[] = [], problems: ParsedImport["problems"] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (raw.trim() === "") return;
    const f = splitLine(raw);
    if (rows.length === 0 && problems.length === 0 && f.length === 2 && f[0]!.toLowerCase() === "client" && f[1]!.toLowerCase() === "site") return;
    if (f.length !== 2 || !f[0] || !f[1]) { problems.push({ line: i + 1, text: "needs a client and a site, and nothing else" }); return; }
    rows.push({ client: f[0], site: f[1] });
  });
  return { rows, problems };
}
