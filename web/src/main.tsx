import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import Layout from "./components/Layout";
import Overview from "./pages/Overview";
import Explorer from "./pages/Explorer";
import PrDetail from "./pages/PrDetail";
import Analyze from "./pages/Analyze";
import Methodology from "./pages/Methodology";
import { initTheme } from "./lib/theme";
import "./styles.css";

initTheme();

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Overview /> },
      { path: "prs", element: <Explorer /> },
      { path: "prs/:owner/:name/:number", element: <PrDetail /> },
      { path: "analyze", element: <Analyze /> },
      { path: "methodology", element: <Methodology /> },
      { path: "*", element: <p>Page not found.</p> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
