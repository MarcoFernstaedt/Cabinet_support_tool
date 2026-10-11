-- The full network read behind a diagnosis (adapter details, routes, ARP table, test and trace results), kept so the console can show it
-- whether or not anything is wrong: a cabinet that matches its baseline can still have a lease about to end, errors on its network card,
-- packet loss to its gateway, or a path to the sync cabinet that goes somewhere unexpected.
ALTER TABLE diagnoses ADD COLUMN readings jsonb;
