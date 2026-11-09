-- The searchable names of a stored reading, lower case, one per line (F21.R4, decision-log D63). The fleet's readings search looks for
-- its text here instead of reading every cabinet's stored JSON apart: at 10,000 cabinets that took about 9 s for one software search. It
-- is written with the result, for the readings the search covers, and cleared with it by retention. Older results have none and are
-- searched as before. Binary comparison: both sides are already lower case, and a binary search of the text is the fast one.
ALTER TABLE commands ADD [search_text] nvarchar(max) COLLATE Latin1_General_100_BIN2 NULL;
GO
