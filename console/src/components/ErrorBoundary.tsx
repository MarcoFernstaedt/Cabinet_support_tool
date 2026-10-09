import { Component, type ReactNode } from "react";

/**
 * Keeps one page's failure (an unexpected answer, a bug) from blanking the whole console: the page is replaced by a
 * short message with a way back, and the rest of the console (navigation, alerts) keeps working. Moving to another
 * page clears it (the boundary is keyed by the path).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="panel" role="alert">
        <h2>This page could not be shown</h2>
        <p className="muted">Something on it was not what the console expected. Nothing was changed on any cabinet.</p>
        <p className="row gap"><a className="btn" href="/">Back to the fleet</a><button type="button" className="btn" onClick={() => this.setState({ failed: false })}>Try again</button></p>
      </section>
    );
  }
}
