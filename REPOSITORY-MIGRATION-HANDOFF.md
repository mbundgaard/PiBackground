# Pi Background GitHub migration handoff

## Requested outcome

The owner requested a migration handoff analogous to Pi Telegram and Pi Intercom:

- Checkout: `D:\Source\PiBackground`
- Source recorded in current package metadata: `comput-sh/pi-background` (verify live).
- Intended destination: **`comput-sh/pi-background`**.
- Keep npm package name **`@comput/pi-background`** unchanged.
- Current local version: `0.1.0`; no version bump is required for this migration.

Only this handoff has been created. No transfer, rename, remote update, package edit, account change, commit, push, publication, installation, or reload was performed for Pi Background. Confirm execution authorization with the owner before carrying out the plan. Do not treat this document as authorization to publish or push unrelated changes.

## Relevant precedent

Pi Telegram was transferred from `comput-sh/pi-telegram` to `comput-sh/pi-telegram` using `gh`:

1. Source-account admin authentication was required; destination account `comput-sh` initially lacked source admin rights.
2. Transfer submission was accepted, but completion required the owner to accept an email invitation as `comput-sh`.
3. Despite supplying `new_name`, GitHub retained the original repository name after acceptance. A separate rename under destination admin credentials completed the change.
4. The immutable repository ID verified continuity across transfer and rename.
5. Local origin and current links were updated, preserving historical release provenance.
6. No commit, push, publication, installation, or version bump occurred. Updating npm's Trusted Publisher mapping is separate and was still pending for Pi Telegram at handoff creation.

The last verified CLI identity in that session was `comput-sh`. Recheck rather than assuming the account remains active. Pi Intercom has a separate handoff; its migration was not performed by that session.

## 1. Preflight and authentication

- Read any current project instructions and inspect working-tree changes; preserve unrelated source changes and local state.
- Confirm intended destination and authorization to execute.
- Verify identity without exposing tokens:
  ```powershell
  gh api user --jq .login
  gh api repos/comput-sh/pi-background --jq '{id,full_name,permissions,visibility,archived}'
  ```
- Record the immutable repository ID for later verification.
- Verify destination owner identity/type and name availability. A 404 may mean lack of visibility rather than availability.
- If source admin rights are missing, have the owner authenticate locally:
  ```powershell
  gh auth switch --hostname github.com --user comput-sh
  # If not saved:
  gh auth login --hostname github.com --web
  ```
- Never request tokens through chat or inspect credential files. Recheck actual source admin permissions before mutation.

## 2. Transfer and rename

After authorization and preflight:

```powershell
gh api --method POST repos/comput-sh/pi-background/transfer -f new_owner=comput-sh -f new_name=pi-background --jq '{id,full_name,html_url}'
```

Submission success is not completion. Query `gh api repositories/<recorded-id>` to reconcile state. If pending, ask the owner to accept the invitation while signed into `comput-sh`; GitHub normally requires acceptance within one day.

Do not blindly repeat an uncertain transfer or use another POST as an unverified email-resend method. Do not cancel/recreate the transfer without permission.

After acceptance:

```powershell
gh auth switch --hostname github.com --user comput-sh
```

Verify destination admin rights and actual current name. If it is still `PiBackground`, perform the separately authorized rename:

```powershell
gh api --method PATCH repos/comput-sh/PiBackground -f name=pi-background --jq '{id,full_name,html_url}'
```

Verify the original ID now resolves to **`comput-sh/pi-background`**. Do not claim integrations, redirects, or release workflows are verified merely because the transfer succeeded.

## 3. Update local references

After remote verification, within authorized scope:

```powershell
git remote set-url origin https://github.com/comput-sh/pi-background.git
```

Check for a separate push URL without exposing embedded credentials. Update current repository references in:

- `package.json`: homepage, bugs, repository.
- README, security/contact documentation if present, badges, current release/development instructions.
- Source links and workflows if they contain old repository references.
- Lockfile root metadata only if applicable; do not churn dependencies.

Keep checkout paths such as `D:\Source\PiBackground` unchanged. Preserve historical release ownership, commits, workflow runs, and attestation/provenance records. Do not rewrite history as though earlier releases originated under the new owner.

## 4. npm Trusted Publisher configuration

Required destination mapping for **`@comput/pi-background`**:

| Field | Value |
| --- | --- |
| GitHub owner | `comput-sh` |
| Repository | `pi-background` |
| Workflow filename | `publish.yml` |
| GitHub environment | Blank |

The inspected `.github/workflows/publish.yml` uses OIDC (`id-token: write`) and `npm publish --provenance`. It has no GitHub environment. It runs on both manual dispatch and published GitHub releases. **Do not dispatch or create a release merely to check migration: that can publish.**

GitHub transfer does not prove npm's mapping changed. Have the owner update and confirm package-specific Trusted Publisher settings through secure npm account UI, unless another supported method is separately authorized. Mark mapping pending until confirmed; do not assume old local npm tokens are valid or inspect them. Do not republish the existing version.

## 5. Validation and completion report

Current package scripts:

```powershell
npm run validate
npm run pack:check
git diff --check
```

`validate` runs typecheck and the smoke test suite via `npm test`. Inspect any changed scripts before execution. Verify the actual package files contain only intended contents; the current allowlist includes source TypeScript, README, and LICENSE, not this handoff.

Report separately:

- Verified repository ID, final owner/name, and URL.
- Local remote/reference changes and exact files edited.
- Validation/package results and any remaining failures.
- npm mapping status: pending, owner-confirmed, or independently verified—do not conflate them.
- No commit/push/publication/install/reload unless separately authorized and actually performed.

## Architecture and scope boundaries

This is a repository migration, not a feature or integration project. Preserve unrelated work. The owner explicitly rejects coupling between independent extensions; do not introduce imports, shared private protocols, peer-specific runtime assumptions, or orchestration integrations. Mentions of other projects in this handoff are migration history only, not dependencies. Do not read, delete, package, or expose private local agent state or credentials.
