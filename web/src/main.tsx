import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthGate } from "./components/AuthGate";
import { bootstrapTheme } from "./lib/theme";
import "./styles/index.css";

bootstrapTheme();

// AuthGate wraps App from outside so App (and every hook inside it) only
// mounts once the server says we're authenticated — no SSE streams or polls
// fire just to be 401'd, and App's hook order is undisturbed.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>,
);
