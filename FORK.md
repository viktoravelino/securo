# Fork notes

This fork (`viktoravelino/securo`) follows `securo-finance/securo`.
Its `main` branch is the latest upstream release plus a few changes. It builds the container images for one home lab.

## What the fork adds

Each change is a branch and an upstream PR. Our `main` gets each change as a cherry-pick on top of the release.

- `fix/nginx-upload-limit`: the frontend nginx accepts request bodies up to 15 MB. The default of 1 MB blocks attachments.
- `fix/negative-debits-inflow`: a debit with a negative amount, such as a refund or a repayment, counts as an inflow.
- `feat/refund-transaction-type`: the transaction form has a Refund type. It depends on the previous change.

Two files exist only in the fork, so a merge from upstream never conflicts with them: `FORK.md` and `.github/workflows/lab-images.yml`.

The feature branches start from upstream `main`, because upstream PRs need that base. A merge of them would bring unreleased upstream commits into our `main`, so cherry-pick instead.

## Why a release and not upstream main

Unreleased commits can add Alembic migrations that upstream still changes before the release.
If the lab runs such a migration and upstream then changes it, the database is left at a revision that no longer exists.
Upstream releases about once a week, so the lab stays close to upstream.

## How the images get built

Push a tag in the form `v<upstream version>-lab.<n>`, for example `v0.16.5-lab.1`.
The workflow `Lab images` then builds two images for `linux/amd64` and pushes them with `GITHUB_TOKEN`.
The image tag is the git tag.

| Image | Tag |
|---|---|
| `ghcr.io/viktoravelino/securo-backend` | `v0.16.5-lab.1` |
| `ghcr.io/viktoravelino/securo-frontend` | `v0.16.5-lab.1` |

The app shows its version as `v0.16.5+lab.1`. The `+lab` form is semver build metadata, so the update banner only shows when upstream has a newer release.

Increase `<n>` when you change our code on the same upstream release. Start again at `1` on a new upstream release.

## How to update to a new upstream release

Do this by hand. Do not automate it.
A push made with `GITHUB_TOKEN` cannot change files in `.github/workflows/`, and it does not trigger other workflows.

1. Fetch upstream: `git fetch upstream --tags`.
2. Merge the new release into `main`, for example `git merge v0.16.6`. Resolve conflicts if there are any.
   When a feature branch gets a new commit, cherry-pick that commit into `main` too.
3. Run the checks. The frontend needs `npm ci`, `npm run lint`, `npm run build` and `npm test`. The backend needs `ruff check .`, `ty check .` and `pytest`.
4. Tag `main`, for example `git tag v0.16.6-lab.1`.
5. Push `main` and the tag: `git push origin main v0.16.6-lab.1`.
6. Check that the workflow `Lab images` ends green.
7. Set the new tag in the lab (`securo_tag` in `ansible/playbooks/apps.yml` of the homelab repo) and apply.

When upstream merges one of our changes, the next merge can conflict in that code. Keep the upstream version, then check that no duplicate is left. Delete the merged feature branch.
