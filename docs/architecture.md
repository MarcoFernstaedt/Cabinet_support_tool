# Architecture

Target product architecture, not a production deployment claim. See [web-only delivery plan](web-only-delivery-plan.md) for the counted acceptance queue. The **browser is the only support Console**; Windows runs the cabinet Agent service. The retired WPF executable and old desktop diagram are removed. `Console.Core` remains temporarily for Agent integration test coverage, not as a product deliverable.

```text
Staff browser --HTTPS, same-origin session cookie--> ASP.NET Core WebHost/BFF
                    Entra OIDC sign-in ----^         |
                                                       | server-held authority; typed calls
                                                       v
                                               ASP.NET Core Server API
                                                 |            |
                                        PostgreSQL fleet   audit/results
                                                 ^
                                                 | outbound device-bound TLS only
                                      Windows cabinet Agent service
                                      (fixed allowlist, local safety)
```

The support Server runs on Mashura infrastructure. Customer cabinets and their local application databases remain on site; the Server never requires direct access to an application database. PostgreSQL is the fleet storage target and SQLite is for local development and tests.

## Trust and process boundaries

- The browser sees only typed, authorized cabinet/site projections and never a generic action-output endpoint, diagnostic ZIP or arbitrary path. Staff sign in through an organization-approved Entra tenant with actually enforced MFA; the WebHost holds any API credentials server-side and uses a Secure, HttpOnly, SameSite cookie with bounded lifetime and CSRF defense. The existing identity-only WebHost and separate loopback preview are not yet this integrated product.
- The Server authenticates and authorizes staff independently of cabinets. It resolves immutable staff identity, active role and exact cabinet/site authority for every API read or write. It owns registration, topology, action dispatch, audit and bounded saved results. A client-provided cabinet ID or hidden button is not authorization.
- The Windows Agent service uses outbound registration, telemetry, polling and result delivery; the Server does not connect to an inbound cabinet listener. A device credential binds to one cabinet. The Agent applies its fixed action allowlist and safety checks immediately before execution, even if the Server accepted a request. No remote desktop, arbitrary shell, physical actuation, automatic firewall changes or application database access is authorized.
- Contracts crossing these boundaries specify absent values, observation and receipt times, action identity, expiry, scope, failure and uncertainty. A timeout does not prove that a mutation did not occur. Controlled changes need durable effect journals, unknown-outcome handling and independent recovery before approval.

The shipping observation-only action ceiling remains in force. File staging and process/network/update maintenance are separate approval holds, not a consequence of the web migration. Native Windows service operation, fleet PostgreSQL behavior, staff assurance, browser accessibility and production deployment still require acceptance evidence.
