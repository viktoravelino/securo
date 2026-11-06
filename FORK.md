# Fork notes

This fork (`viktoravelino/securo`) follows `securo-finance/securo`.
Its `main` branch is the latest upstream release plus a few changes. It builds the container images for one home lab.

## What the fork adds

- The Reports page has an Income Statement (DRE) tab. Files: `frontend/src/lib/income-statement.ts`, `frontend/src/components/reports/IncomeStatementTable.tsx`, and the per-period investments and category-group fields in `backend/app/services/report_service.py`.
- Refunds net against their category. The fork uses upstream's refund model: a refund is a `credit` with a positive amount, usually in the purchase's category. The helper `backend/app/services/category_side.py` sets each category's side from the workspace history. When its debit volume is at least its credit volume, it is an expense category. Otherwise it is an income category. Per period, an expense category's value is debits minus credits, with no clamp at 0, so a month with only a refund shows a negative value. Uncategorized rows are not netted. The dashboard, reports, transaction summaries and account summaries use this helper. A credit card's refund counts in the bill only, not as income.

Three paths exist only in the fork, so a merge from upstream never conflicts with them: `FORK.md`, `.github/workflows/lab-images.yml` and `lab/`.

## Refund model history

Until `v0.16.6-lab.2`, the fork modeled a refund as a `debit` with a negative amount. That model came from `fix/negative-debits-inflow`, the Refund transaction type, and a recurring refund fix. `v0.17.0-lab.1` dropped that model.

`lab/convert-negative-amounts.sql` converts the old rows. A negative debit becomes a positive credit. A negative credit becomes a positive debit. The script changes manual rows outside transfer pairs, and recurring rules with a negative amount.

Warning: until the script runs, the app shows the converted rows with the wrong sign.

1. Let migrations 099-102 run on the lab database.
2. Run `lab/convert-negative-amounts.sql` once, right after step 1.

The script runs in a transaction. It fails if a negative amount is left, so a second run changes nothing.

## Why a release and not upstream main

Unreleased commits can add Alembic migrations that upstream still changes before the release.
If the lab runs such a migration and upstream then changes it, the database is left at a revision that no longer exists.
Upstream releases about once a week, so the lab stays close to upstream.

## How the images get built

Push a tag in the form `v<upstream version>-lab.<n>`, for example `v0.17.0-lab.1`.
The workflow `Lab images` then builds two images for `linux/amd64` and `linux/arm64` and pushes them with `GITHUB_TOKEN`.
The image tag is the git tag.

| Image | Tag |
|---|---|
| `ghcr.io/viktoravelino/securo-backend` | `v0.17.0-lab.1` |
| `ghcr.io/viktoravelino/securo-frontend` | `v0.17.0-lab.1` |

The app shows its version as `v0.17.0+lab.1`. The `+lab` form is semver build metadata, so the update banner only shows when upstream has a newer release.

Increase `<n>` when you change our code on the same upstream release. Start again at `1` on a new upstream release.

## How to update to a new upstream release

Do this by hand. Do not automate it.
A push made with `GITHUB_TOKEN` cannot change files in `.github/workflows/`, and it does not trigger other workflows.

1. Fetch upstream: `git fetch upstream --tags`.
2. Merge the new release into `main`, for example `git merge v0.16.6`. Resolve conflicts if there are any.
   Conflicts are likely in the services that use `category_side.py` and in `reports.tsx`. Keep the netting in each spot.
3. Run the checks. The frontend needs `npm ci`, `npm run lint`, `npm run build` and `npm test`. The backend needs `ruff check .`, `ty check .` and `pytest`.
4. Tag `main`, for example `git tag v0.16.6-lab.1`.
5. Push `main` and the tag: `git push origin main v0.16.6-lab.1`.
6. Check that the workflow `Lab images` ends green.
7. Set the new tag in the lab (`securo_tag` in `ansible/playbooks/apps.yml` of the homelab repo) and apply.
