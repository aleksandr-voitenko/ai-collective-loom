import { useState, useRef, useEffect } from 'react';
import { useLocation, useNavigate, Link, NavLink } from 'react-router';
import { type OnboardingView, Onboarding } from '../contracts/participation.js';
import {
  type Self,
  invalidateIdentity,
  identityGeneration,
  sessionRequest,
  ApiError,
  IntentStore,
  announceIdentityChange,
  exportDrafts,
} from './participation-client.js';
import { NotificationRecovery } from './notification-recovery.js';
import { AttentionRecovery, exportAttentionRecovery } from './attention-recovery.js';
import { UpdatesRecovery } from './updates-recovery.js';
import { SharedRecovery } from './shared-recovery.js';
import { ReadingProvider } from './Reading.js';
import { ReadingRecovery, exportReadingRecovery } from './reading-recovery.js';
import './participation.css';
import { Avatar, ErrorText, Icon } from './participation-ui.js';
import { ActiveView } from './ParticipationRoutes.js';
import { SignIn } from './ParticipationSignIn.js';

export function ParticipationApp() {
  const location = useLocation(),
    navigate = useNavigate();
  const [self, setSelf] = useState<Self | null>(),
    [community, setCommunity] = useState<OnboardingView>(),
    [error, setError] = useState(''),
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
      if (event.key === 'loom.identity-change') invalidateIdentity();
    };
    window.addEventListener('loom-identity', changed);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener('loom-identity', changed);
      window.removeEventListener('storage', storage);
    };
  }, []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController(),
      owner = identityGeneration();
    void sessionRequest<Self>('/api/v1/identity/self', { signal: controller.signal })
      .then(async (value) => {
        const info = await sessionRequest<OnboardingView>('/api/v1/community', {
          signal: controller.signal,
          schema: Onboarding,
        });
        if (active && owner === identityGeneration()) {
          setSelf(value);
          setCommunity(info);
          setError('');
          setUnavailable(false);
        }
      })
      .catch((failure) => {
        if (active && failure.name !== 'AbortError') {
          setSelf(null);
          if (failure instanceof ApiError && failure.code === 'not_found') {
            setUnavailable(true);
            setError(
              'Participation is unavailable. This instance has not enabled the synthetic preview.',
            );
          } else if (!(failure instanceof ApiError && failure.code === 'unauthenticated'))
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
    storageError = '';
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
      await sessionRequest('/api/v1/identity/logout', { body: {}, self });
      const cleanupFailures: string[] = [];
      // Fence pending views before awaiting local locks: a late read must not
      // refill a cleared recovery record while another cleanup lock is blocked.
      try {
        announceIdentityChange();
      } catch {
        invalidateIdentity();
        cleanupFailures.push('other tabs could not be notified.');
      }
      const cleanupOwner = identityGeneration();
      try {
        if (store && community)
          await new IntentStore(community.instance_id, self.participant_id).clear();
      } catch {
        cleanupFailures.push('local drafts could not be cleared.');
      }
      if (cleanupOwner !== identityGeneration()) return;
      try {
        if (community)
          await new NotificationRecovery(community.instance_id, self.participant_id).clear();
      } catch {
        cleanupFailures.push('notification recovery could not be cleared.');
      }
      if (cleanupOwner !== identityGeneration()) return;
      try {
        if (community)
          await new UpdatesRecovery(community.instance_id, self.participant_id).clear();
      } catch {
        cleanupFailures.push('Updates recovery could not be cleared.');
      }
      if (cleanupOwner !== identityGeneration()) return;
      try {
        if (community) await new SharedRecovery(community.instance_id, self.participant_id).clear();
      } catch {
        cleanupFailures.push('shared change recovery could not be cleared.');
      }
      if (cleanupOwner !== identityGeneration()) return;
      try {
        if (community)
          await new ReadingRecovery(community.instance_id, self.participant_id).clear();
      } catch {
        cleanupFailures.push('reading recovery could not be cleared.');
      }
      if (cleanupOwner !== identityGeneration()) return;
      try {
        if (community)
          await new AttentionRecovery(community.instance_id, self.participant_id).clear();
      } catch {
        cleanupFailures.push('attention recovery could not be cleared.');
      }
      if (cleanupOwner !== identityGeneration()) return;
      try {
        if (community)
          await new UpdatesRecovery(
            community.instance_id,
            self.participant_id,
            localStorage,
            true,
          ).clear();
      } catch {
        cleanupFailures.push('routine Updates recovery could not be cleared.');
      }
      if (cleanupOwner !== identityGeneration()) return;
      if (cleanupFailures.length)
        setError(
          `Signed out, but ${cleanupFailures.join(' ')} They remain scoped to this account on this browser.`,
        );
      navigate('/loom');
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
        aria-label={`${community?.community_name ?? 'Community'} — Community overview · Start here`}
        to="/loom/overview"
      >
        {community?.community_name ?? 'Collective Loom'}
      </Link>
      <nav aria-label="Community navigation">
        <NavLink to="/loom/updates">
          <Icon name="discussion" />
          Updates
        </NavLink>
        <NavLink to="/loom" end>
          <Icon name="topic" />
          Topics
        </NavLink>
        <NavLink to="/loom/artifacts">
          <Icon name="artifact" />
          Artifacts
        </NavLink>
        <NavLink to="/loom/following">
          <Icon name="topic" />
          Following
        </NavLink>
        <NavLink to="/loom/saved">
          <Icon name="saved" />
          Saved items
        </NavLink>
        <NavLink to="/loom/attention">
          <Icon name="discussion" />
          Attention settings
        </NavLink>
        <NavLink to="/loom/reading">
          <Icon name="discussion" />
          Reading progress
        </NavLink>
        <NavLink to="/loom/notifications">
          <Icon name="discussion" />
          Mentions/replies
        </NavLink>
        <NavLink to="/loom/search">
          <Icon name="search" />
          Search
        </NavLink>
        <NavLink to="/loom/summaries">
          <Icon name="discussion" />
          Summary maintenance
        </NavLink>
        {self?.role === 'administrator' && (
          <>
            <NavLink to="/loom/admin">
              <Icon name="topic" />
              Administration
            </NavLink>
            <NavLink to="/loom/moderation">
              <Icon name="topic" />
              Content moderation
            </NavLink>
          </>
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
              try {
                if (
                  store?.all().length ||
                  (community &&
                    (new ReadingRecovery(community.instance_id, self.participant_id).all().length ||
                      new AttentionRecovery(community.instance_id, self.participant_id).all()
                        .length))
                )
                  setSignout(true);
                else void logout();
              } catch {
                setSignout(true);
              }
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
            {location.pathname.includes('/admin')
              ? 'Administration'
              : location.pathname.includes('/overview')
                ? 'Community overview'
                : location.pathname.includes('/artifacts')
                  ? 'Artifacts'
                  : location.pathname.includes('/following')
                    ? 'Following'
                    : location.pathname.includes('/changes')
                      ? 'Changes'
                      : location.pathname.includes('/updates')
                        ? 'Updates'
                        : location.pathname.includes('/notifications')
                          ? 'Mentions/replies'
                          : location.pathname.includes('/saved')
                            ? 'Saved items'
                            : location.pathname.includes('/search')
                              ? 'Search'
                              : 'Topics'}
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
                'Local recovery storage is unavailable. Publication is paused to protect your drafts. ' +
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
            <ReadingProvider
              key={`${self.participant_id}:${community.instance_id}:${location.pathname}:${location.pathname === '/loom/changes' ? '' : location.search}`}
              context={{
                controlsProjection: 'private-controls-1',
                self,
                community,
                store,
                refreshCommunity: () => setEpoch((n) => n + 1),
              }}
            >
              <ActiveView
                // Changes owns a separate key for scoped results. Its persistent
                // controls must survive query edits; other views retain their key.
                key={`${self.participant_id}:${community.instance_id}:${location.pathname}:${location.pathname === '/loom/changes' ? '' : location.search}`}
                context={{
                  controlsProjection: 'private-controls-1',
                  self,
                  community,
                  store,
                  refreshCommunity: () => setEpoch((n) => n + 1),
                }}
              />
            </ReadingProvider>
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
          This account has local drafts or submission records. Signing out clears them on this
          browser. Unconfirmed submissions may already be published.
        </p>
        <p>
          Unconfirmed Saved items changes may also have completed. Server bookmarks remain saved
          after signing out.
        </p>
        <p>
          Unconfirmed attention changes may already have completed. Signing out clears this
          browser’s attention recovery; private server choices remain.
        </p>
        <button
          onClick={() => {
            try {
              if (community && self)
                exportAttentionRecovery(community.instance_id, self.participant_id);
            } catch (failure) {
              setError((failure as Error).message);
            }
          }}
        >
          Export attention recovery
        </button>
        <p>
          Unconfirmed reading changes may also have completed. Signing out clears this browser’s
          reading recovery and automatic preference; server reading state remains.
        </p>
        <button
          onClick={() => {
            try {
              if (community && self)
                exportReadingRecovery(community.instance_id, self.participant_id);
            } catch (failure) {
              setError((failure as Error).message);
            }
          }}
        >
          Export reading recovery
        </button>
        <button onClick={() => store && exportDrafts(store)}>Export drafts</button>
        <button onClick={() => void logout()}>Clear local drafts and sign out</button>
        <button onClick={() => setSignout(false)}>Stay signed in</button>
      </dialog>
    </div>
  );
}
