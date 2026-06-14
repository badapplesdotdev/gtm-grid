/**
 * Top-level error boundary. Without one, any uncaught render error unmounts the
 * whole React tree and the window goes BLANK with no clue why — which is exactly
 * how a missing provider / bad env once presented to users. This catches the
 * error, keeps the window non-blank, and surfaces the message so it can be
 * reported instead of looking like a frozen/empty app.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { captureException } from "./analytics";

interface Props {
  readonly children: ReactNode;
}
interface State {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the detail in the console for bug reports / dev tools.
    console.error("Unhandled render error:", error, info.componentStack);
    // React error boundaries swallow the error before it reaches window.onerror,
    // so PostHog's autocapture never sees it — report it explicitly.
    captureException(error);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div role="alert" className="error-boundary">
        <h1>Something went wrong</h1>
        <p>
          The app hit an unexpected error while rendering. Reload to try again —
          your local data is safe on disk.
        </p>
        <pre className="error-boundary__detail">{error.message}</pre>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => location.reload()}
        >
          Reload
        </button>
      </div>
    );
  }
}
