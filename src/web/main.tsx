import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { applicationRoutes } from "./routes.js";
import "./styles.css";

const element = document.getElementById("root");
if (!element) throw new Error("The application root is unavailable.");
const router = createBrowserRouter(applicationRoutes);
createRoot(element).render(<StrictMode><RouterProvider router={router} /></StrictMode>);
