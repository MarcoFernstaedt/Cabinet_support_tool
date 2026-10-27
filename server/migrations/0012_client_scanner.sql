-- Whether a client uses a fingerprint scanner (docs/spec/05-server-spec.md "Fingerprint scanner per client").
--
--   fingerprint_scanner  1: the scanner is watched, checked and alerted on for the client's cabinets; 0: none of it applies.
--                        Existing clients keep today's behaviour (on), as the owner decided; a new client chooses at its first approval.
--   scanner_service      The scanner's Windows service key name, kept so switching the scanner off takes exactly that service off the
--                        client's watched list. NULL until the scanner is switched on through the platform.
ALTER TABLE clients ADD
  [fingerprint_scanner] bit NOT NULL CONSTRAINT [clients_fingerprint_scanner_default] DEFAULT 1,
  [scanner_service] nvarchar(80) NULL;
GO
