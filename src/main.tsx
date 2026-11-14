// The interface's entry point (index.html loads it in the app; mock.html loads src/dev/mockMain.tsx,
// which installs the simulated backend and then imports this). Global styles load first, then the
// appearance and input-modality trackers, then the app.
import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import "./lib/theme";
import { installModality } from "./lib/modality";
import App from "./App";

installModality();
if (import.meta.env.DEV) void import("./dev/selftest").then((m) => m.installSelfTest());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
