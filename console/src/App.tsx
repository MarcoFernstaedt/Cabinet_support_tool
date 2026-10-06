import { useCallback, useEffect, useState } from "react";
import { api, onSignedOut } from "./lib/api";
import { CommandStream } from "./lib/commands";
import { Router, match, useRouter } from "./lib/router";
import { SessionContext, type Me } from "./lib/session";
import { Layout } from "./components/Layout";
import { Tour } from "./components/Tour";
import { PasswordChange, SignIn, TotpSetup, TotpStep, type Stage } from "./pages/SignIn";
import { ClientPage, FleetHome, SitePage } from "./pages/Fleet";
import { CabinetPage } from "./pages/cabinet/CabinetPage";
import { AdminHome, AuditLog, InstallTokens, PendingCabinets, ScannerDefault } from "./pages/admin/Admin";
import { Account } from "./pages/Account";

export function App() {
  const [stage, setStage] = useState<Stage | "loading">("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [tour, setTour] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ user: Me; stage: Stage }>("GET", "/api/auth/me");
      setMe(r.user);
      setStage(r.stage);
      if (r.stage === "complete" && !r.user.tourCompleted) setTour(true);
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
          <Layout><Pages onTour={() => setTour(true)} /></Layout>
          {tour && <Tour onClose={() => setTour(false)} />}
        </CommandStream>
      </Router>
    </SessionContext.Provider>
  );
}

function Pages({ onTour }: { onTour: () => void }) {
  const { path } = useRouter();
  let m: Record<string, string> | null;
  if ((m = match("/clients/:id", path))) return <ClientPage id={m.id!} />;
  if ((m = match("/sites/:id", path))) return <SitePage id={m.id!} />;
  if ((m = match("/cabinets/:id", path))) return <CabinetPage id={m.id!} section="overview" />;
  if ((m = match("/cabinets/:id/:section", path))) return <CabinetPage id={m.id!} section={m.section!} />;
  if (match("/admin", path)) return <AdminHome />;
  if (match("/admin/pending", path)) return <PendingCabinets />;
  if (match("/admin/tokens", path)) return <InstallTokens />;
  if (match("/admin/scanner", path)) return <ScannerDefault />;
  if (match("/admin/audit", path)) return <AuditLog />;
  if (match("/account", path)) return <Account onTour={onTour} />;
  return <FleetHome />;
}
