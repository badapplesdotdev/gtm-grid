import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { CloudProvider } from "./cloud/client";
import { ErrorBoundary } from "./ErrorBoundary";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <CloudProvider>
        <App />
      </CloudProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
