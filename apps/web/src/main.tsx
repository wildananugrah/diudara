import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// Imported HERE and nowhere else. Components must not import CSS: `bun test` has
// no CSS loader, so a component that did would break every test that renders it.
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("missing #root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
