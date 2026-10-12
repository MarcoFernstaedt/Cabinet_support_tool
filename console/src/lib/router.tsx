// A small history-based router: the console needs only path matching and links.
import { createContext, useContext, useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from "react";

const RouterContext = createContext<{ path: string; navigate: (to: string) => void }>({ path: "/", navigate: () => {} });

export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(window.location.pathname + window.location.search);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to: string) => {
    if (to === window.location.pathname + window.location.search) return;
    window.history.pushState(null, "", to);
    setPath(to);
    window.scrollTo(0, 0);
  };
  return <RouterContext.Provider value={{ path, navigate }}>{children}</RouterContext.Provider>;
}

export const useRouter = () => useContext(RouterContext);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORD = /^[a-z0-9-]{1,40}$/i;

/**
 * Matches "/cabinets/:id" style patterns; returns the named parts or null. Every ":id" must be a UUID and any other
 * part a plain word, so nothing typed into the address bar (an encoded "../", a broken escape) can crash the console
 * or steer the API call a page builds from it.
 */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const actual = (path.split("#")[0]!.split("?")[0] ?? "").split("/").filter(Boolean);
  if (p.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg.startsWith(":")) {
      let value: string;
      try { value = decodeURIComponent(actual[i]!); } catch { return null; }
      if (!(seg === ":id" ? UUID : WORD).test(value)) return null;
      params[seg.slice(1)] = value;
    } else if (seg !== actual[i]) return null;
  }
  return params;
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate } = useRouter();
  return (
    <a href={to} {...rest} onClick={e => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(to);
    }}>{children}</a>
  );
}
