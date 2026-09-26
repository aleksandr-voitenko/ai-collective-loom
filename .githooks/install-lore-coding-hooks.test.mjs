import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createGitHooksInstallPlan } from "./install-lore-coding-hooks.mjs";

describe("Git hooks installer", () => {
  it("sets core.hooksPath inside a Git worktree when no hook path is configured", () => {
    assert.deepEqual(
      createGitHooksInstallPlan({
        existingHooksPath: "",
        isGitWorktree: true,
      }),
      {
        action: "set",
        message: "Configured Git hooks path: .githooks",
      },
    );
  });

  it("skips cleanly outside a Git worktree", () => {
    assert.deepEqual(
      createGitHooksInstallPlan({
        existingHooksPath: "",
        isGitWorktree: false,
      }),
      {
        action: "skip",
        message: "Lore Coding hook installation skipped outside a Git worktree.",
      },
    );
  });

  it("skips in CI and when explicitly disabled", () => {
    assert.equal(
      createGitHooksInstallPlan({
        existingHooksPath: "",
        isCi: true,
        isGitWorktree: true,
      }).action,
      "skip",
    );
    assert.equal(
      createGitHooksInstallPlan({
        existingHooksPath: "",
        installDisabled: true,
        isGitWorktree: true,
      }).action,
      "skip",
    );
  });

  it("does not overwrite an existing custom hooks path", () => {
    assert.deepEqual(
      createGitHooksInstallPlan({
        existingHooksPath: ".custom-hooks",
        isGitWorktree: true,
      }),
      {
        action: "skip",
        message:
          "Lore Coding hook installation skipped because core.hooksPath is already set to .custom-hooks.",
      },
    );
  });

  it("treats existing .githooks path variants as already configured", () => {
    assert.deepEqual(
      createGitHooksInstallPlan({
        existingHooksPath: "./.githooks/",
        isGitWorktree: true,
      }),
      {
        action: "noop",
        message: "Git hooks path already configured: ./.githooks/",
      },
    );
  });
});
