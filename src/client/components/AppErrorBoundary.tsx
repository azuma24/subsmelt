import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PageError } from "../ui/QueryState";

// App-level error boundary. Catches render errors anywhere in the tree below it
// and shows a retryable PageError instead of white-screening the app. The
// "reload" action does a full page reload, which is the safest recovery from an
// unknown render error. See frontend-audit §3.

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

// Functional fallback so we can use the i18n hook (class components can't).
function ErrorFallback({ error }: { error: Error | null }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-dvh min-h-dvh w-full items-center justify-center bg-[var(--bg)] text-[var(--text)]">
      <PageError
        message={error?.message || t("errors.boundaryMessage")}
        onRetry={() => window.location.reload()}
      />
    </div>
  );
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the error for diagnostics without crashing the app.
    // eslint-disable-next-line no-console
    console.error("AppErrorBoundary caught a render error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}
