import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <pre className="max-w-xl overflow-auto rounded-md border p-3 text-left text-xs text-[var(--color-destructive)]">
            {this.state.error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-[var(--color-accent)]"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
