-- Which browsers an account has fully signed in from (docs/spec/09-open-decisions.md, "Sign-in limits"). A device row is made as
-- soon as a password is right, before the authenticator code, so "seen" cannot mean "trusted": someone holding only the password
-- would get a browser past the address limit. trusted_at is set when the sign-in passes the authenticator (or the password,
-- for an account without one), and cleared when an Admin ends the account's sessions or the password changes.
ALTER TABLE user_devices ADD [trusted_at] datetime2(3) NULL;
GO
-- The address-limit check finds a device by its hash alone, so a guess costs the same whether or not the account exists.
CREATE INDEX user_devices_hash ON user_devices ([device_hash]) INCLUDE ([user_id], [trusted_at]);
GO
