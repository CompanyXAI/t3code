import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

// Settings, Usage, and Pull Requests replace the sidebar utility row with a
// Back button. Everything else is the main app, including the Cursor agents
// overview, which is the home page that "/" redirects to. Legacy `/projects/<key>` links
// redirect into settings, so they count too and are never remembered.
export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/pull-requests"
  );
}

let mainAppHref: string | null = null;

export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  useEffect(() => {
    if (href !== null) mainAppHref = href;
  }, [href]);
  return null;
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return useCallback(() => navigate({ href: mainAppHref ?? "/" }), [navigate]);
}
