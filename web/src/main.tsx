import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "./lib/arc";
import { LangProvider } from "./lib/i18n";
import { ToastProvider } from "./lib/tx";
import "./styles/app.css";
import "./app/strings";
import "./app/strings-agent";

const Landing = lazy(() => import("./routes/Landing"));
const Home = lazy(() => import("./app/Home"));
const NewChest = lazy(() => import("./app/NewChest"));
const Chest = lazy(() => import("./app/Chest"));
const Pay = lazy(() => import("./app/Pay"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 3, retryDelay: (n) => Math.min(800 * 2 ** n, 6000), staleTime: 10_000 } },
});

const page = (el: React.ReactNode) => <Suspense fallback={<div className="board" />}>{el}</Suspense>;

const router = createBrowserRouter([
  { path: "/", element: page(<Landing />) },
  { path: "/app", element: page(<Home />) },
  { path: "/app/new", element: page(<NewChest />) },
  { path: "/c/:address", element: page(<Chest />) },
  { path: "/pay/:chest/:id", element: page(<Pay />) },
  { path: "*", element: page(<Home />) },
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
