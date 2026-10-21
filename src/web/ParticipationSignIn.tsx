import { useState } from "react";
import { passkey } from "./participation-client.js";
import { ErrorText } from "./participation-ui.js";

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
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
