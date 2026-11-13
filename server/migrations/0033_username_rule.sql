-- The username check refused two characters it says it allows.
--
-- With the dash last in the character class, LIKE does not take it as a literal in a binary collation, so a username
-- containing a dash or an underscore was refused by the table although the admin console's own form offers them:
-- pattern [a-z0-9._-]{2,64}, "Lower-case letters, digits, dot, dash or underscore" (console/src/pages/admin/Users.tsx).
-- An Admin creating "jane-doe" met a check-constraint error, because nothing validates a username before the insert.
--
-- Dash first is a literal dash. Nothing else about the rule moves: upper case, spaces and punctuation are still refused,
-- and so is anything longer than 64 characters. The difference is measured character by character in the test this change
-- carries, and the account service now refuses a username outside the rule itself, with a code the console can act on,
-- so the table's check stays what it should be: the backstop.
ALTER TABLE users DROP CONSTRAINT [users_username_check];
GO
ALTER TABLE users ADD CONSTRAINT [users_username_check] CHECK (LEN(username) BETWEEN 2 AND 64 AND username COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^-a-z0-9._]%');
GO
