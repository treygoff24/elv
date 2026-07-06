## CI (self-hosted devbox runner)

GitHub Actions CI executes on Trey's always-on devbox Mac, not GitHub-hosted ubuntu (`runs-on: [self-hosted, macos, arm64]`, free minutes). Full playbook + quirk list: `~/Code/devbox/guide/ci-runners.md` (present on both machines).

- **Debug CI directly**: `ssh devbox` (tailnet, key auth ready). Runner + logs: `~/actions-runners/elv/` and `~/Library/Logs/actions.runner.treygoff24-elv.*/`; live job checkout: `~/actions-runners/elv/_work/elv/elv/` — `cd` in and rerun failing commands by hand.
- **Jobs run natively on macOS**: no `apt-get`, no `sudo`, no `services:` containers (use `docker run` against colima instead).
- **Shared $HOME across all runners**: never add `pnpm/action-setup` (fixed-path race) or `actions/setup-python` (hosted-only prefix). The toolchain (node, pnpm, postgres, python3.10) is brew-installed on the box.
- **Caching is local-first**: skip `actions/cache` / setup-node `cache:` inputs (WAN round-trips); the persistent box keeps npm/pnpm stores, cargo bins, and playwright browsers warm. Big incremental caches persist under `$CI_CACHE_DIR` keyed by `$RUNNER_NAME`.
