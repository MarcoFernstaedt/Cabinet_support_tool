import { ErrorBoundary } from "./components/ErrorBoundary";
import { useCallback, useEffect, useState } from "react";
import { api, onSignedOut } from "./lib/api";
import { CommandStream } from "./lib/commands";
import { WriteStatusProvider } from "./lib/writes";
import { Link, Router, match, useRouter } from "./lib/router";
import { SessionContext, atLeast, useSession, type Me } from "./lib/session";
import { Layout } from "./components/Layout";
import { WelcomeTour, startWelcomeTour } from "./components/WelcomeTour";
import { PasswordChange, SignIn, TotpSetup, TotpStep, type Stage } from "./pages/SignIn";
import { ClientPage, FleetHome, SitePage } from "./pages/Fleet";
import { CabinetPage } from "./pages/cabinet/CabinetPage";
import { AdminHome, InstallTokens, PendingCabinets, ScannerDefault } from "./pages/admin/Admin";
import { AuditLog, OnlineNow } from "./pages/admin/Audit";
import { UserActivity, Users } from "./pages/admin/Users";
import { ClientsAndSites, IssueTypesAndSuppressions } from "./pages/admin/Organization";
import { FleetSafety, PlatformSettings, SecurityAlerts } from "./pages/admin/Safety";
import { SoftwareLibrary } from "./pages/admin/SoftwareLibrary";
import { RolloutDetail, Upgrades } from "./pages/admin/Upgrades";
import { Setup } from "./pages/admin/Setup";
import { SystemHealth } from "./pages/admin/SystemHealth";
import { Account } from "./pages/Account";
import { FixQueue } from "./pages/Fixes";
import { AlertsPage } from "./pages/alerts/Alerts";
import { IssuesPage } from "./pages/alerts/Issues";
import { IncidentsPage } from "./pages/Crashes";
import { ReadingSearch } from "./pages/ReadingSearch";
import { FleetJob, FleetOperations } from "./pages/FleetOperations";
import { NetworkDiagnosisPage } from "./pages/NetworkDiagnosis";
import { DemoGuide } from "./pages/DemoGuide";
import { DemoTour } from "./components/DemoTour";

export function App() {
  const [stage, setStage] = useState<Stage | "loading">("loading");
  const [me, setMe] = useState<Me | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ user: Me; stage: Stage }>("GET", "/api/auth/me");
      setMe(r.user);
      setStage(r.stage);
    } catch { setMe(null); setStage("signed_out"); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => onSignedOut(() => { setMe(null); setStage("signed_out"); }), []);

  const signOut = useCallback(async () => {
    try { await api("POST", "/api/auth/logout", {}); } catch { /* already signed out */ }
    setMe(null);
    setStage("signed_out");
    window.history.replaceState(null, "", "/");
  }, []);
  const advance = (s: Stage) => { if (s === "complete") void refresh(); else setStage(s); };

  if (stage === "loading") return <p className="muted center" role="status">Loading…</p>;
  if (stage === "signed_out") return <SignIn onStage={advance} />;
  if (stage === "totp") return <TotpStep onStage={advance} onCancel={() => void signOut()} />;
  if (stage === "totp_setup") return <TotpSetup required onStage={advance} onCancel={() => void signOut()} />;
  if (stage === "password_change") return <PasswordChange forced onStage={advance} onCancel={() => void signOut()} />;
  if (!me) return null;
  return (
    <SessionContext.Provider value={{ me, refresh, signOut }}>
      <Router>
        <CommandStream>
          <WriteStatusProvider>
            <Layout><RoutedPages onTour={startWelcomeTour} /></Layout>
            <DemoTour />
            <WelcomeTour />
          </WriteStatusProvider>
        </CommandStream>
      </Router>
    </SessionContext.Provider>
  );
}

/** Each page inside its own error boundary, reset when the path changes. */
function RoutedPages({ onTour }: { onTour: () => void }) {
  const { path } = useRouter();
  return <ErrorBoundary key={path.split("?")[0]}><Pages onTour={onTour} /></ErrorBoundary>;
}

function Pages({ onTour }: { onTour: () => void }) {
  const { path } = useRouter();
  const { me } = useSession();
  let m: Record<string, string> | null;
  if ((m = match("/clients/:id", path))) return <ClientPage id={m.id!} />;
  if ((m = match("/sites/:id", path))) return <SitePage id={m.id!} />;
  if ((m = match("/cabinets/:id", path))) return <CabinetPage id={m.id!} section="overview" />;
  if ((m = match("/cabinets/:id/:section", path))) return <CabinetPage id={m.id!} section={m.section!} />;
  // Admin pages are for Admins: the server refuses their data to anyone else anyway, so another role sees a plain explanation instead of
  // half a page of refusals.
  if ((path === "/admin" || path.startsWith("/admin/") || path.startsWith("/admin?")) && !atLeast(me, "admin")) return <NotFound admin />;
  if (match("/admin", path)) return <AdminHome />;
  if (match("/admin/setup", path)) return <Setup />;
  if (match("/admin/pending", path)) return <PendingCabinets />;
  if (match("/admin/tokens", path)) return <InstallTokens />;
  if (match("/admin/scanner", path)) return <ScannerDefault />;
  if (match("/admin/audit", path)) return <AuditLog />;
  if (match("/admin/software", path)) return <SoftwareLibrary />;
  if (match("/admin/upgrades", path)) return <Upgrades />;
  if ((m = match("/admin/upgrades/:id", path))) return <RolloutDetail id={m.id!} />;
  if (match("/admin/users", path)) return <Users />;
  if ((m = match("/admin/users/:id", path))) return <UserActivity id={m.id!} />;
  if (match("/admin/online", path)) return <OnlineNow />;
  if (match("/admin/clients", path)) return <ClientsAndSites />;
  if (match("/admin/issues", path)) return <IssueTypesAndSuppressions />;
  if (match("/admin/safety", path)) return <FleetSafety />;
  if (match("/admin/security", path)) return <SecurityAlerts />;
  if (match("/admin/settings", path)) return <PlatformSettings />;
  if (match("/admin/health", path)) return <SystemHealth />;
  if (match("/account", path)) return <Account onTour={onTour} />;
  if (match("/fixes", path)) return <FixQueue />;
  if (match("/alerts", path)) return <AlertsPage />;
  if (match("/issues", path)) return <IssuesPage />;
  if (match("/incidents", path)) return <IncidentsPage />;
  if (match("/search", path)) return <ReadingSearch />;
  if ((m = match("/network/diagnosis/:id", path))) return <NetworkDiagnosisPage key={m.id} id={m.id!} />;
  if (match("/fleet-operations", path)) return <FleetOperations key={path} />;
  if ((m = match("/fleet-operations/jobs/:id", path))) return <FleetJob id={m.id!} />;
  if (match("/demo", path)) return <DemoGuide />;
  if ((path.split("?")[0] ?? "/").replace(/\/+$/, "") === "") return <FleetHome />;
  return <NotFound />;
}

/** An address the console has no page for (or an Admin page opened by another role). */
function NotFound({ admin = false }: { admin?: boolean }) {
  return (
    <div className="page">
      <h1>{admin ? "Admin only" : "Page not found"}</h1>
      <p>{admin ? "This page is for Admins. Ask an Admin if you need something changed here." : "There is no page at this address. The link may be old, or mistyped."}</p>
      <p><Link to="/">Go to the fleet</Link></p>
    </div>
  );
}
