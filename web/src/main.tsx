import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "./lib/arc";
import { AppFooter } from "./app/Footer";
import { LangProvider } from "./lib/i18n";
import { ToastProvider } from "./lib/tx";
import "./styles/app.css";
import "./app/strings";
import "./app/strings-agent";
import "./app/strings-bill";

const Landing = lazy(() => import("./routes/Landing"));
const Home = lazy(() => import("./app/Home"));
const Bill = lazy(() => import("./app/Bill"));
const Earnings = lazy(() => import("./app/Earnings"));
const Chest = lazy(() => import("./app/Chest"));
const Pay = lazy(() => import("./app/Pay"));

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
]);

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
if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}
