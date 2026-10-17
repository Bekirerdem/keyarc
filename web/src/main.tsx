import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "./lib/arc";
import { AppFooter } from "./app/Footer";
import { RouteError } from "./app/RouteError";
import { LangProvider } from "./lib/i18n";
import { ToastProvider } from "./lib/tx";
import "./styles/app.css";
import "./app/strings";
import "./app/strings-agent";
import "./app/strings-bill";

// After a deploy, a tab still running the old build asks for page chunks that no longer exist. Reload once to pick
// up the new build; if loading fails again right away, the error page offers a manual reload instead of a loop.
const RELOAD_KEY = "keyarc:chunk-reload";
function reloadOnce(): boolean {
  try {
    if (Date.now() - Number(sessionStorage.getItem(RELOAD_KEY) ?? 0) < 10_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false; // no storage means no loop guard: leave it to the error page
  }
  window.location.reload();
  return true;
}
const lazyPage = (load: () => Promise<{ default: React.ComponentType }>) =>
  lazy(() => load().catch((e: unknown) => (reloadOnce() ? new Promise<never>(() => {}) : Promise.reject(e))));

const Landing = lazyPage(() => import("./routes/Landing"));
const Home = lazyPage(() => import("./app/Home"));
const Bill = lazyPage(() => import("./app/Bill"));
const Earnings = lazyPage(() => import("./app/Earnings"));
const Chest = lazyPage(() => import("./app/Chest"));
const Pay = lazyPage(() => import("./app/Pay"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 3, retryDelay: (n) => Math.min(800 * 2 ** n, 6000), staleTime: 10_000 } },
});

const page = (el: React.ReactNode) => <Suspense fallback={<div className="board" />}>{el}</Suspense>;
// app pages carry a slim footer; the landing has its own
const app = (el: React.ReactNode) => page(<>{el}<AppFooter /></>);

const router = createBrowserRouter([
  { path: "/", element: page(<Landing />) },
  { path: "/app", element: app(<Home />) },
  { path: "/app/new", element: <Navigate to="/app/bill" replace /> },
  { path: "/app/bill", element: app(<Bill />) },
  { path: "/app/earnings", element: app(<Earnings />) },
  { path: "/c/:address", element: app(<Chest />) },
  { path: "/pay/:chest/:id", element: app(<Pay />) },
  { path: "*", element: app(<Home />) },
].map((r) => ({ ...r, errorElement: <RouteError /> })));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <LangProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </LangProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);

// A returning visitor first gets the cached app; when the new deploy's service worker takes over, reload once
// so nobody keeps running an old build against new contracts. A first visit (no previous worker) never reloads.
// The check is on the registration, not the page's controller: a hard reload leaves the page uncontrolled even
// though a worker is installed, and an update that lands later must still reload it.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistration().then((reg) => {
    if (!reg?.active) return;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  });
}
