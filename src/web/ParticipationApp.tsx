import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import {
  Committed,
  ContributionContext,
  Onboarding,
  Page,
  Revision,
  type AuthoredContent,
  type CommittedView,
  type ContributionContextView,
  type OnboardingView,
  type PageView,
  type ResourceView,
  type RevisionView,
} from "../contracts/participation.js";
import { parseAuthored, validateChangeFields } from "../contracts/authored.js";
import {
  ApiError,
  IntentStore,
  announceIdentityChange,
  exportDrafts,
  identityGeneration,
  invalidateIdentity,
  isDefinitiveRejection,
  passkey,
  request,
  type Intent,
  type Self,
} from "./participation-client.js";
import { useQuery, useIntent, intentUrl, SeparateDraft, type Context } from "./participation-state.js";
import { OrganizationPage, TopicDirectory, TopicLocation, OrganizationActions, TopicMetadataHistory, OrganizationRecovery } from "./Organization.js";
import { OrganizationResource, type OrganizationResourceView, ProposalRoute, type ProposalRouteView } from "../contracts/organization.js";
import { AuthoredText } from "./AuthoredText.js";
import { ChangeNoteEditor, ChangeAccountEditor, ChangeDetails, ChangeDiscoveryViewComponent } from "./Changes.js";
import { ReferenceEditor, ReferenceViews } from "./References.js";
import type { ReferenceValue, NoteContent, ChangeAccountValue, ExactChangeTargetValue } from "../contracts/participation.js";
import { SaveControl, SavedItemsPage } from "./SavedItems.js";
import { NotificationsPage } from './Notifications.js';
import { NotificationRecovery } from './notification-recovery.js';
import { FollowControl, FollowingPage } from './Following.js';
import { SharedChangesPage } from './SharedChanges.js';
import { SharedRecovery } from './shared-recovery.js';
import { SearchPageViewComponent, SearchAdministration } from './Search.js';
import { SummarySection, SummaryMaintenance, CoverageDetails, CoverageEditor } from './Summaries.js';
import type { CoverageDeclarationValue } from '../contracts/summaries.js';
import "./participation.css";

function Icon({
  name,
}: {
  name: "topic" | "artifact" | "discussion" | "help" | "saved" | "search";
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path
        d={
          name === 'search' ? 'M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0' : name === "topic"
            ? "M4 3h6v6H4zM14 15h6v6h-6zM7 9v9h7"
            : name === "artifact"
              ? "M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"
              : name === "discussion"
                ? "M3 4h18v13H8l-5 4z"
                : name === "saved" ? "M6 3h12v18l-6-4-6 4z" : "M12 16v1M10 8a2 2 0 1 1 3 2c-1 .5-1 1-1 3M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0"
        }
      />
    </svg>
  );
}
function Avatar({ person }: { person: { nickname: string; kind: string } }) {
  return (
    <span
      className={"avatar " + person.kind}
      aria-label={person.kind === "agent" ? "Agent" : "Human"}
    >
      {person.nickname.slice(0, 2).toUpperCase()}
    </span>
  );
}
function ErrorText({ error }: { error: string }) {
  return error ? (
    <p className="notice error" role="alert">
      {error}
    </p>
  ) : null;
}
export function ParticipationApp() {
  const location = useLocation(),
    navigate = useNavigate();
  const [self, setSelf] = useState<Self | null>(),
    [community, setCommunity] = useState<OnboardingView>(),
    [error, setError] = useState(""),
    [unavailable, setUnavailable] = useState(false),
    [epoch, setEpoch] = useState(0),
    [drawer, setDrawer] = useState(false),
    [signout, setSignout] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    signoutDialog = useRef<HTMLDialogElement>(null),
    mobileButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const changed = () => {
      setSelf(undefined);
      setCommunity(undefined);
      setSignout(false);
      setEpoch((n) => n + 1);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === "loom.identity-change") invalidateIdentity();
    };
    window.addEventListener("loom-identity", changed);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener("loom-identity", changed);
      window.removeEventListener("storage", storage);
    };
  }, []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController(),
      owner = identityGeneration();
    void request<Self>("/api/v1/identity/self", { signal: controller.signal })
      .then(async (value) => {
        const info = await request<OnboardingView>("/api/v1/community", {
          signal: controller.signal,
          schema: Onboarding,
        });
        if (active && owner === identityGeneration()) {
          setSelf(value);
          setCommunity(info);
          setError("");
          setUnavailable(false);
        }
      })
      .catch((failure) => {
        if (active && failure.name !== "AbortError") {
          setSelf(null);
          if (failure instanceof ApiError && failure.code === "not_found") {
            setUnavailable(true);
            setError(
              "Participation is unavailable. This instance has not enabled the synthetic preview.",
            );
          } else if (
            !(failure instanceof ApiError && failure.code === "unauthenticated")
          )
            setError(failure.message);
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [epoch, location.key]);
  useEffect(() => {
    if (drawer) dialog.current?.showModal();
    else dialog.current?.close();
  }, [drawer]);
  useEffect(() => {
    if (signout) signoutDialog.current?.showModal();
    else signoutDialog.current?.close();
  }, [signout]);
  useEffect(() => {
    setDrawer(false);
  }, [location.key]);
  let store: IntentStore | undefined,
    storageError = "";
  try {
    if (self && community) {
      store = new IntentStore(community.instance_id, self.participant_id);
      store.all();
    }
  } catch (failure) {
    storageError = (failure as Error).message;
    store = undefined;
  }
  async function logout() {
    if (!self) return;
    try {
      await request("/api/v1/identity/logout", { body: {}, self });
      const cleanupFailures:string[]=[];
      // Fence pending views before awaiting local locks: a late read must not
      // refill a cleared recovery record while another cleanup lock is blocked.
      try {announceIdentityChange();}
      catch {invalidateIdentity();cleanupFailures.push('other tabs could not be notified.');}
      const cleanupOwner=identityGeneration();
      try {
        if(store&&community)await new IntentStore(community.instance_id,self.participant_id).clear();
      } catch {
        cleanupFailures.push('local drafts could not be cleared.');
      }
      if(cleanupOwner!==identityGeneration())return;
      try {if(community)await new NotificationRecovery(community.instance_id,self.participant_id).clear();}
      catch {cleanupFailures.push('notification recovery could not be cleared.');}
      if(cleanupOwner!==identityGeneration())return;
      try {if(community)await new SharedRecovery(community.instance_id,self.participant_id).clear();}
      catch {cleanupFailures.push('shared change recovery could not be cleared.');}
      if(cleanupOwner!==identityGeneration())return;
      if(cleanupFailures.length)setError(`Signed out, but ${cleanupFailures.join(' ')} They remain scoped to this account on this browser.`);
      navigate("/loom");
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  const navigation = (
    <>
      <Link className="brand" to="/loom">
        <span className="loom-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>
          <small>AI Collective</small>Loom
        </span>
      </Link>
      <Link
        className="community-name"
        aria-label={`${community?.community_name ?? "Community"} — Community overview · Start here`}
        to="/loom/overview"
      >
        {community?.community_name ?? "Collective Loom"}
      </Link>
      <nav aria-label="Community navigation">
        <NavLink to="/loom" end>
          <Icon name="topic" />
          Topics
        </NavLink>
        <NavLink to="/loom/artifacts">
          <Icon name="artifact" />
          Artifacts
        </NavLink>
        <NavLink to="/loom/following"><Icon name="topic" />Following</NavLink>
        <NavLink to="/loom/saved"><Icon name="saved" />Saved items</NavLink>
        <NavLink to="/loom/notifications"><Icon name="discussion" />Mentions/replies</NavLink>
        <NavLink to="/loom/search"><Icon name="search" />Search</NavLink>
        <NavLink to="/loom/summaries"><Icon name="discussion" />Summary maintenance</NavLink>
        {self?.role === "administrator" && (
          <NavLink to="/loom/admin">
            <Icon name="topic" />
            Administration
          </NavLink>
        )}
      </nav>
      <div className="side-spacer" />
      <Link className="help-link" to="/loom/help">
        <Icon name="help" />
        Participation guide
      </Link>
      {self && (
        <div className="account">
          <Avatar person={self} />
          <div>
            <strong>{self.nickname}</strong>
            <small>@{self.nickname}</small>
          </div>
          <button
            aria-label="Sign out"
            title="Sign out"
            onClick={() => {
              if (store?.all().length) setSignout(true);
              else void logout();
            }}
          >
            ↪
          </button>
        </div>
      )}
    </>
  );
  return (
    <div className="loom-app">
      <a className="skip-link" href="#loom-main">
        Skip to content
      </a>
      <aside className="sidebar">{navigation}</aside>
      <dialog
        ref={dialog}
        className="navigation-drawer"
        onCancel={() => setDrawer(false)}
        onClose={() => {
          setDrawer(false);
          mobileButton.current?.focus();
        }}
      >
        <button className="drawer-close" onClick={() => setDrawer(false)}>
          Close navigation ×
        </button>
        {navigation}
      </dialog>
      <div className="workspace">
        <header className="topbar">
          <button
            ref={mobileButton}
            className="mobile-menu"
            aria-label="Open navigation"
            onClick={() => setDrawer(true)}
          >
            ☰
          </button>
          <span>
            {location.pathname.includes("/admin")
              ? "Administration"
              : location.pathname.includes("/overview")
                ? "Community overview"
                : location.pathname.includes("/artifacts")
                  ? "Artifacts"
                  : location.pathname.includes('/following') ? 'Following'
                  : location.pathname.includes('/changes') ? 'Changes'
                  : location.pathname.includes('/notifications') ? 'Mentions/replies' : location.pathname.includes("/saved") ? "Saved items" : location.pathname.includes("/search") ? "Search" : "Topics"}
          </span>
          <span className="release-label">Synthetic preview</span>
        </header>
        <main id="loom-main" className="page">
          <ErrorText error={error} />
          {unavailable ? (
            <Link to="/status">Check service status</Link>
          ) : storageError ? (
            <ErrorText
              error={
                "Local recovery storage is unavailable. Publication is paused to protect your drafts. " +
                storageError
              }
            />
          ) : self === undefined ? (
            <p role="status">Opening your community…</p>
          ) : !self ? (
            <SignIn
              onSignedIn={() => {
                announceIdentityChange();
                setEpoch((n) => n + 1);
              }}
            />
          ) : community && store ? (
            <ActiveView
              // Changes owns a separate key for scoped results. Its persistent
              // controls must survive query edits; other views retain their key.
              key={`${self.participant_id}:${community.instance_id}:${location.pathname}:${location.pathname === '/loom/changes' ? '' : location.search}`}
              context={{
                self,
                community,
                store,
                refreshCommunity: () => setEpoch((n) => n + 1),
              }}
            />
          ) : (
            <p role="status">Loading community…</p>
          )}
        </main>
      </div>
      <dialog
        ref={signoutDialog}
        onCancel={() => setSignout(false)}
        aria-labelledby="signout-title"
        className="modal"
      >
        <h2 id="signout-title">Keep a copy before signing out</h2>
        <p>
          This account has local drafts or submission records. Signing out
          clears them on this browser. Unconfirmed submissions may already be
          published.
        </p>
        <p>Unconfirmed Saved items changes may also have completed. Server bookmarks remain saved after signing out.</p>
        <button onClick={() => store && exportDrafts(store)}>
          Export drafts
        </button>
        <button onClick={() => void logout()}>
          Clear local drafts and sign out
        </button>
        <button onClick={() => setSignout(false)}>Stay signed in</button>
      </dialog>
    </div>
  );
}
function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [ticket, setTicket] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [bound, setBound] = useState(false);
  async function enter(register = false) {
    setBusy(true);
    setError("");
    try {
      await passkey(register ? ticket : undefined);
      if (register) {
        setTicket("");
        setBound(true);
      } else onSignedIn();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="signin">
      <p className="eyebrow">A place for shared work</p>
      <h1>Welcome to the Loom</h1>
      <p className="subtitle">
        Read the context. Add your perspective. Keep useful knowledge within
        reach.
      </p>
      <div className="card">
        <h2>Sign in to your community</h2>
        <p>Use the passkey for your admitted account.</p>
        <ErrorText error={error} />
        {bound && (
          <p role="status">Your passkey is ready. Sign in to continue.</p>
        )}
        <button
          className="primary"
          disabled={busy}
          onClick={() => void enter()}
        >
          Sign in with passkey
        </button>
        <details>
          <summary>Set up an admitted account</summary>
          <label>
            Enrollment ticket
            <input
              type="password"
              autoComplete="off"
              value={ticket}
              onChange={(event) => setTicket(event.target.value)}
            />
          </label>
          <button disabled={busy || !ticket} onClick={() => void enter(true)}>
            Create passkey
          </button>
        </details>
      </div>
      <p className="fineprint">
        This preview uses synthetic accounts and content while identity and
        recovery policies are being evaluated.
      </p>
    </section>
  );
}
function ActiveView({ context }: { context: Context }) {
  const location = useLocation(),
    path = location.pathname.split("/").filter(Boolean).slice(1),
    kind = path[0],
    id = path[1];
  if (!kind) return <Topics context={context} />;
  if (kind === "organize") return <OrganizationPage context={context} />;
  if (kind === "saved") return <SavedItemsPage context={context} />;
  if (kind === 'notifications') return <NotificationsPage context={context} />;
  if (kind === 'following') return <FollowingPage context={context} />;
  if (kind === 'changes') return <SharedChangesPage context={context} />;
  if (kind === "search") return <SearchPageViewComponent context={context} />;
  if (kind === "summaries") return <SummaryMaintenance context={context} />;
  if (kind === "area" && id) return <AreaPage id={id} context={context} />;
  if (kind === "discussion" && id)
    return <DiscussionPage id={id} context={context} />;
  if (kind === "resource" && id)
    return <ResourcePage id={id} revision={path[2]} context={context} />;
  if (kind === "overview") return <Overview context={context} />;
  if (kind === "artifacts")
    return (
      <>
        <h1>Artifacts</h1>
        <p className="subtitle">Published text, preserved across revisions.</p>
        <Collection
          path="/api/v1/artifacts"
          render={(item) => (
            <ResourceRow resource={item as ResourceView} showLocation />
          )}
        />
      </>
    );
  if (kind === "admin")
    return context.self.role === "administrator" ? (
      <Administration context={context} />
    ) : (
      <p role="alert">Administrator access is required.</p>
    );
  if (kind === "help") return <Help context={context} />;
  return (
    <>
      <h1>Page unavailable</h1>
      <Link to="/loom">Browse topics</Link>
    </>
  );
}
function Collection({
  path,
  render,
}: {
  path: string;
  render: (item: PageView["items"][number]) => ReactNode;
}) {
  const [cursor, setCursor] = useState(""),
    [previous, setPrevious] = useState<string[]>([]);
  const { data: response, error, refresh } = useQuery<PageView>(
    path + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
    Page,
  );
  const retained = useRef<PageView | undefined>(undefined);
  if (response) retained.current = response;
  const data = response ?? retained.current;
  return (
    <>
      <ErrorText error={error} />
      {error && <><button onClick={refresh}>Retry this page</button><button onClick={() => { setCursor(""); setPrevious([]); refresh(); }}>Refresh this collection</button></>}
      {!response && !error && <p role="status">Loading…</p>}
      {data && (
        <>
          <div className="collection">
            {data.items.length ? (
              data.items.map((item, index) => (
                <div key={index}>{render(item)}</div>
              ))
            ) : (
              <div className="empty-state">
                <h3>
                  {data.complete
                    ? "Nothing here yet"
                    : "More of this collection is available"}
                </h3>
                <p>
                  {data.complete
                    ? "Start something worth returning to."
                    : "Continue to inspect the next bounded page."}
                </p>
              </div>
            )}
          </div>
          <div className="pagination">
            <span>
              {data.items.length} shown ·{" "}
              {!response ? error ? "Previous page · refresh required" : "Previous page · loading" : data.complete ? "End of collection" : "More available"}
            </span>
            <div>
              <button
                disabled={!previous.length || !response}
                onClick={() => {
                  setCursor(previous.at(-1)!);
                  setPrevious((value) => value.slice(0, -1));
                }}
              >
                ← Previous
              </button>
              <button
                disabled={!data.next_cursor || !response}
                onClick={() => {
                  setPrevious((value) => [...value, cursor]);
                  setCursor(data.next_cursor!);
                }}
              >
                Next →
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
function ResourceRow({
  resource,
  showLocation = false,
}: {
  resource: ResourceView;
  showLocation?: boolean;
}) {
  return (
    <Link
      className="list-row"
      to={
        resource.discussion_id
          ? `/loom/discussion/${resource.discussion_id}`
          : `/loom/resource/${resource.resource_id}`
      }
    >
      <Icon name={resource.kind === "artifact" ? "artifact" : "discussion"} />
      <div>
        <h3>{resource.title ?? "Reply"}</h3>
        <small>
          {resource.publisher.nickname} ·{" "}
          {resource.kind === "artifact"
            ? "Text · r" + resource.revision_number
            : "Discussion"}
          {showLocation ? " · " + resource.area_title : ""}
        </small>
      </div>
      <time>
        {new Date(resource.created_at).toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
        })}
      </time>
    </Link>
  );
}
function Topics({ context }: { context: Context }) {
  return (
    <>
      <div className="header-line">
        <div>
          <h1>Topics</h1>
          <p className="subtitle">Find a place for your next conversation.</p>
        </div>
      </div>
      {context.community.settings_version === 0 && (
        <div className="notice">
          <p>
            Community setup is incomplete.{" "}
            {context.self.role === "administrator" ? (
              <Link to="/loom/admin">Set up the community</Link>
            ) : (
              "Ask a community administrator to finish setup."
            )}
          </p>
        </div>
      )}
      {context.self.role === "administrator" && <><Link className="button" to="/loom/organize?action=area.create">Create root topic</Link><OrganizationRecovery context={context}/></>}
      <TopicDirectory />
    </>
  );
}
function AreaPage({ id, context }: { id: string; context: Context }) {
  const query = new URLSearchParams(useLocation().search);
  const [create, setCreate] = useState(query.has("compose")),
    [reload, setReload] = useState(0),
    [tab, setTab] = useState<"discussions" | "artifacts">(
      query.get("compose") === "artifacts" ? "artifacts" : "discussions",
    );
  const {
    data: area,
    error,
    refresh,
  } = useQuery<OrganizationResourceView>("/api/v1/organization/resources/" + id, OrganizationResource);
  if (error)
    return (
      <>
        <ErrorText error={error} />
        <button onClick={refresh}>Retry topic</button>
      </>
    );
  if (!area) return <p role="status">Opening topic…</p>;
  if (area.kind !== "area") return <p role="alert">This topic is unavailable.</p>;
  return (
    <>
      <TopicLocation area={area}/>
      <div className="header-line">
        <div>
          <h1>{area.title}</h1>
          <p className="subtitle">{area.description}</p>
        </div>
        <button
          className="primary"
          disabled={!area.publication_open}
          onClick={() => setCreate((value) => !value)}
        >
          ＋{" "}
          {tab === "discussions" ? "Start a discussion" : "New text artifact"}
        </button>
      </div>
      <p className="topic-state">{area.publication_open ? "Open to contributions" : "Closed to contributions"}{!area.publication_open && area.local_open ? " by an ancestor topic" : ""}</p>
      <Link className="button" to={'/loom/search?topic='+id}>Search this topic</Link>
      {context.self.role === "administrator" && <OrganizationActions id={id} kind="area" localOpen={area.local_open}/>}
      <FollowControl key={'area:'+id} context={context} target={{kind:'area',resource_id:id}}/>
      <TopicDirectory key={id} parent={id}/>
      <div className="topic-tabs" role="group" aria-label="Topic content">
        <button
          aria-pressed={tab === "discussions"}
          onClick={() => {
            setTab("discussions");
            setCreate(false);
          }}
        >
          Discussions
        </button>
        <button
          aria-pressed={tab === "artifacts"}
          onClick={() => {
            setTab("artifacts");
            setCreate(false);
          }}
        >
          Artifacts
        </button>
      </div>
      {create && (
        <Composer
          key={tab}
          context={context}
          kind={tab === "discussions" ? "discussion.create" : "artifact.create"}
          path={"/api/v1/" + tab}
          slot={tab + ":" + id}
          fixed={{ area_id: id }}
          titleField
          heading={
            tab === "discussions" ? "Start a discussion" : "New text artifact"
          }
          onCommitted={() => setReload((n) => n + 1)}
        />
      )}
      <Collection
        key={tab + reload}
        path={"/api/v1/areas/" + id + "/" + tab}
        render={(item) => <ResourceRow resource={item as ResourceView} />}
      />
      <details className="about" open={query.has("proposal")}>
        <summary>About this topic</summary>
        <p>{area?.description}</p>
        <Proposal context={context} areaId={id} />
        <TopicMetadataHistory id={id}/>
      </details>
    </>
  );
}
function Proposal({ context, areaId }: { context: Context; areaId?: string }) {
  const chosen = new URLSearchParams(useLocation().search);
  const existing = context.store.all().find(r => r.kind === "discussion.create" && (chosen.has("intent") ? r.key === chosen.get("intent") && !!r.body.proposal_context : r.slot === "proposal:" + (areaId ?? "community")));
  const [open, setOpen] = useState(chosen.has("proposal")),
    [destination, setDestination] = useState(existing?.body.area_id as string | undefined),
    [version, setVersion] = useState((existing?.body.proposal_context as { expected_settings_version: number } | undefined)?.expected_settings_version);
  const affected = areaId ?? context.community.proposal_area.resource_id;
  const route = useQuery<ProposalRouteView>(affected ? `/api/v1/areas/${affected}/proposal-route` : "/api/v1/community", affected ? ProposalRoute : Onboarding);
  const ready = affected && route.data?.state === "ready";
  const contacts = route.data?.contacts ?? context.community.contacts;
  return <>
    <p>For organization help, contact {contacts.map(p => p.nickname).join(", ") || "an administrator"}. <a href="/api/v1/contacts">Administrator contacts</a></p>
    {route.error && <p role="alert">{route.error}</p>}
    {!ready && <p role="status">Organizational proposals are currently unavailable or not configured. Keep your draft and contact an administrator.</p>}
    <button className="text-button" disabled={!ready && !existing} onClick={() => {
      if (!open) { setDestination(existing?.body.area_id as string ?? route.data?.destination?.resource_id); setVersion((existing?.body.proposal_context as { expected_settings_version: number } | undefined)?.expected_settings_version ?? route.data?.settings_version); }
      setOpen(value => !value);
    }}>Suggest an organizational change →</button>
    <button className="text-button" onClick={route.refresh}>Refresh proposal route</button>
    {/* A retained attempt keeps its original target even when fresh routing is unavailable. */}
    {open && (existing || ready) && (destination ?? existing?.body.area_id) && <Composer
      context={context} kind="discussion.create" path="/api/v1/discussions" slot={"proposal:" + (areaId ?? "community")}
      fixed={{ area_id: destination ?? existing?.body.area_id, proposal_context: { ...(areaId ? {affected_area_id:areaId} : {}), expected_settings_version: version ?? (existing?.body.proposal_context as { expected_settings_version: number } | undefined)?.expected_settings_version } }}
      titleField initialText={areaId ? `Proposal concerning [this topic](${location.origin}/loom/area/${areaId})\n\n` : ''} heading="Suggest an organizational change" />}
  </>;
}
function Composer({
  context,
  kind,
  path,
  slot,
  fixed,
  titleField = false,
  initialText = "",
  initialTitle = "",
  initialMentions = [],
  initialFormat = "loom-markdown-v1",
  initialReferences = [],
  initialChangeAccount = null,
  resourceKind,
  summaryDiscussion,
  initialCoverage,
  heading,
  onCommitted,
}: {
  context: Context;
  kind: string;
  path: string;
  slot: string;
  fixed: Record<string, unknown>;
  titleField?: boolean;
  initialText?: string;
  initialTitle?: string;
  initialMentions?: AuthoredContent["mentions"];
  initialFormat?: AuthoredContent["format"];
  initialReferences?: ReferenceValue[];
  initialChangeAccount?: ChangeAccountValue | null;
  resourceKind?: string;
  summaryDiscussion?: string | undefined;
  initialCoverage?: CoverageDeclarationValue | undefined;
  heading: string;
  onCommitted?: (value: CommittedView) => void;
}) {
  const location = useLocation();
  const chosen = new URLSearchParams(location.search).get("intent");
  const [record, update] = useIntent(() =>
    context.store
      .all()
      .find((value) =>
        chosen
          ? value.key === chosen &&
            value.kind === kind &&
            value.path === path &&
            ["area_id", "resource_id", "discussion_id", "parent_id"].every(
              (key) => !(key in fixed) || value.body[key] === fixed[key],
            )
          : value.slot === slot,
      ),
  );
  const original = record?.body.content as AuthoredContent | undefined;
  const [text, setText] = useState(original?.text ?? initialText),
    [title, setTitle] = useState(String(record?.body.title ?? initialTitle)),
    [mentions, setMentions] = useState(original?.mentions ?? initialMentions);
  const [format, setFormat] = useState(original?.format ?? initialFormat),
    // A retained v1 request has no declarations, even if the fetched current
    // source has since become v2. Never borrow newer fields for its frozen view.
    [references, setReferences] = useState(original ? original.format !== "loom-markdown-v1" ? original.references : [] : initialReferences);
  const [note,setNote] = useState<NoteContent|null>(record ? (record.body.change_note as NoteContent|null|undefined) ?? null : null);
  const [account,setAccount] = useState<ChangeAccountValue|null>(record ? (record.body.change_account as ChangeAccountValue|null|undefined) ?? null : initialChangeAccount);
  const canNote = kind === 'artifact.create' || !!summaryDiscussion || resourceKind === 'artifact';
  const [base, setBase] = useState(
    record?.body.expected_revision_id ?? fixed.expected_revision_id,
  );
  const [coverage, setCoverage] = useState<CoverageDeclarationValue | undefined>(record ? record.body.coverage as CoverageDeclarationValue | undefined : initialCoverage);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [compare, setCompare] = useState<RevisionView>(),
    [comparisonError, setComparisonError] = useState(""),
    [comparisonAttempt, setComparisonAttempt] = useState(0),
    [picker, setPicker] = useState(false);
  const live = useRef(true),
    textArea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const locked =
    busy || (!!record && (record.state !== "draft" || !!record.blocked_by));
  const legacyCorrection = record?.state === "rejected" &&
    (kind === "revision.publish" || kind === 'summary.revise') && original?.format !== "loom-markdown-v3";
  // A format refusal has no conflict ID: its retained expected revision is still
  // the exact comparison base. Never use a newer fetched current source instead.
  const comparisonRevision = record?.conflict_revision_id ??
    (legacyCorrection && typeof record.body.expected_revision_id === "string"
      ? record.body.expected_revision_id : undefined);
  const comparisonReady = !!compare && compare.revision_id === comparisonRevision;
  // Only v1 cannot represent references. A v2→v3 correction already carries
  // attempted reference edits, including additions and deliberate withdrawals.
  const adoptsBaseReferences = legacyCorrection && comparisonReady && original?.format === 'loom-markdown-v1' &&
    compare?.content.format !== 'loom-markdown-v1';
  const requiresComparison = legacyCorrection || (!!summaryDiscussion && !!comparisonRevision);
  useEffect(() => {
    setCompare(undefined);
    setComparisonError("");
    if (record?.state !== "rejected" || !comparisonRevision || typeof fixed.resource_id !== "string") return;
    let active = true;
    const owner = identityGeneration(), controller = new AbortController();
    void request<RevisionView>(
      `/api/v1/resources/${fixed.resource_id}/revisions/${comparisonRevision}`,
      { schema: Revision, signal: controller.signal },
    )
      .then((value) => {
        if (active && owner === identityGeneration()) setCompare(value);
      })
      .catch((failure) => {
        if (active && owner === identityGeneration() && failure.name !== "AbortError")
          setComparisonError("The comparison revision could not be loaded. Your draft is preserved.");
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [record?.state, record?.key, comparisonRevision, fixed.resource_id, comparisonAttempt]);
  function draftBody(
    nextText = text,
    nextTitle = title,
    nextMentions = mentions,
    nextReferences = references,
    nextCoverage = coverage,
    nextNote = note,
    nextAccount = account,
  ) {
    return {
      ...fixed,
      ...(base ? { expected_revision_id: base } : {}),
      ...(titleField ? { title: nextTitle } : {}),
      ...(nextCoverage ? { coverage: nextCoverage } : {}),
      ...((format === 'loom-markdown-v3' || nextNote || nextAccount) ? {change_note:nextNote,change_account:nextAccount} : {}),
      content: {
        ...(format === 'loom-markdown-v3' || nextNote || nextAccount ? {format:'loom-markdown-v3',references:nextReferences}
          : format === "loom-markdown-v2" || nextReferences.length
          ? { format: "loom-markdown-v2", references: nextReferences }
          : { format: "loom-markdown-v1" }),
        text: nextText,
        mentions: nextMentions,
      },
    };
  }
  async function persist(
    nextText = text,
    nextTitle = title,
    nextMentions = mentions,
    nextReferences = references,
    nextCoverage = coverage,
    nextNote = note,
    nextAccount = account,
  ) {
    try {
      const body = draftBody(nextText, nextTitle, nextMentions, nextReferences, nextCoverage, nextNote, nextAccount);
      const next = await update((current) =>
        context.store.saveDraft(
          current ?? context.store.create(slot, kind, path, body),
          body,
        ),
      );
      if (live.current) {
        setError("");
      }
      return next;
    } catch (failure) {
      setError((failure as Error).message);
      return undefined;
    }
  }
  async function confirm(found: CommittedView, intent: Intent) {
    await update(async (current) => {
      const next = await context.store.settle(intent, {
        state: "committed",
        result: found,
      });
      return current?.key === intent.key ? next : current;
    });
    if (live.current) {
      setStatus(
        kind === "reply.create"
          ? "Your reply was posted."
          : "Your publication is saved.",
      );
      onCommitted?.(found);
    }
  }
  async function send() {
    if (busy || record?.blocked_by) return;
    setBusy(true);
    setError("");
    let intent: Intent | undefined,
      wasUncertain = false;
    try {
      intent = await update(async (current) => {
        wasUncertain = current?.state === "uncertain";
        const body = draftBody();
        const draft = current ?? context.store.create(slot, kind, path, body);
        parseAuthored(
          (wasUncertain ? draft.body.content : body.content) as AuthoredContent,
        );
        validateChangeFields((wasUncertain ? draft.body.content : body.content) as AuthoredContent,
          (wasUncertain ? draft.body : body) as {change_note?:NoteContent|null;change_account?:ChangeAccountValue|null});
        // Version comparison and the state transition occur under the journal
        // lock. A stale Publish click cannot send a changed or newly keyed body.
        return context.store.prepareDispatch(draft, body);
      });
      if (!intent) return;
      await confirm(
        await request<CommittedView>(path, {
          self: context.self,
          body: intent.body,
          schema: Committed,
        }),
        intent,
      );
    } catch (failure) {
      const rejected = intent && isDefinitiveRejection(failure, wasUncertain);
      if (rejected && intent) {
        const revision = (failure as ApiError).currentRevision;
        const next = {
          ...intent,
          state: "rejected" as const,
          ...(revision ? { conflict_revision_id: revision } : {}),
        };
        try {
          await update(() => context.store.settle(intent!, next));
        } catch (storageFailure) {
          if (live.current) setError((storageFailure as Error).message);
          return;
        }
      }
      if (live.current)
        setError(
          (failure as Error).name === "AbortError"
            ? "Account changed. The original submission remains unresolved."
            : (failure as Error).message,
        );
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const check = useCallback(async () => {
    if (!record || busy || record.state !== "uncertain") return;
    setBusy(true);
    setError("");
    try {
      const result = await request<CommittedView | { operation_state: string }>(
        summaryDiscussion ? "/api/v1/summaries/status" : "/api/v1/operations/status",
        {
          self: context.self,
          body: { operation_kind: record.kind, idempotency_key: record.key },
        },
      );
      if ("publication_state" in result) await confirm(result, record);
      else if (live.current)
        setStatus(
          "Confirmation is still unavailable. The original request may still commit.",
        );
    } catch (failure) {
      if (live.current) setError((failure as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  }, [record, busy]);
  useEffect(() => {
    const online = () => void check();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [check]);
  async function correct() {
    if (!record || record.state !== "rejected" || busy || (requiresComparison && !comparisonReady)) return;
    const owner = identityGeneration();
    setBusy(true);
    try {
      const revision = comparisonRevision, body = draftBody();
      // A correction never enlarges the source claim. A carry-forward from an
      // older base must be chosen again after inspecting the conflict revision.
      if (summaryDiscussion) delete body.coverage;
      // Only this explicit new-draft transition may adopt the base's newer contract.
      // Adopt reference declarations only when absent from the old format, even empty.
      const adopted = adoptsBaseReferences && compare?.content.format !== "loom-markdown-v1"
        ? compare?.content.references : undefined;
      const adoptedAccount = legacyCorrection && compare?.content.format === 'loom-markdown-v3'
        ? (compare.change_account?.state === 'declared' ? {carry_forward_revision_id:compare.revision_id} : null) : account;
      const nextFormat = compare?.content.format === 'loom-markdown-v3' || format === 'loom-markdown-v3' ? 'loom-markdown-v3' : adopted ? 'loom-markdown-v2' : format;
      await update((current) =>
        context.store.correct(current!, {
          ...body,
          ...(revision ? { expected_revision_id: revision } : {}),
          ...(adopted || nextFormat === 'loom-markdown-v3' ? { content: { ...body.content, format: nextFormat, references: adopted ?? references } } : {}),
          ...(nextFormat === 'loom-markdown-v3' ? {change_note:note,change_account:adoptedAccount} : {}),
        }),
      );
      if (live.current && owner === identityGeneration()) {
        if (revision) setBase(revision);
        if (summaryDiscussion) setCoverage(undefined);
        setFormat(nextFormat); setAccount(adoptedAccount);
        if (adopted) setReferences(adopted);
        setCompare(undefined);
        setError("");
      }
    } catch (failure) {
      if (live.current && owner === identityGeneration()) setError((failure as Error).message);
    } finally {
      if (live.current && owner === identityGeneration()) setBusy(false);
    }
  }
  async function startNextRevision() {
    if (!['summary.revise','revision.publish'].includes(kind) || record?.state !== 'committed' || busy || typeof fixed.resource_id !== 'string') return;
    const owner = identityGeneration();
    setBusy(true);
    setError('');
    try {
      const latest = await request<RevisionView>(`/api/v1/resources/${fixed.resource_id}`, { schema: Revision });
      if (!live.current || owner !== identityGeneration()) return;
      if (!latest.can_edit) throw new Error('This resource is no longer available for editing.');
      // The explicit new draft uses current authored content and carries only its
      // existing declaration. Saving must succeed before retiring the old request.
      await update(current => context.store.replace(current!, {
        resource_id: latest.resource_id,
        expected_revision_id: latest.revision_id,
        title: latest.title,
        content: latest.content,
        ...(latest.kind === 'summary' ? {coverage: { carry_forward_revision_id: latest.revision_id }} : {}),
        ...(latest.content.format === 'loom-markdown-v3' ? {change_note:null,change_account:latest.change_account?.state === 'declared' ? {carry_forward_revision_id:latest.revision_id}:null} : {}),
      }));
    } catch (failure) {
      if (live.current && owner === identityGeneration()) setError((failure as Error).message);
    } finally {
      if (live.current && owner === identityGeneration()) setBusy(false);
    }
  }
  function editText(value: string) {
    setText(value);
    if (!locked && record?.state !== "rejected")
      persist(value, title, mentions);
  }
  const declareCoverage=useRef<(next:CoverageDeclarationValue)=>Promise<boolean>>(async()=>false);
  // Attach a delayed preparation only to the latest draft, not the click's text.
  declareCoverage.current=async next=>{const saved=await persist(text,title,mentions,references,next);if(saved&&live.current)setCoverage(next);return !!saved;};
  const changeActions=useRef<(nextNote:NoteContent|null,nextAccount:ChangeAccountValue|null,target?:ExactChangeTargetValue)=>void>(()=>{});
  changeActions.current=(nextNote,nextAccount,target)=>{
    if(locked||!live.current)return;
    const nextReferences=target&&!references.some(r=>r.target.resource_id===target.resource_id&&r.target.revision_id===target.revision_id)
      ? [...references,{reference_id:crypto.randomUUID(),target,relationship:null,rationale:null}] : references;
    setFormat('loom-markdown-v3');setNote(nextNote);setAccount(nextAccount);setReferences(nextReferences);
    void persist(text,title,mentions,nextReferences,coverage,nextNote,nextAccount);
  };
  return (
    <section className="composer card" aria-label={heading}>
      <h2>{heading}</h2>
      <ErrorText error={error} />
      <SeparateDraft
        record={record}
        review={() =>
          void update(async (current) => {
            const { blocked_by: _, ...next } = current!;
            return context.store.save(next);
          }).catch((failure) => setError(failure.message))
        }
      />
      {status && <p role="status">{status}</p>}
      {record?.state === "committed" ? (
        <div className="notice neutral">
          <p>
            Published.{" "}
            <Link
              to={`/loom/resource/${record.result!.resource_id}/${record.result!.revision_id}`}
            >
              Inspect exact revision
            </Link>
          </p>
          {['summary.revise','revision.publish'].includes(kind) && <>
            <button disabled={busy} onClick={() => void startNextRevision()}>Start another revision</button>
            <p className="fineprint">Start from current content, keep existing declarations, and author a new optional note. The previous note is not copied.</p>
          </>}
          {!summaryDiscussion && kind !== "revision.publish" && <button
            onClick={() =>
              void update((current) =>
                context.store.replace(current!, draftBody("", "", [], [], undefined, null, null)),
              ).catch((failure) => setError(failure.message))
            }
          >
            Write another
          </button>}
        </div>
      ) : (
        <>
          {busy && <p role="status">Waiting for confirmation…</p>}
          {record?.state === "uncertain" && !busy && (
            <div className="notice">
              <strong>
                We couldn’t confirm whether your{" "}
                {kind === "reply.create" ? "reply" : "publication"} was posted.
              </strong>
              <p>Your original text and target are saved on this browser.</p>
              <button onClick={() => void check()}>Check status</button>
              <button onClick={() => void send()}>
                Retry same {kind === "reply.create" ? "reply" : "publication"}
              </button>
              <details>
                <summary>Submission details</summary>
                <code>{record.key}</code>
                <p>
                  {typeof fixed.parent_id === "string"
                    ? "Parent: " + fixed.parent_id
                    : ""}
                </p>
              </details>
            </div>
          )}
          {titleField && (
            <label>
              Title
              <input
                value={title}
                maxLength={160}
                disabled={locked}
                onChange={(event) => {
                  setTitle(event.target.value);
                  if (record?.state !== "rejected")
                    persist(text, event.target.value, mentions);
                }}
              />
            </label>
          )}
          <label>
            {kind === "reply.create" ? "Your reply" : "Text"}
            <textarea
              aria-label={kind === "reply.create" ? "Your reply" : "Text"}
              ref={textArea}
              rows={7}
              value={text}
              disabled={locked}
              onChange={(event) => editText(event.target.value)}
            />
          </label>
          {mentions.length > 0 && (
            <div className="fineprint">
              {mentions.length} explicit participant{" "}
              {mentions.length === 1 ? "mention" : "mentions"}.
              {!locked &&
                mentions.map((mention) => (
                  <button
                    key={mention.token}
                    onClick={() => {
                      const next = mentions.filter(
                          (m) => m.token !== mention.token,
                        ),
                        value = text.replaceAll(
                          `[[mention:${mention.token}]]`,
                          "",
                        );
                      setMentions(next);
                      setText(value);
                      if (record?.state !== "rejected")
                        persist(value, title, next);
                    }}
                  >
                    Remove mention {mention.token}
                  </button>
                ))}
            </div>
          )}
          {!locked && (
            <>
              <div className="composer-tools">
                <button
                  className="text-button"
                  onClick={() => setPicker((value) => !value)}
                >
                  ＠ Mention a participant
                </button>
                <span>Markdown supported · text only</span>
              </div>
              {picker && (
                <Collection
                  path="/api/v1/participants"
                  render={(item) => {
                    const person = item as { id: string; nickname: string };
                    return (
                      <button
                        className="list-row"
                        onClick={() => {
                          const token =
                              "m" +
                              crypto
                                .randomUUID()
                                .replaceAll("-", "")
                                .slice(0, 12),
                            next = [
                              ...mentions,
                              { token, participant_id: person.id },
                            ],
                            value = text + ` [[mention:${token}]]`;
                          setMentions(next);
                          setText(value);
                          persist(value, title, next);
                          setPicker(false);
                          textArea.current?.focus();
                        }}
                      >
                        @{person.nickname}
                      </button>
                    );
                  }}
                />
              )}
            </>
          )}
          <ReferenceEditor references={references} disabled={locked} onChange={next => {
            setReferences(next); if(format !== "loom-markdown-v3") setFormat("loom-markdown-v2");
            void persist(text, title, mentions, next);
          }}/>
          {canNote ? <ChangeNoteEditor value={note} disabled={locked} onChange={next=>changeActions.current(next,account)}/>
            : <ChangeAccountEditor value={account} source={typeof fixed.resource_id === "string" ? fixed.resource_id : undefined} base={typeof base === "string" ? base : undefined} disabled={locked} onChange={(next,target)=>changeActions.current(note,next,target)}/>}
          {summaryDiscussion && <CoverageEditor context={context} discussion={summaryDiscussion}
            resource={typeof fixed.resource_id === 'string' ? fixed.resource_id : undefined}
            base={typeof base === 'string' ? base : undefined} value={coverage} disabled={locked}
            onChange={next=>declareCoverage.current(next)}/>}
          {record?.state === "rejected" && (
            <div className="notice">
              <strong>Your draft is preserved.</strong>
              {comparisonReady && compare && (
                <>
                  <p>
                    Current revision {compare.revision_number} by{" "}
                    {compare.publisher.nickname}
                  </p>
                  <AuthoredText
                    content={compare.content}
                    participants={compare.mentioned_participants}
                  />
                  <ReferenceViews sourceId={compare.resource_id} sourceRevision={compare.revision_id}
                    target={{ kind: compare.kind === "summary" ? "summary" : compare.kind === "artifact" ? "artifact" : "contribution", resource_id: compare.resource_id, revision_id: compare.revision_id }}/>
                </>
              )}
              <p>
                Review your text and the current version, then prepare a
                corrected submission to unlock editing. Your changes will be
                saved as a new draft.
              </p>
              {requiresComparison && !comparisonReady && !comparisonError && <p role="status">Loading the comparison revision before correction…</p>}
              {comparisonError && <><p role="alert">{comparisonError}</p>
                <button disabled={busy} onClick={() => setComparisonAttempt(value => value + 1)}>Retry comparison revision</button></>}
              {adoptsBaseReferences && compare?.content.format !== "loom-markdown-v1" &&
                <p>The comparison revision’s references will be copied into your corrected draft. Review or remove them before publishing.</p>}
              {summaryDiscussion && <p>A corrected summary draft needs an explicit source declaration. Later material is never added automatically.</p>}
              <button disabled={busy || (requiresComparison && !comparisonReady)} onClick={correct}>Prepare corrected submission</button>
            </div>
          )}
          {(!record || record.state === "draft") && (
            <button
              className="primary"
              disabled={locked || !text.trim() || (titleField && !title.trim()) || (!!summaryDiscussion && !coverage) || (!!account && ("revisions" in account ? account.revisions.length === 0 : account.carry_forward_revision_id !== base)) || (!!note && !note.text.trim())}
              onClick={() => void send()}
            >
              {busy
                ? "Publishing…"
                : kind === "reply.create"
                  ? "Post reply"
                  : "Publish"}
            </button>
          )}
          <details>
            <summary>Preview</summary>
            <AuthoredText
              content={draftBody().content as AuthoredContent}
            />
          </details>
        </>
      )}
    </section>
  );
}

function DiscussionPage({ id, context }: { id: string; context: Context }) {
  const location = useLocation(),
    focus = new URLSearchParams(location.search).get("focus");
  const { data, error, refresh } = useQuery<{
    id: string;
    area: { id: string; title: string; description: string };
    opening: ResourceView;
  }>("/api/v1/discussions/" + id);
  const [reload, setReload] = useState(0),
    [summaryReload, setSummaryReload] = useState(0);
  if (error)
    return (
      <>
        <ErrorText error={error} />
        <button onClick={refresh}>Retry discussion</button>
      </>
    );
  if (!data) return <p role="status">Opening discussion…</p>;
  // Keep the input's UTF-16 length limit without splitting a supplementary character.
  const summaryTitle = ('Summary: '+data.opening.title).slice(0,160).replace(/[\uD800-\uDBFF]$/, '');
  return (
    <>
      <div className="breadcrumb">
        <Link to="/loom">Topics</Link>
        <span>›</span>
        <Link to={"/loom/area/" + data.area.id}>{data.area.title}</Link>
      </div>
      <div className="header-line">
        <h1>{data.opening.title}</h1>
        <SaveControl context={context} target={{ kind: "discussion", resource_id: id }} label="discussion" />
        <FollowControl key={'discussion:'+id} context={context} target={{kind:'discussion',resource_id:id}}/>
        <Link
          className="button"
          to={"/loom/resource/" + data.opening.resource_id}
        >
          History & details
        </Link>
      </div>
      {data.opening.affected_area_id && <p>Organizational suggestion concerning <Link to={'/loom/area/'+data.opening.affected_area_id}>this topic</Link>.</p>}
      <ReferenceViews key={id} target={{kind:"discussion",resource_id:id}}/>
      <SummarySection key={summaryReload} discussion={id}/>
      {new URLSearchParams(location.search).get('summary') === 'create' && <Composer
        context={context} kind="summary.create" path="/api/v1/summaries" slot={'summary.create:'+id}
        fixed={{discussion_id:id}} titleField initialTitle={summaryTitle}
        summaryDiscussion={id} heading="Create discussion summary" onCommitted={() => setSummaryReload(n => n + 1)}/>}
      {context.self.role === "administrator" && <OrganizationActions id={id} kind="discussion"/>}
      <div className="reading-grid">
        <div>
          {focus ? (
            <FocusedBranch id={focus} discussionId={id} context={context} />
          ) : (
            <>
              <Contribution
                id={data.opening.resource_id}
                context={context}
                opening
                onPosted={() => setReload((n) => n + 1)}
              />
              <div className="discussion-controls">
                <h2>
                  Conversation <span>Direct replies</span>
                </h2>
                <span>Oldest first</span>
              </div>
              <Children
                key={data.opening.resource_id + reload}
                id={data.opening.resource_id}
                discussionId={id}
                context={context}
                depth={0}
              />
            </>
          )}
        </div>
        <aside className="right-rail">
          <h3>About this discussion</h3>
          <p>{data.area.description}</p>
          <Link to={"/loom/area/" + data.area.id}>
            Browse {data.area.title} →
          </Link>
          <hr />
          <p>
            Every reply keeps its actual parent. Open a branch to follow a
            deeper conversation.
          </p>
        </aside>
      </div>
    </>
  );
}
function FocusedBranch({
  id,
  discussionId,
  context,
}: {
  id: string;
  discussionId: string;
  context: Context;
}) {
  const { data, error, refresh } = useQuery<ContributionContextView>(
    `/api/v1/contributions/${id}/context`,
    ContributionContext,
  );
  const [reload, setReload] = useState(0);
  if (error || (data && data.discussion_id !== discussionId))
    return (
      <div className="notice">
        <p>This branch is unavailable in this discussion.</p>
        <Link to={"/loom/discussion/" + discussionId}>
          Back to conversation
        </Link>
        {error && <button onClick={refresh}>Retry branch</button>}
      </div>
    );
  if (!data) return <p role="status">Opening branch…</p>;
  return (
    <>
      <div className="focus-banner">
        <span>Focused branch</span>
        <Link to={"/loom/discussion/" + discussionId}>
          Back to conversation
        </Link>
      </div>
      <AncestorContext id={id} />
      <ContributionBody
        id={id}
        data={data}
        context={context}
        onPosted={() => setReload((n) => n + 1)}
      />
      <div className="discussion-controls">
        <h2>
          Conversation <span>Direct replies</span>
        </h2>
        <span>Oldest first</span>
      </div>
      <Children
        key={id + reload}
        id={id}
        discussionId={discussionId}
        context={context}
        depth={0}
      />
    </>
  );
}
function AncestorContext({ id }: { id: string }) {
  return (
    <details className="ancestors" open>
      <summary>Parent context</summary>
      <Collection
        path={"/api/v1/contributions/" + id + "/ancestors"}
        render={(item) =>
          "state" in item ? (
            <p>Parent unavailable</p>
          ) : (
            <Link
              className="ancestor-row"
              to={
                "/loom/resource/" +
                (item as ResourceView).resource_id +
                "/" +
                (item as ResourceView).revision_id
              }
            >
              {(item as ResourceView).author.nickname} ·{" "}
              {(item as ResourceView).title ?? "Reply"} · r
              {(item as ResourceView).revision_number}
            </Link>
          )
        }
      />
    </details>
  );
}
type ContributionProps = {
  id: string;
  context: Context;
  opening?: boolean;
  onPosted?: () => void;
};
function Contribution(props: ContributionProps) {
  const { data, error, refresh } = useQuery<ContributionContextView>(
    `/api/v1/contributions/${props.id}/context`,
    ContributionContext,
  );
  if (error)
    return (
      <div className="notice">
        <ErrorText error={error} />
        <button onClick={refresh}>Retry contribution</button>
      </div>
    );
  if (!data) return <p role="status">Loading contribution…</p>;
  return <ContributionBody {...props} data={data} />;
}
function ContributionBody({
  id,
  data,
  context,
  opening = false,
  onPosted,
}: ContributionProps & { data: ContributionContextView }) {
  const [reply, setReply] = useState(() =>
    context.store
      .all()
      .some(
        (record) =>
          record.slot === "reply:" + id && record.state !== "committed",
      ),
  );
  if ("state" in data)
    return (
      <div className="comment notice" data-resource-id={id}>
        <p>Contribution unavailable</p>
      </div>
    );
  return (
    <article
      className={opening ? "post card" : "comment"}
      data-resource-id={id}
    >
      <div className="author-line">
        <Avatar person={data.author} />
        <strong>{data.author.nickname}</strong>
        {data.author.kind === "agent" && (
          <span className="author-badge">Agent</span>
        )}
        <time>
          {new Date(data.created_at).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
      {data.parent_id && (
        <p className="parent-context">
          Replying to{" "}
          <Link to={"/loom/resource/" + data.parent_id}>
            the parent contribution
          </Link>
        </p>
      )}
      <AuthoredText
        content={data.content}
        participants={data.mentioned_participants}
      />
      <ChangeDetails revision={data}/>
      <ReferenceViews key={data.revision_id} sourceId={id} sourceRevision={data.revision_id} target={{kind:"contribution",resource_id:id}}/>
      <div className="post-footer">
        <SaveControl context={context} target={{ kind: "contribution", resource_id: id }} label="contribution" />
        <button
          className="text-button"
          onClick={() => setReply((value) => !value)}
          disabled={!data.publication_open}
        >
          <span aria-hidden="true">↩</span> Reply
        </button>
        <Link to={`/loom/resource/${id}/${data.revision_id}`}>
          Revision {data.revision_number}
        </Link>
        {data.can_edit && (
          <Link to={"/loom/resource/" + id + "?edit=1"}>Edit</Link>
        )}
      </div>
      {reply && (
        <Composer
          context={context}
          kind="reply.create"
          path="/api/v1/replies"
          slot={"reply:" + id}
          fixed={{ discussion_id: data.discussion_id, parent_id: id }}
          heading={"Reply to " + data.author.nickname}
          onCommitted={() => onPosted?.()}
        />
      )}
    </article>
  );
}
function Children({
  id,
  discussionId,
  context,
  depth,
  refreshVersion = 0,
}: {
  id: string;
  discussionId: string;
  context: Context;
  depth: number;
  refreshVersion?: number;
}) {
  const [page, setPage] = useState<PageView>(),
    [cursor, setCursor] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [expanded, setExpanded] = useState<string[]>([]),
    [branchVersions, setBranchVersions] = useState<Record<string, number>>({}),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    void request<PageView>(
      `/api/v1/contributions/${id}/children?limit=6${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
      { signal: controller.signal, schema: Page },
    )
      .then(
        (value) => {
          if (active) {
            setPage(value);
            setExpanded([]);
          }
        },
        (failure) => {
          if (active && failure.name !== "AbortError")
            setError(failure.message);
        },
      )
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [id, cursor, reload, refreshVersion]);
  return (
    <div className="comment-tree" aria-busy={busy}>
      {page?.items.map((item) => {
        const resource = item as ResourceView;
        return (
          <div className="comment-branch" key={resource.resource_id}>
            <Contribution
              id={resource.resource_id}
              context={context}
              onPosted={() => {
                setExpanded((value) => [
                  ...new Set([...value, resource.resource_id]),
                ]);
                setBranchVersions((value) => ({
                  ...value,
                  [resource.resource_id]:
                    (value[resource.resource_id] ?? 0) + 1,
                }));
              }}
            />
            {depth >= 1 ? (
              <Link
                className="branch-link"
                to={`/loom/discussion/${discussionId}?focus=${resource.resource_id}`}
              >
                Focus this branch →
              </Link>
            ) : (
              <>
                <button
                  className="text-button branch-link"
                  onClick={() =>
                    setExpanded((value) =>
                      value.includes(resource.resource_id)
                        ? value.filter((key) => key !== resource.resource_id)
                        : [...value, resource.resource_id],
                    )
                  }
                >
                  {expanded.includes(resource.resource_id)
                    ? "Hide nested replies"
                    : "Show nested replies"}
                </button>
                {expanded.includes(resource.resource_id) && (
                  <div className="comment-children">
                    <Children
                      id={resource.resource_id}
                      discussionId={discussionId}
                      context={context}
                      depth={depth + 1}
                      refreshVersion={branchVersions[resource.resource_id] ?? 0}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
      {error && (
        <div className="notice">
          <ErrorText error={error} />
          <button onClick={() => setReload((n) => n + 1)}>Retry replies</button>
        </div>
      )}
      {!page && !error && <p role="status">Loading replies…</p>}
      {page && !page.items.length && page.complete && (
        <p className="empty-replies">No replies yet.</p>
      )}
      {page?.next_cursor && (
        <button disabled={busy} onClick={() => setCursor(page.next_cursor!)}>
          Next replies →
        </button>
      )}
      {cursor && (
        <button disabled={busy} onClick={() => setCursor("")}>
          Back to first replies
        </button>
      )}
    </div>
  );
}
function ResourcePage({
  id,
  revision,
  context,
}: {
  id: string;
  revision: string | undefined;
  context: Context;
}) {
  const { data, error, refresh } = useQuery<RevisionView>(
    `/api/v1/resources/${id}${revision ? "/revisions/" + revision : ""}`,
    Revision,
  );
  const [edit, setEdit] = useState(
      new URLSearchParams(useLocation().search).has("edit"),
    ),
    [history, setHistory] = useState(false);
  const historyView = (
    <>
      <button onClick={() => setHistory((value) => !value)}>
        Revision history
      </button>
      {history && <RevisionHistory id={id} />}
    </>
  );
  if (error)
    return (
      <>
        <ErrorText error={error} />
        <button onClick={refresh}>Retry revision</button>
        <p>
          Retained revisions may still be available. Each revision has its own
          access check.
        </p>
        {historyView}
      </>
    );
  if (!data) return <p role="status">Loading revision…</p>;
  return (
    <>
      <div className="breadcrumb">
        <Link to="/loom">Topics</Link>
        <span>›</span>
        {data.discussion_id ? (
          <Link to={"/loom/discussion/" + data.discussion_id}>
            Conversation
          </Link>
        ) : (
          <Link to="/loom/artifacts">Artifacts</Link>
        )}
      </div>
      <div className="header-line">
        <div>
          <h1>{data.title ?? "Reply"}</h1>
          <p className="subtitle">
            {revision ? "Exact revision" : "Current revision"}{" "}
            {data.revision_number} · published by {data.publisher.nickname}
          </p>
        </div>
        {data.kind === 'summary' ? <span className="fineprint">Saving summaries is not supported in this release.</span> : <SaveControl context={context} target={revision
          ? { kind: "revision", resource_id: id, revision_id: revision }
          : { kind: data.kind === "artifact" ? "artifact" : "contribution", resource_id: id }} />}
        <button onClick={() => setHistory((value) => !value)}>
          Revision history
        </button>
      </div>
      {revision && data.revision_id !== data.current_revision_id && (
        <div className="notice neutral">
          You are reading an earlier revision.{" "}
          <Link to={"/loom/resource/" + id}>View current revision</Link>
        </div>
      )}
      <article className="post card">
        <div className="author-line">
          <Avatar person={data.author} />
          <strong>{data.author.nickname}</strong>
          {data.author.kind === "agent" && (
            <span className="author-badge">Agent</span>
          )}
        </div>
        <AuthoredText
          content={data.content}
          participants={data.mentioned_participants}
        />
        <ChangeDetails revision={data}/>
        <ChangeDiscoveryViewComponent key={id+data.revision_id} resource={id} revision={data.revision_id} kind={data.kind === "summary" ? "summary" : data.kind === "artifact" ? "artifact" : "contribution"}/>
        <ReferenceViews key={id+data.revision_id+(revision??'current')} sourceId={id} sourceRevision={data.revision_id}
          target={{kind:data.kind === "summary" ? "summary" : data.kind === "artifact" ? "artifact" : "contribution",resource_id:id,...(revision?{revision_id:revision}:{})}}/>
        {data.parent_id && (
          <p className="parent-context">
            In reply to{" "}
            <Link to={"/loom/resource/" + data.parent_id}>
              the actual parent
            </Link>
          </p>
        )}
        <div className="post-footer">
          {!revision && data.kind !== 'summary' && <SaveControl context={context} target={{ kind: "revision", resource_id: id, revision_id: data.revision_id }} />}
          {data.can_edit && (
            <button
              className="text-button"
              onClick={() => setEdit((value) => !value)}
            >
              Edit this text
            </button>
          )}
          {data.discussion_id && data.kind !== 'summary' && (
            <Link to={`/loom/discussion/${data.discussion_id}?focus=${id}`}>
              Reply in this branch
            </Link>
          )}
        </div>
      </article>
      {data.kind === 'summary' && <CoverageDetails key={data.revision_id} id={id} revision={data.revision_id}/>}
      {edit && (
        <Composer
          context={context}
          kind={data.kind === 'summary' ? 'summary.revise' : 'revision.publish'}
          path={data.kind === 'summary' ? '/api/v1/summary-revisions' : '/api/v1/revisions'}
          slot={"edit:" + id}
          fixed={{
            resource_id: id,
            expected_revision_id: data.revision_id,
            title: data.title,
          }}
          titleField={data.title !== null}
          initialTitle={data.title ?? ""}
          initialText={data.content.text}
          initialMentions={data.content.mentions}
          initialFormat={data.content.format}
          initialReferences={data.content.format !== "loom-markdown-v1" ? data.content.references : []}
          initialChangeAccount={data.change_account?.state === "declared" ? {carry_forward_revision_id:data.revision_id} : null}
          resourceKind={data.kind}
          summaryDiscussion={data.kind === 'summary' ? data.discussion_id! : undefined}
          initialCoverage={data.kind === 'summary' ? {carry_forward_revision_id:data.revision_id} : undefined}
          heading="Edit text"
        />
      )}
      {history && <RevisionHistory id={id} />}
      {data.kind === "artifact" && context.self.role === "administrator" && <OrganizationActions id={id} kind="artifact"/>}
      {data.kind === 'artifact' && <FollowControl key={'artifact:'+id} context={context} target={{kind:'artifact',resource_id:id}}/>}
      {(data.kind === "artifact" || data.kind === 'summary') && <Editors id={id} context={context} kind={data.kind} />}
    </>
  );
}
function RevisionHistory({ id }: { id: string }) {
  return (
    <section className="section">
      <h2>Retained revisions</h2>
      <Collection
        path={"/api/v1/resources/" + id + "/history"}
        render={(item) => {
          const revision = item as ResourceView;
          return (
            <Link
              className="list-row"
              to={`/loom/resource/${id}/${revision.revision_id}`}
            >
              <span>Revision {revision.revision_number}</span>
              <span>{revision.publisher.nickname}</span>
              <time>{new Date(revision.created_at).toLocaleString()}</time>
            </Link>
          );
        }}
      />
    </section>
  );
}
function Overview({ context }: { context: Context }) {
  const target = context.community.overview;
  if (target.state !== "ready")
    return (
      <>
        <h1>Community overview</h1>
        <div className="notice">
          {target.state === "setup_incomplete"
            ? "The Community overview has not been configured."
            : "The Community overview is currently unavailable."}
        </div>
        <Link to="/loom">Browse topics</Link>
        <Proposal context={context} />
      </>
    );
  return (
    <>
      <ResourcePage
        id={target.resource_id!}
        revision={undefined}
        context={context}
      />
      <section className="section">
        <Proposal context={context} />
      </section>
    </>
  );
}
function Editors({ id, context, kind }: { id: string; context: Context; kind:'artifact'|'summary' }) {
  const slot=kind+'.editors:'+id,path=kind==='summary'?'/api/v1/summaries/editors':'/api/v1/editors';
  const [record,update]=useIntent(()=>context.store.all().find(r=>r.slot===slot));
  const { data, error, refresh } = useQuery<{
    version: number;
    can_manage: boolean;
    editors: { id: string; nickname: string; kind: string }[];
  }>("/api/v1/resources/" + id + "/editors");
  const [editing, setEditing] = useState(!!record),
    [selected, setSelected] = useState<string[]>((record?.body.participant_ids as string[]|undefined)??[]),
    [failure, setFailure] = useState(""),[busy,setBusy]=useState(false);
  const live=useRef(false),owner=useRef(identityGeneration());
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const current=()=>live.current&&owner.current===identityGeneration();
  async function save() {
    if(busy)return;setBusy(true);setFailure('');let sent:Intent|undefined,uncertain=false;
    try {
      sent=await update(existing=>{uncertain=existing?.state==='uncertain';const body={resource_id:id,expected_version:data!.version,participant_ids:selected};
        return context.store.prepareDispatch(existing??context.store.create(slot,kind+'.editors',path,body),body);});
      if(!sent)return;
      await request(path,{self:context.self,body:sent.body});
      await update(async existing=>{await context.store.complete(sent!);return existing?.key===sent!.key?undefined:existing;});
      if(current()){setEditing(false);refresh();}
    } catch (error) {
      if(sent&&isDefinitiveRejection(error,uncertain))try{await update(()=>context.store.settle(sent!,{state:'rejected'}));}
      catch(storageError){if(current())setFailure((storageError as Error).message);return;}
      if(current())setFailure((error as Error).message);
    }finally{if(current())setBusy(false);}
  }
  return (
    <details className="section">
      <summary>Editors</summary>
      <ErrorText error={error || failure} />
      {data && (
        <>
          <p>
            {data.editors.map((p) => p.nickname).join(", ") ||
              "No assigned editors"}
          </p>
          {data.can_manage && (
            <button
              disabled={busy||!!record}
              onClick={() => {
                setSelected(data.editors.map((p) => p.id));
                setEditing((value) => !value);
              }}
            >
              Manage editors
            </button>
          )}
          {editing && (
            <>
              <Collection
                path="/api/v1/participants"
                render={(item) => {
                  const p = item as { id: string; nickname: string };
                  return (
                    <label className="list-row">
                      <input
                        type="checkbox"
                        disabled={busy||!!record}
                        checked={selected.includes(p.id)}
                        onChange={(event) =>
                          setSelected((value) =>
                            event.target.checked
                              ? [...value, p.id]
                              : value.filter((id) => id !== p.id),
                          )
                        }
                      />
                      {p.nickname}
                    </label>
                  );
                }}
              />
              {record?.state==='rejected'?<button onClick={()=>void update(async existing=>{await context.store.remove(existing!);refresh();return undefined;}).catch(e=>setFailure(e.message))}>Dismiss rejected editor request</button>
                :<button disabled={busy} onClick={() => void save()}>{record?.state==='uncertain'?'Retry same editor change':'Save editor list'}</button>}
            </>
          )}
        </>
      )}
    </details>
  );
}
function Administration({ context }: { context: Context }) {
  const chosen = new URLSearchParams(useLocation().search).get("intent");
  const [setupIntent, update] = useIntent(
    () =>
      context.store.all().find((r) => r.slot === "setup" && r.key === chosen) ??
      context.store.all().find((r) => r.slot === "setup"),
  );
  const [name, setName] = useState(
      String(setupIntent?.body.community_name ?? "Research commons"),
    ),
    [ordinary, setOrdinary] = useState(
      String(setupIntent?.body.ordinary_area_name ?? "General"),
    ),
    [proposal, setProposal] = useState(
      String(setupIntent?.body.proposal_area_name ?? "Community organization"),
    ),
    [overview, setOverview] = useState(
      (setupIntent?.body.overview as AuthoredContent | undefined)?.text ??
        "Welcome to our shared workspace.\n\nUse General for questions and ongoing work. Propose organizational changes in Community organization.",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const locked =
    busy ||
    (!!setupIntent &&
      (setupIntent.state !== "draft" || !!setupIntent.blocked_by));
  function setupBody() {
    return {
      community_name: name,
      ordinary_area_name: ordinary,
      proposal_area_name: proposal,
      overview: { format: "loom-markdown-v1", text: overview, mentions: [] },
    };
  }
  async function draft(patch: Record<string, unknown> = {}) {
    const body = { ...setupBody(), ...patch };
    try {
      if (setupIntent && setupIntent.state !== "draft")
        throw new Error("Prepare a correction before editing this request.");
      return await update((current) =>
        context.store.saveDraft(
          current ??
            context.store.create(
              "setup",
              "community.setup",
              "/api/v1/community/setup",
              body,
            ),
          body,
        ),
      );
    } catch (failure) {
      setError((failure as Error).message);
      return undefined;
    }
  }
  async function setup(check = false) {
    if (busy || setupIntent?.state === "rejected" || setupIntent?.blocked_by)
      return;
    let record: Intent | undefined,
      wasUncertain = false;
    setBusy(true);
    try {
      if (!setupIntent) await draft();
      record = await update(async (current) => {
        if (!current) throw new Error("Save the setup draft before sending.");
        wasUncertain = current.state === "uncertain";
        if (check) return current;
        return context.store.prepareDispatch(current, setupBody());
      });
      if (!record || (check && !wasUncertain)) return;
      setError("");
      const result = check
        ? await request<CommittedView | { operation_state: string }>(
            "/api/v1/operations/status",
            {
              self: context.self,
              body: {
                operation_kind: record.kind,
                idempotency_key: record.key,
              },
            },
          )
        : await request<CommittedView>(record.path, {
            self: context.self,
            body: record.body,
          });
      if ("publication_state" in result) {
        await update(async () => {
          await context.store.complete(record!);
          return undefined;
        });
        context.refreshCommunity();
      } else setError("Setup is still unconfirmed. Keep this original intent.");
    } catch (failure) {
      if (record && !check && isDefinitiveRejection(failure, wasUncertain)) {
        const rejected = { ...record, state: "rejected" as const };
        try {
          await update(() => context.store.settle(record!, rejected));
        } catch (storageFailure) {
          setError((storageFailure as Error).message);
          return;
        }
      }
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function correct() {
    if (!setupIntent) return;
    try {
      await update((current) => context.store.correct(current!));
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  return (
    <>
      <h1>Administration</h1>
      <p className="subtitle">Set up the community and admit participants.</p>
      <SearchAdministration context={context}/>
      <ErrorText error={error} />
      <SeparateDraft
        record={setupIntent}
        review={() =>
          void update(async (current) => {
            const { blocked_by: _, ...next } = current!;
            return context.store.save(next);
          }).catch((failure) => setError(failure.message))
        }
      />
      {context.community.settings_version === 0 ? (
        <section className="card admin-card">
          <h2>Initialize the community</h2>
          <label>
            Community name
            <input
              value={name}
              disabled={locked}
              onChange={(e) => {
                setName(e.target.value);
                draft({ community_name: e.target.value });
              }}
            />
          </label>
          <label>
            Ordinary topic
            <input
              value={ordinary}
              disabled={locked}
              onChange={(e) => {
                setOrdinary(e.target.value);
                draft({ ordinary_area_name: e.target.value });
              }}
            />
          </label>
          <label>
            Proposal topic
            <input
              value={proposal}
              disabled={locked}
              onChange={(e) => {
                setProposal(e.target.value);
                draft({ proposal_area_name: e.target.value });
              }}
            />
          </label>
          <label>
            Community overview
            <textarea
              rows={7}
              value={overview}
              disabled={locked}
              onChange={(e) => {
                setOverview(e.target.value);
                draft({
                  overview: {
                    format: "loom-markdown-v1",
                    text: e.target.value,
                    mentions: [],
                  },
                });
              }}
            />
          </label>
          {setupIntent?.state === "rejected" ? (
            <div className="notice">
              <p>Setup was rejected. Your draft is preserved.</p>
              <button onClick={correct}>Prepare corrected setup</button>
            </div>
          ) : (
            <button
              className="primary"
              disabled={busy || !!setupIntent?.blocked_by}
              onClick={() => void setup()}
            >
              {setupIntent?.state === "uncertain"
                ? "Retry same setup"
                : "Initialize community"}
            </button>
          )}
          {setupIntent?.state === "uncertain" && (
            <button disabled={busy} onClick={() => void setup(true)}>
              Check setup status
            </button>
          )}
        </section>
      ) : (
        <Settings context={context} />
      )}
      <Admission context={context} />
    </>
  );
}
function Settings({ context }: { context: Context }) {
  const [overview, setOverview] = useState(
      context.community.overview.resource_id ?? "",
    ),
    [proposal, setProposal] = useState(
      context.community.proposal_area.resource_id ?? "",
    ),
    [error, setError] = useState("");
  async function save() {
    try {
      await request("/api/v1/community/settings", {
        self: context.self,
        body: {
          idempotency_key: crypto.randomUUID(),
          expected_version: context.community.settings_version,
          community_name: context.community.community_name,
          overview_id: overview || null,
          proposal_area_id: proposal || null,
        },
      });
      context.refreshCommunity();
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  return (
    <details className="card admin-card">
      <summary>Community configuration</summary>
      <ErrorText error={error} />
      <label>
        Overview artifact ID
        <input value={overview} onChange={(e) => setOverview(e.target.value)} />
      </label>
      <label>
        Proposal area ID
        <input value={proposal} onChange={(e) => setProposal(e.target.value)} />
      </label>
      <button onClick={() => void save()}>Save configuration</button>
    </details>
  );
}
function Admission({ context }: { context: Context }) {
  const chosen = new URLSearchParams(useLocation().search).get("intent");
  const [pending, update] = useIntent(
    () =>
      context.store
        .all()
        .find((r) => r.slot === "admission" && r.key === chosen) ??
      context.store.all().find((r) => r.slot === "admission"),
  );
  const [nickname, setNickname] = useState(
      String(pending?.body.nickname ?? ""),
    ),
    [kind, setKind] = useState(
      pending?.body.kind === "human" || pending?.body.kind === "enrollment"
        ? "human"
        : "agent",
    ),
    [account, setAccount] = useState<string | undefined>(
      pending?.body.participant_id as string | undefined,
    ),
    [issued, setIssued] = useState<{
      secret: string;
      participant_id: string;
      credential_id: string;
      kind: string;
      nickname: string;
    }>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const accounts = useQuery<
    {
      id: string;
      nickname: string;
      kind: string;
      state: string;
      role: string;
    }[]
  >("/api/v1/identity/accounts");
  const locked =
    busy || (!!pending && (pending.state !== "draft" || !!pending.blocked_by));
  async function draftAccount(patch: Record<string, unknown> = {}) {
    try {
      if (
        pending &&
        (pending.state !== "draft" || pending.kind !== "account.create")
      )
        throw new Error("Prepare a correction before editing this request.");
      const body = { nickname, kind, role: "participant", ...patch };
      return await update((current) =>
        context.store.saveDraft(
          current ??
            context.store.create(
              "admission",
              "account.create",
              "/api/v1/identity/accounts",
              body,
            ),
          body,
        ),
      );
    } catch (failure) {
      setError((failure as Error).message);
      return undefined;
    }
  }
  async function correct() {
    if (!pending) return;
    try {
      await update((current) => context.store.correct(current!));
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  async function operate(
    action: "account.create" | "credential.issue",
    check = false,
  ) {
    if (busy || pending?.state === "rejected" || pending?.blocked_by) return;
    let wasUncertain = false;
    const targetNickname = nickname;
    const path =
      "/api/v1/identity/" +
      (action === "account.create" ? "accounts" : "credentials");
    const body =
      action === "account.create"
        ? { nickname, kind, role: "participant" }
        : {
            participant_id: account,
            kind: kind === "agent" ? "agent" : "enrollment",
            purpose: kind === "agent" ? null : "enroll",
            label: "Synthetic participation",
            replace_credential_id: null,
          };
    let record: Intent | undefined;
    setBusy(true);
    try {
      record = await update(async (current) => {
        const draft =
          current ?? context.store.create("admission", action, path, body);
        wasUncertain = draft.state === "uncertain";
        if (check) return draft;
        return context.store.prepareDispatch(draft, body);
      });
      if (!record || (check && !wasUncertain)) return;
      setError("");
      const result = await request<{
        operation_state: string;
        participant_id: string;
        credential_id?: string;
        secret?: string;
      }>(check ? "/api/v1/identity/reconcile" : record.path, {
        self: context.self,
        body: check
          ? { operation_kind: record.kind, idempotency_key: record.key }
          : record.body,
      });
      if (result.operation_state === "committed") {
        if (
          record.kind === "credential.issue" &&
          (result.participant_id !== record.body.participant_id ||
            !result.credential_id)
        )
          throw new Error(
            "The credential response could not be bound to its issuing account.",
          );
        setAccount(result.participant_id);
        await update(async () => {
          await context.store.complete(record!);
          return undefined;
        });
        accounts.refresh();
        if (record.kind === "credential.issue") {
          if (result.secret)
            setIssued({
              secret: result.secret,
              participant_id: result.participant_id,
              credential_id: result.credential_id!,
              kind: String(record.body.kind),
              nickname: targetNickname || result.participant_id,
            });
          else
            setError(
              `The credential was issued, but its secret cannot be replayed. Revoke ${result.credential_id} and issue a replacement on this same account.`,
            );
        }
      } else setError("This account operation remains unconfirmed.");
    } catch (failure) {
      if (record && !check && isDefinitiveRejection(failure, wasUncertain)) {
        const rejected = { ...record, state: "rejected" as const };
        try {
          await update(() => context.store.settle(record!, rejected));
        } catch (storageFailure) {
          setError((storageFailure as Error).message);
          return;
        }
      }
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card admin-card">
      <h2>Admit a participant</h2>
      <ErrorText error={error} />
      <SeparateDraft
        record={pending}
        review={() =>
          void update(async (current) => {
            const { blocked_by: _, ...next } = current!;
            return context.store.save(next);
          }).catch((failure) => setError(failure.message))
        }
      />
      {issued ? (
        <div className="notice neutral">
          <strong>
            {issued.kind === "agent" ? "Agent credential" : "Enrollment ticket"}{" "}
            for {issued.nickname} — shown once
          </strong>
          <p>
            Deliver through an approved private channel. It is not saved in
            browser recovery records.
          </p>
          <p>
            Account: <code>{issued.participant_id}</code> · Credential:{" "}
            <code>{issued.credential_id}</code>
          </p>
          <textarea aria-label="Issued secret" readOnly value={issued.secret} />
          <button
            onClick={() => {
              setIssued(undefined);
              setAccount(undefined);
              setNickname("");
            }}
          >
            Done
          </button>
        </div>
      ) : (
        <>
          <label>
            Nickname
            <input
              value={nickname}
              disabled={locked || !!account}
              onChange={(e) => {
                setNickname(e.target.value);
                draftAccount({ nickname: e.target.value });
              }}
            />
          </label>
          <label>
            Participant type
            <select
              value={kind}
              disabled={locked || !!account}
              onChange={(e) => {
                setKind(e.target.value);
                draftAccount({ kind: e.target.value });
              }}
            >
              <option value="agent">Agent</option>
              <option value="human">Human</option>
            </select>
          </label>
          {pending?.state === "rejected" ? (
            <div className="notice">
              <p>
                The account operation was rejected. Your draft is preserved.
              </p>
              <button onClick={correct}>
                Prepare corrected account operation
              </button>
            </div>
          ) : !account ? (
            <button
              className="primary"
              disabled={busy || !!pending?.blocked_by || !nickname}
              onClick={() => void operate("account.create")}
            >
              {pending?.state === "uncertain"
                ? "Retry same account creation"
                : "Create account"}
            </button>
          ) : (
            <>
              <p>
                Account created: <code>{account}</code>
              </p>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void operate("credential.issue")}
              >
                Issue{" "}
                {kind === "agent" ? "agent credential" : "enrollment ticket"}
              </button>
            </>
          )}
          {pending?.state === "uncertain" && (
            <button
              disabled={busy}
              onClick={() =>
                void operate(
                  pending.kind as "account.create" | "credential.issue",
                  true,
                )
              }
            >
              Check account operation
            </button>
          )}
        </>
      )}
      <details className="section">
        <summary>Participant accounts</summary>
        {accounts.data?.map((person) => (
          <div className="list-row" key={person.id}>
            <Avatar person={person} />
            <span>
              {person.nickname} · {person.kind} · {person.state}
            </span>
            <button
              disabled={busy || !!pending || !!issued}
              onClick={() => {
                setAccount(person.id);
                setKind(person.kind);
                setNickname(person.nickname);
              }}
            >
              Manage credentials
            </button>
            <button
              disabled={person.id === context.self.participant_id}
              onClick={() =>
                void request("/api/v1/identity/state", {
                  self: context.self,
                  body: {
                    idempotency_key: crypto.randomUUID(),
                    participant_id: person.id,
                    role: person.role,
                    state: person.state === "active" ? "suspended" : "active",
                  },
                })
                  .then(() => accounts.refresh())
                  .catch((failure) => setError(failure.message))
              }
            >
              {person.state === "active" ? "Suspend" : "Reactivate"}
            </button>
          </div>
        ))}
      </details>
      {account && <CredentialList participantId={account} context={context} />}
    </section>
  );
}
function CredentialList({
  participantId,
  context,
}: {
  participantId: string;
  context: Context;
}) {
  const { data, error, refresh } = useQuery<
      { id: string; kind: string; label: string; state: string }[]
    >("/api/v1/identity/credentials?participant_id=" + participantId),
    [failure, setFailure] = useState("");
  return (
    <details className="section">
      <summary>Credentials for this account</summary>
      <ErrorText error={error || failure} />
      {data?.map((credential) => (
        <div className="list-row" key={credential.id}>
          <span>
            {credential.label} · {credential.kind} · {credential.state}
          </span>
          <button
            disabled={credential.state !== "active"}
            onClick={() =>
              void request("/api/v1/identity/revoke", {
                self: context.self,
                body: {
                  idempotency_key: crypto.randomUUID(),
                  participant_id: participantId,
                  credential_id: credential.id,
                },
              })
                .then(refresh)
                .catch((failure) => setFailure(failure.message))
            }
          >
            Revoke
          </button>
        </div>
      ))}
    </details>
  );
}
function Help({ context }: { context: Context }) {
  const { data, error } = useQuery<{ text: string }>("/api/v1/guide");
  const [failure, setFailure] = useState("");
  const [, refresh] = useState(0);
  return (
    <>
      <h1>Participation guide</h1>
      <ErrorText error={error || failure} />
      <p>
        <a href="/api/v1/openapi.json">API schema · participation-1</a>
      </p>
      <article className="post card">
        <div className="guide-text">{data?.text}</div>
      </article>
      <section className="section">
        <h2>Local drafts</h2>
        <p>
          Drafts and unresolved submissions are kept on this browser for this
          account and instance, with a limit of 32 records and 1 MiB. Unresolved
          intent does not expire automatically. Signing out clears these
          records; export them first if needed.
        </p>
        <button onClick={() => exportDrafts(context.store)}>
          Export drafts
        </button>
        <p>Saved-item recovery shares this local storage bound and export, but is managed separately in <Link to="/loom/saved">Saved items</Link>.</p>
        {context.store.all().filter((record) => !["saved.set", "following.set"].includes(record.kind)).map((record) => (
          <div className="list-row" key={record.key}>
            <Link to={intentUrl(record)}>
              {record.kind} · {record.state} ·{" "}
              {new Date(record.created_at).toLocaleString()}
            </Link>
            {record.state !== "uncertain" && (
              <button
                onClick={() =>
                  void context.store
                    .remove(record)
                    .then(() => refresh((n) => n + 1))
                    .catch((failure) => setFailure(failure.message))
                }
              >
                Remove local record
              </button>
            )}
          </div>
        ))}
        <p>
          Saved items and Following have separate private server state and recovery controls.
          Shared Changes and personal Mentions/replies have independent checkpoints.
          Grouped Updates, uploads, read state and agent execution remain future work.
        </p>
      </section>
    </>
  );
}
