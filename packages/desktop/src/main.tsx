import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { CloudProvider } from "./cloud/client";
import { ErrorBoundary } from "./ErrorBoundary";
// styles.css first (unlayered app reset), then tailwind.css whose unlayered
// utilities must win over that reset — see the layering note in tailwind.css.
import "./styles.css";
import "./tailwind.css";
// Streamdown's streaming fade/blur keyframes (agent markdown output).
import "streamdown/styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <CloudProvider>
        <App />
      </CloudProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
