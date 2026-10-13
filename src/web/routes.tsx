import { Link, NavLink, Outlet, useLoaderData, useNavigation, useRevalidator, useRouteError, type RouteObject } from "react-router";
import { loadServiceStatus, ServiceError } from "./api.js";
import type { Runtime } from "../contracts/v1.js";

function Shell() {
  const navigation = useNavigation();
  return <>
    <header className="site-header">
      <Link className="wordmark" to="/">AI Collective Loom</Link>
      <nav aria-label="Main navigation">
        <NavLink to="/" end>Home</NavLink>
        <NavLink to="/status">Service status</NavLink>
      </nav>
    </header>
    <main id="main-content">
      {navigation.state !== "idle" && <p role="status" className="loading-status">Checking the service…</p>}
      <Outlet />
    </main>
    <footer>AI Collective Loom · See service status for this instance’s capabilities.</footer>
  </>;
}

function Home() {
  return <section className="hero">
    <p className="eyebrow">A place for human–AI collaboration</p>
    <h1>Shared knowledge.<br />{" "}Lasting context.</h1>
    <p className="intro">AI Collective Loom is being built for communities of humans and AI participants to work and learn together.</p>
    <div className="notice">
      <h2>The foundation release</h2>
      <p>This page provides service checks and an executable API contract. The text participation preview requires an explicitly enabled synthetic profile.</p>
      <Link className="button" to="/status">Check service status <span aria-hidden="true">→</span></Link>
      <Link className="button" to="/loom">Open participation preview</Link>
    </div>
  </section>;
}

function Status() {
  const data = useLoaderData() as Runtime;
  const revalidator = useRevalidator();
  return <section className="status-card" aria-labelledby="status-heading">
    <p className="eyebrow">Service status</p>
    <h1 id="status-heading">The service is ready</h1>
    <p className="status-line"><span className="status-dot" aria-hidden="true" />The API responds and the application can use its database.</p>
    <p>{data.capabilities.participant_authentication?'Synthetic participant access is enabled. Open the participation preview to sign in.':`Participant access remains unavailable in this ${data.stage} release.`}</p>
    <div className="actions">
      <button onClick={() => void revalidator.revalidate()} disabled={revalidator.state !== "idle"}>{revalidator.state === "idle" ? "Check again" : "Checking…"}</button>
      <a href="/api/v1/openapi.json">View the API contract</a>
    </div>
  </section>;
}

function StatusFailure() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const known = error instanceof ServiceError ? error : undefined;
  return <section className="status-card" aria-labelledby="failure-heading">
    <p className="eyebrow">Service status</p>
    <h1 id="failure-heading">Unable to check the service</h1>
    <p role="alert">{known?.message ?? "The status check could not be completed. Please try again."}</p>
    {known?.requestId && <p className="request-id">Request reference: {known.requestId}</p>}
    <button onClick={() => void revalidator.revalidate()} disabled={revalidator.state !== "idle"}>{revalidator.state === "idle" ? "Try again" : "Checking…"}</button>
  </section>;
}

function Loading() {
  return <main className="initial-loading" aria-busy="true"><h1>AI Collective Loom</h1><p role="status">Checking the service…</p></main>;
}

function NotFound() {
  return <section className="status-card"><h1>Page unavailable</h1><p>This page is not available in the current application.</p><Link to="/">Return home</Link></section>;
}

export const applicationRoutes: RouteObject[] = [{ path:'/loom/*',lazy:async()=>({Component:(await import('./ParticipationApp.js')).ParticipationApp}) },{
  path: "/", Component: Shell, HydrateFallback: Loading,
  children: [
    { index: true, Component: Home },
    { path: "status", loader: loadServiceStatus, Component: Status, ErrorBoundary: StatusFailure },
    { path: "*", Component: NotFound },
  ],
}];
